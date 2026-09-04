/**
 * relay.bridge — how a native-value refusal reaches the AGENT (phase-3 W3).
 *
 * `planRelayStepTx` refuses a `tx.value` Vex cannot attribute (its own suite is
 * `__tests__/tools/relay/native-value-gate.test.ts`). This file pins the other
 * half, which is a wording contract, not an arithmetic one: what the handler
 * TELLS an autonomous agent when that refusal fires.
 *
 * Before this branch existed the refusal fell into the generic post-intent
 * catch and came back as `status: "interrupted"` — "An internal error
 * interrupted the bridge after it was recorded … Check the record before any
 * further action." That is unusable mid-mission: it reads as "funds may be in
 * flight", it names no action, and it does not say the same quote is
 * deterministically refused, so an agent re-sends it forever.
 *
 * The handler's own orchestration (staging, CAS, pending output) is covered by
 * `bridge.test.ts`; the mocks here mirror that file so this stays a wording +
 * control-flow test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";

const mockGetQuote = vi.fn();
const mockGetIntentStatus = vi.fn();
const mockGetCachedRelayChains = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({
    getQuote: (...a: unknown[]) => mockGetQuote(...a),
    getIntentStatus: (...a: unknown[]) => mockGetIntentStatus(...a),
  }),
  getCachedRelayChains: (...a: unknown[]) => mockGetCachedRelayChains(...a),
}));

// `planRelayStepTx` is driven per-test; `native-value.js` stays REAL so the
// refusal wording under test is the shipped wording, not a fixture of it.
const mockResolveStepClients = vi.fn();
const mockPoll = vi.fn();
const mockPlanStepTx = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  resolveRelayStepClients: (...a: unknown[]) => mockResolveStepClients(...a),
  pollRelayIntentStatus: (...a: unknown[]) => mockPoll(...a),
  planRelayStepTx: (...a: unknown[]) => mockPlanStepTx(...a),
}));

const mockSign = vi.fn();
vi.mock("@tools/kyberswap/evm/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSign(...a),
}));

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

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

vi.mock("@config/store.js", () => ({ loadConfig: () => ({ services: { relayApiUrl: "https://api.relay.link" } }) }));
const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...a: unknown[]) => mockPin(...a) }));

const mockCreateIntent = vi.fn();
const mockPreFail = vi.fn();
const mockCheckInFlight = vi.fn();
const mockAttach = vi.fn();
const mockMarkBroadcast = vi.fn();
const mockMarkAccepted = vi.fn();
const mockConfirm = vi.fn();
const mockFail = vi.fn();
const mockAbort = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
  createBridgePreBroadcastFailure: (...a: unknown[]) => mockPreFail(...a),
  checkBridgeInFlight: (...a: unknown[]) => mockCheckInFlight(...a),
  attachProviderOrderId: (...a: unknown[]) => mockAttach(...a),
  markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
}));

const { RELAY_BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/relay/handlers/bridge.js");
const { relayNativeValueRefusal } = await import("@tools/relay/native-value.js");
const { VexError, ErrorCodes } = await import("../../../../errors.js");

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

function executeRelay(params = PARAMS, context: ProtocolExecutionContext = CTX) {
  const handler = RELAY_BRIDGE_HANDLERS["relay.bridge"];
  if (!handler) throw new Error("relay.bridge handler missing");
  return handler(params, context);
}

function txStep(id: string, chainId = 8453) {
  return { id, kind: "transaction", requestId: "0xreq", items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1000000000000000", data: "0x", chainId } }] };
}
function quote(steps = [txStep("deposit")]): RelayQuoteResponse {
  return { steps, requestId: "0xreq" } as unknown as RelayQuoteResponse;
}
function adaptedOk() {
  return {
    requestId: "0xreq",
    operation: "bridge",
    timeEstimateSeconds: 12,
    usdSource: "relay_quote_v2",
    currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: "2.94" },
    currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "995000000000000", amountFormatted: "0.000995", amountUsd: "2.92" },
    feeUsdByBucket: { relayer: "0.02" },
  };
}

const depositStep = { stepId: "deposit", role: "bridge_deposit", chainId: 8453, step: txStep("deposit") };

function outputOf(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

/** The exact error `planRelayStepTx` throws when a surcharge cannot be attributed. */
function unauthorizedNativeValue(): VexError {
  return new VexError(
    ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
    relayNativeValueRefusal("bridge_deposit", "1000000000000000 wei of native value could not be attributed to a proven cost component"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue(quote());
  mockAdapt.mockReturnValue(adaptedOk());
  mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1], blockProductionLagging: [] });
  mockCorrelation.mockReturnValue({ ok: true, requestId: "0xreq" });
  mockStepPolicy.mockReturnValue({ ok: true, steps: [depositStep] });
  mockCheckInFlight.mockResolvedValue({ inFlight: false, existing: null });
  mockResolveStepClients.mockResolvedValue({ publicClient: {}, walletClient: {} });
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
  mockPin.mockResolvedValue({ inserted: true });
  mockPlanStepTx.mockReturnValue({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n });
  mockSign.mockResolvedValue({ kind: "confirmed", txHash: "0xdep", receipt: {} });
});

describe("relay.bridge — what Vex derives for the native-value gate", () => {
  it("returns a structured pre-sign refusal when trusted metadata is unavailable", async () => {
    const result = await executeRelay(PARAMS, {
      ...CTX,
      bridgeTokenPreview: {
        source: {
          family: "eip155", kind: "metadata_unavailable", chainId: 8453, tokenAddress: ZERO,
          symbol: null, decimals: null, metadataSource: "chain_registry_unavailable", symbolSanitized: false,
          metadataErrorCode: "native_registry_metadata_unavailable",
          metadataErrorMessage: "Native currency symbol and decimals are unavailable in the venue chain registry.",
        },
        destination: {
          family: "eip155", kind: "native", chainId: 4663, tokenAddress: ZERO,
          symbol: "ETH", decimals: 18, metadataSource: "chain_registry", symbolSanitized: false,
        },
        amountRaw: "1000000000000000",
        amountHuman: null,
      },
    });
    const out = outputOf(result);

    expect(out).toMatchObject({ status: "rejected" });
    expect(out.message).toContain("nothing was signed");
    expect(mockPlanStepTx).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("hands the planner Vex's OWN post-fee amount and origin asset, never the quote's", async () => {
    await executeRelay();
    expect(mockPlanStepTx).toHaveBeenCalledTimes(1);
    const context = mockPlanStepTx.mock.calls[0]![3] as Record<string, unknown>;
    expect(context).toMatchObject({
      role: "bridge_deposit",
      originCurrency: ZERO,
      tradeType: "EXACT_INPUT",
    });
    // 0.001 ETH minus Vex's 25 bps — the amount Relay was actually quoted for.
    expect(context.bridgedAmountRaw).toBe("997500000000000");
  });
});

describe("relay.bridge — a refused native charge is reported honestly", () => {
  beforeEach(() => {
    mockPlanStepTx.mockImplementation(() => {
      throw unauthorizedNativeValue();
    });
  });

  it("nothing is signed and nothing is broadcast", async () => {
    await executeRelay();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockMarkBroadcast).not.toHaveBeenCalled();
  });

  it("the result is 'not_attempted', never the generic 'interrupted' body", async () => {
    const result = await executeRelay();
    expect(result.success).toBe(false);
    const body = outputOf(result);
    expect(body.status).toBe("not_attempted");
    expect(JSON.stringify(body)).not.toContain("Check the record before any further action");
  });

  it("names the unattributed amount and says nothing was signed or broadcast", async () => {
    const body = outputOf(await executeRelay());
    expect(String(body.message)).toContain("1000000000000000 wei");
    expect(String(body.message)).toMatch(/nothing was signed or broadcast for this step/i);
  });

  it("distinguishes a Vex policy refusal from a transport failure, and names what to do next", async () => {
    const body = outputOf(await executeRelay());
    const message = String(body.message);
    // Which state to change, and that re-sending THIS one cannot work.
    expect(message).toMatch(/NOT a network, provider or transport failure/i);
    expect(message).toMatch(/re-sending the SAME quote will be refused again/i);
    // Whether a fresh quote can succeed — the actionable path, stated as one.
    expect(message).toMatch(/Get a fresh relay__bridge_quote_get for this route and retry/i);
    expect(message).toMatch(/solver routing changes between quotes/i);
    // And the fallback when it does not.
    expect(message).toMatch(/bridge this route with khalani__bridge_execute instead/i);
  });

  it("marks the SAME quote as not retryable — a re-send is refused deterministically", async () => {
    const result = await executeRelay();
    expect((result.data as Record<string, unknown>).retryable).toBe(false);
  });

  it("finalizes the recorded plan as not-attempted so the in-flight guard releases", async () => {
    await executeRelay();
    expect(mockAbort).toHaveBeenCalled();
  });

  it("charges no Vex fee — the bridge did not happen", async () => {
    const body = outputOf(await executeRelay());
    expect(JSON.stringify(body.vexFee)).toContain("not_attempted");
  });
});
