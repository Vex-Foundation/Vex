/**
 * relay.bridge / relay.quote.get — W-SPINE agent_activity staged contract (W3b).
 *
 * Adversarial staged suite: every PRE-SIGN gate failure records a HASHLESS
 * `definitively_failed` row and broadcasts NOTHING (C1); staging is per-leg
 * (planned → sign → CAS → broadcast → accepted, R4); a CAS miss aborts before an
 * untracked broadcast; a destination-chain step is rejected (origin-only, B3);
 * the pending output is TRUTHFUL (success:false, "tracked automatically", the
 * logical row stays pending for W4 — success-while-pending is FORBIDDEN, B5);
 * the in-flight guard (C2) surfaces a clear message; USD is nullable end-to-end.
 *
 * The W2 gate helpers (health / correlation / step-policy / quote adapter) and
 * the W-SPINE repo primitives are mocked so the HANDLER's orchestration is
 * isolated (the helpers have their own suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const ERC20 = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";

// The origin-token fee eligibility probe reaches a live token API. Only that
// one export is replaced; everything else in the barrel (the fee split, the
// activity role, the treasury transfer builder) stays real, because the fee
// ARITHMETIC is part of what these tests assert.
vi.mock("@tools/bridge-fee/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/bridge-fee/index.js")>();
  return { ...actual, evaluateEvmBridgeFeeEligibility: async () => ({ charge: true } as const) };
});

vi.mock("@vex-agent/tools/protocols/bridge-token-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/bridge-token-identity.js")>();
  return {
    ...actual,
    resolveRelayBridgeTokenPreview: async (params: Record<string, unknown>) => {
      const one = (chainId: number, tokenAddress: string) => tokenAddress === ZERO
        ? {
            family: "eip155" as const, kind: "native" as const, chainId, tokenAddress,
            symbol: "ETH", decimals: 18, metadataSource: "chain_registry" as const, symbolSanitized: false,
          }
        : {
            family: "eip155" as const, kind: "erc20" as const, chainId, tokenAddress,
            symbol: "TOKEN", decimals: 18, metadataSource: "rpc_contract" as const, symbolSanitized: false,
          };
      return {
        source: one(8453, String(params.fromToken)),
        destination: one(4663, String(params.toToken)),
        amountRaw: String(params.amountRaw),
        amountHuman: "0.001",
      };
    },
  };
});

// ── Relay client (getQuote + getIntentStatus) + cached chains ──
const mockGetQuote = vi.fn();

/**
 * The first `/quote` request body - no quote requested is the test failure.
 *
 * The three ADDRESS fields are declared alongside the tolerance because they
 * are the money leg the suite asserts on: `user`, `recipient` and `refundTo`
 * are all derived from the session's selected wallet and none of them is a
 * parameter.
 */
function firstQuoteRequest(): {
  slippageTolerance?: string;
  user?: string;
  recipient?: string;
  refundTo?: string;
} {
  const [call] = mockGetQuote.mock.calls;
  assert.ok(call, "no quote was requested");
  return call[0] as { slippageTolerance?: string; user?: string; recipient?: string; refundTo?: string };
}
const mockGetIntentStatus = vi.fn();
const mockGetCachedRelayChains = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({
    getQuote: (...a: unknown[]) => mockGetQuote(...a),
    getIntentStatus: (...a: unknown[]) => mockGetIntentStatus(...a),
  }),
  getCachedRelayChains: (...a: unknown[]) => mockGetCachedRelayChains(...a),
}));

// ── Execution primitives (IO) — planRelayStepTx mocked to a fixed tx so staging
//    orchestration is decoupled from tx parsing (parsing is covered in execute.test.ts). ──
const mockResolveStepClients = vi.fn();
const mockPoll = vi.fn();
const mockPlanStepTx = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  resolveRelayStepClients: (...a: unknown[]) => mockResolveStepClients(...a),
  pollRelayIntentStatus: (...a: unknown[]) => mockPoll(...a),
  planRelayStepTx: (...a: unknown[]) => mockPlanStepTx(...a),
}));

// ── Shared staged-broadcast primitive (drives the leg outcome + invokes hooks). ──
const mockSign = vi.fn();
vi.mock("@tools/kyberswap/evm/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSign(...a),
}));

// ── W2 pre-sign gate helpers (control each gate outcome). ──
const mockHealth = vi.fn();
vi.mock("@tools/relay/health.js", () => ({ evaluateRelayRouteHealth: (...a: unknown[]) => mockHealth(...a) }));
const mockCorrelation = vi.fn();
vi.mock("@tools/relay/correlation.js", () => ({ assertRelayQuoteCorrelation: (...a: unknown[]) => mockCorrelation(...a) }));
const mockStepPolicy = vi.fn();
vi.mock("@tools/relay/step-policy.js", () => ({ classifyRelayBridgeSteps: (...a: unknown[]) => mockStepPolicy(...a) }));
const mockAdapt = vi.fn();
vi.mock("@tools/relay/quote.js", () => ({
  adaptRelayQuote: (...a: unknown[]) => mockAdapt(...a),
  RELAY_QUOTE_USD_SOURCE: "relay_quote_v2",
}));

// ── Wallet resolution ──
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

// ── Config + tracked tokens ──
vi.mock("@config/store.js", () => ({ loadConfig: () => ({ services: { relayApiUrl: "https://api.relay.link" } }) }));
const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...a: unknown[]) => mockPin(...a) }));

// ── W-SPINE agent_activity repo ──
const mockCreateIntent = vi.fn();
const mockPreFail = vi.fn();
const mockCheckInFlight = vi.fn();
const mockAttach = vi.fn();
const mockMarkBroadcast = vi.fn();
const mockMarkAccepted = vi.fn();
const mockConfirm = vi.fn();
const mockFail = vi.fn();
const mockAbort = vi.fn();
const mockNotePendingReason = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
const mockNoteBridgeProviderObservation = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
const mockFillExecutedAmounts = vi.fn(async (..._a: unknown[]) => ({ outcome: "applied" }));
const mockNoteSettlementDeclined = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
  createBridgePreBroadcastFailure: (...a: unknown[]) => mockPreFail(...a),
  checkBridgeInFlight: (...a: unknown[]) => mockCheckInFlight(...a),
  attachProviderOrderId: (...a: unknown[]) => mockAttach(...a),
  markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
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

// The bound quote the execute revalidates its Vex fee against, in the pre-sign
// window. The gate has its own suites; this one drives the HANDLER, so the
// re-read is a controlled answer and the default answer is the statement this
// arrangement's own quote would have recorded.
const mockFindFreshMatchedPrequote = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/gate.js", () => ({
  findFreshMatchedPrequote: (...a: unknown[]) => mockFindFreshMatchedPrequote(...a),
}));

const { RELAY_BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/relay/handlers/bridge.js");
const {
  boundChargedVexFee,
  boundSkippedVexFee,
  matchedPrequoteWithVexFee,
} = await import("../../../tools/bridge-fee/bound-vex-fee.js");
const { DependentLegGasEstimateError, DEPENDENT_LEG_ESTIMATE_MARKER } =
  await import("@tools/evm-chains/dependent-leg-gas-estimate.js");

const CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm", address: SEL_EVM }, solana: null },
  walletPolicy: { kind: "none" },
  sessionId: "sess-1",
};

const CHAINS = [
  { id: 8453, name: "base", displayName: "Base", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
  { id: 4663, name: "robinhood", displayName: "Robinhood Chain", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
];

const PARAMS = { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: "native", amountRaw: "1000000000000000" };

function txStep(id: string, chainId = 8453) {
  return { id, kind: "transaction", requestId: "0xreq", items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1000000000000000", data: "0x", chainId } }] };
}
function quote(steps = [txStep("deposit")]): RelayQuoteResponse {
  return { steps, requestId: "0xreq" } as unknown as RelayQuoteResponse;
}

function adaptedOk(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "0xreq",
    operation: "bridge",
    timeEstimateSeconds: 12,
    usdSource: "relay_quote_v2",
    currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: "2.94", minimumAmountRaw: null },
    currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "995000000000000", amountFormatted: "0.000995", amountUsd: "2.92", minimumAmountRaw: null },
    feeUsdByBucket: { relayer: "0.02" },
    totalImpactPercent: null,
    destinationSlippagePercent: null,
    ...overrides,
  };
}

/** signStageBroadcast mock that invokes the staging hooks then returns `kind`. */
function signAs(kind: "confirmed" | "reverted" | "ambiguous", txHash: string) {
  return async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    await hooks.onHashStaged({ txHash, fromAddress: SEL_EVM, nonce: 1 });
    await hooks.onAccepted();
    return kind === "ambiguous" ? { kind, txHash, stage: "send" } : { kind, txHash, receipt: {} };
  };
}

const depositStep = { stepId: "deposit", role: "bridge_deposit", chainId: 8453, step: txStep("deposit") };
const approveStep = { stepId: "approve", role: "allowance", chainId: 8453, step: txStep("approve") };

async function runBridge(params: Record<string, unknown> = PARAMS) {
  return RELAY_BRIDGE_HANDLERS["relay.bridge"](params, CTX);
}
function outputOf(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The approved quote for these exact params stated this exact fee.
  mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
    feeAmountRaw: "2500000000000", netAmountRaw: "997500000000000", totalDebitedRaw: "1000000000000000",
  })));
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue(quote());
  mockAdapt.mockReturnValue(adaptedOk());
  mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1], blockProductionLagging: [] });
  mockCorrelation.mockReturnValue({ ok: true, requestId: "0xreq" });
  mockStepPolicy.mockReturnValue({ ok: true, steps: [depositStep] });
  mockCheckInFlight.mockResolvedValue({ inFlight: false, existing: null });
  mockResolveStepClients.mockResolvedValue({ publicClient: {}, walletClient: {} });
  mockPlanStepTx.mockReturnValue({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n });
  mockPoll.mockResolvedValue({ status: "submitted", observed: true, destinationTxHashes: [] });
  mockPreFail.mockResolvedValue({ executionId: 900, expectedFill: { id: 901 } });
  mockCreateIntent.mockImplementation(async (input: { legs: unknown[] }) => ({
    outcome: "created",
    executionId: 100,
    legs: input.legs.map((_l, i) => ({ id: 200 + i })),
    expectedFill: { id: 300 },
  }));
  mockAttach.mockResolvedValue({ outcome: "attached", row: { id: 300 } });
  mockMarkBroadcast.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockMarkAccepted.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockConfirm.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockFail.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockAbort.mockResolvedValue([]);
  mockSign.mockImplementation(signAs("confirmed", "0xdep"));
  mockPin.mockResolvedValue({ inserted: true });
});

/** When a mock was first called, so ordering is asserted on facts, not on timing. */
function firstCallOrder(mock: { mock: { invocationCallOrder: readonly number[] } }): number {
  const [first] = mock.mock.invocationCallOrder;
  if (first === undefined) throw new Error("expected this mock to have been called");
  return first;
}

// ── The bound Vex fee statement (rule 90: revalidate immediately before sign) ──
describe("relay.bridge - the fee must still match the statement the approval was granted on", () => {
  /** Nothing signed, nothing planned, nothing broadcast, no in-flight guard taken. */
  function assertNothingHappened(): void {
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockCheckInFlight).not.toHaveBeenCalled();
    expect(mockResolveStepClients).not.toHaveBeenCalled();
  }

  it("REFUSES before any signing when the card said a fee is taken and this bridge would skip it", async () => {
    // The dust arm of the same divergence class as a token flagged
    // fee-on-transfer after the card was shown: the row still says charged, the
    // fresh derivation says nothing is taken, so the amount that would actually
    // be bridged is not the amount the card stated.
    mockAdapt.mockReturnValue(adaptedOk({
      currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "300", amountFormatted: "0.0000000000000003", amountUsd: null, minimumAmountRaw: null },
    }));

    const result = await runBridge({ ...PARAMS, amountRaw: "300" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("relay.bridge failed:");
    expect(result.output).toContain("The Vex fee statement this approval was granted on no longer holds");
    expect(result.output).toContain("Nothing was signed and nothing was broadcast");
    expect(result.output).toContain("relay__bridge_quote_get");
    // An authorization refusal is not a bridge that failed: no durable
    // failure row is written for it, exactly as the prequote gate writes none.
    expect(mockPreFail).not.toHaveBeenCalled();
    assertNothingHappened();
  });

  it("REFUSES and names the moved amount when the bound fee is not the fee this bridge would take", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
      feeAmountRaw: "2000000000000", netAmountRaw: "998000000000000", totalDebitedRaw: "1000000000000000",
    })));

    const result = await runBridge();

    expect(result.success).toBe(false);
    expect(result.output).toContain("2000000000000 raw units");
    expect(result.output).toContain("2500000000000 raw units");
    assertNothingHappened();
  });

  it("REFUSES when the card stated no fee and this bridge would take one", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(
      matchedPrequoteWithVexFee(boundSkippedVexFee({ totalDebitedRaw: "1000000000000000" })),
    );

    const result = await runBridge();

    expect(result.success).toBe(false);
    expect(result.output).toContain("NO Vex fee would be taken");
    assertNothingHappened();
  });

  it("FAILS CLOSED when the bound row carries no readable fee statement at all", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(undefined));

    const result = await runBridge();

    expect(result.success).toBe(false);
    expect(result.output).toContain("no readable Vex fee statement");
    assertNothingHappened();
  });

  it("REFUSES when the approved row was superseded while the approval waited", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue({ ok: false, reason: "approval_row_superseded" });

    const result = await runBridge();

    expect(result.success).toBe(false);
    expect(result.output).toContain("no longer the current one");
    assertNothingHappened();
  });

  it("proceeds to sign when the statement holds, and reads the row AFTER the quote", async () => {
    const result = await runBridge();

    expect(mockSign).toHaveBeenCalled();
    expect(outputOf(result).status).toBe("pending");
    // The comparison must see the disposition the deposit would use, so the
    // quote is what it is compared against, not a pre-quote guess.
    const readOrder = firstCallOrder(mockFindFreshMatchedPrequote);
    expect(firstCallOrder(mockGetQuote)).toBeLessThan(readOrder);
    expect(firstCallOrder(mockSign)).toBeGreaterThan(readOrder);
  });

  it("a dryRun never reads the bound row: it is a preview, it signs nothing", async () => {
    await runBridge({ ...PARAMS, dryRun: true });
    expect(mockFindFreshMatchedPrequote).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Pre-sign gates: each failure records a HASHLESS row + broadcasts NOTHING ──
describe("relay.bridge — pre-sign gate failures (C1: hashless failed row, no broadcast)", () => {
  it("health gate unserviceable → chain_unsupported failure row, no intent, no sign", async () => {
    mockHealth.mockReturnValue({ serviceable: false, failedSide: "destination", chainId: 4663, reason: "deposit_not_enabled" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail).toHaveBeenCalledTimes(1);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "chain_unsupported", protocol: "relay", toolId: "relay.bridge" });
    expect(mockGetQuote).not.toHaveBeenCalled(); // health fails BEFORE the quote
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(outputOf(result).status).toBe("rejected");
  });

  it("correlation gate failure → bridge_failed failure row, no intent, no sign", async () => {
    mockCorrelation.mockReturnValue({ ok: false, reason: "missing_request_id", stepId: null, detail: "no requestId" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("step-policy rejection (origin-only, B3) → bridge_failed failure row, no sign", async () => {
    mockStepPolicy.mockReturnValue({ ok: false, reason: "step_chain_not_origin", stepId: "deposit", detail: "targets chain 4663, not the origin 8453" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(String(mockPreFail.mock.calls[0]![0].failureReason)).toContain("origin");
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("no origin deposit as the final step → bridge_failed failure row, no sign", async () => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep] }); // approve only, no deposit
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("empty quote steps → route_not_found failure row, no sign", async () => {
    mockGetQuote.mockResolvedValue(quote([]));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "route_not_found" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("getQuote throws → bridge_failed failure row (scrubbed), no sign", async () => {
    mockGetQuote.mockRejectedValue(new Error("relay 500 https://api.relay.link/quote/v2 boom"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("client resolution failure is PRE-intent → hashless failed row, no intent, no strand (blocker 3)", async () => {
    // Registry/RPC/client construction fails (e.g. a Relay-only origin with no
    // safe RPC). It must fail BEFORE the intent exists so no pending plan is
    // stranded and the in-flight guard is never taken.
    mockResolveStepClients.mockRejectedValue(new Error("relay chain 999 exposes no safe public HTTPS RPC"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("rejected");
    expect(mockPreFail).toHaveBeenCalledTimes(1);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
  });
});

// ── In-flight guard (C2) ──
describe("relay.bridge — in-flight guard (C2)", () => {
  it("friendly pre-check inFlight → clear message, no intent, no sign", async () => {
    mockCheckInFlight.mockResolvedValue({ inFlight: true, existing: { id: 5 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/already in flight for this route/i);
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("authoritative DB conflict (unique violation) → clear message, no sign", async () => {
    mockCreateIntent.mockResolvedValue({ outcome: "in_flight_conflict", existing: null });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/already in flight for this route/i);
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Staged broadcast + truthful pending output ──
describe("relay.bridge — staged broadcast (R4) + truthful pending (B5/C3)", () => {
  it("confirmed deposit → success:false pending, logical NOT confirmed, requestId attached, tracked-automatically", async () => {
    const result = await runBridge();
    // success-while-pending is FORBIDDEN: a broadcast bridge is NOT final.
    expect(result.success).toBe(false);
    const out = outputOf(result);
    expect(out.status).toBe("pending");
    expect(out.requestId).toBe("0xreq");
    // TWO origin broadcasts now: the deposit, then Vex's own 25 bps treasury
    // transfer (`@tools/bridge-fee`). The fee leg is a real movement of user
    // funds, so it is surfaced here rather than hidden. `mockSign` returns the
    // same stub hash for both.
    expect(out.inTxHashes).toEqual(["0xdep", "0xdep"]);
    expect(String(out.message)).toMatch(/track(?:ed|ing)(?: it)? automatically/i);

    // Full staging discipline ran for the deposit leg AND the fee leg.
    expect(mockMarkBroadcast).toHaveBeenCalledTimes(2);
    expect(mockMarkAccepted).toHaveBeenCalledTimes(2);
    expect(mockConfirm).toHaveBeenCalledWith(200, {});
    // The fee is disclosed on the execute output, never silent.
    const vexFee = out.vexFee as Record<string, unknown>;
    expect(vexFee.charged).toBe(true);
    expect(vexFee.bps).toBe(25);
    expect(vexFee.feeAmountRaw).toBe("2500000000000"); // 25 bps of 1e15 wei
    expect(vexFee.collection).toBe("confirmed");
    // requestId attached AFTER submission (R5).
    expect(mockAttach).toHaveBeenCalledWith({ executionId: 100, providerOrderId: "0xreq" });
    // The logical fill row is NEVER confirmed in-turn (W4 owns verified confirm).
    expect(mockConfirm).not.toHaveBeenCalledWith(300, expect.anything());
    expect(mockPoll).toHaveBeenCalledWith("0xreq");
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("_executionId is threaded so post-handler capture reuses the intent row", async () => {
    const result = await runBridge();
    expect((result.data as { _executionId?: number })._executionId).toBe(100);
  });

  it("a confirm CAS miss to a non-confirmed state marks the leg confirmed_unrecorded, never ordinary (m5-relay / C41)", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { id: 200, status: "definitively_failed" } });
    const result = await runBridge();
    const legs = outputOf(result).legs as Array<{ role: string; status: string }>;
    const deposit = legs.find((l) => l.role === "bridge_deposit");
    expect(deposit?.status).toBe("confirmed_unrecorded");
  });

  it("a confirm CAS miss where the row is ALREADY confirmed is a benign race → ordinary confirmed", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { id: 200, status: "confirmed" } });
    const result = await runBridge();
    const legs = outputOf(result).legs as Array<{ role: string; status: string }>;
    const deposit = legs.find((l) => l.role === "bridge_deposit");
    expect(deposit?.status).toBe("confirmed");
  });

  it("in-turn provider 'success' still returns NOT-final (verified confirm left to W4)", async () => {
    mockPoll.mockResolvedValue({ status: "success", observed: true, destinationTxHashes: ["0xfill"] });
    const result = await runBridge();
    expect(result.success).toBe(false);
    const out = outputOf(result);
    expect(out.status).toBe("pending");
    expect(out.txHashes).toEqual(["0xfill"]);
    expect(String(out.message)).toMatch(/verify|in progress/i);
    expect(mockConfirm).not.toHaveBeenCalledWith(300, expect.anything());
  });

  it("in-turn provider 'refund' surfaces the money-back-≠-success distinction, row stays pending for W4", async () => {
    mockPoll.mockResolvedValue({ status: "refund", observed: true, destinationTxHashes: [] });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/refund/i);
    // Never terminalized in-turn (W4's verified sweep owns refund terminalization).
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("ERC-20 onto a local chain is auto-pinned (fail-soft)", async () => {
    await runBridge({ ...PARAMS, toToken: ERC20 });
    expect(mockPin).toHaveBeenCalledWith({ walletAddress: SEL_EVM, chainId: 4663, tokenAddress: ERC20, source: "bridge" });
  });

  it("a NATIVE destination is not pinned (native is always read)", async () => {
    await runBridge({ ...PARAMS, toToken: "native" });
    expect(mockPin).not.toHaveBeenCalled();
  });
});

// ── Staging failure modes ──
describe("relay.bridge — staging failure modes", () => {
  it("CAS miss on markActivityBroadcast aborts BEFORE an untracked broadcast", async () => {
    mockMarkBroadcast.mockResolvedValue({ applied: false, row: { id: 0 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("interrupted");
    // Never confirmed; the never-signed rows are aborted.
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockAbort).toHaveBeenCalledWith(100, 0, expect.any(String));
  });

  it("origin deposit reverted → leg + logical failed bridge_failed, remaining aborted", async () => {
    mockSign.mockImplementation(signAs("reverted", "0xrev"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("failed");
    expect(mockFail).toHaveBeenCalledWith(200, expect.objectContaining({ failureCode: "bridge_failed" }));
    expect(mockFail).toHaveBeenCalledWith(300, expect.objectContaining({ failureCode: "bridge_failed" }));
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("ambiguous deposit → pending (unconfirmed), requestId attached, NO in-turn poll", async () => {
    mockSign.mockImplementation(signAs("ambiguous", "0xamb"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("pending");
    expect(String(outputOf(result).message)).toMatch(/could not yet confirm/i);
    expect(mockAttach).toHaveBeenCalledWith({ executionId: 100, providerOrderId: "0xreq" });
    expect(mockPoll).not.toHaveBeenCalled();
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("ambiguous APPROVE → deposit never signed, deposit + logical aborted, one broadcast only", async () => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
    mockSign.mockImplementation(signAs("ambiguous", "0xapprove")); // the FIRST (approve) leg is ambiguous
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("unconfirmed");
    expect(mockSign).toHaveBeenCalledTimes(1); // deposit was never signed
    expect(mockAbort).toHaveBeenCalledWith(100, 1, expect.any(String)); // aborts deposit + logical
  });

  it("attach anomaly (conflict_different_id) is best-effort — the bridge still returns pending", async () => {
    mockAttach.mockResolvedValue({ outcome: "conflict_different_id", row: { id: 300 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("pending");
  });
});

/**
 * Live 2026-07-25 regression: the origin approve
 * `0x68dec753bc925c2d255104e22a27cc0c62ea9b5c85160fd99661a0009f378548`
 * CONFIRMED, then the deposit leg was refused pre-sign with `Execution
 * reverted for an unknown reason`; an immediate retry of the unchanged
 * transaction landed (`0xc96bfee1…`). The refusal was reported as an
 * unexplained interruption, which is what makes a transient RPC lag permanent
 * for an autonomous agent.
 */
describe("relay.bridge — deposit refused because its estimate never succeeded after a confirmed approve", () => {
  const APPROVE_BLOCK = 34_567_890n;
  const LIVE_DEPOSIT_REVERT = "Execution reverted for an unknown reason.";

  /** approve confirms (carrying its receipt block), then the deposit leg throws `err`. */
  function approveThenDepositThrows(err: Error) {
    let leg = 0;
    return async (
      _p: unknown, _w: unknown, _tx: unknown,
      hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
    ) => {
      if (leg++ === 0) {
        await hooks.onHashStaged({ txHash: "0xapprove", fromAddress: SEL_EVM, nonce: 1 });
        await hooks.onAccepted();
        return { kind: "confirmed", txHash: "0xapprove", receipt: { blockNumber: APPROVE_BLOCK } };
      }
      throw err;
    };
  }

  beforeEach(() => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
  });

  it("threads the confirmed approve's receipt block into the deposit leg's estimate", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new Error(LIVE_DEPOSIT_REVERT)));

    await runBridge();

    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockSign.mock.calls[0]![4]).toBeUndefined(); // the approve has nothing before it
    expect(mockSign.mock.calls[1]![4]).toEqual({ blockNumber: APPROVE_BLOCK });
  });

  it("reports a stale-estimate refusal as not_attempted + safe to re-run, and records the marker", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: APPROVE_BLOCK,
      observedHeadBlock: APPROVE_BLOCK,
      cause: new Error(LIVE_DEPOSIT_REVERT),
    })));

    const result = await runBridge();
    const body = outputOf(result);

    expect(result.success).toBe(false);
    expect(body.status).toBe("not_attempted");
    expect(String(body.message)).toContain("Nothing was signed or broadcast");
    expect(String(body.message)).toContain("reasonable");
    // The durable reason (via abortPlannedEvents) carries the same discriminator.
    expect(mockAbort).toHaveBeenCalledWith(100, 1, expect.stringContaining(DEPENDENT_LEG_ESTIMATE_MARKER));
    // Aborting from the deposit index onward finalizes the logical fill row too,
    // which is what releases the in-flight guard so re-running is actually possible.
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("a genuine failure at the same point still reads as an interruption — the two are NOT the same message", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new Error(LIVE_DEPOSIT_REVERT)));
    const genuine = outputOf(await runBridge());

    vi.clearAllMocks();
    mockGetCachedRelayChains.mockResolvedValue(CHAINS);
    mockGetQuote.mockResolvedValue(quote());
    mockAdapt.mockReturnValue(adaptedOk());
    mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1], blockProductionLagging: [] });
    mockCorrelation.mockReturnValue({ ok: true, requestId: "0xreq" });
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
    mockCheckInFlight.mockResolvedValue({ inFlight: false, existing: null });
    mockResolveStepClients.mockResolvedValue({ publicClient: {}, walletClient: {} });
    mockPlanStepTx.mockReturnValue({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n });
    mockCreateIntent.mockImplementation(async (input: { legs: unknown[] }) => ({
      outcome: "created", executionId: 100,
      legs: input.legs.map((_l, i) => ({ id: 200 + i })), expectedFill: { id: 300 },
    }));
    mockMarkBroadcast.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockMarkAccepted.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockConfirm.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockAbort.mockResolvedValue([]);
    mockSign.mockImplementation(approveThenDepositThrows(new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: APPROVE_BLOCK,
      observedHeadBlock: APPROVE_BLOCK,
      cause: new Error(LIVE_DEPOSIT_REVERT),
    })));
    const stale = outputOf(await runBridge());

    expect(genuine.status).toBe("interrupted");
    expect(String(genuine.message)).toContain("An internal error interrupted the bridge");
    expect(String(genuine.message)).not.toContain("Nothing was signed or broadcast");
    expect(String(stale.message)).not.toEqual(String(genuine.message));
  });
});

// ── USD nullable propagation ──
describe("relay.bridge — USD nullable end-to-end (Q2)", () => {
  it("null quote USD → expectedFill usd*Est undefined + output usd null (never fabricated)", async () => {
    mockAdapt.mockReturnValue(adaptedOk({
      currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: null },
      currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "995000000000000", amountFormatted: "0.000995", amountUsd: null },
    }));
    const result = await runBridge();
    const intentInput = mockCreateIntent.mock.calls[0]![0] as { expectedFill: Record<string, unknown> };
    expect(intentInput.expectedFill.usdInEst).toBeUndefined();
    expect(intentInput.expectedFill.usdOutEst).toBeUndefined();
    const amounts = outputOf(result).amounts as { in: { usd: unknown }; out: { usd: unknown } };
    expect(amounts.in.usd).toBeNull();
    expect(amounts.out.usd).toBeNull();
  });

  it("route endpoints use the canonical toRelayCurrency tuples (W5 key-consistency)", async () => {
    await runBridge();
    const intentInput = mockCreateIntent.mock.calls[0]![0] as { route: Record<string, unknown> };
    expect(intentInput.route).toMatchObject({
      fromChainId: 8453, fromChainFamily: "eip155", fromToken: ZERO,
      toChainId: 4663, toChainFamily: "eip155", toToken: ZERO,
    });
  });
});

// ── dryRun preview ──
describe("relay.bridge — dryRun preview signs and records nothing", () => {
  it("returns a preview (serviceable/correlated/stepsValid) without signing or recording", async () => {
    const result = await runBridge({ ...PARAMS, dryRun: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.serviceable).toBe(true);
    expect(data.stepsValid).toBe(true);
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockPreFail).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Read handler ──
describe("W4a — the slippage tolerance is sent EXPLICITLY on both lanes", () => {
  // Relay auto-computes a tolerance when `slippageTolerance` is omitted. Vex's
  // price protection must not be the provider's choice, so BOTH the quote and
  // the execute send the resolved value — the same one the prequote identity
  // binds — even when the caller supplied none.
  it("relay.quote.get sends the Vex default when the caller omits slippageBps", async () => {
    await RELAY_BRIDGE_HANDLERS["relay.quote.get"](PARAMS, CTX);
    const request = firstQuoteRequest();
    expect(request.slippageTolerance).toBe(String(VEX_DEFAULT_SLIPPAGE_BPS));
  });

  it("relay.bridge sends the SAME default on the execute lane", async () => {
    await RELAY_BRIDGE_HANDLERS["relay.bridge"]({ ...PARAMS, dryRun: true }, CTX);
    const request = firstQuoteRequest();
    expect(request.slippageTolerance).toBe(String(VEX_DEFAULT_SLIPPAGE_BPS));
  });

  it("an explicit tolerance is forwarded verbatim, never the default", async () => {
    await RELAY_BRIDGE_HANDLERS["relay.quote.get"]({ ...PARAMS, slippageBps: 200 }, CTX);
    const request = firstQuoteRequest();
    expect(request.slippageTolerance).toBe("200");
  });

  it("an over-ceiling tolerance is refused before any quote is requested", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"]({ ...PARAMS, slippageBps: 5000 }, CTX);
    expect(result.success).toBe(false);
    expect(mockGetQuote).not.toHaveBeenCalled();
  });
});

describe("relay.quote.get — read preview keeps the prequote structural shape + records nothing", () => {
  it("returns provider/origin/destination/steps + agent-grade amounts, no recording", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"](PARAMS, CTX);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.provider).toBe("relay");
    expect(data.originChainId).toBe(8453);
    expect(data.destinationChainId).toBe(4663);
    expect(Array.isArray(data.steps)).toBe(true);
    expect(data.serviceable).toBe(true);
    expect((data.amounts as { in: { usd: unknown } }).in.usd).toBe("2.94");
    // W2c: the decline signals are projected onto the read surface. Absent here
    // (the adapter is mocked), so they must be NULL — never an invented number.
    expect(data.totalImpactPercent).toBeNull();
    expect(data.minimumAmountOutRaw).toBeNull();
    expect(String((data as { summary: string }).summary)).not.toContain("undefined");
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockPreFail).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  // W2c: an agent that cannot see -11.53 % total impact cannot decline a bad
  // bridge, and the guaranteed floor is the number `slippageBps` controls.
  it("surfaces total price impact, the worst-case received amount, and the applied tolerance", async () => {
    mockAdapt.mockReturnValue(adaptedOk({
      totalImpactPercent: "-11.53",
      destinationSlippagePercent: "0.99",
      currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "88466568981856", amountFormatted: "0.0000884", amountUsd: "0.162859", minimumAmountRaw: "87581903292038" },
    }));
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"](PARAMS, CTX);
    const data = result.data as Record<string, unknown>;
    expect(data.totalImpactPercent).toBe("-11.53");
    expect(data.minimumAmountOutRaw).toBe("87581903292038");
    expect(data.appliedSlippagePercent).toBe("0.99");
    expect(String(data.summary)).toContain("-11.53%");
    expect(String(data.summary)).toContain("87581903292038");
  });

  it("warns when Relay reports the destination chain's block production lagging", async () => {
    mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1], blockProductionLagging: ["destination"] });
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"](PARAMS, CTX);
    const data = result.data as Record<string, unknown>;
    expect(String(data.summary)).toContain("block production lagging");
    expect(data.serviceable).toBe(true);
    expect(data.blockProductionLagging).toEqual(["destination"]);
  });
});

// ── Scrub boundary on the leg-resolution path (FIX5) ──
//
// `resolveLegs` throws locally-authored text, but `resolveRelayChainId` echoes
// the MODEL-SUPPLIED chain value verbatim (`Relay does not support chain
// "<input>".`). Both handlers returned that raw `err.message`, so a
// model-injected URL or key-shaped string reached tool output without ever
// passing the sanitisation boundary. Chain resolution is real here (only the
// Relay client/gates are mocked), so these exercise the true throw.
describe("the bridge destination is DERIVED - both Relay entry points", () => {
  /**
   * `recipient` used to be a Relay bridge param defaulted to the selected
   * wallet, so a model (or an injection reaching tool params) could name any
   * address and the funds would go there. Rule 90: a value that can redirect
   * funds never originates from model input; both wallet references agree
   * (MetaMask quotes for the selected account, Rabby's bridge UI has no
   * recipient input). The capability is REMOVED and the key is refused by name.
   */
  const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

  it("the quote request delivers to the session's selected wallet", async () => {
    await RELAY_BRIDGE_HANDLERS["relay.quote.get"](PARAMS, CTX);

    const request = firstQuoteRequest();
    expect(request.recipient).toBe(SEL_EVM);
    expect(request.user).toBe(SEL_EVM);
    expect(request.refundTo).toBe(SEL_EVM);
  });

  it("the execute request delivers to the session's selected wallet", async () => {
    await runBridge();

    const request = firstQuoteRequest();
    expect(request.recipient).toBe(SEL_EVM);
  });

  for (const toolId of ["relay.quote.get", "relay.bridge"] as const) {
    it(`${toolId} rejects a supplied recipient BY NAME, quoting nothing and signing nothing`, async () => {
      const result = await RELAY_BRIDGE_HANDLERS[toolId]({ ...PARAMS, recipient: ATTACKER }, CTX);

      expect(result.success).toBe(false);
      expect(result.output).toContain("recipient is not a parameter");
      // The address the bridge WOULD deliver to, and the tool that can send
      // somewhere else - not a bare refusal the agent retries under a synonym.
      expect(result.output).toContain(SEL_EVM);
      expect(result.output).toContain("WalletSendPrepare");
      expect(result.output).not.toContain(ATTACKER);
      // No provider request, no recording, no signing.
      expect(mockGetQuote).not.toHaveBeenCalled();
      expect(mockCreateIntent).not.toHaveBeenCalled();
      expect(mockPreFail).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });
  }
});

describe("relay leg resolution — model-supplied params reach output only through the scrub boundary", () => {
  const INJECTED_URL = "https://evil.example.com/x?key=LEAKEDKEY123";

  it("relay.quote.get redacts a URL injected through fromChain", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"](
      { ...PARAMS, fromChain: INJECTED_URL },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("LEAKEDKEY123");
    expect(result.output).not.toContain("evil.example.com");
    expect(result.output).toContain("[url]");
    // The honest part of the message still reaches the agent.
    expect(result.output).toMatch(/does not support chain/i);
  });

  it("relay.bridge redacts a URL injected through toChain — before any quote or signing", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"](
      { ...PARAMS, toChain: INJECTED_URL },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("LEAKEDKEY123");
    expect(result.output).not.toContain("evil.example.com");
    expect(result.output).toContain("[url]");
    expect(mockGetQuote).not.toHaveBeenCalled();
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("redacts a key-shaped string injected through a chain param", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"](
      { ...PARAMS, fromChain: "apiKey=sk-or-v1-abcdef0123456789" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-or-v1-abcdef0123456789");
  });
});

// ── The receipt floor makes the Vex fee leg ineligible ─────────────────────
//
// A deposit that moved LESS than the principal the user consented to did not
// perform the operation the fee is charged for (rule 90: take a fee only after
// the operation it charges for succeeds). `floor - 1` on an ERC-20 origin:
// nothing with a `vex_fee` role reaches `signStageBroadcast`, so no nonce is
// reserved and nothing is staged for it, and the planned fee row is aborted.

describe("relay.bridge - a deposit below the receipt floor is never charged a fee", () => {
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const DEPOSIT_TARGET = "0x2222222222222222222222222222222222222222";
  const padded = (address: string): string => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  /** The post-fee principal for a 1,000,000-unit ERC-20 bridge at 25 bps. */
  const PRINCIPAL = 997_500n;
  const ERC20_PARAMS = { ...PARAMS, fromToken: ERC20, amountRaw: "1000000" };

  /** Every leg confirms; the deposit's receipt carries one Transfer of `moved`. */
  function signWithDepositTransfer(moved: bigint) {
    return async (
      _p: unknown, _w: unknown, tx: { to: string },
      hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
    ) => {
      await hooks.onHashStaged({ txHash: "0xdep", fromAddress: SEL_EVM, nonce: 1 });
      await hooks.onAccepted();
      return {
        kind: "confirmed",
        txHash: "0xdep",
        receipt: {
          blockNumber: 1n,
          logs: [{
            address: ERC20,
            topics: [TRANSFER_TOPIC, padded(SEL_EVM), padded(DEPOSIT_TARGET)],
            data: `0x${moved.toString(16).padStart(64, "0")}`,
          }],
        },
      };
    };
  }

  beforeEach(() => {
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
      feeAmountRaw: "2500", netAmountRaw: "997500", totalDebitedRaw: "1000000",
    })));
    mockAdapt.mockReturnValue(adaptedOk({
      currencyIn: {
        symbol: "USDC", decimals: 6, currencyAddress: ERC20, amountRaw: "997500",
        amountFormatted: "0.9975", amountUsd: "1.00", minimumAmountRaw: null,
      },
    }));
    mockPlanStepTx.mockReturnValue({ to: DEPOSIT_TARGET, data: "0xe8017952", value: 0n });
  });

  it("signs the fee leg when the deposit moved the whole principal (positive control)", async () => {
    mockSign.mockImplementation(signWithDepositTransfer(PRINCIPAL));

    const result = await runBridge(ERC20_PARAMS);

    // Two signatures: the deposit, then the Vex fee transfer.
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(outputOf(result).vexFee).toBeDefined();
  });

  it("signs NOTHING for the fee when the deposit moved one unit less than the principal", async () => {
    mockSign.mockImplementation(signWithDepositTransfer(PRINCIPAL - 1n));

    const result = await runBridge(ERC20_PARAMS);

    // The deposit signed; the fee leg never reached the signer, so no nonce was
    // reserved for it and nothing was staged or broadcast under its row.
    expect(mockSign).toHaveBeenCalledTimes(1);
    // The planned fee row is aborted rather than left pending forever.
    expect(mockAbort).toHaveBeenCalled();
    // The tool result names BOTH figures, so the human can compare them.
    const body = JSON.stringify(outputOf(result));
    expect(body).toContain("997499");
    expect(body).toContain("997500");
    expect(body).toMatch(/No Vex fee was taken/i);
  });
});
