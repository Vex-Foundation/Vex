/**
 * Pendle quote instrument guard (P3 fix) — pendle.yt.quote must FAIL unless
 * EXACTLY one leg resolves as an active YT, and pendle.pt.quote must FAIL when
 * neither leg resolves as an active PT.
 *
 * Why this is fund-safety: a quote that "succeeds" with market:null records a
 * GENERIC swap identity (chain/wallet/tokenIn/tokenOut/amount/provider). Without
 * the guard, a PT-legged call routed through pendle.yt.quote would record an
 * identity that authorizes the PT execute for the same legs while SKIPPING the
 * PT term-lock warning path (instrument confusion). The guard closes the hole at
 * the quote: no success → the runtime never records a prequote.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveMarketByYt = vi.fn();
const mockResolveMarketByPt = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByYt: (...a: unknown[]) => mockResolveMarketByYt(...a),
  resolveMarketByPt: (...a: unknown[]) => mockResolveMarketByPt(...a),
  resolveMarketByAddress: vi.fn(),
  buildAssetMap: vi.fn(async () => new Map()),
  priceUsdFor: vi.fn(() => null),
}));

// R5b: the exit actions (pt.redeem, lp.remove, claim) resolve through the
// matured-capable lane. Delegates to the SAME market doubles this suite
// already sets up, wrapped in the {market, maturity} envelope.
// R5b: a failed active-only lookup now NAMES the reason from the read-only
// classification lane. Stubbed so the refusal text is produced offline — the
// lane is network-bounded in production (`read/client.ts` fetchWithTimeout),
// but a unit test must not reach for it.
vi.mock("@vex-agent/tools/protocols/pendle/market-read.js", () => ({
  resolveMarketForRead: vi.fn(async () => ({ status: "not_found" })),
}));

vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: async (...a: unknown[]) => {
    const m = await mockResolveMarketByPt(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
  resolveExitMarketByAddress: vi.fn(async () => null),
  resolveExitYtForPt: vi.fn(async () => null),
}));

const mockConvert = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({ convert: (...a: unknown[]) => mockConvert(...a) }),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: vi.fn(),
}));

// resolveInputToken reads decimals on-chain — stub the public client.
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: () => ({ readContract: async () => 6 }),
  getPendleEvmClients: vi.fn(),
}));

const { PENDLE_YT_HANDLERS } = await import(
  "@vex-agent/tools/protocols/pendle/handlers/yt.js"
);
const { PENDLE_PT_HANDLERS } = await import(
  "@vex-agent/tools/protocols/pendle/handlers/pt.js"
);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const YT = "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2";
const PT = "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb";
const MARKET = {
  address: "0x177768caf9d0e036725a51d3f60d7e20f2d4d194",
  name: "sUSDe",
  expiry: "2026-08-13T00:00:00.000Z",
  pt: PT,
  yt: YT,
  sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
  underlyingAsset: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
  details: { liquidity: 8_000_000, impliedApy: 0.1, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
  categoryIds: [],
  isNew: false,
  isPrime: false,
};

const CONVERT_OK = {
  action: "swap",
  inputs: [],
  requiredApprovals: [],
  routes: [
    {
      contractParamInfo: { method: "swapExactTokenForYt", contractCallParams: [] },
      tx: { to: "0x888888888889758F76e7103c6CbF23ABbF58F946", data: "0x", from: null, value: null },
      outputs: [{ token: YT, amount: "1000000" }],
      data: { aggregatorType: "KYBERSWAP", priceImpact: 0.0001, feeUsd: null },
    },
  ],
};

const ctx = { walletResolution: {}, walletPolicy: {} } as never;
const params = { chain: "ethereum", tokenIn: USDC, tokenOut: YT, amountIn: "100" };

beforeEach(() => {
  vi.clearAllMocks();
  mockConvert.mockResolvedValue(CONVERT_OK);
});

describe("pendle.yt.quote — instrument guard", () => {
  it("fails when NEITHER leg is an active YT (even if a leg is a PT) — the cross-authorization hole", () => {
    // PT-legged params routed through the YT quote: the YT resolver finds
    // nothing, the PT resolver would (proving the legs collide with a PT trade).
    mockResolveMarketByYt.mockResolvedValue(null);
    mockResolveMarketByPt.mockResolvedValue(MARKET);
    return PENDLE_YT_HANDLERS["pendle.yt.quote"]!(
      { ...params, tokenOut: PT },
      ctx,
    ).then((res) => {
      // No success → the runtime records NO prequote → a yt.quote can no longer
      // mint a generic swap identity for PT legs (cross-authorization closed).
      expect(res.success).toBe(false);
      expect(res.output).toContain("Neither token is an active Pendle YT");
      expect(mockConvert).not.toHaveBeenCalled();
    });
  });

  it("fails when BOTH legs are YTs", async () => {
    mockResolveMarketByYt.mockResolvedValue(MARKET);
    const res = await PENDLE_YT_HANDLERS["pendle.yt.quote"]!(params, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("Both tokens are Pendle YTs");
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("succeeds with exactly one YT leg (out → buy) and echoes non-null market/yt", async () => {
    mockResolveMarketByYt.mockImplementation(async (_chainId: unknown, addr: unknown) =>
      String(addr).toLowerCase() === YT ? MARKET : null,
    );
    const res = await PENDLE_YT_HANDLERS["pendle.yt.quote"]!(params, ctx);
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.direction).toBe("buy");
    expect(data.market).toBe(MARKET.address);
    expect(String(data.yt).toLowerCase()).toBe(YT);
    expect(data.instrument).toBe("yt");
  });

  // 2026-07-25 restoration: `PendleConvertRouteData.feeUsd` was validated and
  // dropped at every quote/dryRun site while its sibling `priceImpact` was
  // surfaced — the route's own fee estimate never reached the agent.
  it("surfaces the route's feeUsdEstimate next to priceImpact", async () => {
    mockResolveMarketByYt.mockImplementation(async (_chainId: unknown, addr: unknown) =>
      String(addr).toLowerCase() === YT ? MARKET : null,
    );
    mockConvert.mockResolvedValue({
      ...CONVERT_OK,
      routes: [{
        ...CONVERT_OK.routes[0],
        data: { aggregatorType: "KYBERSWAP", priceImpact: 0.0001, feeUsd: 0.37 },
      }],
    });

    const res = await PENDLE_YT_HANDLERS["pendle.yt.quote"]!(params, ctx);

    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.feeUsdEstimate).toBe(0.37);
    expect(data.priceImpact).toBe(0.0001);
  });

  it("reports feeUsdEstimate as null when Pendle quoted no fee", async () => {
    mockResolveMarketByYt.mockImplementation(async (_chainId: unknown, addr: unknown) =>
      String(addr).toLowerCase() === YT ? MARKET : null,
    );
    const res = await PENDLE_YT_HANDLERS["pendle.yt.quote"]!(params, ctx);
    expect((res.data as Record<string, unknown>).feeUsdEstimate).toBeNull();
  });

  it("resolves the sell direction when only the IN leg is a YT", async () => {
    mockResolveMarketByYt.mockImplementation(async (_chainId: unknown, addr: unknown) =>
      String(addr).toLowerCase() === YT ? MARKET : null,
    );
    const res = await PENDLE_YT_HANDLERS["pendle.yt.quote"]!(
      { ...params, tokenIn: YT, tokenOut: USDC },
      ctx,
    );
    expect(res.success).toBe(true);
    expect((res.data as Record<string, unknown>).direction).toBe("sell");
  });
});

describe("pendle.pt.quote — symmetric instrument guard", () => {
  it("fails when NEITHER leg is an active PT (aligns the quote with the execute side)", async () => {
    mockResolveMarketByPt.mockResolvedValue(null);
    const res = await PENDLE_PT_HANDLERS["pendle.pt.quote"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: YT, amountIn: "100" },
      ctx,
    );
    expect(res.success).toBe(false);
    // The GUARD is what this case pins: refuse, and never reach Convert. The
    // WORDING moved in R5b — "Neither token is an active Pendle PT" is now
    // sourced from the read-only classification lane, which distinguishes a
    // matured market from a genuinely absent one instead of collapsing both into
    // "not active". Here the lane reports a proven absence, so the refusal says
    // the full catalogue (matured included) was read and found nothing.
    expect(res.output).toMatch(/No Pendle market on ethereum has PT/);
    expect(res.output).toMatch(/including matured markets/);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("names MATURITY as the reason when the PT belongs to a matured market", async () => {
    // The defect this replaces: a matured PT answered "not an active Pendle PT",
    // which reads as "this PT does not exist" and sends the agent hunting for
    // another address instead of to pendle.pt.redeem.
    mockResolveMarketByPt.mockResolvedValue(null);
    const { resolveMarketForRead } = await import("@vex-agent/tools/protocols/pendle/market-read.js");
    vi.mocked(resolveMarketForRead).mockResolvedValueOnce({
      status: "found",
      matured: true,
      matchedBy: "pt",
      catalogScope: "inactive",
      market: { address: "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654", expiry: "2026-04-02T00:00:00.000Z" },
    } as never);

    const res = await PENDLE_PT_HANDLERS["pendle.pt.quote"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: YT, amountIn: "100" },
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.output).toMatch(/matured on 2026-04-02/);
    expect(res.output).toMatch(/pendle__pt_redeem/);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("still succeeds for a PT buy (out leg resolves)", async () => {
    mockResolveMarketByPt.mockImplementation(async (_chainId: unknown, addr: unknown) =>
      String(addr).toLowerCase() === PT ? MARKET : null,
    );
    const res = await PENDLE_PT_HANDLERS["pendle.pt.quote"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" },
      ctx,
    );
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.direction).toBe("buy");
    expect(data.market).toBe(MARKET.address);
  });
});
