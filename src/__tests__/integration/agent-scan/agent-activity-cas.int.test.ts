/**
 * `agent_activity` CAS transitions (plan §4.1 + §11.1; hardened by Codex
 * spine-review round 1 — see `agents_dm/codex-review-spine-round1.md` findings
 * 3 and 6, bound in `agents_dm/agent-scan-factory.md` "Coordinator addendum 1"
 * as C6/C7/C8).
 *
 * FIX-W0 delta (this revision):
 *   - C13: every test seeds a REAL `protocol_executions` row via
 *     `_fixtures.ts#seedIntent` (satisfies the FK `agent_activity` needs) —
 *     no more hardcoded orphan `protocolExecutionId` literals. `afterEach`
 *     cleans up every row this file created.
 *   - C7: `confirmActivityEvent`/`failActivityEvent` now return
 *     `{ applied: boolean, row }`, NOT the row directly. A missed CAS (the
 *     row was already terminal, or a precondition failed) is `applied:false`
 *     with the row UNCHANGED — distinguishable from a genuinely applied
 *     transition, so two concurrent finalizers can never both believe they
 *     finalized the same event.
 *   - C6/C8 (finding 3's test half): confirming a swap-role event that never
 *     had a `tx_hash` persisted (no prior `markActivityBroadcast`) must be
 *     REJECTED — a confirmed swap event requires `tx_hash` + executed raw
 *     legs. This suite now asserts the REJECTION (`applied:false` or a thrown
 *     constraint error), not acceptance of a hashless confirm.
 *
 * Contract pinned here:
 *   - a freshly created event row starts `pending`;
 *   - `pending -> confirmed` (with a hash staged first) succeeds exactly once,
 *     stamps `confirmedAt` + the receipt-derived executed legs, and returns
 *     `applied:true`;
 *   - a hashless confirm attempt is REJECTED (C6/C8) — the row never becomes
 *     `confirmed` without a persisted `tx_hash` + executed legs;
 *   - `pending -> definitively_failed` succeeds exactly once and stamps
 *     `failureCode` + `failureReason`, returning `applied:true`;
 *   - a terminal row (`confirmed` or `definitively_failed`) is IMMUTABLE — a
 *     second finalize call (either transition) returns `applied:false` with
 *     the row's CURRENT (unchanged) terminal state, never re-stamping or
 *     silently overwriting it;
 *   - a confirmation-timeout receipt-guard outcome (an ambiguous/thrown
 *     receipt wait) leaves the row `pending` — nothing in this suite ever
 *     calls confirm/fail in response to that class of outcome.
 */
import { afterEach, describe, it, expect } from "vitest";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

describe("agent_activity — CAS transitions", () => {
  it("a freshly created event row is 'pending' and carries no terminal fields", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
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
    });
    expect(event.status).toBe("pending");
    expect(event.failureCode).toBeNull();
    expect(event.confirmedAt).toBeNull();
    expect(event.txHash).toBeNull();
  });

  it("a hashless confirm is REJECTED (C6/C8) — a swap-role event needs tx_hash + executed raw legs first", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    // Deliberately NO markActivityBroadcast call — tx_hash stays NULL.
    const outcome = await repo
      .confirmActivityEvent(event.id, { executedAmountInRaw: "1", executedAmountOutRaw: "1" })
      .catch((err: unknown) => err);

    if (outcome instanceof Error) {
      expect(outcome.message).not.toBe("");
    } else {
      expect(outcome.applied).toBe(false);
      expect(outcome.row.status).not.toBe("confirmed");
    }
    const persisted = await repo.getActivityEventById(event.id);
    expect(persisted?.status).not.toBe("confirmed");
    expect(persisted?.txHash).toBeNull();
  });

  it("pending -> confirmed (with a staged hash) stamps confirmedAt + executed legs, applied:true, exactly once", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });

    const first = await repo.confirmActivityEvent(event.id, {
      executedAmountInRaw: "1000000000000000000",
      executedAmountOutRaw: "2000000",
    });
    expect(first.applied).toBe(true);
    expect(first.row.status).toBe("confirmed");
    expect(first.row.confirmedAt).not.toBeNull();
    expect(first.row.txHash).toBe("0xHASH");

    // A second confirm attempt on the SAME terminal row is a detectable
    // duplicate CAS (C7) — applied:false, row UNCHANGED (original amounts).
    const second = await repo.confirmActivityEvent(event.id, {
      executedAmountInRaw: "999", executedAmountOutRaw: "999",
    });
    expect(second.applied).toBe(false);
    expect(second.row.status).toBe("confirmed");
    expect(second.row.executedAmountInRaw).toBe("1000000000000000000");
  });

  it("pending -> definitively_failed stamps failureCode + failureReason, applied:true, exactly once", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const outcome = await repo.failActivityEvent(event.id, {
      failureCode: "simulation_reverted",
      failureReason: "reason unavailable",
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.row.status).toBe("definitively_failed");
    expect(outcome.row.failureCode).toBe("simulation_reverted");
  });

  it("a terminal row is immutable: confirmed cannot flip to definitively_failed (applied:false, unchanged)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    const confirmed = await repo.confirmActivityEvent(event.id, {
      executedAmountInRaw: "1", executedAmountOutRaw: "1",
    });
    expect(confirmed.applied).toBe(true);

    const flipAttempt = await repo.failActivityEvent(event.id, {
      failureCode: "unknown", failureReason: "should never apply",
    });
    expect(flipAttempt.applied).toBe(false);
    expect(flipAttempt.row.status).toBe("confirmed");
    expect(flipAttempt.row.failureCode).toBeNull();

    const stillConfirmed = await repo.getActivityEventById(event.id);
    expect(stillConfirmed?.status).toBe("confirmed");
    expect(stillConfirmed?.failureCode).toBeNull();
  });

  it("a terminal row is immutable: definitively_failed cannot flip to confirmed (applied:false, unchanged)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const failed = await repo.failActivityEvent(event.id, {
      failureCode: "route_not_found", failureReason: "no route",
    });
    expect(failed.applied).toBe(true);

    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    const flipAttempt = await repo.confirmActivityEvent(event.id, {
      executedAmountInRaw: "1", executedAmountOutRaw: "1",
    });
    expect(flipAttempt.applied).toBe(false);
    expect(flipAttempt.row.status).toBe("definitively_failed");

    const stillFailed = await repo.getActivityEventById(event.id);
    expect(stillFailed?.status).toBe("definitively_failed");
    expect(stillFailed?.failureCode).toBe("route_not_found");
  });

  it("an ambiguous confirmation outcome (receipt-guard.ts:29-37 semantics) keeps the row 'pending' — confirm/fail are never called", async () => {
    // Mirrors src/tools/evm-chains/receipt-guard.ts:29-37: a broadcast whose
    // confirmation could not be determined must never be recorded as a
    // terminal outcome — it may still settle on-chain. This suite does not
    // call confirmActivityEvent/failActivityEvent in response to that class
    // of outcome; the repair sweep (repair-sweep.test.ts) is the only path
    // that may later finalize it, and only from a definitive receipt (C1).
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    const stillPending = await repo.getActivityEventById(event.id);
    expect(stillPending?.status).toBe("pending");
  });
});
