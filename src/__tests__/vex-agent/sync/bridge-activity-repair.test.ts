/**
 * bridge-activity-repair — sweep ORCHESTRATION (mocked-dep unit suite, Phase-1
 * repair-test style). Every branch of `repairPendingBridges` over an injected
 * `BridgeRepairDeps`: status reactions, R6 correlation gating (Blocker 7),
 * attempt-vs-observation timestamps (B6), fair scheduling, null-order-id recovery
 * (R5), the B4 verification gate, multi-fill append (Blocker 9), the
 * verify-then-write-then-terminalize refund path (Blocker 8), the C3
 * confirm+enqueue side-effect ordering + recovery (Blocker 11), and the B5
 * reveal-clear (relay-only, verified-only).
 *
 * Pure helpers (status mapping, correlation, SSRF matrix, fairness comparator)
 * are pinned separately in `bridge-activity-repair-verification.test.ts`; the
 * production SQL deps are pinned in the real-Postgres
 * `integration/agent-scan/bridge-sweep.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import logger from "@utils/logger.js";
import type {
  AgentActivityEvent,
  AgentActivityStatus,
  CasResult,
  MarkBridgeLegObservedResult,
  AttachProviderOrderIdResult,
  AttachProviderOrderIdOutcome,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  repairPendingBridges,
  type BridgeRepairDeps,
  type BridgeSweepRow,
  type KhalaniOrderView,
  type RelayStatusView,
} from "@vex-agent/sync/bridge-activity-repair.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function row(overrides: Partial<BridgeSweepRow> = {}): BridgeSweepRow {
  return {
    id: 1,
    protocolExecutionId: 100,
    protocol: "khalani",
    providerOrderId: "order-1",
    fromChainId: 8453,
    toChainId: 42161,
    destChainFamily: "eip155",
    tokenInAddress: "0xsrctoken",
    tokenOutAddress: "0xdesttoken",
    walletAddress: "0xwallet",
    depositTxHash: "0xdeposit",
    quoteId: "Q-1",
    routeId: "R-1",
    sessionId: "sess-1",
    normalizedRoute: "eip155:8453:0xa->eip155:42161:0xb",
    lastAttemptedAt: null,
    createdAt: "2026-07-23T09:00:00.000Z",
    ...overrides,
  };
}

function cas(applied: boolean, status: AgentActivityStatus): CasResult {
  return { applied, row: { status } as AgentActivityEvent };
}

function attach(outcome: AttachProviderOrderIdOutcome): AttachProviderOrderIdResult {
  return { outcome, row: null };
}

const observed: MarkBridgeLegObservedResult = { inserted: true, row: {} as AgentActivityEvent };

function makeDeps(overrides: Partial<BridgeRepairDeps> = {}): BridgeRepairDeps {
  return {
    listSweepCandidates: vi.fn().mockResolvedValue([]),
    listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([]),
    listConfirmedNeedingBalanceRefresh: vi.fn().mockResolvedValue([]),
    touchAttempt: vi.fn().mockResolvedValue(undefined),
    touchChecked: vi.fn().mockResolvedValue(undefined),
    fetchKhalaniOrder: vi.fn().mockResolvedValue(null),
    fetchRelayStatus: vi.fn().mockResolvedValue(null),
    recoverKhalaniOrderId: vi.fn().mockResolvedValue(null),
    verifyFill: vi.fn().mockResolvedValue({ verified: true }),
    confirmExpectedFill: vi.fn().mockResolvedValue(cas(true, "confirmed")),
    failLogical: vi.fn().mockResolvedValue(cas(true, "definitively_failed")),
    appendFillObserved: vi.fn().mockResolvedValue(observed),
    appendRefundEvidence: vi.fn().mockResolvedValue(observed),
    attachOrderId: vi.fn().mockResolvedValue(attach("attached")),
    enqueueBalanceRefresh: vi.fn().mockResolvedValue(undefined),
    clearRelayReveal: vi.fn(),
    ...overrides,
  };
}

function khalaniOrder(status: string, overrides: Partial<KhalaniOrderView> = {}): KhalaniOrderView {
  return {
    id: "order-1",
    status,
    fromChainId: 8453,
    toChainId: 42161,
    quoteId: "Q-1",
    routeId: "R-1",
    fromToken: "0xsrctoken",
    toToken: "0xdesttoken",
    author: "0xwallet",
    depositTxHash: "0xdeposit",
    transactions: {},
    ...overrides,
  };
}

function relayStatus(status: string, overrides: Partial<RelayStatusView> = {}): RelayStatusView {
  return { status, originChainId: 8453, destinationChainId: 42161, inTxHashes: ["0xdeposit"], ...overrides };
}

const khalaniFilled = (txHash = "0xfill") =>
  khalaniOrder("filled", { transactions: { fill: { txHash, chainId: 42161 } } });

describe("repairPendingBridges — orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Timestamps (B6) ────────────────────────────────────────────────────────

  it("touches last_attempted_at on a transport failure but NOT last_checked_at (B6)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(null), // transport failure
    });
    const result = await repairPendingBridges(deps);
    expect(deps.touchAttempt).toHaveBeenCalledWith(100);
    expect(deps.touchChecked).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("touches last_checked_at with the provider status on a SUCCESSFUL observation (B6)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("published")),
    });
    await repairPendingBridges(deps);
    expect(deps.touchAttempt).toHaveBeenCalledWith(100);
    expect(deps.touchChecked).toHaveBeenCalledWith(100, "published");
  });

  // ── Fair scheduling ─────────────────────────────────────────────────────────

  it("processes candidates least-recently-touched first (never-attempted before recently-attempted)", async () => {
    const recentlyAttempted = row({
      id: 1,
      protocolExecutionId: 10,
      lastAttemptedAt: "2026-07-23T10:00:00.000Z",
      createdAt: "2026-07-23T08:00:00.000Z",
    });
    const neverAttempted = row({
      id: 2,
      protocolExecutionId: 20,
      lastAttemptedAt: null,
      createdAt: "2026-07-23T09:00:00.000Z",
    });
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([recentlyAttempted, neverAttempted]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("published")),
    });
    await repairPendingBridges(deps);
    const attemptOrder = (deps.touchAttempt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(attemptOrder).toEqual([20, 10]);
  });

  // ── pending stays pending, never terminalized ───────────────────────────────

  it("a non-terminal provider status leaves the row pending and terminalizes nothing", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("refund_pending")),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(deps.failLogical).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  // ── R6 correlation gate (Blocker 7) ──────────────────────────────────────────

  it("a correlation mismatch keeps the row pending, terminalizes nothing, and logs the field name only", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      // Same order id but a DIFFERENT author — a mismatched settlement identity.
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("filled", { author: "0xEvil", transactions: { fill: { txHash: "0xfill", chainId: 42161 } } })),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(deps.verifyFill).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    const call = warnSpy.mock.calls.find((c) => c[0] === "bridge.repair.correlation_mismatch");
    expect(call).toBeDefined();
    expect((call?.[1] as Record<string, unknown>)?.field).toBe("author");
    warnSpy.mockRestore();
  });

  // ── B4 verification gate ─────────────────────────────────────────────────────

  it("confirms only AFTER independent verification passes; enqueues balance + no reveal-clear (khalani)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
      verifyFill: vi.fn().mockResolvedValue({ verified: true }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.verifyFill).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xfill", expectedChainId: 42161, chainFamily: "eip155", protocol: "khalani", recipient: null }),
    );
    expect(deps.confirmExpectedFill).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 100, txHash: "0xfill", evidenceSource: "khalani_order_status", providerStatus: "filled" }),
    );
    expect(deps.enqueueBalanceRefresh).toHaveBeenCalledWith({ namespace: "khalani", executionId: 100 });
    expect(deps.clearRelayReveal).not.toHaveBeenCalled(); // khalani never clears a relay reveal
    expect(result.confirmed).toBe(1);
  });

  it("NEVER substitutes the source wallet as the destination recipient (recipient passed as null — Blocker 7)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
    });
    await repairPendingBridges(deps);
    const call = (deps.verifyFill as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.recipient).toBeNull();
    expect(call.recipient).not.toBe("0xwallet");
  });

  it("a FAILED B4 check keeps the row pending and never confirms (provider word alone is not enough)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
      verifyFill: vi.fn().mockResolvedValue({ verified: false, reason: "receipt_unavailable" }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(deps.enqueueBalanceRefresh).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("passes decoded executed amounts through to the confirm ONLY when the verifier supplies them (Q2)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
      verifyFill: vi.fn().mockResolvedValue({ verified: true, executedAmountOutHuman: "1.5", executedAmountOutRaw: "1500000" }),
    });
    await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).toHaveBeenCalledWith(
      expect.objectContaining({ executedAmountOutHuman: "1.5", executedAmountOutRaw: "1500000" }),
    );
  });

  // ── Multi-fill append (Blocker 9) ────────────────────────────────────────────

  it("the FIRST verified fill confirms; every ADDITIONAL verified hash becomes a bridge_fill_observed row", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("success", { txHashes: ["0xprimary", "0xextra1", "0xextra2"] })),
      verifyFill: vi.fn().mockResolvedValue({ verified: true }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xprimary" }));
    expect(deps.appendFillObserved).toHaveBeenCalledTimes(2);
    expect(deps.appendFillObserved).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xextra1", evidenceSource: "relay_intent_status" }));
    expect(deps.appendFillObserved).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xextra2" }));
    expect(result.confirmed).toBe(1);
  });

  it("an UNVERIFIED additional fill is skipped (never appended unverified), the confirm still stands", async () => {
    const verifyFill = vi
      .fn()
      .mockResolvedValueOnce({ verified: true }) // primary
      .mockResolvedValueOnce({ verified: false, reason: "not_yet_confirmed" }); // extra
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("success", { txHashes: ["0xprimary", "0xextra"] })),
      verifyFill,
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).toHaveBeenCalledTimes(1);
    expect(deps.appendFillObserved).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(1);
  });

  // ── filled-without-hash anomaly (dossier §5) ─────────────────────────────────

  it("'filled' WITHOUT a fill hash stays pending + logs an anomaly, never fabricates a confirmation", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("filled")), // no transactions.fill
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(warnSpy.mock.calls.some((c) => c[0] === "bridge.repair.filled_without_hash")).toBe(true);
    warnSpy.mockRestore();
  });

  it("a chain-id mismatch stays pending + logs an anomaly", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("filled", { toChainId: 999, transactions: { fill: { txHash: "0xx", chainId: 999 } } })),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(warnSpy.mock.calls.some((c) => c[0] === "bridge.repair.chain_id_mismatch")).toBe(true);
    warnSpy.mockRestore();
  });

  // ── Reveal clear (B5): relay + verified confirm ONLY, cleared BEFORE enqueue ──

  it("clears the relay route reveal on a VERIFIED relay confirm, BEFORE the balance enqueue (B5 + C3 ordering)", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("success", { txHashes: ["0xdest"] })),
      verifyFill: vi.fn().mockResolvedValue({ verified: true }),
      clearRelayReveal: vi.fn().mockImplementation(() => callOrder.push("reveal")),
      enqueueBalanceRefresh: vi.fn().mockImplementation(async () => {
        callOrder.push("enqueue");
      }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.confirmExpectedFill).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceSource: "relay_intent_status", txHash: "0xdest" }),
    );
    expect(deps.clearRelayReveal).toHaveBeenCalledWith("sess-1", "eip155:8453:0xa->eip155:42161:0xb");
    expect(callOrder).toEqual(["reveal", "enqueue"]); // reveal cleared before enqueue (Blocker 11)
    expect(result.confirmed).toBe(1);
  });

  it("does NOT clear the reveal when the relay confirm CAS did not apply (already confirmed elsewhere)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("success", { txHashes: ["0xdest"] })),
      confirmExpectedFill: vi.fn().mockResolvedValue(cas(false, "confirmed")),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.clearRelayReveal).not.toHaveBeenCalled();
    expect(deps.enqueueBalanceRefresh).not.toHaveBeenCalled(); // no double enqueue on a duplicate CAS
    expect(result.confirmed).toBe(0);
  });

  it("does NOT clear the reveal on a relay non-terminal / refund / failure", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("refund")),
    });
    await repairPendingBridges(deps);
    expect(deps.clearRelayReveal).not.toHaveBeenCalled();
  });

  // ── Refund evidence: verify → write → terminalize (Blocker 8) ─────────────────

  it("a refund VERIFIES the refund hash, appends the evidence row, THEN terminalizes bridge_refunded", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("refunded", { transactions: { refund: { txHash: "0xrefund", chainId: 8453 } } })),
      verifyFill: vi.fn().mockResolvedValue({ verified: true }),
      appendRefundEvidence: vi.fn().mockImplementation(async () => {
        callOrder.push("evidence");
        return observed;
      }),
      failLogical: vi.fn().mockImplementation(async () => {
        callOrder.push("fail");
        return cas(true, "definitively_failed");
      }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.verifyFill).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xrefund", expectedChainId: 8453, protocol: "khalani" }),
    );
    expect(callOrder).toEqual(["evidence", "fail"]);
    expect(deps.appendRefundEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xrefund", chainId: 8453, evidenceSource: "khalani_order_status" }),
    );
    expect(deps.failLogical).toHaveBeenCalledWith(1, "bridge_refunded", expect.stringContaining("refund"));
    expect(result.failed).toBe(1);
    expect(result.refunded).toBe(1);
  });

  it("an UNVERIFIABLE refund hash keeps the WHOLE row pending — no evidence write, no terminalization (Blocker 8)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("refunded", { transactions: { refund: { txHash: "0xrefund", chainId: 8453 } } })),
      verifyFill: vi.fn().mockResolvedValue({ verified: false, reason: "not_yet_confirmed" }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.appendRefundEvidence).not.toHaveBeenCalled();
    expect(deps.failLogical).not.toHaveBeenCalled();
    expect(result.refunded).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("a relay refund with NO hash still terminalizes bridge_refunded WITHOUT an evidence row (named gap)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", providerOrderId: "req-1" })]),
      fetchRelayStatus: vi.fn().mockResolvedValue(relayStatus("refund")),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.verifyFill).not.toHaveBeenCalled(); // no hash → nothing to verify
    expect(deps.appendRefundEvidence).not.toHaveBeenCalled();
    expect(deps.failLogical).toHaveBeenCalledWith(1, "bridge_refunded", expect.any(String));
    expect(result.refunded).toBe(1);
  });

  it("a provider-terminal failure terminalizes bridge_failed with no evidence row", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("failed")),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.appendRefundEvidence).not.toHaveBeenCalled();
    expect(deps.failLogical).toHaveBeenCalledWith(1, "bridge_failed", expect.any(String));
    expect(result.failed).toBe(1);
    expect(result.refunded).toBe(0);
  });

  // ── Null-order-id recovery (R5) ──────────────────────────────────────────────

  it("recovers a missing order id via deposit-hash match and attaches it", async () => {
    const deps = makeDeps({
      listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([
        { executionId: 200, protocol: "khalani", walletAddress: "0xw", depositTxHash: "0xdep", fromChainId: 8453, toChainId: 42161 },
      ]),
      recoverKhalaniOrderId: vi.fn().mockResolvedValue("order-recovered"),
      attachOrderId: vi.fn().mockResolvedValue(attach("attached")),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.touchAttempt).toHaveBeenCalledWith(200);
    expect(deps.attachOrderId).toHaveBeenCalledWith({ executionId: 200, providerOrderId: "order-recovered" });
    expect(deps.touchChecked).toHaveBeenCalledWith(200, "order_recovered:attached");
    expect(result.recovered).toBe(1);
  });

  it("treats an already-attached-same order id as a successful recovery (DuplicateRecord path)", async () => {
    const deps = makeDeps({
      listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([
        { executionId: 200, protocol: "khalani", walletAddress: "0xw", depositTxHash: "0xdep", fromChainId: 8453, toChainId: 42161 },
      ]),
      recoverKhalaniOrderId: vi.fn().mockResolvedValue("order-existing"),
      attachOrderId: vi.fn().mockResolvedValue(attach("already_attached_same")),
    });
    const result = await repairPendingBridges(deps);
    expect(result.recovered).toBe(1);
    expect(result.stillPending).toBe(0);
  });

  it("no order found yet → attempt touched, stays pending, no attach", async () => {
    const deps = makeDeps({
      listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([
        { executionId: 200, protocol: "khalani", walletAddress: "0xw", depositTxHash: "0xdep", fromChainId: 8453, toChainId: 42161 },
      ]),
      recoverKhalaniOrderId: vi.fn().mockResolvedValue(null),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.touchAttempt).toHaveBeenCalledWith(200);
    expect(deps.attachOrderId).not.toHaveBeenCalled();
    expect(result.recovered).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("a conflicting attach outcome does NOT count as recovery", async () => {
    const deps = makeDeps({
      listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([
        { executionId: 200, protocol: "khalani", walletAddress: "0xw", depositTxHash: "0xdep", fromChainId: 8453, toChainId: 42161 },
      ]),
      recoverKhalaniOrderId: vi.fn().mockResolvedValue("order-x"),
      attachOrderId: vi.fn().mockResolvedValue(attach("conflict_different_id")),
    });
    const result = await repairPendingBridges(deps);
    expect(result.recovered).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("a recovery lookup throw is scrubbed and leaves the row pending", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([
        { executionId: 200, protocol: "khalani", walletAddress: "0xw", depositTxHash: "0xdep", fromChainId: 8453, toChainId: 42161 },
      ]),
      recoverKhalaniOrderId: vi.fn().mockRejectedValue(new Error("boom https://user:pw@rpc.example")),
    });
    const result = await repairPendingBridges(deps);
    const call = warnSpy.mock.calls.find((c) => c[0] === "bridge.repair.order_recovery_failed");
    expect(call).toBeDefined();
    expect(String((call?.[1] as Record<string, unknown>)?.error)).not.toContain("user:pw");
    expect(result.stillPending).toBe(1);
    warnSpy.mockRestore();
  });

  // ── C3 confirm+enqueue recovery path (CHOICE = explicit recovery, not one tx) ─

  it("reconciles confirmed-but-unenqueued rows by idempotently enqueuing the balance job, re-clearing a relay reveal (C3 recovery)", async () => {
    const deps = makeDeps({
      listConfirmedNeedingBalanceRefresh: vi.fn().mockResolvedValue([
        { executionId: 300, protocol: "relay", sessionId: "sess-r", normalizedRoute: "route-r" },
        { executionId: 301, protocol: "khalani", sessionId: "sess-k", normalizedRoute: "route-k" },
      ]),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.enqueueBalanceRefresh).toHaveBeenCalledWith({ namespace: "relay", executionId: 300 });
    expect(deps.enqueueBalanceRefresh).toHaveBeenCalledWith({ namespace: "khalani", executionId: 301 });
    // Recovery re-clears the stranded relay reveal (Blocker 11) — khalani never does.
    expect(deps.clearRelayReveal).toHaveBeenCalledWith("sess-r", "route-r");
    expect(deps.clearRelayReveal).not.toHaveBeenCalledWith("sess-k", "route-k");
    expect(result.balanceReconciled).toBe(2);
  });

  it("idempotent re-run: once confirmed, a second sweep neither re-confirms nor re-enqueues from the confirm path", async () => {
    // First run: pending → confirmed (enqueue once). Second run: the CAS is a
    // no-op (already confirmed) AND the reconcile list is empty (already enqueued).
    const firstRunDeps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
    });
    await repairPendingBridges(firstRunDeps);
    expect(firstRunDeps.enqueueBalanceRefresh).toHaveBeenCalledTimes(1);

    const secondRunDeps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniFilled()),
      confirmExpectedFill: vi.fn().mockResolvedValue(cas(false, "confirmed")), // already confirmed
      listConfirmedNeedingBalanceRefresh: vi.fn().mockResolvedValue([]), // already enqueued
    });
    const secondResult = await repairPendingBridges(secondRunDeps);
    expect(secondRunDeps.enqueueBalanceRefresh).not.toHaveBeenCalled();
    expect(secondResult.confirmed).toBe(0);
  });

  // ── Duplicate CAS + counters ─────────────────────────────────────────────────

  it("counts nothing and does not throw when every queue is empty", async () => {
    const result = await repairPendingBridges(makeDeps());
    expect(result).toEqual({
      checked: 0,
      confirmed: 0,
      failed: 0,
      refunded: 0,
      recovered: 0,
      balanceReconciled: 0,
      stillPending: 0,
    });
  });

  it("an unknown provider on a candidate is treated as a transport miss (no terminalization)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "mystery" })]),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.fetchKhalaniOrder).not.toHaveBeenCalled();
    expect(deps.fetchRelayStatus).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(warnSpy.mock.calls.some((c) => c[0] === "bridge.repair.unknown_protocol")).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("repairPendingBridges — error text scrubbing", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
  });
  afterEach(() => warnSpy.mockRestore());

  it("a refund-evidence append failure is scrubbed and KEEPS the row pending (no terminalization — Blocker 8)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("refunded", { transactions: { refund: { txHash: "0xrefund", chainId: 8453 } } })),
      verifyFill: vi.fn().mockResolvedValue({ verified: true }),
      appendRefundEvidence: vi.fn().mockRejectedValue(new Error("Authorization: Bearer LEAK_TOKEN_123")),
    });
    const result = await repairPendingBridges(deps);
    // The evidence-write failure must NOT terminalize — the row stays pending for
    // the next sweep, so the known refund hash is never permanently lost.
    expect(deps.failLogical).not.toHaveBeenCalled();
    expect(result.refunded).toBe(0);
    expect(result.stillPending).toBe(1);
    const call = warnSpy.mock.calls.find((c) => c[0] === "bridge.repair.refund_evidence_failed");
    expect(String((call?.[1] as Record<string, unknown>)?.error)).not.toContain("LEAK_TOKEN_123");
  });
});
