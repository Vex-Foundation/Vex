/**
 * THE IN-FLIGHT SEND AND THE 401 RESET, on one database with two clients.
 *
 * ## The defect this suite exists for (Codex final review, round 2)
 *
 * `registration_generation` fenced the controlled backfill's transaction, but
 * not a send that was already in flight. The periodic lane and the seconds-level
 * push lane claim DIFFERENT batches concurrently, so this ordering is ordinary,
 * not exotic:
 *
 *   1. request A is claimed at generation G and posted; the server commits it,
 *      but A's response is delayed;
 *   2. request B comes back `401`; the drain runs the auth_lost recovery, which
 *      makes every non-rejected row unsent and `backfill = TRUE` and bumps the
 *      generation to G+1;
 *   3. A's delayed `200` lands and `markOutboxSent` writes `sent_at`.
 *
 * That row is now marked sent AFTER the reset that made it owed again, so it is
 * silently omitted from the full resend the reset exists to produce. Under
 * `resetIdentityForRecovery` it is not merely a gap: the event stays attached to
 * the identity that was abandoned and never reaches the new one.
 *
 * ## Why real Postgres, and why two clients
 *
 * The fence is a lock discipline (`SELECT ... FOR SHARE` on the state singleton,
 * then the generation restated as a predicate in the row UPDATE) against another
 * transaction's `FOR UPDATE`. A fake cannot have a lock, so a mocked test would
 * be asserting its own fixture. Only two real connections on one real database
 * can answer "does the stale write apply?".
 *
 * Ordering is EXPLICIT throughout - either a committed reset before the stale
 * write, or a blocker transaction holding the singleton while the write parks on
 * it, observed through `pg_stat_activity` rather than slept for.
 *
 * The shape is VS Code's `handleSaveSuccess`
 * (`src/vs/workbench/services/textfile/common/textFileEditorModel.ts:953-964`):
 * the write really did succeed downstream, and it is still not allowed to clear
 * the dirty flag if the model's `versionId` moved while it was in flight.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";
import type { AgentscanClient, SendOutcome } from "@vex-agent/agentscan/client.js";
import { enqueueAtCurrentGeneration, claimAtCurrentGeneration } from "./_reporting-tick.js";

type ReportingRepo = typeof import("../../../vex-agent/db/repos/agentscan-reporting.js");

async function reportingRepo(): Promise<ReportingRepo> {
  return import("../../../vex-agent/db/repos/agentscan-reporting.js");
}
async function sql(): Promise<typeof import("@vex-agent/db/client.js")> {
  return import("@vex-agent/db/client.js");
}

const IDENTITY = {
  agentHash: "c".repeat(64),
  ingestToken: "C".repeat(43),
};

afterEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(`DELETE FROM agentscan_reporting_state`, []);
  await cleanupSeeded();
});

/** One eligible pending swap through the real activity writer. */
async function seedEligibleSwap(): Promise<number> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole: "swap",
    kind: "swap",
    protocol: "kyberswap",
    chainId: 8453,
    walletAddress,
    sessionId,
    tokenIn: {
      tokenAddress: "0x" + "1".repeat(40),
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountRaw: "1000000000000000000",
    },
    tokenOut: {
      tokenAddress: "0x" + "2".repeat(40),
      tokenSymbol: "VEX",
      tokenDecimals: 18,
      amountRaw: "2410000000000000000000",
    },
  });
  return event.id;
}

interface OutboxRow {
  sent_at: Date | null;
  rejected_at: Date | null;
  backfill: boolean;
  next_attempt_at: Date;
  attempt_count: number;
}

/** Every outbox row for one activity, with the label the scan gave it. */
async function outboxRowsFor(activityId: number): Promise<{ id: number; backfill: boolean }[]> {
  const { query } = await sql();
  const rows = await query<{ id: string; backfill: boolean }>(
    `SELECT id::text, backfill FROM agentscan_outbox WHERE activity_id = $1 ORDER BY id`,
    [activityId],
  );
  return rows.map((r) => ({ id: Number(r.id), backfill: r.backfill }));
}

async function outboxRow(outboxId: number): Promise<OutboxRow> {
  const { queryOne } = await sql();
  const row = await queryOne<OutboxRow>(
    `SELECT sent_at, rejected_at, backfill, next_attempt_at, attempt_count
       FROM agentscan_outbox WHERE id = $1`,
    [outboxId],
  );
  if (row === null) throw new Error(`no outbox row ${outboxId}`);
  return row;
}

/** A registered install with an identity, as every tick below starts from. */
async function registerInstall(): Promise<number> {
  const repo = await reportingRepo();
  const { execute } = await sql();
  await repo.ensureIdentity(() => IDENTITY);
  await execute(`UPDATE agentscan_reporting_state SET registered_at = NOW() WHERE id = 1`, []);
  return (await repo.getReportingState()).registrationGeneration;
}

/**
 * "Request A": a registered install claims its batch under the generation it
 * read its credentials at, which is the fence the send carries.
 */
async function claimOneAsRegisteredInstall(): Promise<{
  outboxId: number;
  activityId: number;
  atGeneration: number;
}> {
  const atGeneration = await registerInstall();
  const activityId = await seedEligibleSwap();
  expect(await enqueueAtCurrentGeneration(false)).toBe(1);

  const claimed = (await claimAtCurrentGeneration())[0];
  if (claimed === undefined) throw new Error("expected one claimed row");
  expect(claimed.backfill).toBe(false);
  return { outboxId: claimed.outboxId, activityId, atGeneration };
}

describe("a terminal outbox write is fenced by the generation it was claimed under", () => {
  it("A's delayed 200 does not mark a row the 401 reset re-owed (resetForReRegistration)", async () => {
    const repo = await reportingRepo();
    const { outboxId, atGeneration } = await claimOneAsRegisteredInstall();

    // Request B's 401, in the drain's own recovery: every non-rejected row is
    // owed again as HISTORY, and the generation moves.
    await repo.resetForReRegistration();
    const afterReset = await repo.getReportingState();
    expect(afterReset.registrationGeneration).toBe(atGeneration + 1);

    // A's response finally arrives, carrying the generation it was claimed under.
    const outcome = await repo.markOutboxSent([outboxId], atGeneration);

    expect(outcome).toEqual({ kind: "stale_generation", rows: 0 });
    const row = await outboxRow(outboxId);
    // Exactly as the reset left it: unsent, and labelled history rather than
    // live activity. The full resend the reset exists for still includes it.
    expect(row.sent_at).toBeNull();
    expect(row.backfill).toBe(true);
    expect(row.attempt_count).toBe(0);

    // And it is genuinely reclaimable, not merely unsent-looking.
    const reclaimed = await claimAtCurrentGeneration();
    expect(reclaimed.map((c) => c.outboxId)).toEqual([outboxId]);
  });

  it("the event is still owed to the NEW identity after resetIdentityForRecovery", async () => {
    const repo = await reportingRepo();
    const { outboxId, activityId, atGeneration } = await claimOneAsRegisteredInstall();

    // session/complete's own 401: the identity is abandoned entirely.
    await repo.resetIdentityForRecovery();
    const abandoned = await repo.getReportingState();
    expect(abandoned.agentHash).toBeNull();
    expect(abandoned.registrationGeneration).toBe(atGeneration + 1);

    // A's delayed success, decided against the identity that no longer exists.
    expect(await repo.markOutboxSent([outboxId], atGeneration)).toEqual({
      kind: "stale_generation",
      rows: 0,
    });

    // The next run mints a FRESH identity, and the event is owed to IT. Without
    // the fence the row would read as sent and would stay attached forever to an
    // agent hash the server no longer has.
    const reborn = await repo.ensureIdentity(() => ({
      agentHash: "d".repeat(64),
      ingestToken: "D".repeat(43),
    }));
    expect(reborn.agentHash).toBe("d".repeat(64));

    const owed = (await claimAtCurrentGeneration())[0];
    if (owed === undefined) throw new Error("expected the event to be owed to the new identity");
    expect(owed.outboxId).toBe(outboxId);
    expect(owed.activityId).toBe(activityId);
    expect(owed.backfill).toBe(true);
  });

  it("a stale REJECTION does not poison a row the reset re-labelled", async () => {
    const repo = await reportingRepo();
    const { outboxId, atGeneration } = await claimOneAsRegisteredInstall();

    await repo.resetForReRegistration();

    // The per-item verdict was about the payload the PREVIOUS identity sent.
    // Poisoning the row here would delete the event from this install's history
    // permanently - `rejected_at` is the one state the reset itself will not
    // clear.
    expect(
      await repo.markOutboxRejected(outboxId, "validation_failed", atGeneration),
    ).toEqual({ kind: "stale_generation", rows: 0 });

    const row = await outboxRow(outboxId);
    expect(row.rejected_at).toBeNull();
    expect(row.backfill).toBe(true);
    expect((await claimAtCurrentGeneration()).map((c) => c.outboxId)).toEqual([outboxId]);
  });

  it("a stale RESCHEDULE does not push the new identity's resend an hour out", async () => {
    const repo = await reportingRepo();
    const { execute } = await sql();
    const { outboxId, atGeneration } = await claimOneAsRegisteredInstall();

    await repo.resetForReRegistration();
    const dueAfterReset = (await outboxRow(outboxId)).next_attempt_at;

    // The batch-invalid hold, decided under the dead generation.
    expect(await repo.rescheduleOutbox([outboxId], 3600, atGeneration)).toEqual({
      kind: "stale_generation",
      rows: 0,
    });

    const row = await outboxRow(outboxId);
    expect(row.next_attempt_at.getTime()).toBe(dueAfterReset.getTime());
    // Due now, as the reset left it - not an hour from now.
    expect(await claimAtCurrentGeneration()).toHaveLength(1);

    // And the same call under the CURRENT generation still works: the fence
    // refuses staleness, not rescheduling.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    const live = await repo.getReportingState();
    expect(await repo.rescheduleOutbox([outboxId], 3600, live.registrationGeneration)).toEqual({
      kind: "applied",
      rows: 1,
    });
    expect(await claimAtCurrentGeneration()).toHaveLength(0);
  });

  /**
   * THE INTERLEAVE ITSELF, with two clients and explicit ordering.
   *
   * The three sequential tests above prove the PREDICATE (a reset that already
   * committed is seen). This one proves the SERIALIZATION, which is the half a
   * predicate alone cannot give: a blocker transaction holds the singleton
   * `FOR UPDATE`, so `markOutboxSent` parks on its own `FOR SHARE` - observed by
   * waiting for the blocked backend to appear in `pg_stat_activity`, never
   * slept for. The reset then runs INSIDE that transaction and commits, which is
   * the 401 "landing mid-write". The write wakes, reads the moved generation,
   * and applies to nothing.
   *
   * Without the share lock the write could commit between the reset's state
   * UPDATE and its outbox relabel and be undone only by luck of statement order.
   */
  it("serializes a reset that lands while the terminal write is parked, and the write never wins", async () => {
    const repo = await reportingRepo();
    const { getPool } = await sql();
    const { outboxId, atGeneration } = await claimOneAsRegisteredInstall();

    const blocker = await getPool().connect();
    let write: Promise<{ kind: string; rows: number }>;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR UPDATE",
      );

      write = repo.markOutboxSent([outboxId], atGeneration);
      await waitForBlockedBackend();

      // The 401 recovery, landing while A's success is stuck on the fence.
      await blocker.query(
        `UPDATE agentscan_reporting_state
            SET registered_at = NULL,
                backfill_enqueued_at = NULL,
                backfill_vocabulary_version = NULL,
                registration_generation = registration_generation + 1,
                updated_at = NOW()
          WHERE id = 1`,
      );
      await blocker.query(
        `UPDATE agentscan_outbox
            SET sent_at = NULL, attempt_count = 0, next_attempt_at = NOW(),
                backfill = TRUE, last_error = NULL
          WHERE rejected_at IS NULL`,
      );
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }

    expect(await write).toEqual({ kind: "stale_generation", rows: 0 });
    const row = await outboxRow(outboxId);
    expect(row.sent_at).toBeNull();
    expect(row.backfill).toBe(true);
  });
});

/**
 * THE INSERT A RESET CANNOT REACH (Codex final review, round 3).
 *
 * Round 3 fenced the TERMINAL writes and captured the generation inside the
 * claim, which left the step before them - the incremental diff scan - running
 * unfenced under a generation the lane had already outlived:
 *
 *   1. the push lane reads registered state at G and passes its guards;
 *   2. a concurrent 401 reset commits G+1, relabelling every existing
 *      non-rejected outbox row as owed history;
 *   3. the stale lane runs the incremental scan, which INSERTS a previously
 *      absent `(activity_id, status)` pair as `backfill = FALSE`;
 *   4. the claim adopts G+1 - so nothing downstream objects - although the send
 *      still carries G's credentials;
 *   5. the send never completes (rate budget spent, or a retryable failure), so
 *      no second reset comes to relabel anything;
 *   6. the controlled backfill cannot replace that row: its enqueue is the same
 *      diff and `UNIQUE (activity_id, status)` is already taken.
 *
 * A reset can relabel rows; it cannot relabel a row inserted after it committed.
 * The row is then this install's history, sent to the server as live activity.
 */
describe("the incremental scan is fenced by the generation the lane read its credentials at", () => {
  it("a stale incremental tick inserts nothing, sends nothing, and leaves the pair to the backfill", async () => {
    const repo = await reportingRepo();
    // The lane's own `getReportingState()`: credentials AND generation, held.
    const staleGeneration = await registerInstall();

    // The concurrent 401 recovery, one transaction: relabel plus bump.
    await repo.resetForReRegistration();
    expect((await repo.getReportingState()).registrationGeneration).toBe(staleGeneration + 1);

    // A pair the outbox has NEVER seen - the population a reset cannot relabel.
    const activityId = await seedEligibleSwap();

    const sendEvents = vi.fn(
      async (): Promise<SendOutcome> => ({
        kind: "retryable",
        status: 503,
        retryAfterSeconds: null,
        detail: "unavailable",
      }),
    );
    const client: AgentscanClient = { sendEvents };
    const { drainIncremental } = await import("@vex-agent/sync/agentscan-report/drain.js");

    const result = await drainIncremental(
      client,
      IDENTITY.agentHash,
      IDENTITY.ingestToken,
      staleGeneration,
    );

    expect(result).toEqual({ enqueued: 0, sent: 0, rejected: 0, deferred: 0 });
    // No row at all, so no `backfill = false` row - and nothing was sent under
    // the credentials the reset replaced.
    expect(await outboxRowsFor(activityId)).toEqual([]);
    expect(sendEvents).not.toHaveBeenCalled();

    // The repo says why, rather than reporting a silent zero.
    expect(await repo.enqueueEligibleActivity(false, staleGeneration)).toEqual({
      kind: "stale_generation",
      rows: 0,
    });

    // Nothing is lost: the controlled backfill that the reset made owed picks
    // the pair up and labels it history, which is the label the stale tick
    // would have made unreachable forever.
    expect(await enqueueAtCurrentGeneration(true)).toBe(1);
    const backfilled = await outboxRowsFor(activityId);
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]?.backfill).toBe(true);
  });

  it("a claim at a stale generation claims nothing and leaves the row due and unstamped", async () => {
    const repo = await reportingRepo();
    const staleGeneration = await registerInstall();
    const activityId = await seedEligibleSwap();
    expect(await enqueueAtCurrentGeneration(false)).toBe(1);

    await repo.resetForReRegistration();

    // Claiming here would stamp a backoff on a row the reset just re-owed and
    // hand it to a send carrying the replaced credentials.
    expect(await repo.claimDueOutbox(10, staleGeneration)).toEqual({ kind: "stale_generation" });

    const outboxId = (await outboxRowsFor(activityId))[0]?.id;
    if (outboxId === undefined) throw new Error("expected the enqueued row to survive the reset");
    const row = await outboxRow(outboxId);
    expect(row.attempt_count).toBe(0);
    expect(row.backfill).toBe(true);
    expect(row.sent_at).toBeNull();

    // Due now for the tick that reads the CURRENT generation.
    expect((await claimAtCurrentGeneration()).map((c) => c.outboxId)).toEqual([outboxId]);
  });

  /**
   * THE SERIALIZATION, with two clients: the scan takes the singleton
   * `FOR SHARE`, so a reset holding it `FOR UPDATE` parks the scan (observed
   * through `pg_stat_activity`, never slept for) and the scan then reads the
   * moved generation and inserts nothing. Without the share lock the INSERT
   * could commit against a pre-reset snapshot and produce exactly the
   * unreachable `backfill = false` row this suite exists for.
   */
  it("serializes a reset that lands while the incremental scan is parked, and the scan inserts nothing", async () => {
    const repo = await reportingRepo();
    const { getPool } = await sql();
    const staleGeneration = await registerInstall();
    const activityId = await seedEligibleSwap();

    const blocker = await getPool().connect();
    let scan: Promise<{ kind: string; rows: number }>;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT registration_generation FROM agentscan_reporting_state WHERE id = 1 FOR UPDATE",
      );

      scan = repo.enqueueEligibleActivity(false, staleGeneration);
      await waitForBlockedBackend();

      await blocker.query(
        `UPDATE agentscan_reporting_state
            SET registered_at = NULL,
                backfill_enqueued_at = NULL,
                backfill_vocabulary_version = NULL,
                registration_generation = registration_generation + 1,
                updated_at = NOW()
          WHERE id = 1`,
      );
      await blocker.query(
        `UPDATE agentscan_outbox
            SET sent_at = NULL, attempt_count = 0, next_attempt_at = NOW(),
                backfill = TRUE, last_error = NULL
          WHERE rejected_at IS NULL`,
      );
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }

    expect(await scan).toEqual({ kind: "stale_generation", rows: 0 });
    expect(await outboxRowsFor(activityId)).toEqual([]);
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
