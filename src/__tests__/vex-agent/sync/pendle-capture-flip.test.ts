/**
 * Batch B card B2 — the Pendle capture flip + auto-pin, as one atom.
 *
 * Three behaviours are pinned here, all of which must hold TOGETHER or the
 * Pendle feed silently loses rows:
 *
 *   1. `pinConfirmedPendleAcquisition` pins an acquired PT/YT/LP into
 *      `tracked_tokens` — the replacement discovery source now that the tools
 *      no longer write `proj_activity` capture rows for the enrichment scan.
 *   2. Every Pendle mutating tool is `capture: "none"`, so the legacy
 *      projection pipeline never writes a second, quote-derived truth beside
 *      the handler's own `agent_activity` (`kind: 'yield'`) rows.
 *   3. A FAILED Pendle attempt still reaches the transactions failure half —
 *      under the `yield` product, including the LP and reward-claim tools that
 *      the pre-flip `lp`/`reward` products excluded.
 *
 * A0.2 closes the loop STRUCTURALLY. The matrix said `capture: "none"` while
 * eight handlers still emitted a `_tradeCapture` (and two of them a
 * `_tradeCaptureItems` pair) that nothing consumed — a second, quote-derived
 * truth beside the receipt-decoded `agent_activity` row. The last describe here
 * drives every mutating Pendle handler for real, against a mocked broadcast, and
 * fails the build if a success result ever carries either key again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: (...a: unknown[]) => mockPin(...a),
}));

// ── Harness for the structural capture invariant ─────────────────────
//
// Everything outside the handler is mocked so each tool reaches its SUCCESS
// return: the provider, the calldata binders, the prequote gates, the chain
// clients and the broadcast. What is NOT mocked is the handler itself — the
// point is to inspect the shape it really returns.

const HARNESS_WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
const MARKET_ADDR = "0xafb7d6d1e9bca5b675adc9b4f52f0cdfddec9654";
const PT_ADDR = "0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375";
const YT_ADDR = "0x31f9e6692e87d81ff8d64de1f475fce6880a030f";
const SY_ADDR = "0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e";
const UNDERLYING = "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003";
const TOKEN_IN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const HARNESS_MARKET = {
  address: MARKET_ADDR,
  name: "srUSDe",
  expiry: "2027-04-02T00:00:00.000Z",
  pt: PT_ADDR,
  yt: YT_ADDR,
  sy: SY_ADDR,
  underlyingAsset: UNDERLYING,
  details: { liquidity: 1000, impliedApy: 0.1, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
  categoryIds: [], isNew: false, isPrime: false,
};

/** The Convert `action` string each mutating tool insists on seeing. */
const CONVERT_ACTION_FOR = new Map<string, string>([
  ["pendle.pt.buy", "swap"],
  ["pendle.pt.sell", "swap"],
  ["pendle.pt.redeem", "redeem-py"],
  ["pendle.yt.buy", "swap"],
  ["pendle.yt.sell", "swap"],
  ["pendle.py.mint", "mint-py"],
  ["pendle.py.redeem", "redeem-py"],
  ["pendle.lp.add", "add-liquidity"],
  ["pendle.lp.remove", "remove-liquidity"],
  ["pendle.sy.mint", "mint-sy"],
  ["pendle.sy.redeem", "redeem-sy"],
  ["pendle.lp.removeDual", "remove-liquidity-dual"],
  ["pendle.lp.addKeepYt", "add-liquidity"],
  ["pendle.pt.rollover", "roll-over-pt"],
  ["pendle.lp.transfer", "transfer-liquidity"],
  ["pendle.lp.toPt", "remove-liquidity"],
]);

/** Set per case so the mocked provider answers with the action that tool needs. */
let harnessAction = "swap";

const HARNESS_ROUTE = {
  tx: { to: ROUTER, data: "0xdeadbeef", from: HARNESS_WALLET, value: null },
  outputs: [
    { token: PT_ADDR, amount: "990000000000000000" },
    { token: YT_ADDR, amount: "990000000000000000" },
    { token: MARKET_ADDR, amount: "990000000000000000" },
    { token: SY_ADDR, amount: "990000000000000000" },
    { token: UNDERLYING, amount: "990000000000000000" },
    { token: TOKEN_IN, amount: "990000000000000000" },
  ],
  contractParamInfo: { method: "swapExactTokenForPt", contractCallParams: [] },
  data: { aggregatorType: null, priceImpact: null, feeUsd: null },
};
const harnessResponse = () => ({
  action: harnessAction,
  requiredApprovals: [],
  routes: [HARNESS_ROUTE],
  inputs: [],
});

vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    convert: async () => harnessResponse(),
    convertMulti: async () => harnessResponse(),
    redeemInterestsAndRewards: async () => ({
      tx: { to: ROUTER, data: "0xdeadbeef" },
      tokenApprovals: [],
    }),
  }),
}));

vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: async () => HARNESS_MARKET,
  resolveMarketByYt: async () => HARNESS_MARKET,
  resolveMarketByAddress: async () => HARNESS_MARKET,
  buildAssetMap: async () => new Map(),
  priceUsdFor: () => null,
}));
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: async () => ({ market: HARNESS_MARKET, maturity: "active" }),
  resolveExitMarketByAddress: async () => ({ market: HARNESS_MARKET, maturity: "active" }),
  resolveExitYtForPt: async () => null,
}));
vi.mock("@vex-agent/tools/protocols/pendle/calldata.js", () => ({
  selectSafeRoute: () => HARNESS_ROUTE,
  assertClaimSafe: () => ({ yts: [{ yt: YT_ADDR, tokenRedeemSy: UNDERLYING }], markets: [MARKET_ADDR] }),
}));
vi.mock("@vex-agent/tools/protocols/pendle/calldata/bind-reflect.js", () => ({
  selectSafeReflectRoute: () => HARNESS_ROUTE,
}));
vi.mock("@vex-agent/tools/protocols/pendle/claim-targets.js", () => ({
  buildPendleClaimTargets: async () => ({
    intendedYts: new Map([[YT_ADDR, { yt: YT_ADDR, sy: SY_ADDR, tokenRedeemSy: UNDERLYING }]]),
    intendedMarkets: new Set([MARKET_ADDR]),
    eligibleMarketCount: 1,
    selectedMarketCount: 1,
    marketCap: 10,
    skipped: [],
  }),
  describePendleClaimSkips: () => null,
}));

/** The broadcast is the boundary: confirmed, with a decoded fill on every leg. */
vi.mock("@vex-agent/tools/protocols/pendle/handlers/signed-broadcast.js", () => ({
  sendPendleRouterTx: async () => ({
    kind: "confirmed",
    txHash: "0xabc",
    executionId: 5,
    executed: {
      amountInRaw: "1000000000000000000",
      amountIn2Raw: "1000000000000000000",
      amountOutRaw: "990000000000000000",
      amountOut2Raw: "990000000000000000",
    },
  }),
  recordPendleRefusal: async () => undefined,
}));

const ALLOW = { kind: "allow" } as const;
vi.mock("@vex-agent/tools/protocols/pendle/handlers/reflect-prequote.js", () => ({
  gatePendleTermExecute: async () => ALLOW,
  recordPendleTermPrequote: async () => undefined,
}));
vi.mock("@vex-agent/tools/protocols/pendle/handlers/lp-dual-prequote.js", () => ({
  gatePendleLpDualExecute: async () => ALLOW,
  recordPendleLpDualPrequote: async () => undefined,
}));
vi.mock("@vex-agent/tools/protocols/pendle/handlers/sy-prequote.js", () => ({
  gatePendleSyExecute: async () => ALLOW,
  recordPendleSyPrequote: async () => undefined,
}));

vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: () => ({ readContract: async () => 18 }),
  getPendleEvmClients: () => ({ publicClient: {}, walletClient: {} }),
}));
vi.mock("@tools/pendle/erc20.js", () => ({ ensurePendleAllowanceExact: async () => undefined }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({ ensureErc20Balance: async () => undefined }));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => HARNESS_WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: HARNESS_WALLET, privateKey: `0x${"11".repeat(32)}` }),
  walletScopeErrorToResult: (e: unknown) => ({ success: false, output: String(e) }),
}));

const { pinConfirmedPendleAcquisition } = await import("@vex-agent/sync/pendle-acquisition-pin.js");
const { MUTATION_MATRIX } = await import("@vex-agent/tools/protocols/mutation-matrix.js");
const { PENDLE_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers.js");
const { validateCaptureContract } = await import("@vex-agent/tools/protocols/capture-validator.js");
const { FAILURE_TOOL_PRODUCTS, TRANSACTION_PRODUCTS, failureToolsForProduct } = await import(
  "@vex-agent/db/repos/transactions-failure-tools.js"
);

/** Every mutating Pendle tool flipped by this card. */
const PENDLE_MUTATING_TOOLS = [
  "pendle.pt.buy",
  "pendle.pt.sell",
  "pendle.pt.redeem",
  "pendle.yt.buy",
  "pendle.yt.sell",
  "pendle.py.mint",
  "pendle.py.redeem",
  "pendle.lp.add",
  "pendle.lp.remove",
  // R5d: the SY wrap pair mutates too, and `transactions-failure-tools.ts`
  // already maps both to the `yield` product. Additive — nothing else about this
  // expected set changes.
  "pendle.sy.mint",
  "pendle.sy.redeem",
  // R5d card E5: the dual-LP pair (E3) and the three term-mobility writes (E4)
  // are Pendle broadcasts on the same terms — `capture: "none"` because their
  // handlers write `kind: 'yield'` rows straight to `agent_activity`, and the
  // `yield` product so a FAILED attempt is still filed somewhere. Additive
  // again: no existing id's classification changes.
  "pendle.lp.removeDual",
  "pendle.lp.addKeepYt",
  "pendle.pt.rollover",
  "pendle.lp.transfer",
  "pendle.lp.toPt",
  "pendle.claim",
] as const;

const WALLET = "0x1111111111111111111111111111111111111111";
/** PT-SIERRA-6AUG2026 on Ethereum (lowercase on purpose — pins store checksummed). */
const PT_LOWER = "0x0ee083964c815baed1a2d7f5e3cec851ec394e7d";
const PT_CHECKSUM = "0x0ee083964C815bAED1A2d7F5E3Cec851eC394E7d";

describe("pendle acquisition auto-pin", () => {
  beforeEach(() => {
    mockPin.mockReset();
    mockPin.mockResolvedValue({ inserted: true });
  });

  it("pins each acquired token into tracked_tokens, checksummed, source 'swap'", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 1, [
      { address: PT_LOWER, symbol: "PT-SIERRA", decimals: 6 },
      { address: "0x9fc74f8ed616b5baf52a170caa97d6d3898602d1", symbol: null, decimals: null },
    ]);
    expect(mockPin).toHaveBeenCalledTimes(2);
    expect(mockPin).toHaveBeenNthCalledWith(1, {
      walletAddress: WALLET,
      chainId: 1,
      tokenAddress: PT_CHECKSUM,
      source: "swap",
    });
  });

  it("never throws when the pin write fails — a settled on-chain action must not unwind", async () => {
    mockPin.mockRejectedValue(new Error("db down"));
    await expect(
      pinConfirmedPendleAcquisition(WALLET, 1, [{ address: PT_LOWER, symbol: null, decimals: null }]),
    ).resolves.toBeUndefined();
  });

  it("skips a malformed address without aborting the remaining pins", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 1, [
      { address: "not-an-address", symbol: null, decimals: null },
      { address: PT_LOWER, symbol: null, decimals: null },
    ]);
    expect(mockPin).toHaveBeenCalledTimes(1);
    expect(mockPin).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: PT_CHECKSUM }));
  });

  it("writes nothing for a chain Pendle does not serve", async () => {
    await pinConfirmedPendleAcquisition(WALLET, 999999, [
      { address: PT_LOWER, symbol: null, decimals: null },
    ]);
    expect(mockPin).not.toHaveBeenCalled();
  });
});

describe("pendle mutation matrix — capture flip", () => {
  it("every Pendle mutating tool is capture:'none' with no required fields", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      const contract = MUTATION_MATRIX.get(toolId);
      expect(contract, `${toolId} missing from the matrix`).toBeDefined();
      expect(contract!.capture, `${toolId} must not project proj_activity`).toBe("none");
      expect(contract!.requiredFields).toEqual([]);
      expect(contract!.expectedType).toBe("yield");
    }
  });

  it("the capture validator no longer demands a _tradeCapture from a Pendle tool", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      // Pre-flip this returned false for a null capture (capture:"full").
      expect(validateCaptureContract(toolId, null), toolId).toBe(true);
    }
  });
});

describe("pendle failures reach the transactions failure half", () => {
  it("'yield' is a transaction product", () => {
    expect(TRANSACTION_PRODUCTS.has("yield")).toBe(true);
  });

  it("every Pendle mutating tool derives the 'yield' product", () => {
    for (const toolId of PENDLE_MUTATING_TOOLS) {
      expect(FAILURE_TOOL_PRODUCTS.get(toolId), toolId).toBe("yield");
    }
  });

  it("the LP and reward-claim tools are no longer excluded (P2-11)", () => {
    // Pre-flip these three were deliberately absent: their `lp` / `reward`
    // products were not transaction products.
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.lp.add")).toBe(true);
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.lp.remove")).toBe(true);
    expect(FAILURE_TOOL_PRODUCTS.has("pendle.claim")).toBe(true);
  });

  it("failureToolsForProduct('yield') is exactly the Pendle mutating set", () => {
    expect([...failureToolsForProduct("yield")].sort()).toEqual([...PENDLE_MUTATING_TOOLS].sort());
  });

  it("Pendle tools do NOT leak into the 'spot' allowlist any more", () => {
    expect(failureToolsForProduct("spot")).not.toContain("pendle.pt.buy");
  });
});

// ── A0.2: the structural capture invariant ───────────────────────────

/** The params each mutating Pendle tool needs to reach its success return. */
const HARNESS_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  "pendle.pt.buy": { chain: "ethereum", tokenIn: TOKEN_IN, tokenOut: PT_ADDR, amountIn: "1" },
  "pendle.pt.sell": { chain: "ethereum", tokenIn: PT_ADDR, tokenOut: TOKEN_IN, amountIn: "1" },
  "pendle.pt.redeem": { chain: "ethereum", tokenIn: PT_ADDR, amountIn: "1" },
  "pendle.yt.buy": { chain: "ethereum", tokenIn: TOKEN_IN, tokenOut: YT_ADDR, amountIn: "1" },
  "pendle.yt.sell": { chain: "ethereum", tokenIn: YT_ADDR, tokenOut: TOKEN_IN, amountIn: "1" },
  "pendle.py.mint": { chain: "ethereum", pt: PT_ADDR, tokenIn: TOKEN_IN, amountIn: "1" },
  "pendle.py.redeem": { chain: "ethereum", pt: PT_ADDR, tokenOut: UNDERLYING, amountIn: "1" },
  "pendle.lp.add": { chain: "ethereum", market: MARKET_ADDR, tokenIn: TOKEN_IN, amountIn: "1" },
  "pendle.lp.remove": { chain: "ethereum", market: MARKET_ADDR, tokenOut: UNDERLYING, amountIn: "1" },
  "pendle.sy.mint": { chain: "ethereum", sy: SY_ADDR, tokenIn: TOKEN_IN, amountIn: "1" },
  "pendle.sy.redeem": { chain: "ethereum", sy: SY_ADDR, tokenOut: TOKEN_IN, amountIn: "1" },
  "pendle.lp.removeDual": { chain: "ethereum", market: MARKET_ADDR, tokenOut: UNDERLYING, amountIn: "1" },
  "pendle.lp.addKeepYt": { chain: "ethereum", market: MARKET_ADDR, tokenIn: TOKEN_IN, amountIn: "1" },
  "pendle.pt.rollover": { chain: "ethereum", fromPt: PT_ADDR, toPt: UNDERLYING, amountIn: "1" },
  "pendle.lp.transfer": { chain: "ethereum", fromMarket: MARKET_ADDR, toMarket: UNDERLYING, amountIn: "1" },
  "pendle.lp.toPt": { chain: "ethereum", market: MARKET_ADDR, amountIn: "1" },
  "pendle.claim": { chain: "ethereum" },
};

const HARNESS_CTX = {
  sessionPermission: "full" as const,
  approved: true,
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
  sessionId: "sess-invariant",
};

describe("capture:'none' means the handler emits no capture at all (A0.2)", () => {
  /** Every Pendle tool the matrix marks `capture:"none"` — derived, never listed. */
  const pendleNoneTools = [...MUTATION_MATRIX.entries()]
    .filter(([toolId, contract]) => toolId.startsWith("pendle.") && contract.capture === "none")
    .map(([toolId]) => toolId);

  it("covers every Pendle capture:'none' tool in the matrix", () => {
    expect(pendleNoneTools.length).toBeGreaterThan(0);
    for (const toolId of pendleNoneTools) {
      expect(HARNESS_PARAMS[toolId], `${toolId} has no harness params`).toBeDefined();
      expect(PENDLE_HANDLERS[toolId], `${toolId} has no handler`).toBeDefined();
    }
  });

  for (const toolId of [...MUTATION_MATRIX.entries()]
    .filter(([id, c]) => id.startsWith("pendle.") && c.capture === "none")
    .map(([id]) => id)) {
    it(`${toolId} returns no _tradeCapture / _tradeCaptureItems on success`, async () => {
      harnessAction = CONVERT_ACTION_FOR.get(toolId) ?? "swap";
      const res = await PENDLE_HANDLERS[toolId](HARNESS_PARAMS[toolId], HARNESS_CTX);

      expect(res.success, `${toolId}: ${res.output}`).toBe(true);
      const data = (res as { data?: Record<string, unknown> }).data ?? {};
      // The keys, not their values: an explicit `undefined` would still be a key
      // the legacy projection pipeline could read.
      expect(Object.keys(data)).not.toContain("_tradeCapture");
      expect(Object.keys(data)).not.toContain("_tradeCaptureItems");
      // The durable truth is still identified — the agent_activity execution.
      expect(data._executionId).toBe(5);
    });
  }
});
