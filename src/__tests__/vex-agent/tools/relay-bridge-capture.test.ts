/**
 * relay.bridge `_tradeCapture` shape — pins the MOVES-facing audit legs.
 *
 * A Relay bridge previously captured raw currency ADDRESSES (zero-address for
 * native ETH) as inputToken/outputToken and the raw wei request amount, which
 * the desktop MOVES panel rendered as `SWAP 0x0000…0000 → 0x0000…0000`.
 * This suite proves the capture now records:
 *   - SYMBOLS in inputToken/outputToken (quote `details` currency metadata,
 *     falling back to the chain registry's native-currency symbol, then to
 *     the raw address);
 *   - the raw currency addresses in inputTokenAddress/outputTokenAddress;
 *   - HUMAN-readable amounts (`details.currencyIn/Out.amountFormatted`, wei
 *     fallback only when Relay omits details);
 *   - the destination estimate as outputAmount;
 *   - meta.provider "relay" (venue provenance).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";

const mockGetQuote = vi.fn();
const mockGetCachedRelayChains = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({ getQuote: (...a: unknown[]) => mockGetQuote(...a) }),
  getCachedRelayChains: (...a: unknown[]) => mockGetCachedRelayChains(...a),
}));

const mockExecuteRelayBridge = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  executeRelayBridge: (...a: unknown[]) => mockExecuteRelayBridge(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

const mockPinTrackedToken = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: (...a: unknown[]) => mockPinTrackedToken(...a),
}));

const { RELAY_BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/relay/handlers/bridge.js");

const SESSION_CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm", address: SEL_EVM }, solana: null },
  walletPolicy: { kind: "none" },
};

const CHAINS = [
  { id: 8453, name: "base", currency: { symbol: "ETH", decimals: 18 } },
  { id: 4663, name: "robinhood", currency: { symbol: "ETH", decimals: 18 } },
];

const STEP = {
  id: "deposit",
  kind: "transaction",
  requestId: "0xreq",
  items: [{ status: "incomplete", data: { to: "0x2222222222222222222222222222222222222222", value: "1714000000000000", data: "0x", chainId: 8453 } }],
};

/** Live-confirmed (2026-07-06) POST /quote `details` shape, trimmed. */
function quoteWithDetails(): RelayQuoteResponse {
  return {
    steps: [STEP],
    details: {
      currencyIn: {
        currency: { chainId: 8453, address: ZERO, symbol: "ETH", decimals: 18 },
        amount: "1714000000000000",
        amountFormatted: "0.001714",
      },
      currencyOut: {
        currency: { chainId: 4663, address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", symbol: "VIRTUAL", decimals: 18 },
        amount: "5421000000000000000",
        amountFormatted: "5.421",
      },
    },
  } as RelayQuoteResponse;
}

const PARAMS = {
  fromChain: "base",
  fromToken: "native",
  toChain: "robinhood",
  toToken: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  amount: "1714000000000000",
};

interface Capture {
  [key: string]: unknown;
  meta: Record<string, unknown>;
}

async function runBridge(params: Record<string, unknown>): Promise<Capture> {
  const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(params, SESSION_CTX);
  expect(result.success).toBe(true);
  return (result.data as { _tradeCapture: Capture })._tradeCapture;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue(quoteWithDetails());
  mockExecuteRelayBridge.mockResolvedValue({
    requestId: "0xreq",
    finalStatus: "success",
    txHashes: ["0xhash1"],
    // Per-hop records (origin Base) — the handler maps these to `_explorerRefs`.
    transactions: [{ chainId: 8453, hash: "0xhash1" }],
  });
  mockPinTrackedToken.mockResolvedValue({ inserted: true });
});

describe("relay.bridge trade capture", () => {
  it("records SYMBOL legs + addresses + human-readable amounts from the quote details", async () => {
    const capture = await runBridge(PARAMS);
    expect(capture).toMatchObject({
      type: "bridge",
      chain: "8453",
      status: "executed",
      inputToken: "ETH",
      inputTokenAddress: ZERO,
      inputAmount: "0.001714",
      outputToken: "VIRTUAL",
      outputTokenAddress: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
      outputAmount: "5.421",
      signature: "0xhash1",
      walletAddress: SEL_EVM,
    });
    expect(capture.meta).toMatchObject({ provider: "relay", sourceChain: "8453", destChain: "4663" });
  });

  it("falls back to the chain's native symbol + raw amount when Relay omits details (no outputAmount)", async () => {
    mockGetQuote.mockResolvedValue({ steps: [STEP] } as RelayQuoteResponse);
    const capture = await runBridge({ ...PARAMS, toToken: "native" });
    expect(capture.inputToken).toBe("ETH"); // origin chain native symbol from the registry
    expect(capture.outputToken).toBe("ETH"); // destination chain native symbol
    expect(capture.inputTokenAddress).toBe(ZERO);
    expect(capture.outputTokenAddress).toBe(ZERO);
    expect(capture.inputAmount).toBe("1714000000000000"); // legacy raw fallback
    expect("outputAmount" in capture).toBe(false);
  });

  it("converts a raw details amount with the currency decimals when amountFormatted is missing", async () => {
    const quote = quoteWithDetails();
    delete (quote.details!.currencyIn as { amountFormatted?: string }).amountFormatted;
    mockGetQuote.mockResolvedValue(quote);
    const capture = await runBridge(PARAMS);
    expect(capture.inputAmount).toBe("0.001714");
  });

  it("keeps the raw address leg for an unknown ERC-20 with no details metadata", async () => {
    mockGetQuote.mockResolvedValue({ steps: [STEP] } as RelayQuoteResponse);
    const capture = await runBridge(PARAMS);
    // ERC-20 destination without quote metadata: no symbol source → address leg.
    expect(capture.outputToken).toBe("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
  });

  // ── Auto-pin (Robinhood launch: tracked_tokens replaces spot derivation) ──

  it("auto-pins an ERC-20 landing on a LOCAL chain (source 'bridge')", async () => {
    await runBridge(PARAMS);
    expect(mockPinTrackedToken).toHaveBeenCalledWith({
      walletAddress: SEL_EVM,
      chainId: 4663,
      tokenAddress: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
      source: "bridge",
    });
  });

  it("does not pin a NATIVE destination (native is always read)", async () => {
    await runBridge({ ...PARAMS, toToken: "native" });
    expect(mockPinTrackedToken).not.toHaveBeenCalled();
  });

  it("a pin failure is fail-soft — the bridge result stays successful", async () => {
    mockPinTrackedToken.mockRejectedValue(new Error("db down"));
    const capture = await runBridge(PARAMS);
    expect(capture.status).toBe("executed");
  });
});

// ── Per-hop explorer refs (multi-chain deep links) ────────────────────────────

describe("relay.bridge explorer refs", () => {
  async function runBridgeData(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(params, SESSION_CTX);
    expect(result.success).toBe(true);
    return result.data as Record<string, unknown>;
  }

  it("emits one `_explorerRefs` entry per broadcast hop, each chained to its own chain id", async () => {
    // Two-hop bridge: origin Base (8453) + destination Robinhood (4663).
    mockExecuteRelayBridge.mockResolvedValue({
      requestId: "0xreq",
      finalStatus: "success",
      txHashes: ["0xorigin", "0xdest"],
      transactions: [
        { chainId: 8453, hash: "0xorigin" },
        { chainId: 4663, hash: "0xdest" },
      ],
    });
    const data = await runBridgeData(PARAMS);
    expect(data._explorerRefs).toEqual([
      { chain: "8453", txRef: "0xorigin" },
      { chain: "4663", txRef: "0xdest" },
    ]);
  });

  it("`deriveExplorerRefs` merges the per-hop refs (deduped against the origin capture)", async () => {
    const { deriveExplorerRefs } = await import("@vex-agent/engine/core/explorer-refs.js");
    mockExecuteRelayBridge.mockResolvedValue({
      requestId: "0xreq",
      finalStatus: "success",
      txHashes: ["0xorigin", "0xdest"],
      transactions: [
        { chainId: 8453, hash: "0xorigin" },
        { chainId: 4663, hash: "0xdest" },
      ],
    });
    const data = await runBridgeData(PARAMS);
    // The origin capture ref (chain "8453", txRef "0xorigin") and the origin
    // `_explorerRefs` entry are the SAME identity → one deduped ref; the
    // destination hop adds the second.
    expect(deriveExplorerRefs(data)).toEqual([
      { chain: "8453", txRef: "0xorigin" },
      { chain: "4663", txRef: "0xdest" },
    ]);
  });
});
