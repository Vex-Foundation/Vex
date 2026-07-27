/**
 * Pendle broadcast-unconfirmed contract (phase-4 card H-4).
 *
 * Every mutating Pendle handler signs, broadcasts, and THEN reads the Pendle
 * asset catalogue back for USD valuation — inside the SAME `try`. The `txHash`
 * used to be a `const` scoped inside that `try`, so a throw in the read-back
 * landed in a `catch` that could not see the hash: the agent was told a funded,
 * already-broadcast trade had simply FAILED, and was free to retry it.
 *
 * H-1 made this the LIKELY path, not the exotic one: an unreadable asset
 * catalogue used to return `[]` silently (handlers completed with wrong
 * numbers); it now raises `PENDLE_INVALID_RESPONSE`. Pendle is also compute-unit
 * throttled, so `PENDLE_RATE_LIMITED` can land right after we spent CUs — and
 * its hint is literally "Wait and retry.", which must NOT reach the agent as
 * advice about the trade.
 *
 * These tests pin, per affected tool:
 *   1. a post-broadcast throw surfaces the hash, says it WAS broadcast, says the
 *      outcome is unknown, forbids retry, states Vex did NOT record it, and
 *      still reports `success: false`;
 *   2. a PRE-broadcast failure keeps its byte-identical legacy message and never
 *      mentions a broadcast.
 *
 * `selectSafeRoute` (the fund-safety calldata extractor) is stubbed so these
 * tests reach the broadcast at all — it has its own dedicated suites
 * (`calldata*.test.ts`), and re-deriving real Router calldata for six methods
 * here would test the extractor, not the failure path under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hex } from "viem";

import { VexError, ErrorCodes } from "../../../../../errors.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockBuildAssetMap = vi.fn();
const mockResolveMarketByPt = vi.fn();
const mockResolveMarketByYt = vi.fn();
const mockResolveMarketByAddress = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: (...a: unknown[]) => mockResolveMarketByPt(...a),
  resolveMarketByYt: (...a: unknown[]) => mockResolveMarketByYt(...a),
  resolveMarketByAddress: (...a: unknown[]) => mockResolveMarketByAddress(...a),
  buildAssetMap: (...a: unknown[]) => mockBuildAssetMap(...a),
  priceUsdFor: () => null,
}));

const mockConvert = vi.fn();
const mockConvertMulti = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    convert: (...a: unknown[]) => mockConvert(...a),
    convertMulti: (...a: unknown[]) => mockConvertMulti(...a),
  }),
}));

const mockSendTransaction = vi.fn();
vi.mock("@tools/pendle/evm-client.js", () => ({
  // Serves BOTH `resolveInputToken`'s on-chain decimals read and
  // `lp.remove`'s LP balanceOf read.
  getPendlePublicClient: () => ({ readContract: async () => 6 }),
  getPendleEvmClients: () => ({
    publicClient: { readContract: async () => 6 },
    walletClient: {
      account: { address: WALLET },
      chain: { id: 1 },
      sendTransaction: (...a: unknown[]) => mockSendTransaction(...a),
    },
  }),
}));

vi.mock("@tools/pendle/erc20.js", () => ({
  ensurePendleAllowanceExact: vi.fn(async () => undefined),
}));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn(async () => undefined),
}));

const WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const PRIVATE_KEY = `0x${"1".repeat(64)}`;
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY }),
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope error" }),
}));

const mockSelectSafeRoute = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/calldata.js", () => ({
  selectSafeRoute: (...a: unknown[]) => mockSelectSafeRoute(...a),
  assertClaimSafe: vi.fn(),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), error: vi.fn() },
}));

const { PENDLE_PT_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/pt.js");
const { PENDLE_YT_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/yt.js");
const { PENDLE_PY_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/py.js");
const { PENDLE_LP_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/lp.js");

// ── Fixtures ─────────────────────────────────────────────────────────

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PT = "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb";
const YT = "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2";
const MARKET_ADDR = "0x177768caf9d0e036725a51d3f60d7e20f2d4d194";
const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

const MARKET = {
  address: MARKET_ADDR,
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

/** A stubbed safe route — the extractor's own suites cover its real behaviour. */
const ROUTE = {
  contractParamInfo: { method: "swapExactTokenForPt", contractCallParams: [] },
  tx: { to: ROUTER, data: "0x1234", from: null, value: null },
  outputs: [{ token: PT, amount: "1000000" }],
  data: { aggregatorType: "KYBERSWAP", priceImpact: 0.0001, feeUsd: null },
};

function convertResponse(action: string, approvals: { token: string; amount: string }[] = []) {
  return { action, inputs: [], requiredApprovals: approvals, routes: [ROUTE] };
}

/** The dominant post-broadcast failure since H-1: the catalogue is unreadable. */
const CATALOGUE_UNREADABLE = new VexError(
  ErrorCodes.PENDLE_INVALID_RESPONSE,
  "Pendle asset catalogue for chain 1 is unreadable.",
  "Retry shortly; do not treat this as an empty catalogue.",
);

/** The other live one: throttled AFTER we already spent compute units. */
const THROTTLED = new VexError(
  ErrorCodes.PENDLE_RATE_LIMITED,
  "Pendle rate limited",
  "Pendle is self-throttled by compute units. Wait and retry.",
);

const ctx = { walletResolution: {}, walletPolicy: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMarketByPt.mockResolvedValue(MARKET);
  mockResolveMarketByYt.mockResolvedValue(MARKET);
  mockResolveMarketByAddress.mockResolvedValue(MARKET);
  mockSelectSafeRoute.mockReturnValue(ROUTE);
  mockSendTransaction.mockResolvedValue(TX_HASH);
  mockBuildAssetMap.mockRejectedValue(CATALOGUE_UNREADABLE);
});

// ── The shared contract ──────────────────────────────────────────────

/**
 * Every broadcast-unconfirmed result must carry the SAME six facts. Asserted on
 * behaviour (the agent-readable text), not on an implementation detail.
 */
function expectBroadcastUnconfirmed(res: { success: boolean; output: string }, toolId: string): void {
  // 3. Never success — the on-chain outcome is genuinely unknown.
  expect(res.success).toBe(false);
  // 2a. The hash itself, so the agent can surface it.
  expect(res.output).toContain(TX_HASH);
  // 2b. The repo's existing status vocabulary, not a synonym.
  expect(res.output).toContain("broadcast_unconfirmed");
  // 2c. It WAS broadcast, and the outcome is UNKNOWN.
  expect(res.output).toContain("WAS BROADCAST");
  expect(res.output).toContain("outcome is UNKNOWN");
  // 2d. Do not retry.
  expect(res.output).toContain("DO NOT retry");
  // 2e. Vex has NOT recorded it and nothing will resolve it — the opposite of
  // the KyberSwap wording, which promises automatic resolution it can deliver
  // and Pendle cannot (no settlement decoder, and success:false skips capture).
  expect(res.output).toContain("Vex has NOT recorded this transaction");
  expect(res.output).toContain("nothing will confirm, track, or resolve it automatically");
  expect(res.output).not.toContain("will resolve automatically.");
  // 2f. The underlying reason still reaches the agent.
  expect(res.output).toContain(toolId);
  // The tool is named so the agent knows which leg is in doubt.
  expect(res.output.startsWith(toolId)).toBe(true);
}

// ── PT ───────────────────────────────────────────────────────────────

describe("pendle.pt.buy / pendle.pt.sell — post-broadcast throw", () => {
  const buyParams = { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" };
  const sellParams = { chain: "ethereum", tokenIn: PT, tokenOut: USDC, amountIn: "100" };

  beforeEach(() => {
    mockConvert.mockResolvedValue(convertResponse("swap"));
  });

  it("pendle.pt.buy reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(buyParams, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.pt.buy");
    expect(res.output).toContain(ErrorCodes.PENDLE_INVALID_RESPONSE);
  });

  it("pendle.pt.sell reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_PT_HANDLERS["pendle.pt.sell"]!(sellParams, ctx);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.pt.sell");
  });

  it("neutralises the throttle hint's own 'Wait and retry.' advice", async () => {
    mockBuildAssetMap.mockRejectedValue(THROTTLED);
    const res = await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(buyParams, ctx);
    // The provider hint is passed through for diagnosis...
    expect(res.output).toContain("Wait and retry.");
    // ...but it is explicitly scoped to the read-back and disclaimed, so it can
    // never read as permission to re-broadcast a funded trade.
    expect(res.output).toContain("DO NOT retry");
    expect(res.output).toContain("describes the failed read-back only");
    expect(res.output).toContain('disregard any "retry" wording in it');
  });

  it("logs the broadcast-unconfirmed state with the hash for operators", async () => {
    await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(buyParams, ctx);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "pendle.handler.broadcast_unconfirmed",
      { toolId: "pendle.pt.buy", txHash: TX_HASH },
    );
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvert.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(buyParams, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.output).toBe(
      `Pendle buy failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.output).not.toContain("broadcast");
    expect(res.output).not.toContain(TX_HASH);
  });
});

describe("pendle.pt.redeem — post-broadcast throw on BOTH paths", () => {
  const params = { chain: "ethereum", tokenIn: PT, amountIn: "100" };

  it("Convert path: the pre-broadcast catalogue read succeeds, the post-broadcast one throws", async () => {
    // The redeem reads the catalogue ONCE before signing (valuation baseline) and
    // again after — this is the live shape: CUs spent, then throttled/unreadable.
    mockBuildAssetMap
      .mockResolvedValueOnce(new Map())
      .mockRejectedValue(THROTTLED);
    mockConvert.mockResolvedValue(convertResponse("redeem-py", [{ token: PT, amount: "100000000" }]));

    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.pt.redeem");
  });

  it("redeemPyToSy fallback path: the hash still reaches the catch", async () => {
    // Convert is unavailable → the API-independent fallback broadcasts instead.
    // Nothing on the fallback path makes a live call after signing TODAY, so the
    // throw is injected into the valuation read of the pre-fetched map: what is
    // pinned here is that the FALLBACK broadcast's hash is reachable by the
    // catch (site `pt.ts` fallback), not one particular error source.
    const hostileMap = new Map<string, never>();
    hostileMap.get = () => {
      throw new Error("valuation lookup failed");
    };
    mockBuildAssetMap.mockResolvedValueOnce(hostileMap);
    mockConvert.mockRejectedValue(new Error("Convert unavailable"));

    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.pt.redeem");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    // H-1's dominant pre-broadcast failure: the baseline catalogue read throws.
    mockBuildAssetMap.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(params, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle redeem failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

// ── YT ───────────────────────────────────────────────────────────────

describe("pendle.yt.buy / pendle.yt.sell — post-broadcast throw", () => {
  const buyParams = { chain: "ethereum", tokenIn: USDC, tokenOut: YT, amountIn: "100" };
  const sellParams = { chain: "ethereum", tokenIn: YT, tokenOut: USDC, amountIn: "100" };

  beforeEach(() => {
    mockConvert.mockResolvedValue(convertResponse("swap"));
  });

  it("pendle.yt.buy reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_YT_HANDLERS["pendle.yt.buy"]!(buyParams, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.yt.buy");
  });

  it("pendle.yt.sell reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_YT_HANDLERS["pendle.yt.sell"]!(sellParams, ctx);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.yt.sell");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvert.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_YT_HANDLERS["pendle.yt.buy"]!(buyParams, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle YT buy failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

// ── PY ───────────────────────────────────────────────────────────────

describe("pendle.py.mint — post-broadcast throw", () => {
  const params = { chain: "ethereum", pt: PT, tokenIn: USDC, amountIn: "100" };

  beforeEach(() => {
    mockConvertMulti.mockResolvedValue(convertResponse("mint-py"));
  });

  it("reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_PY_HANDLERS["pendle.py.mint"]!(params, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.py.mint");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvertMulti.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_PY_HANDLERS["pendle.py.mint"]!(params, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle mint failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

describe("pendle.py.redeem — post-broadcast throw", () => {
  const params = { chain: "ethereum", pt: PT, amountIn: "100" };

  beforeEach(() => {
    mockConvertMulti.mockResolvedValue(
      convertResponse("redeem-py", [{ token: PT, amount: "100000000" }]),
    );
  });

  it("reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_PY_HANDLERS["pendle.py.redeem"]!(params, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.py.redeem");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvertMulti.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_PY_HANDLERS["pendle.py.redeem"]!(params, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle redeem failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

// ── LP ───────────────────────────────────────────────────────────────

describe("pendle.lp.add — post-broadcast throw", () => {
  const params = { chain: "ethereum", market: MARKET_ADDR, tokenIn: USDC, amountIn: "100" };

  beforeEach(() => {
    mockConvertMulti.mockResolvedValue(convertResponse("add-liquidity"));
  });

  it("reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_LP_HANDLERS["pendle.lp.add"]!(params, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.lp.add");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvertMulti.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_LP_HANDLERS["pendle.lp.add"]!(params, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle add liquidity failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

describe("pendle.lp.remove — post-broadcast throw", () => {
  const params = { chain: "ethereum", market: MARKET_ADDR, amountIn: "100" };

  beforeEach(() => {
    mockConvertMulti.mockResolvedValue(convertResponse("remove-liquidity"));
  });

  it("reports the broadcast hash instead of a plain failure", async () => {
    const res = await PENDLE_LP_HANDLERS["pendle.lp.remove"]!(params, ctx);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expectBroadcastUnconfirmed(res as { success: boolean; output: string }, "pendle.lp.remove");
  });

  it("PRE-broadcast failure keeps its byte-identical legacy message", async () => {
    mockConvertMulti.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = await PENDLE_LP_HANDLERS["pendle.lp.remove"]!(params, ctx);
    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(res.output).toBe(
      `Pendle remove liquidity failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.)`,
    );
    expect(res.success).toBe(false);
  });
});

// `pendle.claim` (yt.ts) is deliberately NOT covered here: only array maps and a
// logger sit between its send and its return, so it never needed the hoist and
// H-4 leaves it byte-identical. Covering it would need its own claim-target and
// position mocks — a vacuous assertion here would be worse than none.
