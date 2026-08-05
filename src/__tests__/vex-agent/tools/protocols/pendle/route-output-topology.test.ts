/**
 * The funded-lane blocker: a route-output topology the RESPONSE gets to choose.
 *
 * Four write paths bound their price floor to `route.outputs` while running on a
 * Router selector whose minimum-output is a BARE `uint256` — `mintSyFromToken`
 * (sy.mint), `removeLiquiditySinglePt` (lp.toPt), and the two `callAndReflect`
 * final legs `swapExactSyForPt` (pt.rollover) and `addLiquiditySingleSy`
 * (lp.transfer). Those selectors name no output token anywhere in the calldata,
 * so `assertRouteFloorBound` had nothing to tie the declared outputs to: a
 * response that declared ONE DUST OUTPUT OF AN UNRELATED TOKEN produced a floor
 * of ~1 raw unit, which every honest-looking min-out clears, while the calldata
 * still delivered the real asset at a completely unbounded price.
 *
 * `calldata/price-floor.ts`'s `assertRouteOutputTopology` closes it by making
 * the CALLER declare what the response is allowed to say, checked EXACTLY and
 * BEFORE any floor arithmetic.
 *
 * WHY THIS FILE EXISTS BESIDE THE BINDER SUITES. `sy-family.test.ts` and
 * `reflect-family.test.ts` pin the refusal at the binder. What only a HANDLER
 * test can pin is the consequence the card actually cares about: on the DRY-RUN
 * path a poisoned response must leave NO prequote authorization behind — because
 * a recorded authorization is what a later execute matches against — and must
 * never reach an approval or a broadcast. Every check here asserts on behaviour
 * (what was recorded, what was signed), never on an internal shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress } from "viem";

import { PENDLE_R5D_FIXTURES as F } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";

// ── Addresses, taken from the live captures the fixtures carry ───────

const WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const SY = getAddress("0xcbc72d92b2dc8187414f6734718563898740c0bc");
const WSTETH = getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0");
const SOURCE_MARKET = getAddress("0x34280882267ffa6383b363e278b027be083bbe3b");
const DEST_MARKET = getAddress("0xba1cbaece600beec76dabc0a4ead31e0339cbe37");
const SOURCE_PT = getAddress("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
const DEST_PT = getAddress("0xa3e7ccf0d0fa014892372c0321731a1ed977068c");
/** The unrelated token a hostile response declares a dust amount of. */
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");

// ── Mocks ────────────────────────────────────────────────────────────

const mockResolveMarketByPt = vi.fn();
const mockResolveMarketByAddress = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: (...a: unknown[]) => mockResolveMarketByPt(...a),
  resolveMarketByAddress: (...a: unknown[]) => mockResolveMarketByAddress(...a),
  buildAssetMap: async () => new Map(),
  priceUsdFor: () => null,
}));
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: async (...a: unknown[]) => {
    const m = await mockResolveMarketByPt(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
  resolveExitMarketByAddress: async (...a: unknown[]) => {
    const m = await mockResolveMarketByAddress(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
}));

const mockConvert = vi.fn();
const mockConvertMulti = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    convert: (...a: unknown[]) => mockConvert(...a),
    convertMulti: (...a: unknown[]) => mockConvertMulti(...a),
  }),
}));

/** Every capture was quoted on 18-decimal legs. */
const mockSendRawTransaction = vi.fn();
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: () => ({ readContract: async () => 18 }),
  getPendleEvmClients: () => ({
    publicClient: {
      readContract: async () => 18,
      estimateGas: async () => 1_000_000n,
      sendRawTransaction: (...a: unknown[]) => mockSendRawTransaction(...a),
      waitForTransactionReceipt: async () => ({ status: "success", logs: [], blockNumber: 1n }),
    },
    walletClient: {
      account: { address: WALLET },
      chain: { id: 1 },
      prepareTransactionRequest: async (r: Record<string, unknown>) => ({ ...r, nonce: 1 }),
      signTransaction: async () => "0x02f8b10101",
    },
  }),
}));

const mockEnsureAllowance = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tools/pendle/erc20.js", () => ({
  ensurePendleAllowanceExact: (...a: unknown[]) => mockEnsureAllowance(...a),
}));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn(async () => undefined),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: `0x${"1".repeat(64)}` }),
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope error" }),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: vi.fn(async () => ({ executionId: 1, events: [{ id: 1 }] })),
  createAgentActivityPreBroadcastFailure: vi.fn(async () => ({ executionId: 2, event: {} })),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
}));

/**
 * The prequote REPO, not the recorder module — so the real
 * `recordPendle*Prequote` runs and this suite proves the authorization is never
 * written, rather than proving a stub was not called.
 */
const mockPrequoteCreate = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (...a: unknown[]) => mockPrequoteCreate(...a),
  existsFreshFailByMatch: vi.fn(async () => false),
  findLatestFreshByMatch: vi.fn(async () => null),
  markConsumed: vi.fn(async () => undefined),
}));

const { PENDLE_SY_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/sy.js");
const { PENDLE_TERM_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/reflect.js");

// ── Market doubles ───────────────────────────────────────────────────

const market = (address: string, pt: string) => ({
  address,
  name: "capture",
  expiry: "2027-01-01T00:00:00.000Z",
  pt,
  yt: STRANGER,
  sy: SY,
  underlyingAsset: WSTETH,
  details: { liquidity: 1, impliedApy: 0.1, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
  categoryIds: [],
  isNew: false,
  isPrime: false,
});

const SOURCE = market(SOURCE_MARKET, SOURCE_PT);
const DEST = market(DEST_MARKET, DEST_PT);

/** A live capture whose declared outputs have been replaced with foreign dust. */
function poisoned(key: keyof typeof F): PendleConvertResponse {
  const response = mutableConvertFixture(F[key]);
  for (const route of response.routes) route.outputs = [{ token: STRANGER, amount: "1" }];
  return response;
}

const ctx = { walletResolution: {}, walletPolicy: {}, sessionId: "session-1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMarketByPt.mockImplementation(async (_chain: number, pt: string) =>
    pt.toLowerCase() === DEST_PT.toLowerCase() ? DEST : SOURCE,
  );
  mockResolveMarketByAddress.mockImplementation(async (_chain: number, addr: string) =>
    addr.toLowerCase() === DEST_MARKET.toLowerCase() ? DEST : SOURCE,
  );
});

// ── The contract, per affected family ────────────────────────────────

type Res = { success: boolean; output: string };

const POISONED_DRY_RUNS: Array<{
  toolId: string;
  run: (p: Record<string, unknown>) => Promise<unknown>;
  params: Record<string, unknown>;
  stage: () => void;
}> = [
  {
    toolId: "pendle.sy.mint",
    run: (p) => PENDLE_SY_HANDLERS["pendle.sy.mint"]!(p, ctx),
    params: { chain: "ethereum", sy: SY, tokenIn: WSTETH, amountIn: "1", slippageBps: 100, dryRun: true },
    stage: () => mockConvert.mockResolvedValue(poisoned("mintSy")),
  },
  {
    toolId: "pendle.pt.rollover",
    run: (p) => PENDLE_TERM_HANDLERS["pendle.pt.rollover"]!(p, ctx),
    params: { chain: "ethereum", fromPt: SOURCE_PT, toPt: DEST_PT, amountIn: "1", slippageBps: 100, dryRun: true },
    stage: () => mockConvertMulti.mockResolvedValue(poisoned("rollOverPtR5d")),
  },
  {
    toolId: "pendle.lp.transfer",
    run: (p) => PENDLE_TERM_HANDLERS["pendle.lp.transfer"]!(p, ctx),
    params: { chain: "ethereum", fromMarket: SOURCE_MARKET, toMarket: DEST_MARKET, amountIn: "1", slippageBps: 100, dryRun: true },
    stage: () => mockConvertMulti.mockResolvedValue(poisoned("transferLiquidity")),
  },
  {
    toolId: "pendle.lp.toPt",
    run: (p) => PENDLE_TERM_HANDLERS["pendle.lp.toPt"]!(p, ctx),
    params: { chain: "ethereum", market: SOURCE_MARKET, amountIn: "1", slippageBps: 100, dryRun: true },
    stage: () => mockConvertMulti.mockResolvedValue(poisoned("convertLpToPt")),
  },
];

describe.each(POISONED_DRY_RUNS)(
  "$toolId — a response that declares an output this action does not deliver",
  ({ run, params, stage }) => {
    beforeEach(() => stage());

    it("is REFUSED on the dry run", async () => {
      const res = (await run(params)) as Res;
      expect(res.success).toBe(false);
    });

    it("records NO prequote authorization, so no execute can ever match it", async () => {
      await run(params);
      expect(mockPrequoteCreate).not.toHaveBeenCalled();
    });

    it("approves nothing and signs nothing", async () => {
      await run(params);
      expect(mockEnsureAllowance).not.toHaveBeenCalled();
      expect(mockSendRawTransaction).not.toHaveBeenCalled();
    });
  },
);

describe("the same responses UNPOISONED still authorize — the guard is not a blanket refusal", () => {
  it("pendle.sy.mint records its prequote on the provider's own capture", async () => {
    mockConvert.mockResolvedValue(mutableConvertFixture(F.mintSy));
    const res = (await PENDLE_SY_HANDLERS["pendle.sy.mint"]!(
      { chain: "ethereum", sy: SY, tokenIn: WSTETH, amountIn: "1", slippageBps: 100, dryRun: true },
      ctx,
    )) as Res;
    expect(res.success).toBe(true);
    expect(mockPrequoteCreate).toHaveBeenCalledTimes(1);
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  it("pendle.lp.toPt records its prequote on the provider's own capture", async () => {
    mockConvertMulti.mockResolvedValue(mutableConvertFixture(F.convertLpToPt));
    const res = (await PENDLE_TERM_HANDLERS["pendle.lp.toPt"]!(
      { chain: "ethereum", market: SOURCE_MARKET, amountIn: "1", slippageBps: 100, dryRun: true },
      ctx,
    )) as Res;
    expect(res.success).toBe(true);
    expect(mockPrequoteCreate).toHaveBeenCalledTimes(1);
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });
});
