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
 * Put the reporting state exactly where migration 102 leaves an existing
 * install: the widened vocabulary is present, and the one-time backfill it owes
 * has NOT run yet.
 */
async function stateAfterMigration(): Promise<void> {
  const repo = await reportingRepo();
  await repo.getReportingState();
  const { execute } = await sql();
  await execute(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 2, backfill_enqueued_at = NULL
      WHERE id = 1`,
  );
}

/** An install whose database has NOT applied the widening. */
async function stateBeforeMigration(): Promise<void> {
  const repo = await reportingRepo();
  await repo.getReportingState();
  const { execute } = await sql();
  await execute(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 1, backfill_enqueued_at = NOW()
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
        SET vocabulary_version = 2, backfill_enqueued_at = NULL
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

    await repo.enqueueEligibleActivity(false);

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

    await repo.enqueueEligibleActivity(true);
    await repo.markBackfillEnqueued();

    expect(await outboxFor(family)).toEqual([{ backfill: true }]);
  });

  it("every incremental scan AFTER the mark takes the new roles normally", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    await repo.enqueueEligibleActivity(true);
    await repo.markBackfillEnqueued();

    // A row that arrives after the backfill is live activity, and is labelled so.
    const fresh = await seedPending("claim", "reward_distribution");
    await repo.enqueueEligibleActivity(false);

    expect(await outboxFor(fresh)).toEqual([{ backfill: false }]);
  });

  it("re-running the backfill is a no-op: the diff, not the flag, is what makes it idempotent", async () => {
    await stateAfterMigration();
    const repo = await reportingRepo();
    const family = await seedPending("claim", "creator_fee_claim");

    const first = await repo.enqueueEligibleActivity(true);
    const second = await repo.enqueueEligibleActivity(true);

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

    await repo.enqueueEligibleActivity(false);
    await repo.enqueueEligibleActivity(true);

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
      (async () => {
        await repo.enqueueEligibleActivity(true);
        await repo.markBackfillEnqueued();
      })(),
      repo.enqueueEligibleActivity(false),
      repo.enqueueEligibleActivity(false),
      repo.enqueueEligibleActivity(false),
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
    await repo.enqueueEligibleActivity(true);
    // ...crash here, no mark.

    // An incremental tick in the crash window still refuses the new roles, so a
    // row written during it is not stolen either.
    const during = await seedPending("claim", "holder_reward_claim");
    await repo.enqueueEligibleActivity(false);
    expect(await outboxFor(during)).toEqual([]);

    // The next periodic run re-enters the same branch and completes it.
    await repo.enqueueEligibleActivity(true);
    await repo.markBackfillEnqueued();

    expect(await outboxFor(before)).toEqual([{ backfill: true }]);
    expect(await outboxFor(during)).toEqual([{ backfill: true }]);
  });
});
