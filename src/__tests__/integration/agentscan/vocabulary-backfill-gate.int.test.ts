/**
 * THE VOCABULARY BACKFILL GATE, against real Postgres and with the two scans
 * racing.
 *
 * ## The defect this suite exists for
 *
 * Migration 102 widened the reportable vocabulary. Widening makes rows that
 * ALREADY EXIST newly eligible, and the AgentScan outbox is filled by a diff
 * scan that runs in two modes: the one-time BACKFILL (`backfill = TRUE`, "this
 * is history") and the incremental tick (`backfill = FALSE`, "this just
 * happened"). Whichever scan reaches a pair first owns it forever - a completed
 * outbox row is never re-enqueued and never re-sent - so if an incremental tick
 * got there first, months of historical claim rows would arrive at the server
 * labelled live activity. The server cannot detect that, and this install cannot
 * correct it.
 *
 * ## Why real Postgres, and why concurrently
 *
 * The gate is one SQL predicate joined against the reporting-state singleton,
 * and the property under test is what happens when two writers evaluate it at
 * overlapping times. A unit test with a fake would be asserting the fixture. The
 * only thing that can answer "does the incremental scan steal the history?" is
 * two real statements against one real database.
 *
 * The shape is VS Code's one-time storage migration
 * (`src/vs/workbench/services/extensions/common/extensionStorageMigration.ts`):
 * a durable done-marker, the work skipped entirely when the marker is present,
 * the marker written after the work, and a re-run that is a no-op. Here the
 * marker is `agentscan_reporting_state.backfill_enqueued_at`, which migration
 * 102 resets, and the work is the diff scan.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";
import { enqueueAtCurrentGeneration } from "./_reporting-tick.js";

type ActivityRepo = typeof import("../../../vex-agent/db/repos/agent-activity.js");
type ReportingRepo = typeof import("../../../vex-agent/db/repos/agentscan-reporting.js");

async function activityRepo(): Promise<ActivityRepo> {
  return import("@vex-agent/db/repos/agent-activity.js");
}
async function reportingRepo(): Promise<ReportingRepo> {
  return import("../../../vex-agent/db/repos/agentscan-reporting.js");
}
async function sql(): Promise<typeof import("@vex-agent/db/client.js")> {
  return import("@vex-agent/db/client.js");
}

const ERC20_OUT = {
  tokenAddress: "0x" + "2".repeat(40),
  tokenSymbol: "PT",
  tokenDecimals: 18,
  amountRaw: "1900000000000000000",
};

/**
 * Put the reporting state exactly where migration 107 leaves an existing
 * install: the widened vocabulary is present, and the one-time backfill it owes
 * has NOT run yet.
 */
async function stateAfterMigration(): Promise<void> {
  const repo = await reportingRepo();
  await repo.getReportingState();
  const { execute } = await sql();
  await execute(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 2,
            backfill_enqueued_at = NULL,
            backfill_vocabulary_version = NULL
      WHERE id = 1`,
  );
}

/**
 * The controlled backfill exactly as `sync/agentscan-report.ts` runs it: read the
 * generation the decision was made under, then enqueue and mark in ONE
 * transaction. Never two calls, because the whole point of the fix is that the
 * enqueue and the mark are one fact.
 */
async function runControlledBackfill(): Promise<{ enqueued: number; marked: boolean }> {
  const repo = await reportingRepo();
  const state = await repo.getReportingState();
  const outcome = await repo.enqueueBackfillAndMark({
    startedAtGeneration: state.registrationGeneration,
  });
  return { enqueued: outcome.enqueued, marked: outcome.marked };
}

/** An install whose database has NOT applied the widening. */
async function stateBeforeMigration(): Promise<void> {
  const repo = await reportingRepo();
  await repo.getReportingState();
  const { execute } = await sql();
  await execute(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 1,
            backfill_enqueued_at = NOW(),
            backfill_vocabulary_version = 1
      WHERE id = 1`,
  );
}

/** One pending row of the given kind/role through the real generic write path. */
async function seedPending(
  kind: "swap" | "claim",
  eventRole: string,
): Promise<number> {
  const repo = await activityRepo();
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole: eventRole as Parameters<ActivityRepo["createPendingActivityEvent"]>[0]["eventRole"],
    kind,
    protocol: "pools",
    chainId: 8453,
    chainFamily: "eip155",
    walletAddress,
    sessionId,
    tokenOut: ERC20_OUT,
  });
  return event.id;
}

/** The outbox rows for one activity, with the flag each was enqueued under. */
async function outboxFor(activityId: number): Promise<{ backfill: boolean }[]> {
  const { query } = await sql();
  return query<{ backfill: boolean }>(
    `SELECT backfill FROM agentscan_outbox WHERE activity_id = $1 ORDER BY id`,
    [activityId],
  );
}

beforeEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
});

afterEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 2,
            backfill_enqueued_at = NULL,
            backfill_vocabulary_version = NULL,
            registration_generation = 0
      WHERE id = 1`,
  );
  await cleanupSeeded();
});

describe("the widened vocabulary waits for its own backfill", () => {
  it("an incremental scan before the mark refuses the new roles and still takes the old ones", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const legacy = await seedPending("swap", "swap");
    const family = await seedPending("claim", "creator_fee_claim");

    await enqueueAtCurrentGeneration(false);

    // The vocabulary every install has always reported is untouched by the gate:
    // holding it back would stop live reporting for a migration it has nothing
    // to do with.
    expect(await outboxFor(legacy)).toEqual([{ backfill: false }]);
    // The new role is REFUSED, not deferred to a later incremental tick: the
    // only scan allowed to claim it is the controlled backfill.
    expect(await outboxFor(family)).toEqual([]);
  });

  it("the controlled backfill claims the whole newly-eligible history as history", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const family = await seedPending("claim", "holder_reward_claim");

    await runControlledBackfill();

    expect(await outboxFor(family)).toEqual([{ backfill: true }]);
  });

  it("every incremental scan AFTER the mark takes the new roles normally", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    await runControlledBackfill();

    // A row that arrives after the backfill is live activity, and is labelled so.
    const fresh = await seedPending("claim", "reward_distribution");
    await enqueueAtCurrentGeneration(false);

    expect(await outboxFor(fresh)).toEqual([{ backfill: false }]);
  });

  it("re-running the backfill is a no-op: the diff, not the flag, is what makes it idempotent", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const family = await seedPending("claim", "creator_fee_claim");

    const first = await enqueueAtCurrentGeneration(true);
    const second = await enqueueAtCurrentGeneration(true);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(await outboxFor(family)).toEqual([{ backfill: true }]);
  });

  it("a database that has not applied the widening reports nothing new, even with the mark set", async () => {
    // The gate is TWO facts, not one. A build shipped ahead of its migration
    // must not report a role its own CHECK constraint would refuse to store.
    await stateBeforeMigration();
    const repo = await reportingRepo();
    const family = await seedPending("claim", "pools_claim");

    await enqueueAtCurrentGeneration(false);
    await enqueueAtCurrentGeneration(true);

    expect(await outboxFor(family)).toEqual([]);
  });
});

describe("the two scans racing on one database", () => {
  /**
   * The interleaving that motivated the gate: the periodic lane runs the
   * controlled backfill while the seconds-level push lane fires its own
   * incremental scan against the same table.
   *
   * The invariant is not "the backfill wins the race" - either order is fine -
   * it is that a historical row carrying a new-vocabulary role can NEVER end up
   * in the outbox flagged `backfill = false`. An incremental scan that reads the
   * marker as absent refuses those roles outright; one that reads it as present
   * finds the backfill's rows already committed and its own insert is dropped by
   * `ON CONFLICT DO NOTHING`, which preserves the flag the backfill wrote.
   */
  it("never labels a historical new-vocabulary row as live activity", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const family = [
      await seedPending("claim", "pools_claim"),
      await seedPending("claim", "creator_fee_claim"),
      await seedPending("claim", "holder_reward_claim"),
      await seedPending("claim", "reward_distribution"),
    ];
    const legacy = await seedPending("swap", "swap");

    await Promise.all([
      runControlledBackfill(),
      enqueueAtCurrentGeneration(false),
      enqueueAtCurrentGeneration(false),
      enqueueAtCurrentGeneration(false),
    ]);

    for (const id of family) {
      // Exactly one row, and it is history. Not two, because the pair is unique;
      // not `backfill = false`, because that is the lie the gate prevents.
      expect(await outboxFor(id)).toEqual([{ backfill: true }]);
    }
    // The old vocabulary is unaffected by any of it: whichever scan got there
    // first, the row is reported.
    expect(await outboxFor(legacy)).toHaveLength(1);
  });

  it("survives a crash between the backfill and its mark by re-running the same step", async () => {
    // The marker is written AFTER the work, so a crash in between leaves the
    // rows enqueued and the marker absent. The recovery is not a repair path: it
    // is the same one-time branch running again, and the diff makes it a no-op
    // for everything already enqueued.
    await stateAfterMigration();
    const repo = await reportingRepo();
    const before = await seedPending("claim", "creator_fee_claim");
    await enqueueAtCurrentGeneration(true);
    // ...crash here, no mark.

    // An incremental tick in the crash window still refuses the new roles, so a
    // row written during it is not stolen either.
    const during = await seedPending("claim", "holder_reward_claim");
    await enqueueAtCurrentGeneration(false);
    expect(await outboxFor(during)).toEqual([]);

    // The next periodic run re-enters the same branch and completes it.
    await runControlledBackfill();

    expect(await outboxFor(before)).toEqual([{ backfill: true }]);
    expect(await outboxFor(during)).toEqual([{ backfill: true }]);
  });
});

/**
 * THE COMPLETION MARK AND THE 401 RESET, on one database with two clients.
 *
 * The lost update this closes: `resetForReRegistration` (the 401 recovery)
 * CLEARS the completion marker, because a server that has forgotten this install
 * is owed the whole history again. While the enqueue and the mark were two
 * separate commits, a reset landing between them wrote nothing that survived -
 * the stale mark, which had started before the reset, put the timestamp straight
 * back. The install then believed a backfill it never ran was complete, and
 * every historical row the reset had made owed again was swept up by the next
 * INCREMENTAL tick and reported as live activity.
 *
 * Both halves now commit in one transaction that takes `SELECT ... FOR UPDATE`
 * on the singleton before it scans, and the mark carries the registration
 * generation it started under.
 */
describe("the backfill mark against a concurrent registration reset", () => {
  /**
   * The reset landed after the caller decided to backfill. Deterministic and
   * with no lock choreography, because the guard under test is exactly this
   * ordering: the generation the attempt carries no longer exists.
   */
  it("refuses to mark a backfill whose registration generation has moved", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const before = await repo.getReportingState();

    // The 401 lands between the caller reading state and the transaction opening.
    await repo.resetForReRegistration();

    const outcome = await repo.enqueueBackfillAndMark({
      startedAtGeneration: before.registrationGeneration,
    });

    expect(outcome).toEqual({ enqueued: 0, marked: false, declined: "generation_moved" });
    const after = await repo.getReportingState();
    // Still owed. The stale attempt wrote nothing at all - not the mark, and not
    // the rows, because rows enqueued under a dead identity would be labelled by
    // a marker that never arrives.
    expect(after.backfillEnqueuedAt).toBeNull();
    expect(after.backfillVocabularyVersion).toBeNull();
  });

  /**
   * THE INTERLEAVE ITSELF, with two clients and explicit ordering.
   *
   * Client A opens a transaction and locks the singleton, so the backfill
   * transaction blocks at its own `FOR UPDATE` - proven by waiting for the
   * blocked backend to appear in `pg_stat_activity`, not by sleeping. The reset
   * then runs INSIDE A's transaction and commits, which is the reset "landing
   * mid-backfill". The backfill wakes, sees the moved generation, and declines.
   *
   * What it proves is the serialization: there is no longer a window in which
   * the enqueue is committed and the mark is not, so a reset can never be
   * overwritten by a mark that predates it.
   */
  it("serializes a reset that lands while the backfill is in flight, and the mark never wins", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const { getPool } = await sql();
    const family = await seedPending("claim", "holder_reward_claim");
    const before = await repo.getReportingState();

    const blocker = await getPool().connect();
    let attempt: Promise<{ marked: boolean }>;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR UPDATE");

      attempt = repo.enqueueBackfillAndMark({ startedAtGeneration: before.registrationGeneration });
      await waitForBlockedBackend();

      // The 401 recovery, landing while the backfill is stuck on the lock.
      await blocker.query(
        `UPDATE agentscan_reporting_state
            SET registered_at = NULL,
                backfill_enqueued_at = NULL,
                backfill_vocabulary_version = NULL,
                registration_generation = registration_generation + 1,
                updated_at = NOW()
          WHERE id = 1`,
      );
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }

    expect(await attempt).toMatchObject({ marked: false, declined: "generation_moved" });
    const after = await repo.getReportingState();
    expect(after.backfillEnqueuedAt).toBeNull();
    expect(after.backfillVocabularyVersion).toBeNull();
    // And the family row is still owed: nothing was enqueued under the dead
    // generation, so the next backfill on the live one picks it up as history.
    expect(await outboxFor(family)).toEqual([]);
  });

  /**
   * A row that was IN FLIGHT when the 401 arrived. It is unsent and flagged
   * `backfill = false`, and it is the exact population the reset used to skip:
   * `sent_at IS NOT NULL` reads as "only what the server already saw", but the
   * rows being sent when the identity went away are the ones still unsent. Left
   * as they were, the drain later delivers this install's history to a
   * freshly-registered agent as live activity, and the controlled backfill
   * cannot repair it - its insert is a diff on `(activity_id, status)` and the
   * pair already has a row.
   */
  it("re-labels an UNSENT live row as history when the 401 reset lands", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const { query } = await sql();
    await runControlledBackfill();

    // A family row that arrives after the backfill is live activity...
    const fresh = await seedPending("claim", "creator_fee_claim");
    await enqueueAtCurrentGeneration(false);
    expect(await outboxFor(fresh)).toEqual([{ backfill: false }]);

    // ...and is still unsent when the server forgets this install.
    await repo.resetForReRegistration();

    expect(await outboxFor(fresh)).toEqual([{ backfill: true }]);
    const rows = await query<{ sent_at: Date | null; attempt_count: number }>(
      `SELECT sent_at, attempt_count FROM agentscan_outbox WHERE activity_id = $1`,
      [fresh],
    );
    expect(rows[0]?.sent_at).toBeNull();
    expect(Number(rows[0]?.attempt_count)).toBe(0);
  });
});

/**
 * Wait until some backend is blocked on a lock. A CONDITION, not a delay: the
 * loop ends when the database itself reports the waiter, so the ordering the
 * test depends on is observed rather than assumed.
 */
async function waitForBlockedBackend(): Promise<void> {
  const { query } = await sql();
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND state = 'active'`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("no backend ever blocked on the reporting-state row lock");
}
