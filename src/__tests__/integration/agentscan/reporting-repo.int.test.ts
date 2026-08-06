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
 *   - ineligible rows (roles/kinds outside the contract, status
 *     `superseded_unproven`) are never enqueued;
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

  it("registration lifecycle: backoff failure → registered → cleared (401 recovery)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.ensureIdentity(() => IDENTITY_A);

    await repo.noteRegisterAttemptFailed(600);
    let state = await repo.getReportingState();
    expect(state.registerAttemptCount).toBe(1);
    expect(new Date(state.nextRegisterAttemptAt).getTime()).toBeGreaterThan(Date.now() + 500_000);

    await repo.markRegistered();
    state = await repo.getReportingState();
    expect(state.registeredAt).not.toBeNull();

    await repo.clearRegistration();
    state = await repo.getReportingState();
    expect(state.registeredAt).toBeNull();
    // identity survives a 401 recovery — only the registration stamp resets
    expect(state.agentHash).toBe(IDENTITY_A.agentHash);
  });

  it("markStopped + markBackfillEnqueued persist", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await repo.markBackfillEnqueued();
    await repo.markStopped("consent_revoked");
    const state = await repo.getReportingState();
    expect(state.backfillEnqueuedAt).not.toBeNull();
    expect(state.stoppedReason).toBe("consent_revoked");
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

    const claimed = await repo.claimDueOutbox(10);
    const statuses = claimed.map((c) => c.status).sort();
    expect(statuses).toEqual(["confirmed", "pending"]);
    expect(claimed.every((c) => c.activityId === activityId)).toBe(true);
  });

  it("stamps backfill=true only on rows enqueued by a backfill scan", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    expect(await repo.enqueueEligibleActivity(true)).toBe(1);
    const claimed = await repo.claimDueOutbox(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.backfill).toBe(true);
  });

  it("never enqueues contract-inexpressible rows: allowance role, wrap kind, superseded_unproven status", async () => {
    const agentActivity = await import("@vex-agent/db/repos/agent-activity.js");
    const { execute } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");

    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    await agentActivity.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "allowance", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
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

    expect(await repo.enqueueEligibleActivity(false)).toBe(0);
  });
});

describe("agentscan_outbox — claim-and-stamp lifecycle", () => {
  it("a claimed row leaves the candidate set until its backoff elapses", async () => {
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);

    const first = await repo.claimDueOutbox(10);
    expect(first).toHaveLength(1);
    expect(first[0]!.activity).not.toBeNull();

    const second = await repo.claimDueOutbox(10);
    expect(second).toHaveLength(0);
  });

  it("markOutboxSent terminalizes; rescheduleOutbox overrides the stamped backoff", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);

    const claimed = await repo.claimDueOutbox(10);
    expect(claimed).toHaveLength(1);
    const outboxId = claimed[0]!.outboxId;

    // Retry-After override: due again once the (test-shortened) delay passes.
    await repo.rescheduleOutbox([outboxId], 0);
    const reclaimed = await repo.claimDueOutbox(10);
    expect(reclaimed).toHaveLength(1);

    await repo.markOutboxSent([outboxId]);
    // Force-due everything: a sent row must STILL never be claimable.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    expect(await repo.claimDueOutbox(10)).toHaveLength(0);
  });

  it("markOutboxRejected terminalizes with a bounded error note", async () => {
    const { execute, queryOne } = await import("@vex-agent/db/client.js");
    const repo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    await repo.enqueueEligibleActivity(false);
    const claimed = await repo.claimDueOutbox(10);
    const outboxId = claimed[0]!.outboxId;

    await repo.markOutboxRejected(outboxId, "validation_failed");
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    expect(await repo.claimDueOutbox(10)).toHaveLength(0);

    const row = await queryOne<{ last_error: string | null; rejected_at: Date | null }>(
      `SELECT last_error, rejected_at FROM agentscan_outbox WHERE id = $1`, [outboxId],
    );
    expect(row?.last_error).toBe("validation_failed");
    expect(row?.rejected_at).not.toBeNull();
  });
});
