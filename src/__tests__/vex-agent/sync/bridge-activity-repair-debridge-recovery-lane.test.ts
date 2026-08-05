/**
 * bridge-activity-repair — the DeBridge fill-hash RECOVERY LANE (Card F2): the
 * mapper's `filled_no_hash` recovery payload and the sweep's use of it.
 *
 * A Khalani order routed through DeBridge reports `filled` with no fill hash at
 * all. Instead of leaving those rows pending forever, the sweep asks deBridge's
 * stats API for the destination hash — but ONLY for DeBridge-routed orders, and
 * the recovered hash is then fed through the UNCHANGED B4 path: independent
 * on-chain verification still gates every confirm. A recovery that returns
 * nothing leaves the row exactly as it was: pending, with the anomaly logged.
 *
 * Order shapes are the live 2026-07-26 captures (executions 191/216/229 for the
 * DeBridge lane, 232 for the Hyperstream control); identities are substituted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  mapKhalaniOrderOutcome,
  repairPendingBridges,
  type BridgeRepairDeps,
  type BridgeSweepRow,
  type DebridgeFillHashLookup,
  type KhalaniOrderView,
  type StoredBridgeCorrelation,
} from "@vex-agent/sync/bridge-activity-repair.js";

// ── The live shape: execution 191 / logical row #81, Base → Solana via DeBridge ─

const KHALANI_SOLANA_CHAIN_ID = 20011000000;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AUTHOR = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "mfSnq7L8ZPU4m3QaoPYzBmpWToaQwunGPjAp19WpD7xA";
const DEPOSIT_HASH = `0x${"1a".repeat(32)}`;
const EXTERNAL_ORDER_ID = `0x${"9c".repeat(32)}`;
const RECOVERED_SIGNATURE =
  "XDk6X1UJBXntVTzGXRigZm82sh4WfyEgjwgCh5SzHfaaoXLpuReGjhpS93UxBM2rRPEGojGeyReiRXCtMKxYRyni";

const STORED: StoredBridgeCorrelation = {
  route: {
    fromChainId: 8453,
    fromChainFamily: "eip155",
    toChainId: KHALANI_SOLANA_CHAIN_ID,
    toChainFamily: "solana",
  },
  providerOrderId: "cmrzsdld90000psp7uw0ni9l8",
  tokenInAddress: USDC_BASE,
  tokenOutAddress: USDC_SOLANA,
  author: AUTHOR,
  depositTxHash: DEPOSIT_HASH,
  quoteId: "8ce2abcc-de03-48fc-a9b0-25e96b93c2d3",
  routeId: "DeBridge",
};

function debridgeOrder(overrides: Partial<KhalaniOrderView> = {}): KhalaniOrderView {
  return {
    id: "cmrzsdld90000psp7uw0ni9l8",
    status: "filled",
    fromChainId: 8453,
    toChainId: KHALANI_SOLANA_CHAIN_ID,
    quoteId: "8ce2abcc-de03-48fc-a9b0-25e96b93c2d3",
    routeId: "DeBridge",
    fromToken: USDC_BASE,
    toToken: USDC_SOLANA,
    author: AUTHOR,
    depositTxHash: DEPOSIT_HASH,
    recipient: RECIPIENT,
    destAmount: "17279551",
    externalOrderId: EXTERNAL_ORDER_ID,
    // The whole point: a "filled" order carrying ONLY the deposit.
    transactions: { deposit: { txHash: DEPOSIT_HASH, chainId: 8453, amount: "18000000" } },
    ...overrides,
  };
}

const EXPECTED_LOOKUP: DebridgeFillHashLookup = {
  externalOrderId: EXTERNAL_ORDER_ID,
  expectedDestChainId: KHALANI_SOLANA_CHAIN_ID,
  expectedDestChainFamily: "solana",
  expectedTokenOutAddress: USDC_SOLANA,
  expectedRecipient: RECIPIENT,
  expectedDestAmount: "17279551",
};

describe("mapKhalaniOrderOutcome — the filled_no_hash recovery payload", () => {
  it("a DeBridge-routed hashless fill carries the DLN lookup, built from the STORED token and the order's recipient/amount", () => {
    expect(mapKhalaniOrderOutcome(debridgeOrder(), STORED)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "filled",
      debridgeFillRecovery: EXPECTED_LOOKUP,
    });
  });

  it("the destination chain in the lookup is the STORED route, never the provider's echo", () => {
    const outcome = mapKhalaniOrderOutcome(debridgeOrder(), STORED);
    expect(outcome.kind).toBe("filled_no_hash");
    if (outcome.kind !== "filled_no_hash") return;
    expect(outcome.debridgeFillRecovery?.expectedDestChainId).toBe(STORED.route.toChainId);
    expect(outcome.debridgeFillRecovery?.expectedDestChainFamily).toBe(STORED.route.toChainFamily);
  });

  it("an unrecorded destination token becomes a NULL expectation (never silently skipped)", () => {
    const outcome = mapKhalaniOrderOutcome(debridgeOrder(), { ...STORED, tokenOutAddress: null });
    expect(outcome.kind).toBe("filled_no_hash");
    if (outcome.kind !== "filled_no_hash") return;
    expect(outcome.debridgeFillRecovery?.expectedTokenOutAddress).toBeNull();
  });

  it.each([
    ["a missing recipient", { recipient: null }],
    ["a missing destAmount", { destAmount: undefined }],
  ])("%s becomes a NULL expectation rather than an omitted check", (_label, over) => {
    const outcome = mapKhalaniOrderOutcome(debridgeOrder(over), STORED);
    expect(outcome.kind).toBe("filled_no_hash");
    if (outcome.kind !== "filled_no_hash") return;
    expect(outcome.debridgeFillRecovery).toBeDefined();
    const lookup = outcome.debridgeFillRecovery;
    expect(lookup?.expectedRecipient === null || lookup?.expectedDestAmount === null).toBe(true);
  });

  it("a NON-DeBridge route carries NO lookup (deBridge is not asked about someone else's order)", () => {
    const hyperstream = debridgeOrder({ routeId: "Hyperstream" });
    expect(mapKhalaniOrderOutcome(hyperstream, { ...STORED, routeId: "Hyperstream" })).toEqual({
      kind: "filled_no_hash",
      providerStatus: "filled",
    });
  });

  it("a DeBridge order WITHOUT an externalOrderId carries no lookup", () => {
    expect(mapKhalaniOrderOutcome(debridgeOrder({ externalOrderId: undefined }), STORED)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "filled",
    });
  });

  it("an order that DOES carry a fill hash is unaffected — still the plain confirmable path", () => {
    const withFill = debridgeOrder({
      transactions: { fill: { txHash: RECOVERED_SIGNATURE, chainId: KHALANI_SOLANA_CHAIN_ID } },
    });
    expect(mapKhalaniOrderOutcome(withFill, STORED)).toEqual({
      kind: "confirmable",
      providerStatus: "filled",
      fillTxHashes: [RECOVERED_SIGNATURE],
      destChainId: KHALANI_SOLANA_CHAIN_ID,
      destChainFamily: "solana",
    });
  });

  it("a correlation mismatch still short-circuits BEFORE any recovery payload is built", () => {
    const foreign = debridgeOrder({ author: "0x9999999999999999999999999999999999999999" });
    expect(mapKhalaniOrderOutcome(foreign, STORED)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "author",
    });
  });
});

// ── Sweep orchestration over the injected dep ────────────────────────────────

function row(overrides: Partial<BridgeSweepRow> = {}): BridgeSweepRow {
  return {
    id: 81,
    protocolExecutionId: 191,
    protocol: "khalani",
    providerOrderId: "cmrzsdld90000psp7uw0ni9l8",
    fromChainId: 8453,
    toChainId: KHALANI_SOLANA_CHAIN_ID,
    destChainFamily: "solana",
    tokenInAddress: USDC_BASE,
    tokenOutAddress: USDC_SOLANA,
    walletAddress: AUTHOR,
    depositTxHash: DEPOSIT_HASH,
    quoteId: "8ce2abcc-de03-48fc-a9b0-25e96b93c2d3",
    routeId: "DeBridge",
    sessionId: null,
    normalizedRoute: null,
    lastAttemptedAt: null,
    createdAt: "2026-07-25T03:05:12.813Z",
    lastVerificationReason: null,
    ...overrides,
  };
}

function cas(applied: boolean, status: AgentActivityStatus): CasResult {
  return { applied, row: { status } as AgentActivityEvent };
}

/** The logger's first argument is typed `object | string`; read the event names as text (sibling-suite form). */
function warnedEvents(spy: { mock: { calls: readonly unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => String(Array.from(args)[0]));
}

const observed: MarkBridgeLegObservedResult = { inserted: true, row: {} as AgentActivityEvent };

function makeDeps(overrides: Partial<BridgeRepairDeps> = {}): BridgeRepairDeps {
  return {
    listSweepCandidates: vi.fn().mockResolvedValue([]),
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
    attachOrderId: vi.fn().mockResolvedValue({ outcome: "attached" as AttachProviderOrderIdOutcome, row: null } as AttachProviderOrderIdResult),
    enqueueBalanceRefresh: vi.fn().mockResolvedValue(undefined),
    clearRelayReveal: vi.fn(),
    ...overrides,
  };
}

describe("repairPendingBridges — the DeBridge recovery lane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recovers the hash, verifies it ON-CHAIN, and only then confirms the row", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder()),
      fetchDebridgeFillHash: vi.fn().mockResolvedValue({ txHash: RECOVERED_SIGNATURE }),
    });

    const result = await repairPendingBridges(deps);

    expect(deps.fetchDebridgeFillHash).toHaveBeenCalledWith(EXPECTED_LOOKUP);
    expect(deps.verifyFill).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: RECOVERED_SIGNATURE,
        expectedChainId: KHALANI_SOLANA_CHAIN_ID,
        chainFamily: "solana",
        protocol: "khalani",
        recipient: null,
      }),
    );
    expect(deps.confirmExpectedFill).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 191,
        txHash: RECOVERED_SIGNATURE,
        evidenceSource: "khalani_order_status",
        providerStatus: "filled",
      }),
    );
    expect(deps.enqueueBalanceRefresh).toHaveBeenCalledWith({ namespace: "khalani", executionId: 191 });
    expect(result.confirmed).toBe(1);
    expect(result.stillPending).toBe(0);
  });

  it("a recovered hash that FAILS on-chain verification never confirms — the row stays pending (B4 still gates)", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder()),
      fetchDebridgeFillHash: vi.fn().mockResolvedValue({ txHash: RECOVERED_SIGNATURE }),
      verifyFill: vi.fn().mockResolvedValue({ verified: false, reason: "signature_status_unavailable" }),
    });

    const result = await repairPendingBridges(deps);

    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("a REFUSED recovery leaves the row exactly as before: pending, anomaly logged", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder()),
      fetchDebridgeFillHash: vi.fn().mockResolvedValue(null),
    });

    const result = await repairPendingBridges(deps);

    expect(deps.fetchDebridgeFillHash).toHaveBeenCalledTimes(1);
    expect(deps.verifyFill).not.toHaveBeenCalled();
    expect(deps.confirmExpectedFill).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(warnedEvents(warnSpy)).toContain("bridge.repair.filled_without_hash");
    warnSpy.mockRestore();
  });

  it("a hashless fill with NO externalOrderId never calls deBridge and stays pending exactly as today", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder({ externalOrderId: undefined })),
    });

    const result = await repairPendingBridges(deps);

    expect(deps.fetchDebridgeFillHash).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
    expect(warnedEvents(warnSpy)).toContain("bridge.repair.filled_without_hash");
    warnSpy.mockRestore();
  });

  it("a HYPERSTREAM-routed order never triggers a deBridge lookup", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ routeId: "Hyperstream" })]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder({ routeId: "Hyperstream" })),
    });
    await repairPendingBridges(deps);
    expect(deps.fetchDebridgeFillHash).not.toHaveBeenCalled();
  });

  it("an order that already carries its own fill hash never triggers a deBridge lookup", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row()]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(
        debridgeOrder({ transactions: { fill: { txHash: RECOVERED_SIGNATURE, chainId: KHALANI_SOLANA_CHAIN_ID } } }),
      ),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.fetchDebridgeFillHash).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(1);
  });

  it("a RELAY row with no destination hash never triggers a deBridge lookup", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row({ protocol: "relay", destChainFamily: "eip155", toChainId: 42161 })]),
      fetchRelayStatus: vi.fn().mockResolvedValue({ status: "success", txHashes: [], inTxHashes: [DEPOSIT_HASH] }),
    });
    const result = await repairPendingBridges(deps);
    expect(deps.fetchDebridgeFillHash).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("a lookup that throws does not abort the sweep batch", async () => {
    const deps = makeDeps({
      listSweepCandidates: vi.fn().mockResolvedValue([row(), row({ id: 96, protocolExecutionId: 229 })]),
      fetchKhalaniOrder: vi.fn().mockResolvedValue(debridgeOrder()),
      fetchDebridgeFillHash: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await expect(repairPendingBridges(deps)).resolves.toMatchObject({ checked: 2, stillPending: 2 });
  });
});
