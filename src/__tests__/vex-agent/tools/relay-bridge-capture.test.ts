/**
 * relay.bridge output evidence — RE-PINNED to the W-SPINE agent_activity contract
 * (Wave-3 W3b). Was: the legacy `_tradeCapture` proj_activity blob (single
 * ambiguous `chain` string + destination buried in `meta.destChain`). Now the
 * mutation matrix flips relay.bridge to capture:"none" and the handler records
 * directly to `agent_activity`; the two-hop evidence a bridge must preserve is
 * surfaced as a STRUCTURED, never-truncated `legs[]` (origin deposit leg on the
 * origin chain + the `bridge_fill_expected` leg on the destination chain), with
 * human amounts + per-side USD estimates and coherent per-hop `_explorerRefs`.
 *
 * WHAT CHANGED + WHY: the old suite asserted `_tradeCapture` (SYMBOL legs, raw
 * addresses, human amounts). That capture object no longer exists (capture:"none").
 * Coverage is preserved, re-pinned to the new truth: the SAME two-hop evidence
 * (two chains, both hashes, human amounts, symbols) now lives in `legs[]` +
 * `amounts` + `inTxHashes`/`txHashes`, and a broadcast bridge is truthfully
 * PENDING (success:false) — success-while-pending is forbidden (B5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
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

const mockAdapt = vi.fn();
vi.mock("@tools/relay/quote.js", () => ({ adaptRelayQuote: (...a: unknown[]) => mockAdapt(...a), RELAY_QUOTE_USD_SOURCE: "relay_quote_v2" }));
const mockHealth = vi.fn();
vi.mock("@tools/relay/health.js", () => ({ evaluateRelayRouteHealth: (...a: unknown[]) => mockHealth(...a) }));
vi.mock("@tools/relay/correlation.js", () => ({ assertRelayQuoteCorrelation: () => ({ ok: true, requestId: "0xreq" }) }));
const mockStepPolicy = vi.fn();
vi.mock("@tools/relay/step-policy.js", () => ({ classifyRelayBridgeSteps: (...a: unknown[]) => mockStepPolicy(...a) }));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));
vi.mock("@config/store.js", () => ({ loadConfig: () => ({ services: { relayApiUrl: "https://api.relay.link" } }) }));
const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...a: unknown[]) => mockPin(...a) }));

const mockCreateIntent = vi.fn();
const mockAttach = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
  createBridgePreBroadcastFailure: vi.fn(),
  checkBridgeInFlight: vi.fn().mockResolvedValue({ inFlight: false, existing: null }),
  attachProviderOrderId: (...a: unknown[]) => mockAttach(...a),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue([]),
}));

const { RELAY_BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/relay/handlers/bridge.js");

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

const PARAMS = { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: ERC20, amount: "1714000000000000" };

const depositStep = {
  stepId: "deposit", role: "bridge_deposit", chainId: 8453,
  step: { id: "deposit", kind: "transaction", requestId: "0xreq", items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1714000000000000", data: "0x", chainId: 8453 } }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue({ steps: [depositStep.step], requestId: "0xreq" } as unknown as RelayQuoteResponse);
  mockHealth.mockReturnValue({ serviceable: true });
  mockStepPolicy.mockReturnValue({ ok: true, steps: [depositStep] });
  mockAdapt.mockReturnValue({
    requestId: "0xreq", operation: "bridge", timeEstimateSeconds: 12, usdSource: "relay_quote_v2",
    currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1714000000000000", amountFormatted: "0.001714", amountUsd: "2.94" },
    currencyOut: { symbol: "VIRTUAL", decimals: 18, currencyAddress: ERC20, amountRaw: "5421000000000000000", amountFormatted: "5.421", amountUsd: "5.40" },
    feeUsdByBucket: { relayer: "0.02" },
  });
  mockCreateIntent.mockImplementation(async (input: { legs: unknown[] }) => ({ outcome: "created", executionId: 100, legs: input.legs.map((_l, i) => ({ id: 200 + i })), expectedFill: { id: 300 } }));
  mockAttach.mockResolvedValue({ outcome: "attached", row: {} });
  mockPoll.mockResolvedValue({ status: "submitted", observed: true, destinationTxHashes: ["0xfill"] });
  mockSign.mockImplementation(async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    await hooks.onHashStaged({ txHash: "0xorigin", fromAddress: SEL_EVM, nonce: 1 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xorigin", receipt: {} };
  });
  mockPin.mockResolvedValue({ inserted: true });
});

describe("relay.bridge — two-hop evidence via structured legs[] (no _tradeCapture)", () => {
  it("records SYMBOL + human amounts + per-side USD estimates in `amounts` (never raw wei / zero-address)", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    const out = JSON.parse(result.output) as Record<string, unknown>;
    const amounts = out.amounts as { in: Record<string, unknown>; out: Record<string, unknown> };
    expect(amounts.in).toMatchObject({ token: "ETH", tokenAddress: ZERO, amount: "0.001714", usd: "2.94" });
    expect(amounts.out).toMatchObject({ token: "VIRTUAL", tokenAddress: ERC20, amount: "5.421", usd: "5.40" });
  });

  it("legs[] carries BOTH hops — the origin deposit (Base) and the destination fill (Robinhood)", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    const out = JSON.parse(result.output) as { legs: Array<{ role: string; chainId: number; txHash: string | null }> };
    const deposit = out.legs.find((l) => l.role === "bridge_deposit");
    const fill = out.legs.find((l) => l.role === "bridge_fill_expected");
    expect(deposit).toMatchObject({ chainId: 8453, txHash: "0xorigin" });
    expect(fill).toMatchObject({ chainId: 4663 });
  });

  it("both-side hashes: inTxHashes (Vex origin) + txHashes (provider destination, unverified)", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    const out = JSON.parse(result.output) as Record<string, unknown>;
    // TWO Vex-signed origin transactions: the deposit and the 25 bps treasury
    // transfer (`@tools/bridge-fee`), which is a real fund movement and is
    // therefore surfaced rather than hidden. The stub returns one hash for both.
    expect(out.inTxHashes).toEqual(["0xorigin", "0xorigin"]);
    expect(out.txHashes).toEqual(["0xfill"]);
    // …and the fee itself is disclosed alongside them.
    expect(out.vexFee).toMatchObject({ charged: true, bps: 25, collection: "confirmed" });
  });

  it("_explorerRefs coherently pairs the origin hash with the origin chain (Vex-signed only)", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    const refs = (result.data as { _explorerRefs: Array<{ chain: string; txRef: string }> })._explorerRefs;
    // Both origin broadcasts (deposit + Vex fee transfer) are chain-paired; the
    // provider's destination hash stays out of this clickable set.
    expect(refs).toEqual([
      { chain: "8453", txRef: "0xorigin" },
      { chain: "8453", txRef: "0xorigin" },
    ]);
  });

  it("a broadcast bridge is truthfully PENDING — success-while-pending is forbidden (B5)", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    expect(result.success).toBe(false);
    expect((JSON.parse(result.output) as { status: string }).status).toBe("pending");
  });

  it("an ERC-20 landing on a LOCAL chain is auto-pinned (source 'bridge')", async () => {
    await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(PARAMS, CTX);
    expect(mockPin).toHaveBeenCalledWith({ walletAddress: SEL_EVM, chainId: 4663, tokenAddress: ERC20, source: "bridge" });
  });
});
