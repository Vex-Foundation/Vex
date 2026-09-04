/**
 * relay.bridge status honesty — RE-PINNED to the W-SPINE agent_activity contract
 * (Wave-3 W3b). Was: the handler called `executeRelayBridge` (validate → broadcast
 * → poll to terminal) and mapped its `finalStatus` to a success:true-while-pending
 * / success:false result. Now the handler stages the origin deposit itself and the
 * in-turn poll is INFORMATIONAL only.
 *
 * WHAT CHANGED + WHY: the old success:true-while-pending is remapped — a broadcast
 * bridge is NOT final, so EVERY reached-broadcast outcome returns success:false
 * (B5/C3: no premature balance seed, never read as completion). W3b NEVER
 * terminalizes the durable logical row from an in-turn provider status (even
 * 'success'/'failure'/'refund') — W4's verified sweep owns pending→confirmed,
 * refund terminalization, and reveal-clear. The only definitive in-turn failure is
 * a Vex-observed origin RECEIPT revert (distinct from any provider status).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ERC20 = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";

const mockGetQuote = vi.fn();
const mockGetCachedRelayChains = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({ getQuote: (...a: unknown[]) => mockGetQuote(...a), getIntentStatus: vi.fn() }),
  getCachedRelayChains: (...a: unknown[]) => mockGetCachedRelayChains(...a),
}));

const mockPoll = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  resolveRelayStepClients: vi.fn().mockResolvedValue({ publicClient: {}, walletClient: {} }),
  pollRelayIntentStatus: (...a: unknown[]) => mockPoll(...a),
  planRelayStepTx: () => ({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n }),
}));

const mockSign = vi.fn();
vi.mock("@tools/kyberswap/evm/staged-broadcast.js", () => ({ signStageBroadcast: (...a: unknown[]) => mockSign(...a) }));

vi.mock("@tools/relay/quote.js", () => ({
  adaptRelayQuote: () => ({
    requestId: "0xreq", operation: "bridge", timeEstimateSeconds: 12, usdSource: "relay_quote_v2",
    currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: "0x0000000000000000000000000000000000000000", amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: "2.94" },
    currencyOut: { symbol: "VIRTUAL", decimals: 18, currencyAddress: ERC20, amountRaw: "5000000000000000000", amountFormatted: "5.0", amountUsd: "5.0" },
    feeUsdByBucket: {},
  }),
  RELAY_QUOTE_USD_SOURCE: "relay_quote_v2",
}));
vi.mock("@tools/relay/health.js", () => ({ evaluateRelayRouteHealth: () => ({ serviceable: true, blockProductionLagging: [] }) }));
vi.mock("@tools/relay/correlation.js", () => ({ assertRelayQuoteCorrelation: () => ({ ok: true, requestId: "0xreq" }) }));
const depositStepDef = {
  stepId: "deposit", role: "bridge_deposit", chainId: 8453,
  step: { id: "deposit", kind: "transaction", requestId: "0xreq", items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1000000000000000", data: "0x", chainId: 8453 } }] },
};
vi.mock("@tools/relay/step-policy.js", () => ({ classifyRelayBridgeSteps: () => ({ ok: true, steps: [depositStepDef] }) }));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));
vi.mock("@config/store.js", () => ({ loadConfig: () => ({ services: { relayApiUrl: "https://api.relay.link" } }) }));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }) }));

const mockFail = vi.fn();
const mockAbort = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: vi.fn().mockImplementation(async (input: { legs: unknown[] }) => ({ outcome: "created", executionId: 100, legs: input.legs.map((_l, i) => ({ id: 200 + i })), expectedFill: { id: 300 } })),
  createBridgePreBroadcastFailure: vi.fn(),
  checkBridgeInFlight: vi.fn().mockResolvedValue({ inFlight: false, existing: null }),
  attachProviderOrderId: vi.fn().mockResolvedValue({ outcome: "attached", row: {} }),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
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
} = await import("../../tools/bridge-fee/bound-vex-fee.js");

const CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm", address: SEL_EVM }, solana: null },
  walletPolicy: { kind: "none" },
  sessionId: "sess-1",
  bridgeTokenPreview: {
    source: {
      family: "eip155", kind: "native", chainId: 8453, tokenAddress: "0x0000000000000000000000000000000000000000",
      symbol: "ETH", decimals: 18, metadataSource: "chain_registry", symbolSanitized: false,
    },
    destination: {
      family: "eip155", kind: "erc20", chainId: 4663, tokenAddress: ERC20,
      symbol: "VIRTUAL", decimals: 18, metadataSource: "rpc_contract", symbolSanitized: false,
    },
    amountRaw: "1000000000000000",
    amountHuman: "0.001",
  },
};
const CHAINS = [
  { id: 8453, name: "base", displayName: "Base", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
  { id: 4663, name: "robinhood", displayName: "Robinhood Chain", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
];
const PARAMS = { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: ERC20, amountRaw: "1000000000000000" };

function confirmedSign(txHash = "0xorigin") {
  return async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    await hooks.onHashStaged({ txHash, fromAddress: SEL_EVM, nonce: 1 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash, receipt: {} };
  };
}
async function run() {
  return RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
}
function out(result: { output: string }) {
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
    feeAmountRaw: "2500000000000", netAmountRaw: "997500000000000", totalDebitedRaw: "1000000000000000",
  })));
  vi.clearAllMocks();
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue({ steps: [depositStepDef.step], requestId: "0xreq" } as unknown as RelayQuoteResponse);
  mockSign.mockImplementation(confirmedSign());
  mockPoll.mockResolvedValue({ status: "submitted", observed: true, destinationTxHashes: [], failReason: null, refundFailReason: null, lastError: null });
  mockAbort.mockResolvedValue([]);
});

describe("relay.bridge — an in-turn provider status NEVER terminalizes the durable row (W4 owns it)", () => {
  for (const status of ["submitted", "pending", "delayed"]) {
    it(`non-terminal '${status}' → success:false pending, tracked automatically, row not failed`, async () => {
      mockPoll.mockResolvedValue({ status, observed: true, destinationTxHashes: [], failReason: null, refundFailReason: null, lastError: null });
      const result = await run();
      expect(result.success).toBe(false);
      expect(out(result).status).toBe("pending");
      expect(String(out(result).message)).toMatch(/track(?:ed|ing)(?: it)? automatically/i);
      expect(mockFail).not.toHaveBeenCalled();
    });
  }

  it("provider 'success' → still NOT-final (verified confirm deferred to W4), row not confirmed/failed", async () => {
    mockPoll.mockResolvedValue({ status: "success", observed: true, destinationTxHashes: ["0xfill"], failReason: null, refundFailReason: null, lastError: null });
    const result = await run();
    expect(result.success).toBe(false);
    expect(out(result).status).toBe("pending");
    expect(String(out(result).message)).toMatch(/verify|in progress/i);
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("provider 'refund' → money-back-≠-success message, row stays pending for W4 (not terminalized here)", async () => {
    mockPoll.mockResolvedValue({ status: "refund", observed: true, destinationTxHashes: [], failReason: null, refundFailReason: null, lastError: null });
    const result = await run();
    expect(result.success).toBe(false);
    expect(String(out(result).message)).toMatch(/refund/i);
    expect(String(out(result).message)).toMatch(/not a successful bridge/i);
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("provider 'failure' → destination-did-not-arrive message, row stays pending for W4", async () => {
    mockPoll.mockResolvedValue({ status: "failure", observed: true, destinationTxHashes: [], failReason: null, refundFailReason: null, lastError: null });
    const result = await run();
    expect(result.success).toBe(false);
    expect(String(out(result).message)).toMatch(/failed|did NOT arrive/i);
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("status API unreachable (observed:false) → still pending (deposit confirmed on origin; W4 tracks), NOT a hard failure", async () => {
    mockPoll.mockResolvedValue({ status: "pending", observed: false, destinationTxHashes: [], failReason: null, refundFailReason: null, lastError: null });
    const result = await run();
    expect(result.success).toBe(false);
    expect(out(result).status).toBe("pending");
    expect(out(result).providerStatus).toBeNull();
    expect(mockFail).not.toHaveBeenCalled();
  });
});

describe("relay.bridge — a Vex-observed origin RECEIPT revert IS a definitive failure (distinct from provider status)", () => {
  it("reverted origin deposit → success:false failed, leg + logical row failed bridge_failed", async () => {
    mockSign.mockImplementation(async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
      await hooks.onHashStaged({ txHash: "0xrev", fromAddress: SEL_EVM, nonce: 1 });
      await hooks.onAccepted();
      return { kind: "reverted", txHash: "0xrev", receipt: {} };
    });
    const result = await run();
    expect(result.success).toBe(false);
    expect(out(result).status).toBe("failed");
    expect(mockFail).toHaveBeenCalledWith(200, expect.objectContaining({ failureCode: "bridge_failed" }));
    expect(mockFail).toHaveBeenCalledWith(300, expect.objectContaining({ failureCode: "bridge_failed" }));
    // The in-turn poll is never reached on a reverted origin deposit.
    expect(mockPoll).not.toHaveBeenCalled();
  });
});
