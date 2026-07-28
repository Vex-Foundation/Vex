/**
 * `pendle.pt.redeem` END-TO-END on a MATURED market, and the asset it actually
 * delivers (R5b; P1-13 / G-20).
 *
 * TWO defects meet on this path.
 *
 * G-02/D18 — the market the tool exists for was unreachable BY the tool. Every
 * mutating resolver read the active catalogue only, so a matured PT resolved to
 * nothing and `pendle.pt.redeem` answered "No active Pendle market for this PT".
 * The redeem product could not redeem.
 *
 * P1-13 — and when it did run, it lied about what it paid out. The two redeem
 * paths deliver DIFFERENT assets: Convert's `redeemPyToToken` pays the market's
 * underlying, while the `redeemPyToSy` fallback pays SY. The capture recorded
 * `underlyingAsset` for BOTH, with `outputAmount: "0"` and the FULL input USD
 * attached — so a fallback redeem booked an asset the wallet does not hold, at a
 * value nothing measured. Same tool, same params, a different asset, and nothing
 * in the record said so.
 *
 * What is pinned here is the honest shape: the TRUE delivered asset on both
 * paths, an explicit `deliveredPath` discriminant, and a refusal to state
 * proceeds the evidence does not support.
 *
 * CARD B1 CLOSED THE REMAINING GAP. The fallback used to have no measurement at
 * all — no quote, and no receipt wait — so it honestly recorded `0`. It now
 * decodes the SY credit from the receipt's own Transfer logs, so BOTH paths book
 * a measured amount. The `routeProvenance.deliveredPath` discriminant is what
 * makes that possible: it tells the decoder to match the OUT leg against SY
 * rather than the (absent) underlying.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, type Hex } from "viem";

// ── Mocks ────────────────────────────────────────────────────────────

const mockBuildAssetMap = vi.fn();
const mockResolveExitMarketByPt = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: vi.fn(async () => null),
  resolveMarketByYt: vi.fn(async () => null),
  resolveMarketByAddress: vi.fn(async () => null),
  buildAssetMap: (...a: unknown[]) => mockBuildAssetMap(...a),
  priceUsdFor: () => null,
}));
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: (...a: unknown[]) => mockResolveExitMarketByPt(...a),
  resolveExitMarketByAddress: vi.fn(async () => null),
  resolveExitYtForPt: vi.fn(async () => null),
}));

const mockConvert = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({ convert: (...a: unknown[]) => mockConvert(...a) }),
}));

const mockSendTransaction = vi.fn();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
function padded(a: string): string {
  return `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
}
function transferLog(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, padded(from), padded(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}
/** The matured srUSDe PT — the leg the receipt must show LEAVING the wallet. */
const PT_ADDRESS = "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375";
/** Which token the receipt credits — the Convert path pays the underlying, the fallback pays SY. */
let creditedToken = "";
/** Overrides the credited amount for the "receipt undershoots the quote" case. */
let mockShortCredit: bigint | null = null;
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: () => ({ readContract: async () => 18 }),
  getPendleEvmClients: () => ({
    publicClient: {
      readContract: async (args: { functionName?: string }) =>
        // Share-based SY: the redeem fallback reads exchangeRate() for its floor.
        args?.functionName === "exchangeRate" ? 10n ** 18n : 18,
      estimateGas: async () => 1_000_000n,
      sendRawTransaction: (...a: unknown[]) => mockSendTransaction(...a),
      waitForTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 1n,
        logs: [
          transferLog(PT_ADDRESS, WALLET, ZERO_ADDR, 10n ** 18n),
          transferLog(creditedToken, ZERO_ADDR, WALLET, mockShortCredit ?? 990_000_000_000_000_000n),
        ],
      }),
    },
    walletClient: {
      account: { address: WALLET },
      chain: { id: 1 },
      prepareTransactionRequest: async (r: Record<string, unknown>) => ({ ...r, nonce: 3 }),
      signTransaction: async () => "0x02f8b10101",
    },
  }),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: vi.fn(async () => ({ executionId: 5, events: [{ id: 55 }] })),
  createAgentActivityPreBroadcastFailure: vi.fn(async () => ({ executionId: 6, event: {} })),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
}));
vi.mock("@vex-agent/sync/pendle-acquisition-pin.js", () => ({
  pinConfirmedPendleAcquisition: vi.fn(async () => undefined),
}));

vi.mock("@tools/pendle/erc20.js", () => ({ ensurePendleAllowanceExact: vi.fn(async () => undefined) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({ ensureErc20Balance: vi.fn(async () => undefined) }));
vi.mock("@vex-agent/tools/protocols/pendle/calldata.js", () => ({
  selectSafeRoute: vi.fn(() => SAFE_ROUTE),
}));
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: `0x${"11".repeat(32)}` }),
  walletScopeErrorToResult: (e: unknown) => ({ success: false, output: String(e) }),
}));

const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
// The hash the node returns is derived from the SIGNED bytes, not chosen here.
const TX_HASH: Hex = keccak256("0x02f8b10101");
const SAFE_ROUTE = {
  tx: { to: ROUTER, data: "0xdeadbeef", from: WALLET, value: null },
  outputs: [{ token: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003", amount: "990000000000000000" }],
  contractParamInfo: { method: "redeemPyToToken", contractCallParams: [] },
  data: { aggregatorType: null, priceImpact: null, feeUsd: null },
};

const { PENDLE_PT_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/pt.js");

/** srUSDe — matured 2026-04-02, the exact live row the corpus names. */
const MATURED_MARKET = {
  address: "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654",
  name: "srUSDe",
  expiry: "2026-04-02T00:00:00.000Z",
  pt: "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375",
  yt: "0x31f9e6692e87d81ff8d64de1f475fce6880a030f",
  sy: "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e",
  underlyingAsset: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
  details: { liquidity: 1000, impliedApy: null, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
  categoryIds: [], isNew: false, isPrime: false,
};

const ctx = {
  sessionPermission: "full" as const,
  approved: true,
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
  sessionId: "sess-1",
};
const params = { chain: "ethereum", tokenIn: MATURED_MARKET.pt, amountIn: "1" };

function capture(res: unknown): Record<string, unknown> {
  return ((res as { data: { _tradeCapture: Record<string, unknown> } }).data)._tradeCapture;
}
function output(res: unknown): Record<string, unknown> {
  return JSON.parse((res as { output: string }).output) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildAssetMap.mockResolvedValue(new Map());
  mockResolveExitMarketByPt.mockResolvedValue({ market: MATURED_MARKET, maturity: "matured" });
  mockSendTransaction.mockResolvedValue(TX_HASH);
  creditedToken = MATURED_MARKET.underlyingAsset;
});

describe("a MATURED PT is redeemable at last (G-02 / D18)", () => {
  it("resolves the matured market and broadcasts, instead of 'no active market'", async () => {
    mockConvert.mockResolvedValue({ action: "redeem-py", requiredApprovals: [], routes: [SAFE_ROUTE], inputs: [] });

    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(res.success).toBe(true);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(output(res).txHash).toBe(TX_HASH);
  });

  it("goes through the matured-capable resolver, never the frozen active-only one", async () => {
    mockConvert.mockResolvedValue({ action: "redeem-py", requiredApprovals: [], routes: [SAFE_ROUTE], inputs: [] });
    await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    // The handler checksums the PT before resolving, so compare case-insensitively.
    const [chainId, pt] = mockResolveExitMarketByPt.mock.calls[0]!;
    expect(chainId).toBe(1);
    expect(String(pt).toLowerCase()).toBe(MATURED_MARKET.pt);
  });
});

describe("the CONVERT path delivers the underlying, and says so", () => {
  beforeEach(() => {
    mockConvert.mockResolvedValue({ action: "redeem-py", requiredApprovals: [], routes: [SAFE_ROUTE], inputs: [] });
  });

  it("records the UNDERLYING as the delivered asset", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(capture(res).outputTokenAddress?.toString().toLowerCase()).toBe(MATURED_MARKET.underlyingAsset);
    expect(capture(res).settlementAssetKey?.toString().toLowerCase()).toBe(MATURED_MARKET.underlyingAsset);
  });

  it("marks the path and the asset kind for the agent", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(output(res)).toMatchObject({ deliveredPath: "convert", deliveredAssetKind: "underlying", fallback: false });
  });

  it("books the DECODED output amount, and reports the quote separately", async () => {
    // Card B1: the result is the fill. The quote is still shown, under a name
    // that cannot be mistaken for one — a lot opened at a quoted size that never
    // arrived is a wrong lot forever.
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(capture(res).outputAmount).toBe("990000000000000000");
    expect(output(res).executedAmountOut).toBe("0.99");
    expect(output(res).quotedAmountOut).toBe("0.99");
  });

  it("books the RECEIPT's amount even when it undershoots the quote", async () => {
    // The evidence wins. A route that advertised 0.99 and delivered 0.90 must
    // book 0.90, or the ledger records proceeds the wallet never received.
    creditedToken = MATURED_MARKET.underlyingAsset;
    const shortfall = 900_000_000_000_000_000n;
    mockShortCredit = shortfall;
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(capture(res).outputAmount).toBe(shortfall.toString());
    expect(output(res).executedAmountOut).toBe("0.9");
    expect(output(res).quotedAmountOut).toBe("0.99");
    mockShortCredit = null;
  });

  it("adds no fallback caveat when there is nothing to caveat", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(output(res).note).toBeUndefined();
  });
});

describe("the FALLBACK path delivers SY — and no longer pretends otherwise (P1-13)", () => {
  beforeEach(() => {
    // Convert unavailable → the API-independent redeemPyToSy fallback.
    mockConvert.mockRejectedValue(new Error("Convert unavailable"));
    // The wallet is credited SY on this path — which is the whole point.
    creditedToken = MATURED_MARKET.sy;
  });

  it("records SY as the delivered asset, NOT the underlying", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(capture(res).outputTokenAddress?.toString().toLowerCase()).toBe(MATURED_MARKET.sy);
    // The exact defect: the wallet holds SY, the ledger used to say underlying.
    expect(capture(res).outputTokenAddress?.toString().toLowerCase()).not.toBe(MATURED_MARKET.underlyingAsset);
    expect(capture(res).settlementAssetKey?.toString().toLowerCase()).toBe(MATURED_MARKET.sy);
  });

  it("names the path and the asset kind so the agent knows what it now holds", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(output(res)).toMatchObject({
      deliveredPath: "router_fallback_redeemPyToSy",
      deliveredAssetKind: "sy",
      fallback: true,
    });
    expect(output(res).deliveredAsset?.toString().toLowerCase()).toBe(MATURED_MARKET.sy);
  });

  it("now MEASURES the SY credit instead of recording 0 (card B1)", async () => {
    // The old shape had nothing to measure with — no quote, no receipt wait — so
    // it honestly booked "0". The receipt wait supplies the missing evidence.
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(capture(res).outputAmount).toBe("990000000000000000");
    expect(output(res).executedAmountOut).toBe("0.99");
  });

  it("still refuses to state a USD proceeds figure nothing priced", async () => {
    // A measured AMOUNT is not a measured VALUE. With no price for SY, carrying
    // the input's USD across would state proceeds the evidence cannot support.
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(capture(res).outputValueUsd).toBe("0");
  });

  it("reports NO quoted amount — this path never had a quote to compare against", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(output(res).quotedAmountOut).toBeUndefined();
  });

  it("says WHY the amount is unknown, and names the missing unwrap tool", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    const note = String(output(res).note);
    expect(note).toMatch(/SY/);
    expect(note).toMatch(/pendle\.sy\.redeem/);
    expect(note).toMatch(/unknown|not.*decoded|receipt/i);
  });

  it("carries the discriminant into the capture meta too, not only the model text", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    const meta = capture(res).meta as { pendle: unknown; deliveredPath: string; deliveredAssetKind: string };
    expect(meta.deliveredPath).toBe("router_fallback_redeemPyToSy");
    expect(meta.deliveredAssetKind).toBe("sy");
  });

  it("REFUSES rather than booking the wrong asset when the market reports no SY", async () => {
    // Without an SY address there is no honest asset to name, and the old
    // behaviour — book it as underlying — is exactly the defect. Refuse instead.
    mockResolveExitMarketByPt.mockResolvedValue({
      market: { ...MATURED_MARKET, sy: null },
      maturity: "matured",
    });

    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(res.success).toBe(false);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});

describe("the pre-maturity gate still guards the fallback (P1-14)", () => {
  it("REFUSES the fallback on a market that has not matured, and signs nothing", async () => {
    mockConvert.mockRejectedValue(new Error("Convert unavailable"));
    mockResolveExitMarketByPt.mockResolvedValue({
      market: { ...MATURED_MARKET, expiry: "2027-12-30T00:00:00.000Z" },
      maturity: "active",
    });

    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(res.success).toBe(false);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});
