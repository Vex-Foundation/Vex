/**
 * STALLED VERIFICATION — migration 065's counter, produced (Wave P, Blocker 2).
 *
 * The defect: the verifier already minted precise reasons a check could not
 * conclude — `no_safe_rpc`, `receipt_unavailable`, `not_yet_confirmed` — and
 * dropped every one of them into a log. `verification_attempts` and
 * `last_verification_reason` existed in the schema, the app mapper derived
 * `stalledVerification` from them, and NOTHING ever wrote them. A pending row
 * that had been unverifiable for forty minutes was indistinguishable from one
 * broadcast a second ago, to the user AND to the agent.
 *
 * The invariants pinned here:
 *
 * 1. EVERY inconclusive exit records ONE attempt with a NAMED reason.
 * 2. A CONCLUSIVE observation RESETS the counter — the counter must measure a
 *    stall, not age, or a healthy slow bridge eventually lies about itself.
 * 3. NOTHING here terminalizes. The never-auto-fail policy is unchanged: an
 *    unverifiable row is UNKNOWN, and recording unknown as failed would report a
 *    possibly successful transfer of real funds as a failure.
 * 4. Only a code-authored reason may be stored — never raw provider text.
 */

import { describe, it, expect, vi } from "vitest";

import type {
  AgentActivityEvent,
  AgentActivityStatus,
  CasResult,
  MarkBridgeLegObservedResult,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  repairPendingBridges,
  type BridgeRepairDeps,
  type BridgeSweepRow,
} from "@vex-agent/sync/bridge-activity-repair.js";
import {
  toVerificationReason,
  VERIFICATION_REASONS,
} from "@vex-agent/sync/bridge-activity-repair-contracts.js";

const LOGICAL_ROW_ID = 4242;

function row(overrides: Partial<BridgeSweepRow> = {}): BridgeSweepRow {
  return {
    id: LOGICAL_ROW_ID,
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
    createdAt: "2026-08-03T09:00:00.000Z",
    lastVerificationReason: null,
    ...overrides,
  };
}

function cas(applied: boolean, status: AgentActivityStatus): CasResult {
  return { applied, row: { status } as AgentActivityEvent };
}

const observed: MarkBridgeLegObservedResult = { inserted: true, row: {} as AgentActivityEvent };

function makeDeps(overrides: Partial<BridgeRepairDeps> = {}): BridgeRepairDeps {
  return {
    listSweepCandidates: vi.fn().mockResolvedValue([row()]),
    listOrderIdRecoveryCandidates: vi.fn().mockResolvedValue([]),
    listConfirmedNeedingBalanceRefresh: vi.fn().mockResolvedValue([]),
    touchAttempt: vi.fn().mockResolvedValue(undefined),
    touchChecked: vi.fn().mockResolvedValue(undefined),
    noteVerificationInconclusive: vi.fn().mockResolvedValue(undefined),
    noteVerificationConclusive: vi.fn().mockResolvedValue(undefined),
    fetchKhalaniOrder: vi.fn().mockResolvedValue(null),
    fetchRelayStatus: vi.fn().mockResolvedValue(null),
    fetchDebridgeFillHash: vi.fn().mockResolvedValue(null),
    recoverKhalaniOrderId: vi.fn().mockResolvedValue(null),
    verifyFill: vi.fn().mockResolvedValue({ verified: true }),
    confirmExpectedFill: vi.fn().mockResolvedValue(cas(true, "confirmed")),
    failLogical: vi.fn().mockResolvedValue(cas(true, "definitively_failed")),
    appendFillObserved: vi.fn().mockResolvedValue(observed),
    appendRefundEvidence: vi.fn().mockResolvedValue(observed),
    attachOrderId: vi.fn(),
    enqueueBalanceRefresh: vi.fn().mockResolvedValue(undefined),
    clearRelayReveal: vi.fn(),
    ...overrides,
  };
}

/** A Khalani order the correlation accepts, in whatever state the case needs. */
function khalaniOrder(status: string, transactions: Record<string, unknown> = {}) {
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
    transactions,
  };
}

describe("the reason bound", () => {
  it("admits only code-authored reason codes", () => {
    expect(toVerificationReason("no_safe_rpc")).toBe("no_safe_rpc");
    expect(toVerificationReason("receipt_unavailable")).toBe("receipt_unavailable");
  });

  it("refuses anything it did not author — raw provider text never reaches the column", () => {
    // The column is surfaced to the UI and the agent verbatim; bounding it by
    // NAME rather than by length is what keeps someone else's string out.
    expect(toVerificationReason("https://provider.example/v1?key=SECRET")).toBe(
      "verification_failed",
    );
    expect(toVerificationReason(undefined)).toBe("verification_failed");
    expect(VERIFICATION_REASONS).not.toContain("verification stalled");
  });
});

describe("inconclusive exits record a named attempt", () => {
  it("a transport failure records provider_unreachable and terminalizes nothing", async () => {
    const deps = makeDeps({ fetchKhalaniOrder: vi.fn().mockResolvedValue(null) });

    const result = await repairPendingBridges(deps);

    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(
      LOGICAL_ROW_ID,
      "provider_unreachable",
    );
    expect(deps.failLogical).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("a FAILED on-chain verification records the VERIFIER's own reason", async () => {
    const deps = makeDeps({
      fetchKhalaniOrder: vi
        .fn()
        .mockResolvedValue(khalaniOrder("filled", { fill: { txHash: "0xfill", chainId: 42161 } })),
      verifyFill: vi.fn().mockResolvedValue({ verified: false, reason: "no_safe_rpc" }),
    });

    const result = await repairPendingBridges(deps);

    // `no_safe_rpc` means the outcome is UNKNOWN — the single most important
    // reason never to convert this counter into a failure.
    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(LOGICAL_ROW_ID, "no_safe_rpc");
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(deps.failLogical).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("a filled-without-hash order records filled_without_hash and never confirms", async () => {
    const deps = makeDeps({
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("filled", {})),
    });

    const result = await repairPendingBridges(deps);

    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(
      LOGICAL_ROW_ID,
      "filled_without_hash",
    );
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(0);
  });

  it("a row with no stored route records missing_route", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ fromChainId: null })]),
    });

    await repairPendingBridges(deps);

    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(LOGICAL_ROW_ID, "missing_route");
  });

  it("a chain-id mismatch records chain_mismatch", async () => {
    const deps = makeDeps({
      fetchKhalaniOrder: vi
        .fn()
        .mockResolvedValue(khalaniOrder("filled", { fill: { txHash: "0xfill", chainId: 999 } })),
    });

    await repairPendingBridges(deps);

    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(LOGICAL_ROW_ID, "chain_mismatch");
  });

  it("a correlation mismatch records correlation_mismatch", async () => {
    const order = { ...khalaniOrder("filled", { fill: { txHash: "0xfill", chainId: 42161 } }), author: "0xIMPOSTER" };
    const deps = makeDeps({ fetchKhalaniOrder: vi.fn().mockResolvedValue(order) });

    await repairPendingBridges(deps);

    expect(deps.noteVerificationInconclusive).toHaveBeenCalledWith(
      LOGICAL_ROW_ID,
      "correlation_mismatch",
    );
  });
});

describe("a conclusive observation resets the counter", () => {
  it("a provider-pending status clears the stall instead of accumulating it", async () => {
    const deps = makeDeps({
      fetchKhalaniOrder: vi.fn().mockResolvedValue(khalaniOrder("pending")),
    });

    const result = await repairPendingBridges(deps);

    // The provider ANSWERED — the row is legitimately in flight. An ordinary
    // slow-but-healthy bridge must never accumulate its way into "stalled".
    expect(deps.noteVerificationConclusive).toHaveBeenCalledWith(LOGICAL_ROW_ID);
    expect(deps.noteVerificationInconclusive).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });
});
