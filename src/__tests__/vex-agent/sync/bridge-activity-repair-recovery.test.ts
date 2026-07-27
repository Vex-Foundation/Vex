import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import logger from "@utils/logger.js";
import type {
  AgentActivityEvent,
  AgentActivityStatus,
  AttachProviderOrderIdOutcome,
  AttachProviderOrderIdResult,
  CasResult,
  MarkBridgeLegObservedResult,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  repairPendingBridges,
  type BridgeRepairDeps,
  type BridgeSweepRow,
  type KhalaniOrderView,
} from "@vex-agent/sync/bridge-activity-repair.js";

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
    // F2: recovery never reaches the DeBridge fill-hash lane; default to a refusal.
    fetchDebridgeFillHash: vi.fn().mockResolvedValue(null),
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

const khalaniFilled = (txHash = "0xfill") =>
  khalaniOrder("filled", { transactions: { fill: { txHash, chainId: 42161 } } });

describe("repairPendingBridges — orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

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
    const call = warnSpy.mock.calls.find((args) => String(Array.from(args)[0]) === "bridge.repair.order_recovery_failed");
    expect(call).toBeDefined();
    const [, metadata] = call === undefined ? [] : Array.from(call);
    expect(isRecord(metadata)).toBe(true);
    if (isRecord(metadata)) expect(String(metadata.error)).not.toContain("user:pw");
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
    expect(warnSpy.mock.calls.some((args) => String(Array.from(args)[0]) === "bridge.repair.unknown_protocol")).toBe(true);
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
    const call = warnSpy.mock.calls.find((args) => String(Array.from(args)[0]) === "bridge.repair.refund_evidence_failed");
    const [, metadata] = call === undefined ? [] : Array.from(call);
    expect(isRecord(metadata)).toBe(true);
    if (isRecord(metadata)) expect(String(metadata.error)).not.toContain("LEAK_TOKEN_123");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
