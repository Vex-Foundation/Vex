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
import { afterEach, describe, expect, it } from "vitest";

import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";

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

/**
 * "Request A": a registered install claims its batch, which is the moment the
 * generation the send is fenced by is fixed. Returns the row and that fence.
 */
async function claimOneAsRegisteredInstall(): Promise<{
  outboxId: number;
  activityId: number;
  atGeneration: number;
}> {
  const repo = await reportingRepo();
  const { execute } = await sql();
  await repo.ensureIdentity(() => IDENTITY);
  await execute(
    `UPDATE agentscan_reporting_state SET registered_at = NOW() WHERE id = 1`,
    [],
  );
  const activityId = await seedEligibleSwap();
  expect(await repo.enqueueEligibleActivity(false)).toBe(1);

  const batch = await repo.claimDueOutbox(10);
  const claimed = batch.events[0];
  if (claimed === undefined) throw new Error("expected one claimed row");
  expect(claimed.backfill).toBe(false);
  return {
    outboxId: claimed.outboxId,
    activityId,
    atGeneration: batch.registrationGeneration,
  };
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
    const reclaimed = await repo.claimDueOutbox(10);
    expect(reclaimed.events.map((c) => c.outboxId)).toEqual([outboxId]);
    expect(reclaimed.registrationGeneration).toBe(atGeneration + 1);
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

    const reclaimed = await repo.claimDueOutbox(10);
    const owed = reclaimed.events[0];
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
    expect((await repo.claimDueOutbox(10)).events.map((c) => c.outboxId)).toEqual([outboxId]);
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
    expect((await repo.claimDueOutbox(10)).events).toHaveLength(1);

    // And the same call under the CURRENT generation still works: the fence
    // refuses staleness, not rescheduling.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    const live = await repo.getReportingState();
    expect(await repo.rescheduleOutbox([outboxId], 3600, live.registrationGeneration)).toEqual({
      kind: "applied",
      rows: 1,
    });
    expect((await repo.claimDueOutbox(10)).events).toHaveLength(0);
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
