/**
 * Phase-2 W3a — khalani.bridge staged-execute safety (mirrors the Phase-1
 * kyberswap `staged-execute-safety.test.ts` adversarial suite). Pins the
 * properties a full-mock happy path cannot distinguish:
 *
 *   - a `markActivityBroadcast` CAS miss aborts BEFORE any broadcast/submit;
 *   - an ambiguous DEPOSIT keeps the logical row + in-flight guard PENDING (the
 *     abort excludes the expected-fill index) so W4's null-order-id recovery can
 *     reconcile it; it carries the hash and does NOT submit (blocker 1);
 *   - a reverted deposit fails the leg + aborts, no submit;
 *   - a pre-sign no-route records ONE hashless failed row + reveals Relay;
 *   - a prequote no-route reveals Relay + records NOTHING (absent chain);
 *   - attach outcomes: attached; conflict_different_id polls the PERSISTED id and
 *     NEVER the conflicting one (m4); not_pending polls the persisted id;
 *   - the in-flight guard rejection surfaces a clear output;
 *   - a Vex-signed leg confirm respects `confirmActivityEvent().applied`: a
 *     non-benign CAS miss reports `confirmed_unrecorded`, never ordinary confirmed
 *     (m5, mirrors Phase-1 C41);
 *   - the in-turn poll is TRUTHFUL and NEVER terminalizes the logical row from
 *     provider status: provider `filled` → filled_unverified, pending →
 *     still-settling, failed/refunded → reported truthfully while the row stays
 *     PENDING for W4 (FIX-ROUND-1 architectural decision — W4 owns all terminal
 *     transitions);
 *   - a USD lookup miss records NULL USD + NULL usd_source (named degradation);
 *   - a Solana source stages its signature via the Solana CAS (nonce NULL);
 *   - every error-carrying output is the scrubbed `summarizeProtocolError`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn(() => SESSION_EVM.address as string);
const mockResolveSigningWallet = vi.fn<() => unknown>(() => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...(args as [])),
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...(args as [])),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  familyToInventory: () => "evm",
  walletAddressesEqual: () => true,
}));

const mockChains = [
  { id: 8453, name: "Base", type: "eip155", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } } },
  { id: 42161, name: "Arbitrum One", type: "eip155", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } } },
];

const mockGetChainFamily = vi.fn((id: number) => mockChains.find((c) => c.id === id)?.type ?? "eip155");

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: vi.fn(async () => mockChains),
  getChain: (id: number) => {
    const c = mockChains.find((x) => x.id === id);
    if (!c) throw new Error(`chain ${id} not in registry`);
    return c;
  },
  getChainFamily: (id: number) => mockGetChainFamily(id),
  getChainExplorerUrl: (id: number) => mockChains.find((c) => c.id === id)?.blockExplorers.default.url,
}));

const mockResolveKhalaniPrequoteRoute = vi.fn();
vi.mock("@tools/khalani/prequote-route-guard.js", () => ({
  resolveKhalaniPrequoteRoute: (...args: unknown[]) => mockResolveKhalaniPrequoteRoute(...(args as [])),
}));

const mockPrepareQuoteRequest = vi.fn();
vi.mock("@tools/khalani/request.js", () => ({
  prepareQuoteRequest: (...args: unknown[]) => mockPrepareQuoteRequest(...(args as [])),
  // Real implementation (not a stub): the handler's rejection of caller-supplied
  // fee params AND of a caller-supplied refund destination must stay live in
  // this suite, so a regression that starts accepting either cannot hide behind
  // a permissive mock.
  findCallerSuppliedForbiddenParam: (params: Record<string, unknown>) => {
    const supplied = (key: string) => {
      const value = params[key];
      if (value === undefined || value === null) return false;
      return !(typeof value === "string" && value.trim() === "");
    };
    for (const key of ["referrer", "referrerFeeBps"]) {
      if (supplied(key)) return { param: key, reason: "Vex never takes fee parameters from tool input." };
    }
    if (supplied("refundTo")) {
      return {
        param: "refundTo",
        reason:
          "Vex always refunds a failed bridge to the wallet the funds left, derived from the selected "
          + "source wallet — a refund destination is never taken from tool input.",
      };
    }
    return null;
  },
}));

const mockResolveRouteBestIndex = vi.fn(() => 0);
vi.mock("@tools/khalani/helpers.js", () => ({
  resolveRouteBestIndex: (...args: unknown[]) => mockResolveRouteBestIndex(...(args as [])),
}));

const mockGetQuotes = vi.fn();
const mockBuildDeposit = vi.fn();
const mockSubmitDeposit = vi.fn();
const mockGetOrders = vi.fn();
const mockSearchTokens = vi.fn();
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getQuotes: (...a: unknown[]) => mockGetQuotes(...a),
    buildDeposit: (...a: unknown[]) => mockBuildDeposit(...a),
    submitDeposit: (...a: unknown[]) => mockSubmitDeposit(...a),
    getOrders: (...a: unknown[]) => mockGetOrders(...a),
    searchTokens: (...a: unknown[]) => mockSearchTokens(...a),
  }),
}));

const mockPollKhalaniOrderToTerminal = vi.fn();
vi.mock("@tools/khalani/order-status.js", () => ({
  pollKhalaniOrderToTerminal: (...a: unknown[]) => mockPollKhalaniOrderToTerminal(...a),
}));

const mockPlanKhalaniDepositLegs = vi.fn();
const mockSignStageKhalaniLeg = vi.fn();
vi.mock("@tools/khalani/bridge-executor.js", () => ({
  planKhalaniDepositLegs: (...a: unknown[]) => mockPlanKhalaniDepositLegs(...a),
  signStageKhalaniLeg: (...a: unknown[]) => mockSignStageKhalaniLeg(...a),
}));

const mockCreateBridgeActivityIntent = vi.fn();
const mockCreateBridgePreBroadcastFailure = vi.fn();
const mockAttachProviderOrderId = vi.fn();
const mockCheckBridgeInFlight = vi.fn();
const mockMarkActivityBroadcast = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockAbortPlannedEvents = vi.fn();
const mockNotePendingReason = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
const mockNoteBridgeProviderObservation = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
const mockFillExecutedAmounts = vi.fn(async (..._a: unknown[]) => ({ outcome: "applied" }));
const mockNoteSettlementDeclined = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateBridgeActivityIntent(...a),
  createBridgePreBroadcastFailure: (...a: unknown[]) => mockCreateBridgePreBroadcastFailure(...a),
  attachProviderOrderId: (...a: unknown[]) => mockAttachProviderOrderId(...a),
  checkBridgeInFlight: (...a: unknown[]) => mockCheckBridgeInFlight(...a),
  markActivityBroadcast: (...a: unknown[]) => mockMarkActivityBroadcast(...a),
  markActivitySolanaBroadcast: (...a: unknown[]) => mockMarkActivitySolanaBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkBroadcastAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => mockConfirmActivityEvent(...a),
  failActivityEvent: (...a: unknown[]) => mockFailActivityEvent(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbortPlannedEvents(...a),
  // R1 Step 3b/4 primitives. `provenLegAmounts` is the REAL pure function — the
  // point of the confirm assertions below is WHICH amounts a leg may claim, so
  // stubbing the evidence matrix would test the stub.
  provenLegAmounts: (await importOriginal<Record<string, unknown>>()).provenLegAmounts,
  // The deposit confirm site's money writers: the late-fill CAS for the
  // status-only race, and the named decline when no receipt evidence exists.
  fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFillExecutedAmounts(...a),
  noteSettlementDeclined: (...a: unknown[]) => mockNoteSettlementDeclined(...a),
  notePendingReason: (...a: unknown[]) => mockNotePendingReason(...a),
  noteBridgeProviderObservation: (...a: unknown[]) => mockNoteBridgeProviderObservation(...a),
}));

const mockRevealRelayRoute = vi.fn();
const mockResolveRelayRevealRoute = vi.fn(() => ({
  fromChainId: 8453, fromChainFamily: "eip155", fromToken: "0xaaa",
  toChainId: 42161, toChainFamily: "eip155", toToken: "0xbbb",
}));
vi.mock("@vex-agent/tools/registry/relay-reveal.js", () => ({
  revealRelayRoute: (...a: unknown[]) => mockRevealRelayRoute(...a),
  resolveRelayRevealRoute: (...a: unknown[]) => mockResolveRelayRevealRoute(...(a as [])),
}));

/**
 * The fee-on-transfer oracle is a LIVE NETWORK CALL on the EVM pre-quote path
 * (`bridge-execute.ts:272` → `bridge-fee/fee-eligibility.ts:57`). Unstubbed it
 * cost ~550 ms per EVM case and, on a loaded runner, outlived vitest's 10 s
 * timeout — the still-running handler then consumed the NEXT test's
 * `mockResolvedValueOnce` values and called the CAS mocks after
 * `clearAllMocks`. Stubbed exactly as in the sibling `bridge-fee-execute.test.ts`;
 * the eligibility logic itself still runs for real.
 */
const mockHoneypotFot = vi.fn(async () => ({ isHoneypot: false, isFOT: false, tax: 0 }));
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: (...a: unknown[]) => mockHoneypotFot(...(a as [])) }),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { BRIDGE_HANDLERS } from "@vex-agent/tools/protocols/khalani/handlers/bridge.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { VexError } from "../../../../errors.js";
import { classifyNativeValue } from "@tools/evm-chains/native-value-authorization/index.js";

/**
 * The native-value authorization a zero-value EVM leg carries. `signStageEvmLeg`
 * re-validates this before signing, so a mocked plan must supply one; a leg that
 * sends no native currency has nothing to attribute and authorizes trivially.
 */
function zeroValueAuthorization(to: string) {
  return classifyNativeValue({
    call: { chainId: 8453, to: to as `0x${string}`, data: undefined, valueWei: 0n },
  });
}

const FROM_TOKEN = "0xAAA0000000000000000000000000000000000000";
const TO_TOKEN = "0xBBB0000000000000000000000000000000000000";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  } as ProtocolExecutionContext;
}

function execute(over: Record<string, unknown> = {}, context = ctx()) {
  return BRIDGE_HANDLERS["khalani.bridge"]!(
    { fromChain: "base", toChain: "arbitrum", fromToken: FROM_TOKEN, toToken: TO_TOKEN, amountRaw: "1500000", ...over },
    context,
  );
}

function parse(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

describe("khalani.bridge — staged execute safety (W3a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockGetChainFamily.mockImplementation((id: number) => mockChains.find((c) => c.id === id)?.type ?? "eip155");
    mockResolveKhalaniPrequoteRoute.mockResolvedValue({ outcome: "khalani", fromChainId: 8453, toChainId: 42161 });
    mockPrepareQuoteRequest.mockResolvedValue({
      chains: mockChains, fromChainId: 8453, toChainId: 42161, fromFamily: "eip155", toFamily: "eip155",
      request: { tradeType: "EXACT_INPUT", fromChainId: 8453, fromToken: FROM_TOKEN, toChainId: 42161, toToken: TO_TOKEN, amount: "1500000", fromAddress: SESSION_EVM.address },
    });
    mockGetQuotes.mockResolvedValue({
      quoteId: "q1",
      routes: [{ routeId: "r1", type: "Across", depositMethods: ["CONTRACT_CALL"], quote: { amountIn: "1500000", amountOut: "1499000", expectedDurationSeconds: 2, validBefore: FUTURE, quoteExpiresAt: FUTURE } }],
    });
    mockResolveRouteBestIndex.mockReturnValue(0);
    mockBuildDeposit.mockResolvedValue({ kind: "CONTRACT_CALL", approvals: [] });
    mockPlanKhalaniDepositLegs.mockReturnValue([
      {
        role: "bridge_deposit", family: "eip155", isDeposit: true, kind: "evm",
        tx: { to: FROM_TOKEN },
        // Every EVM leg carries a native-value authorization; this one sends
        // no value, so it authorizes with no components at all.
        nativeValue: zeroValueAuthorization(FROM_TOKEN),
      },
    ]);
    mockSearchTokens.mockImplementation(async (address: string) => ({
      data: [{ address, chainId: address === FROM_TOKEN ? 8453 : 42161, symbol: address === FROM_TOKEN ? "USDC" : "USDC", name: "USD Coin", decimals: 6, extensions: { price: { usd: "1.0001" } } }],
    }));
    mockCheckBridgeInFlight.mockResolvedValue({ inFlight: false, existing: null });
    mockCreateBridgeActivityIntent.mockResolvedValue({ outcome: "created", executionId: 42, legs: [{ id: 100 }], expectedFill: { id: 200 } });
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockAbortPlannedEvents.mockResolvedValue([]);
    mockSignStageKhalaniLeg.mockImplementation(async (_leg, _sc, _ch, _signer, hooks) => {
      await hooks.onHashStaged({ txHash: "0xdeposithash", fromAddress: SESSION_EVM.address, nonce: 7 });
      await hooks.onAccepted();
      return { kind: "confirmed", txHash: "0xdeposithash" };
    });
    mockSubmitDeposit.mockResolvedValue({ orderId: "o1", txHash: "0xdeposithash" });
    mockAttachProviderOrderId.mockResolvedValue({ outcome: "attached", row: { id: 200 } });
    mockPollKhalaniOrderToTerminal.mockResolvedValue({ kind: "pending", status: "published" });
    mockCreateBridgePreBroadcastFailure.mockResolvedValue({ executionId: 7, expectedFill: { id: 9 } });
  });

  it("happy path (pending fill) → success:false, records the intent, submits + attaches, USD present", async () => {
    const result = await execute();
    expect(result.success).toBe(false); // success-shaped ambiguity forbidden until W4-verified
    const data = parse(result.output);
    expect(data.status).toBe("pending");
    expect(data.orderId).toBe("o1");
    expect(data.depositTxHash).toBe("0xdeposithash");
    expect(data._executionId).toBe(42);
    expect(mockCreateBridgeActivityIntent).toHaveBeenCalledTimes(1);
    expect(mockMarkActivityBroadcast).toHaveBeenCalledTimes(1);
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);
    expect(mockSubmitDeposit).toHaveBeenCalledTimes(1);
    expect(mockAttachProviderOrderId).toHaveBeenCalledWith({ executionId: 42, providerOrderId: "o1" });
    // USD resolved from the token-price lookup, marked as an estimate.
    const amountIn = data.amountIn as Record<string, unknown>;
    expect(amountIn.usdEstimate).not.toBeNull();
    const intentArg = mockCreateBridgeActivityIntent.mock.calls[0]![0] as { expectedFill: { usdSource?: string } };
    expect(intentArg.expectedFill.usdSource).toBe("khalani_token_price");
    // Never fabricates a confirmed fill in-turn.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("CAS miss on markActivityBroadcast aborts BEFORE submit — same _executionId", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100 } });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output)._executionId).toBe(42);
    expect(mockMarkActivityBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
    expect(mockAbortPlannedEvents).toHaveBeenCalled();
    expect(mockCreateBridgePreBroadcastFailure).not.toHaveBeenCalled(); // never a 2nd execution
  });

  it("ambiguous deposit → logical row kept PENDING (guard held for W4), carries the hash, does NOT submit", async () => {
    mockSignStageKhalaniLeg.mockResolvedValueOnce({ kind: "ambiguous", txHash: "0xambig", stage: "confirm" });
    const result = await execute();
    expect(result.success).toBe(false);
    const data = parse(result.output);
    expect(data.status).toBe("pending");
    expect(data.depositTxHash).toBe("0xambig");
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
    // FIXED CONTRACT (blocker 1): the abort is bounded by an EXCLUSIVE upper index
    // equal to the expected-fill event index (stagedLegs.length === 1), so the
    // logical `bridge_fill_expected` row (index 1) is EXCLUDED and stays pending
    // for W4's null-order-id recovery. (Previously the call was `(42, 1)` with NO
    // bound, terminalizing the logical row at index 1 — the pinned bug.)
    expect(mockAbortPlannedEvents).toHaveBeenCalledWith(42, 1, expect.stringContaining("ambiguous"), 1);
    // The logical row is NEVER terminalized in-turn.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("reverted deposit → fails the leg + aborts, no submit", async () => {
    mockSignStageKhalaniLeg.mockResolvedValueOnce({ kind: "reverted", txHash: "0xrevert" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("reverted");
    expect(mockFailActivityEvent).toHaveBeenCalledWith(100, expect.objectContaining({ failureCode: "mined_revert" }));
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  });

  it("leg confirm CAS miss (not a benign race) → deposit leg reported confirmed_unrecorded (m5)", async () => {
    // The chain-side settlement is real, but Vex's own confirm write did not apply
    // (the row was no longer pending with a matching hash) — never ordinary confirmed.
    mockConfirmActivityEvent.mockResolvedValueOnce({ applied: false, row: { id: 100, status: "definitively_failed", txHash: null } });
    const result = await execute();
    const legs = parse(result.output).legs as Array<{ role: string; status: string }>;
    expect(legs.find((l) => l.role === "bridge_deposit")?.status).toBe("confirmed_unrecorded");
  });

  it("leg confirm CAS miss that is a benign already-confirmed-same-hash race → ordinary confirmed", async () => {
    mockConfirmActivityEvent.mockResolvedValueOnce({ applied: false, row: { id: 100, status: "confirmed", txHash: "0xdeposithash" } });
    const result = await execute();
    const legs = parse(result.output).legs as Array<{ role: string; status: string }>;
    expect(legs.find((l) => l.role === "bridge_deposit")?.status).toBe("confirmed");
  });

  it("no-route (empty routes) → ONE hashless failed row + Relay reveal, no signing", async () => {
    mockGetQuotes.mockResolvedValueOnce({ quoteId: "q1", routes: [] });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(mockCreateBridgePreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockRevealRelayRoute).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("bridge_quote_relay");
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
  });

  it("prequote no-route (absent chain) → reveal, records NOTHING", async () => {
    mockResolveKhalaniPrequoteRoute.mockResolvedValueOnce({ outcome: "no_route", missing: ["to"] });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(mockRevealRelayRoute).toHaveBeenCalledTimes(1);
    expect(mockCreateBridgePreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockGetQuotes).not.toHaveBeenCalled();
  });

  it("static_relay (local chain) → clear redirect, no record, no reveal", async () => {
    mockResolveKhalaniPrequoteRoute.mockResolvedValueOnce({ outcome: "static_relay", localChainId: 4663, localSide: "to" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(result.output).toContain("Relay");
    expect(mockRevealRelayRoute).not.toHaveBeenCalled();
    expect(mockCreateBridgePreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("in-flight pre-check → clear output, no intent", async () => {
    mockCheckBridgeInFlight.mockResolvedValueOnce({ inFlight: true, existing: { protocolExecutionId: 5, status: "pending" } });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(result.output).toContain("already in flight");
    expect(result.output).toContain("execution 5");
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
  });

  it("in-flight conflict from the DB guard → clear output, no signing", async () => {
    mockCreateBridgeActivityIntent.mockResolvedValueOnce({ outcome: "in_flight_conflict", existing: { protocolExecutionId: 8, status: "pending" } });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(result.output).toContain("already in flight");
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
  });

  it("attach conflict_different_id → logs + polls the PERSISTED id, NEVER the conflicting one (m4)", async () => {
    mockAttachProviderOrderId.mockResolvedValueOnce({ outcome: "conflict_different_id", row: { id: 200, providerOrderId: "persisted-order" } });
    await execute();
    expect(mockLoggerWarn).toHaveBeenCalledWith("khalani.bridge.order_id_conflict", expect.any(Object));
    // FIXED CONTRACT (m4): poll the persisted id, never the newly-returned "o1".
    expect(mockPollKhalaniOrderToTerminal.mock.calls[0]?.[0]).toBe("persisted-order");
    expect(mockPollKhalaniOrderToTerminal).not.toHaveBeenCalledWith("o1");
  });

  it("attach conflict_different_id with no persisted id → skips the poll, truthful pending output (m4)", async () => {
    mockAttachProviderOrderId.mockResolvedValueOnce({ outcome: "conflict_different_id", row: { id: 200, providerOrderId: null } });
    const result = await execute();
    // The conflicting id is NEVER polled; fail-closed to a truthful pending output.
    expect(mockPollKhalaniOrderToTerminal).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("pending");
  });

  it("attach not_pending (terminal row) → logged, polls the persisted id", async () => {
    mockAttachProviderOrderId.mockResolvedValueOnce({ outcome: "not_pending", row: { id: 200, status: "confirmed", providerOrderId: "o1" } });
    await execute();
    expect(mockPollKhalaniOrderToTerminal.mock.calls[0]?.[0]).toBe("o1");
  });

  it("poll filled → filled_unverified, NEVER a fabricated confirmed fill", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "terminal", status: "filled" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("filled_unverified");
    expect(result.output).toContain("Verification is pending");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("poll failed → logical row stays PENDING (W4 owns terminalization), honest did-NOT-arrive wording", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "terminal", status: "failed" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("failed");
    // Message-text honesty pins (carried from the deleted terminal-status suite),
    // adapted to the pending output: the status is reported truthfully while the row
    // is left for the background tracker.
    expect(result.output).toContain("did NOT arrive");
    expect(result.output).toContain("tracked automatically");
    // ARCHITECTURAL (FIX-ROUND-1): the in-turn poll NEVER terminalizes from provider
    // status — W4 owns all terminal transitions (was `failActivityEvent(200, bridge_failed)`).
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("poll refunded → logical row stays PENDING (W4 owns terminalization), money-back messaging", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "terminal", status: "refunded" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("refunded");
    expect(result.output).toContain("refunded");
    // Message-text honesty pins (carried from the deleted terminal-status suite),
    // adapted to the pending output.
    expect(result.output).toContain("did NOT arrive");
    expect(result.output).toContain("money back is not a successful bridge");
    expect(result.output).toContain("tracked automatically");
    // ARCHITECTURAL (FIX-ROUND-1): no in-turn terminalization (was `failActivityEvent(200, bridge_refunded)`).
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("poll refund_pending (non-terminal) → stays pending, refund-in-flight wording, row never failed", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "pending", status: "refund_pending" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("pending");
    // Message-text honesty pins (carried from the deleted terminal-status suite):
    // refund IN FLIGHT is explicitly non-terminal (dossier §2 — Hyperlane refund
    // has no deadline; only terminal provider statuses may terminalize).
    expect(result.output).toContain("refund is IN FLIGHT");
    expect(result.output).toContain("has NOT arrived");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    // The DEPOSIT leg (id 100) is legitimately receipt-confirmed in-turn
    // (Vex-signed); only the LOGICAL row (id 200) must never be confirmed here
    // — that is W4's verified path.
    expect(mockConfirmActivityEvent).not.toHaveBeenCalledWith(200, expect.anything());
  });

  it("poll still settling (non-terminal 'published') → pending, settling wording", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "pending", status: "published" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("pending");
    // Message-text honesty pin (carried from the deleted terminal-status suite).
    expect(result.output).toContain("still settling");
    expect(result.output).toContain("do not re-bridge");
  });

  it("poll unavailable → pending, truthful unreachable messaging", async () => {
    mockPollKhalaniOrderToTerminal.mockResolvedValueOnce({ kind: "unavailable" });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("pending");
    expect(result.output).toContain("UNCONFIRMED");
  });

  it("USD lookup failure → NULL USD + NULL usd_source (named degradation)", async () => {
    mockSearchTokens.mockRejectedValue(new Error("token price service down"));
    await execute();
    const intentArg = mockCreateBridgeActivityIntent.mock.calls[0]![0] as { expectedFill: { usdInEst?: string; usdOutEst?: string; usdSource?: string } };
    expect(intentArg.expectedFill.usdInEst).toBeUndefined();
    expect(intentArg.expectedFill.usdOutEst).toBeUndefined();
    expect(intentArg.expectedFill.usdSource).toBeUndefined();
  });

  it("DuplicateRecordException on submit → fetch the existing order, no new action", async () => {
    const dup = new VexError("KHALANI_API_ERROR", "duplicate submit");
    dup.externalName = "DuplicateRecordException";
    mockSubmitDeposit.mockRejectedValueOnce(dup);
    mockGetOrders.mockResolvedValueOnce({ data: [{ id: "existing-1", depositTxHash: "0xdeposithash" }] });
    await execute();
    expect(mockAttachProviderOrderId).toHaveBeenCalledWith({ executionId: 42, providerOrderId: "existing-1" });
  });

  it("Solana source stages the base58 signature + blockhash evidence via the Solana CAS (nonce NULL) — never the EVM CAS", async () => {
    mockGetChainFamily.mockImplementation((id: number) => (id === 8453 ? "solana" : "eip155"));
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageKhalaniLeg.mockImplementation(async (_leg, _sc, _ch, _signer, hooks) => {
      await hooks.onHashStaged({
        txHash: "5SoLSigBase58", fromAddress: "SoLFromAddr", nonce: null,
        recentBlockhash: "FreshBlockhash1111111111111111111111111111", lastValidBlockHeight: 123456789,
      });
      await hooks.onAccepted();
      return { kind: "confirmed", txHash: "5SoLSigBase58" };
    });
    const result = await execute();
    expect(mockCreateBridgeActivityIntent).toHaveBeenCalledTimes(1);
    // W5 §2/R2b: the evidence-carrying CAS now REQUIRES both fields in the
    // SAME atomic write — the handler's onHashStaged callback threads them
    // straight through from the staged-hash handles, no second write.
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledWith(100, {
      txHash: "5SoLSigBase58", fromAddress: "SoLFromAddr",
      recentBlockhash: "FreshBlockhash1111111111111111111111111111", lastValidBlockHeight: 123456789,
    });
    expect(mockMarkActivityBroadcast).not.toHaveBeenCalled();
    // Truthful in-turn contract unchanged: never success:true before a
    // W4-verified fill.
    expect(result.success).toBe(false);
  });

  it("a nonce-less stage on an EVM-family row is a Solana-CAS miss → aborts before broadcast", async () => {
    // The DB predicate (chain_family='solana') refuses; the handler must abort.
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: false, row: { id: 100 } });
    mockSignStageKhalaniLeg.mockImplementation(async (_leg, _sc, _ch, _signer, hooks) => {
      await hooks.onHashStaged({ txHash: "0xnonceless", fromAddress: SESSION_EVM.address, nonce: null });
      return { kind: "confirmed", txHash: "0xnonceless" };
    });
    const result = await execute();
    expect(result.success).toBe(false);
    expect(mockMarkActivityBroadcast).not.toHaveBeenCalled();
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  });

  it("a provider error reaching the output is the scrubbed summarizeProtocolError message", async () => {
    const RAW = "Quote failed: Authorization: Bearer bridge-scrub-canary apiKey=sk_live_ABC";
    mockGetQuotes.mockRejectedValueOnce(new Error(RAW));
    const result = await execute();
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk_live_ABC");
    expect(result.output).toContain(summarizeProtocolError(new Error(RAW)).message);
    // A quote exception is a pre-sign failure → one hashless failed row.
    expect(mockCreateBridgePreBroadcastFailure).toHaveBeenCalledTimes(1);
  });
});
