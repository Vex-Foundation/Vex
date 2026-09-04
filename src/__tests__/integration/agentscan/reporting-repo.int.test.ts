/**
 * AgentScan reporting repo (migration 073) — real-Postgres suite.
 *
 * What is pinned here, against real SQL (a mocked client would prove nothing):
 *
 *   - the state singleton self-creates and its progress stamps
 *     (registered / backfill-enqueued / stopped / register-backoff) round-trip;
 *   - `ensureIdentity` is once-only — a second generator NEVER replaces a
 *     stored identity (an install must keep one hash for life);
 *   - the diff scan (`enqueueEligibleActivity`) captures exactly the
 *     (activity, status) pairs the ingest contract can express — new rows AND
 *     status transitions — and is idempotent across re-runs;
 *   - rows the ingest contract cannot express (the approval roles the server's
 *     enum lacks) are never enqueued, while `superseded_unproven` is;
 *   - claim-and-stamp: a claimed row is out of the candidate set until its
 *     backoff elapses, and terminal marks (`sent` / `rejected`) remove it
 *     forever.
 *
 * Rows are seeded through the REAL agent-activity repo (same FK/CHECK gauntlet
 * production writes face) via the shared `_fixtures.ts` intent seeder.
 */
import { afterEach, describe, it, expect } from "vitest";
import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";

async function resetAgentscanTables(): Promise<void> {
  const { execute } = await import("@vex-agent/db/client.js");
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(`DELETE FROM agentscan_reporting_state`, []);
}

/**
 * Test-only state-setter: stamps `registered_at` + resets the attempt backoff
 * directly, without going through `markHandshakeComplete` (which also rotates
 * the token / stores name+fingerprint — more than these tests need). Replaces
 * the old `markRegistered()` repo function, which production code no longer
 * calls now that the v2 handshake owns registration.
 */
async function stampRegistered(): Promise<void> {
  const { execute } = await import("@vex-agent/db/client.js");
  await execute(
    `UPDATE agentscan_reporting_state
        SET registered_at = NOW(), register_attempt_count = 0, next_register_attempt_at = NOW()
      WHERE id = 1`,
    [],
  );
}

/** Index into an array without a non-null assertion: a miss throws, honestly. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}, got ${items.length} item(s)`);
  return item;
}

afterEach(async () => {
  await resetAgentscanTables();
  await cleanupSeeded();
});

const IDENTITY_A = {
  agentHash: "a".repeat(64),
  ingestToken: "A".repeat(43),
};
const IDENTITY_B = {
  agentHash: "b".repeat(64),
  ingestToken: "B".repeat(43),
};

/** Seed one eligible pending swap activity row through the real repo. */
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
    tokenIn: { tokenAddress: "0x" + "1".repeat(40), tokenSymbol: "ETH", tokenDecimals: 18, amountRaw: "1000000000000000000" },
    tokenOut: { tokenAddress: "0x" + "2".repeat(40), tokenSymbol: "VEX", tokenDecimals: 18, amountRaw: "2410000000000000000000" },
    usdInEst: "3312.44",
  });
  return event.id;
}

/** Drive an eligible pending row to `confirmed` the way a venue handler does. */
async function confirmSeededSwap(activityId: number): Promise<void> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const broadcast = await repo.markActivityBroadcast(activityId, {
    txHash: `0x${activityId.toString(16).padStart(64, "0")}`,
    fromAddress: "0x" + "3".repeat(40),
    nonce: 1,
  });
  expect(broadcast.applied).toBe(true);
  const confirmed = await repo.confirmActivityEvent(activityId, {
    executedAmountInRaw: "1000000000000000000",
    executedAmountOutRaw: "2407113000000000000000",
  });
  expect(confirmed.applied).toBe(true);
}

describe("agentscan_reporting_state — singleton + progress stamps", () => {
  it("self-creates with no identity, consent v1, not registered, not stopped", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const state = await repo.getReportingState();
    expect(state.agentHash).toBeNull();
    expect(state.ingestToken).toBeNull();
    expect(state.consentVersion).toBe(1);
    expect(state.registeredAt).toBeNull();
    expect(state.backfillEnqueuedAt).toBeNull();
    expect(state.stoppedReason).toBeNull();
    expect(state.registerAttemptCount).toBe(0);
  });

  it("ensureIdentity stores the first identity and NEVER replaces it", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const first = await repo.ensureIdentity(() => IDENTITY_A);
    expect(first.agentHash).toBe(IDENTITY_A.agentHash);
    expect(first.acceptedAt).not.toBeNull();

    const second = await repo.ensureIdentity(() => IDENTITY_B);
    expect(second.agentHash).toBe(IDENTITY_A.agentHash);
    expect(second.ingestToken).toBe(IDENTITY_A.ingestToken);
  });

  it("registration lifecycle: backoff failure → registered → reset for full resend (auth_lost recovery)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);

    await repo.noteRegisterAttemptFailed(600);
    let state = await repo.getReportingState();
    expect(state.registerAttemptCount).toBe(1);
    expect(new Date(state.nextRegisterAttemptAt).getTime()).toBeGreaterThan(Date.now() + 500_000);

    await stampRegistered();
    const registered = await repo.getReportingState();
    await repo.enqueueBackfillAndMark({ startedAtGeneration: registered.registrationGeneration });
    state = await repo.getReportingState();
    expect(state.registeredAt).not.toBeNull();
    expect(state.backfillEnqueuedAt).not.toBeNull();
    // The marker says WHICH vocabulary the backfill covered, not merely that one ran.
    expect(state.backfillVocabularyVersion).toBe(repo.AGENTSCAN_VOCABULARY_VERSION);
    const generationBeforeReset = state.registrationGeneration;

    await repo.resetForReRegistration();
    state = await repo.getReportingState();
    expect(state.registeredAt).toBeNull();
    expect(state.backfillEnqueuedAt).toBeNull();
    // The whole history is owed again, so the coverage claim goes with it, and
    // the generation moves so a mark that started before this reset is refused.
    expect(state.backfillVocabularyVersion).toBeNull();
    expect(state.registrationGeneration).toBe(generationBeforeReset + 1);
    // identity survives an auth_lost recovery — only the progress stamps reset
    expect(state.agentHash).toBe(IDENTITY_A.agentHash);
  });

  it("markStopped + the backfill marker persist", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const before = await repo.getReportingState();
    await repo.enqueueBackfillAndMark({ startedAtGeneration: before.registrationGeneration });
    await repo.markStopped("consent_revoked");
    const state = await repo.getReportingState();
    expect(state.backfillEnqueuedAt).not.toBeNull();
    expect(state.backfillVocabularyVersion).toBe(repo.AGENTSCAN_VOCABULARY_VERSION);
    expect(state.stoppedReason).toBe("consent_revoked");
  });

  it("markStopped accepts wallet_conflict (migration 075 widened CHECK)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.markStopped("wallet_conflict");
    const state = await repo.getReportingState();
    expect(state.stoppedReason).toBe("wallet_conflict");
  });
});

describe("agentscan_reporting_state — handshake fields (migration 075)", () => {
  it("self-creates with every handshake field null", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const state = await repo.getReportingState();
    expect(state.agentName).toBeNull();
    expect(state.lastHandshakeAt).toBeNull();
    expect(state.serverCursorRowId).toBeNull();
    expect(state.boundWalletsFingerprint).toBeNull();
  });

  it("markHandshakeComplete rotates the token, stamps registered_at + last_handshake_at, stores name/cursor/fingerprint, and resets the attempt backoff", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);
    await repo.noteRegisterAttemptFailed(600);
    const before = await repo.getReportingState();
    expect(before.registerAttemptCount).toBe(1);

    await repo.markHandshakeComplete({
      agentName: "agent-007",
      ingestToken: IDENTITY_B.ingestToken,
      serverCursorRowId: 42,
      walletsFingerprint: "deadbeef",
    });

    const state = await repo.getReportingState();
    expect(state.agentHash).toBe(IDENTITY_A.agentHash); // identity itself never rotates
    expect(state.ingestToken).toBe(IDENTITY_B.ingestToken); // token IS rotated
    expect(state.agentName).toBe("agent-007");
    expect(state.serverCursorRowId).toBe(42);
    expect(state.boundWalletsFingerprint).toBe("deadbeef");
    expect(state.registeredAt).not.toBeNull();
    expect(state.lastHandshakeAt).not.toBeNull();
    expect(state.registerAttemptCount).toBe(0);
    expect(new Date(state.nextRegisterAttemptAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("markHandshakeComplete accepts a null server cursor (brand-new agent, no history yet)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);

    await repo.markHandshakeComplete({
      agentName: "agent-fresh",
      ingestToken: IDENTITY_A.ingestToken,
      serverCursorRowId: null,
      walletsFingerprint: "fingerprint-1",
    });

    const state = await repo.getReportingState();
    expect(state.serverCursorRowId).toBeNull();
  });
});

describe("agentscan_outbox — diff scan", () => {
  it("captures a new eligible pending row once, then its confirmed transition as a second pair", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const activityId = await seedEligibleSwap();

    expect(await repo.enqueueEligibleActivity(false)).toBe(1);
    expect(await repo.enqueueEligibleActivity(false)).toBe(0); // idempotent

    await confirmSeededSwap(activityId);
    expect(await repo.enqueueEligibleActivity(false)).toBe(1); // the (id, confirmed) pair

    const claimed = (await repo.claimDueOutbox(10)).events;
    const statuses = claimed.map((c) => c.status).sort();
    expect(statuses).toEqual(["confirmed", "pending"]);
    expect(claimed.every((c) => c.activityId === activityId)).toBe(true);
  });

  it("stamps backfill=true only on rows enqueued by a backfill scan", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    expect(await repo.enqueueEligibleActivity(true)).toBe(1);
    const claimed = (await repo.claimDueOutbox(10)).events;
    expect(claimed).toHaveLength(1);
    expect(at(claimed, 0).backfill).toBe(true);
  });

  it("never enqueues an approval row or a wrap row, but DOES enqueue superseded_unproven", async () => {
    const agentActivity = await import("@vex-agent/db/repos/agent-activity.js");
    const { execute } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");

    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    // The server's role enum has no approval roles, so these have nowhere to go.
    await agentActivity.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "allowance", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    // `wrap` is in the server's vocabulary but has no producer here yet.
    await agentActivity.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 1, eventRole: "wrap", kind: "wrap",
      protocol: "uniswap", chainId: 8453, walletAddress, sessionId,
    });
    const superseded = await agentActivity.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 2, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    // Test-only direct SQL: production reaches superseded_unproven through the
    // claim-fenced CAS; the scan only cares about the resulting status value.
    await execute(
      `UPDATE agent_activity SET status = 'superseded_unproven' WHERE id = $1`,
      [superseded.id],
    );

    // Exactly one: the superseded row. A row this install has CLOSED must be
    // reported, or the server holds its pending row open forever.
    expect(await repo.enqueueEligibleActivity(false)).toBe(1);
    const claimed = (await repo.claimDueOutbox(10)).events;
    expect(claimed).toHaveLength(1);
    expect(at(claimed, 0).activityId).toBe(superseded.id);
    expect(at(claimed, 0).status).toBe("superseded_unproven");
  });
});

describe("agentscan_outbox — claim-and-stamp lifecycle", () => {
  it("a claimed row leaves the candidate set until its backoff elapses", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);

    const first = (await repo.claimDueOutbox(10)).events;
    expect(first).toHaveLength(1);
    expect(at(first, 0).activity).not.toBeNull();

    const second = (await repo.claimDueOutbox(10)).events;
    expect(second).toHaveLength(0);
  });

  it("markOutboxSent terminalizes; rescheduleOutbox overrides the stamped backoff", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);

    const batch = await repo.claimDueOutbox(10);
    const generation = batch.registrationGeneration;
    expect(batch.events).toHaveLength(1);
    const outboxId = at(batch.events, 0).outboxId;

    // Retry-After override: due again once the (test-shortened) delay passes.
    expect(await repo.rescheduleOutbox([outboxId], 0, generation)).toEqual({ kind: "applied", rows: 1 });
    const reclaimed = (await repo.claimDueOutbox(10)).events;
    expect(reclaimed).toHaveLength(1);

    expect(await repo.markOutboxSent([outboxId], generation)).toEqual({ kind: "applied", rows: 1 });
    // Force-due everything: a sent row must STILL never be claimable.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    expect((await repo.claimDueOutbox(10)).events).toHaveLength(0);
  });

  it("markOutboxRejected terminalizes with a bounded error note", async () => {
    const { execute, queryOne } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);
    const batch = await repo.claimDueOutbox(10);
    const outboxId = at(batch.events, 0).outboxId;

    expect(
      await repo.markOutboxRejected(outboxId, "validation_failed", batch.registrationGeneration),
    ).toEqual({ kind: "applied", rows: 1 });
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    expect((await repo.claimDueOutbox(10)).events).toHaveLength(0);

    const row = await queryOne<{ last_error: string | null; rejected_at: Date | null }>(
      `SELECT last_error, rejected_at FROM agentscan_outbox WHERE id = $1`, [outboxId],
    );
    expect(row?.last_error).toBe("validation_failed");
    expect(row?.rejected_at).not.toBeNull();
  });
});

describe("agentscan_outbox — resetForReRegistration (auth_lost full resend)", () => {
  /**
   * CONTRACT CHANGE 2026-09-04 (Codex final review, round 1). This test used to
   * assert that an UNSENT row keeps `backfill = false` through the reset. That
   * expectation was the defect written down: the 401 that enters this path
   * arrives while a batch is in flight, so the rows that were being sent are
   * exactly the ones still `sent_at IS NULL` and still flagged as live activity.
   * Surviving the reset, they are drained later against a freshly-registered
   * identity and this install's HISTORY reaches the server labelled as activity
   * that just happened. The controlled backfill cannot correct it either -
   * `enqueueEligibleActivity` diffs on `(activity_id, status)` and those pairs
   * already have rows, so it inserts nothing.
   *
   * The rule now is: EVERY non-rejected row, sent or unsent, becomes owed again
   * as history. Poisoned rows stay poisoned.
   */
  it("resends every non-rejected row, SENT OR UNSENT, as backfill:true; rejected rows stay terminal", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const { execute, queryOne } = await import("@vex-agent/db/client.js");

    const sentActivityId = await seedEligibleSwap();
    const rejectedActivityId = await seedEligibleSwap();
    const unsentActivityId = await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);

    const batch = await repo.claimDueOutbox(10);
    const claimed = batch.events;
    expect(claimed).toHaveLength(3);
    function claimedFor(activityId: number) {
      const row = claimed.find((c) => c.activityId === activityId);
      if (!row) throw new Error(`expected a claimed row for activity ${activityId}`);
      return row;
    }
    const sentOutboxId = claimedFor(sentActivityId).outboxId;
    const rejectedOutboxId = claimedFor(rejectedActivityId).outboxId;
    const unsentOutboxId = claimedFor(unsentActivityId).outboxId;

    await repo.markOutboxSent([sentOutboxId], batch.registrationGeneration);
    await repo.markOutboxRejected(rejectedOutboxId, "validation_failed", batch.registrationGeneration);

    await repo.resetForReRegistration();

    const sentRow = await queryOne<{
      sent_at: Date | null;
      attempt_count: number;
      backfill: boolean;
      last_error: string | null;
    }>(
      `SELECT sent_at, attempt_count, backfill, last_error FROM agentscan_outbox WHERE id = $1`,
      [sentOutboxId],
    );
    expect(sentRow?.sent_at).toBeNull();
    expect(sentRow?.attempt_count).toBe(0);
    expect(sentRow?.backfill).toBe(true);
    expect(sentRow?.last_error).toBeNull();

    const rejectedRow = await queryOne<{ rejected_at: Date | null; sent_at: Date | null }>(
      `SELECT rejected_at, sent_at FROM agentscan_outbox WHERE id = $1`,
      [rejectedOutboxId],
    );
    expect(rejectedRow?.rejected_at).not.toBeNull();
    expect(rejectedRow?.sent_at).toBeNull();

    const unsentRow = await queryOne<{ sent_at: Date | null; rejected_at: Date | null; backfill: boolean }>(
      `SELECT sent_at, rejected_at, backfill FROM agentscan_outbox WHERE id = $1`,
      [unsentOutboxId],
    );
    expect(unsentRow?.sent_at).toBeNull();
    expect(unsentRow?.rejected_at).toBeNull();
    // The row this whole contract change exists for: in flight when the 401
    // landed, so it must be re-labelled history rather than kept as live.
    expect(unsentRow?.backfill).toBe(true);

    // Force-due everything: the resent row must be reclaimable as backfill;
    // the rejected row must stay out of the candidate set forever.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    const reclaimed = (await repo.claimDueOutbox(10)).events;
    const resent = reclaimed.find((c) => c.outboxId === sentOutboxId);
    if (!resent) throw new Error("expected the previously-sent row to be reclaimable");
    expect(resent.backfill).toBe(true);
    const reclaimedUnsent = reclaimed.find((c) => c.outboxId === unsentOutboxId);
    if (!reclaimedUnsent) throw new Error("expected the unsent row to be reclaimable");
    expect(reclaimedUnsent.backfill).toBe(true);
    expect(reclaimed.some((c) => c.outboxId === rejectedOutboxId)).toBe(false);
  });

  it("resetIdentityForRecovery shares the same full-resend outbox reset", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const { queryOne } = await import("@vex-agent/db/client.js");

    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);
    const batch = await repo.claimDueOutbox(10);
    const sentOutboxId = batch.events[0]?.outboxId;
    if (sentOutboxId === undefined) throw new Error("expected a claimed row");
    await repo.markOutboxSent([sentOutboxId], batch.registrationGeneration);

    await repo.resetIdentityForRecovery();

    const sentRow = await queryOne<{ sent_at: Date | null; backfill: boolean }>(
      `SELECT sent_at, backfill FROM agentscan_outbox WHERE id = $1`,
      [sentOutboxId],
    );
    expect(sentRow?.sent_at).toBeNull();
    expect(sentRow?.backfill).toBe(true);
  });

  it("state reset is a no-op when nothing was ever sent", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);
    await stampRegistered();

    await repo.resetForReRegistration();

    const state = await repo.getReportingState();
    expect(state.registeredAt).toBeNull();
    expect(state.agentHash).toBe(IDENTITY_A.agentHash);
  });

  it("resetIdentityForRecovery abandons the identity entirely (session/complete auth_lost recovery) -- registered_at, agent_hash, ingest_token all clear", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);
    await repo.markHandshakeComplete({
      agentName: "agent-x",
      ingestToken: IDENTITY_A.ingestToken,
      serverCursorRowId: 7,
      walletsFingerprint: "fp-1",
    });
    await repo.noteRegisterAttemptFailed(600);

    await repo.resetIdentityForRecovery();

    const state = await repo.getReportingState();
    expect(state.agentHash).toBeNull();
    expect(state.ingestToken).toBeNull();
    expect(state.agentName).toBeNull();
    expect(state.boundWalletsFingerprint).toBeNull();
    expect(state.registeredAt).toBeNull();
    expect(state.backfillEnqueuedAt).toBeNull();
    expect(state.lastHandshakeAt).toBeNull();
    expect(state.serverCursorRowId).toBeNull();
    expect(state.registerAttemptCount).toBe(0);
    expect(new Date(state.nextRegisterAttemptAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
