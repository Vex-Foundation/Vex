/**
 * Pendle DUAL-LP family (R5d card E3) — `pendle.lp.removeDual` /
 * `pendle.lp.addKeepYt`.
 *
 * Four contracts are pinned here, each against something real rather than
 * against a restatement of the code:
 *
 *   1. ROUTE SAFETY — the two LIVE quote-only captures in `./r5d-fixtures.ts`
 *      (chain 1, 2026-07-28, HTTP 201) must pass `selectSafeRoute` under the new
 *      `lp-remove-dual` / `lp-add-keep-yt` intents, and every poisoned variant —
 *      produced by decoding a real capture and moving ONE field — must be
 *      REFUSED. A poison test can therefore never pass because the surrounding
 *      body was wrong.
 *   2. BOTH FLOORS BIND. A dual action has two economically material minimums,
 *      and a test that only lowers the first would leave the second unproven.
 *      Each is lowered on its own, and the second leg of each capture is
 *      lowered while the first stays honest.
 *   3. PREQUOTE IDENTITY — the dry-run recorder and the execute gate call the
 *      SAME builder, so identical inputs must collide, every execute-variance
 *      field must diverge, and the two dual kinds must never authorize each
 *      other.
 *   4. THE RECEIPT PROVES BOTH LEGS. A confirmed dual `yield_lp` row exists only
 *      when the decoder proved the second inflow too; a receipt missing it must
 *      leave the row pending rather than report one leg and invent the other.
 *
 * Plus the manifest bar: context-free descriptions that state what the tools
 * CANNOT do and never imply Pendle has a two-token "dual add".
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, pad, toHex, type Hex } from "viem";

import { selectSafeRoute, type PendleTxIntent } from "@vex-agent/tools/protocols/pendle/calldata.js";
import { PENDLE_ROUTER_ABI } from "@tools/pendle/constants.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";
import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import {
  buildLpDualMatchInput,
  type PendleLpDualLegs,
} from "@vex-agent/tools/protocols/pendle/handlers/lp-dual-prequote.js";
import { decodePendleSettlement } from "@vex-agent/sync/pendle-settlement-decoder.js";
import { PENDLE_LP_DUAL_TOOLS } from "@vex-agent/tools/protocols/pendle/manifests/lp-dual.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_R5D_FIXTURES as F } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const MARKET = getAddress("0x34280882267ffa6383b363e278b027be083bbe3b");
const PT = getAddress("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
const YT = getAddress("0x04b7fa1e727d7290d6e24fa9b426d0c940283a95");
const WSTETH = getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const ONE = 1_000_000_000_000_000_000n;
/** The slippage every R5d capture was quoted at. */
const BPS = 100;

function expectUnsafe(fn: () => unknown, match?: RegExp): void {
  try {
    fn();
    throw new Error("expected PENDLE_UNSAFE_TX, but the call succeeded");
  } catch (err) {
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
    if (match) expect(e.message).toMatch(match);
  }
}

const removeDualResponse = (): PendleConvertResponse => mutableConvertFixture(F.removeLiquidityDual);
const addKeepYtResponse = (): PendleConvertResponse => mutableConvertFixture(F.addLiquidityKeepYt);

const removeDualIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
  action: "lp-remove-dual",
  wallet: WALLET,
  slippageBps: BPS,
  inputToken: MARKET,
  inputAmountWei: ONE,
  isNative: false,
  expectedMarket: MARKET,
  expectedOutputToken: WSTETH,
  ...over,
});

const addKeepYtIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
  action: "lp-add-keep-yt",
  wallet: WALLET,
  slippageBps: BPS,
  inputToken: WSTETH,
  inputAmountWei: ONE,
  isNative: false,
  expectedMarket: MARKET,
  ...over,
});

/** Decode a real capture, move ONE field, re-encode. */
function tamper(data: string, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

/** Apply the same tamper to every route of a response. */
function tamperAll(response: PendleConvertResponse, mutate: (args: unknown[]) => void): void {
  for (const route of response.routes) {
    route.tx.data = tamper(route.tx.data, mutate);
  }
}

// ── 1. Route safety ──────────────────────────────────────────────────

describe("the LIVE dual-LP captures pass the full fund-safety extractor", () => {
  it("remove-liquidity-dual: the provider's own route is accepted", () => {
    expect(() => selectSafeRoute(removeDualIntent(), removeDualResponse())).not.toThrow();
  });

  it("add-liquidity keep-YT: the provider's own route is accepted", () => {
    expect(() => selectSafeRoute(addKeepYtIntent(), addKeepYtResponse())).not.toThrow();
  });

  it("BOTH output legs are actually declared by each capture — a one-leg fixture would prove nothing", () => {
    const dual = removeDualResponse().routes[0]!;
    expect(dual.outputs.map((o) => getAddress(o.token)).sort()).toEqual([PT, WSTETH].sort());
    const keep = addKeepYtResponse().routes[0]!;
    expect(keep.outputs.map((o) => getAddress(o.token)).sort()).toEqual([MARKET, YT].sort());
  });
});

describe("a dual route can never be satisfied by, or satisfy, its single-leg sibling", () => {
  it("a plain lp-remove intent is refused the dual route (method bind)", () => {
    expectUnsafe(
      () => selectSafeRoute(removeDualIntent({ action: "lp-remove" }), removeDualResponse()),
      /removeLiquidityDualTokenAndPt is not valid for a lp-remove/,
    );
  });

  it("a plain lp-add intent is refused the keep-YT route (method bind)", () => {
    // Convert labels BOTH adds `"add-liquidity"`, so this bind is the only thing
    // between a keep-YT route and an intent that never asked to keep the YT.
    expectUnsafe(
      () => selectSafeRoute(addKeepYtIntent({ action: "lp-add" }), addKeepYtResponse()),
      /addLiquiditySingleTokenKeepYt is not valid for a lp-add/,
    );
  });

  it("a dual-remove intent is refused a keep-YT route, and vice-versa", () => {
    expectUnsafe(
      () => selectSafeRoute(removeDualIntent({ inputToken: WSTETH }), addKeepYtResponse()),
      /not valid for a lp-remove-dual/,
    );
    expectUnsafe(
      () => selectSafeRoute(addKeepYtIntent({ inputToken: MARKET }), removeDualResponse()),
      /not valid for a lp-add-keep-yt/,
    );
  });
});

describe("a dual route that is not the one asked for is REFUSED", () => {
  it("a different market at arg 1 is refused", () => {
    expectUnsafe(
      () => selectSafeRoute(removeDualIntent({ expectedMarket: getAddress("0x1111111111111111111111111111111111111111") }), removeDualResponse()),
      /market does not match the quote/,
    );
  });

  it("a receiver other than the session wallet is refused", () => {
    const response = removeDualResponse();
    tamperAll(response, (args) => {
      args[0] = "0x1111111111111111111111111111111111111111";
    });
    for (const route of response.routes) {
      route.contractParamInfo.contractCallParams[0] = "0x1111111111111111111111111111111111111111";
    }
    expectUnsafe(() => selectSafeRoute(removeDualIntent(), response), /receiver is not the session wallet/);
  });

  it("an inflated LP burn inside the calldata is refused", () => {
    const response = removeDualResponse();
    tamperAll(response, (args) => {
      args[2] = ONE * 2n;
    });
    expectUnsafe(() => selectSafeRoute(removeDualIntent(), response), /spend amount does not match/);
  });

  it("an inflated deposit inside the keep-YT calldata is refused", () => {
    const response = addKeepYtResponse();
    tamperAll(response, (args) => {
      args[4] = { ...(args[4] as Record<string, unknown>), netTokenIn: ONE * 2n };
    });
    expectUnsafe(() => selectSafeRoute(addKeepYtIntent(), response), /spend amount does not match/);
  });

  it("a keep-YT route depositing a token other than the quoted one is refused", () => {
    // The approval set is bound BEFORE the calldata, so naming a different input
    // on the intent is caught there — still by name, still before any signature.
    expectUnsafe(
      () => selectSafeRoute(addKeepYtIntent({ inputToken: USDC }), addKeepYtResponse()),
      /approval targets a token other than the input/,
    );
    // And with the approval set left honest, the TokenInput tuple itself is
    // bound: a swapped `tokenIn` inside the calldata cannot slip past.
    const response = addKeepYtResponse();
    tamperAll(response, (args) => {
      args[4] = { ...(args[4] as Record<string, unknown>), tokenIn: USDC };
    });
    expectUnsafe(() => selectSafeRoute(addKeepYtIntent(), response), /input token does not match/);
  });

  it("a dual remove delivering a token leg other than the quoted one is refused", () => {
    expectUnsafe(
      () => selectSafeRoute(removeDualIntent({ expectedOutputToken: USDC }), removeDualResponse()),
      /output token does not match/,
    );
  });

  it("an approval for a token other than the input is refused", () => {
    const response = removeDualResponse();
    response.requiredApprovals[0]!.token = USDC;
    expectUnsafe(() => selectSafeRoute(removeDualIntent(), response), /approval targets a token other than the input/);
  });
});

// ── 2. BOTH price floors bind ────────────────────────────────────────

describe("each dual action's TWO minimum-outputs are bound independently", () => {
  it("a lowered minTokenOut on the dual remove is refused as price_floor", () => {
    const response = removeDualResponse();
    tamperAll(response, (args) => {
      args[3] = { ...(args[3] as Record<string, unknown>), minTokenOut: 1n };
    });
    expectUnsafe(() => selectSafeRoute(removeDualIntent(), response), /price_floor: minTokenOut/);
  });

  it("a lowered minPtOut on the dual remove is refused as price_floor — the SECOND leg", () => {
    const response = removeDualResponse();
    tamperAll(response, (args) => {
      args[4] = 1n;
    });
    expectUnsafe(() => selectSafeRoute(removeDualIntent(), response), /price_floor: minPtOut/);
  });

  it("a lowered minLpOut on the keep-YT add is refused as price_floor", () => {
    const response = addKeepYtResponse();
    tamperAll(response, (args) => {
      args[2] = 1n;
    });
    expectUnsafe(() => selectSafeRoute(addKeepYtIntent(), response), /price_floor: minLpOut/);
  });

  it("a lowered minYtOut on the keep-YT add is refused as price_floor — the SECOND leg", () => {
    const response = addKeepYtResponse();
    tamperAll(response, (args) => {
      args[3] = 1n;
    });
    expectUnsafe(() => selectSafeRoute(addKeepYtIntent(), response), /price_floor: minYtOut/);
  });

  it("the floor follows the CALLER's slippage, not the provider's: 0 bps refuses the 100 bps capture", () => {
    expectUnsafe(() => selectSafeRoute(removeDualIntent({ slippageBps: 0 }), removeDualResponse()), /price_floor/);
    expectUnsafe(() => selectSafeRoute(addKeepYtIntent({ slippageBps: 0 }), addKeepYtResponse()), /price_floor/);
  });
});

// ── 3. Prequote identity — dry run ↔ execute agreement ───────────────

const legs = (over: Partial<PendleLpDualLegs> = {}): PendleLpDualLegs => ({
  chainId: 1,
  walletAddress: WALLET,
  market: MARKET,
  token: WSTETH,
  amount: "1",
  ...over,
});

const removeHash = (params: Record<string, unknown> = { slippageBps: 50 }, over: Partial<PendleLpDualLegs> = {}): string =>
  computePrequoteMatchHash(buildLpDualMatchInput("lp_remove_dual", "sess-1", params, legs(over)));
const addHash = (params: Record<string, unknown> = { slippageBps: 50 }, over: Partial<PendleLpDualLegs> = {}): string =>
  computePrequoteMatchHash(buildLpDualMatchInput("lp_add_keep_yt", "sess-1", params, legs(over)));

describe("dual-LP prequote identity — dry run ↔ execute agreement", () => {
  it("identical inputs collide (the SAME builder runs on both sides)", () => {
    expect(removeHash()).toBe(removeHash());
    expect(addHash()).toBe(addHash());
  });

  it("the two dual kinds never collide, even on identical legs", () => {
    expect(removeHash()).not.toBe(addHash());
  });

  it("a changed market / token leg / amount / slippage / chain / wallet each diverge", () => {
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 50 }, { market: PT }));
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 50 }, { token: USDC }));
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 50 }, { amount: "1.0001" }));
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 100 }));
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 50 }, { chainId: 42161 }));
    expect(removeHash()).not.toBe(removeHash({ slippageBps: 50 }, { walletAddress: USDC }));
  });

  it("an omitted slippage normalizes to the handler default (50) on both sides", () => {
    expect(removeHash({})).toBe(removeHash({ slippageBps: 50 }));
    expect(addHash({})).toBe(addHash({ slippageBps: 50 }));
  });

  it("the identity binds the RESOLVED market and puts the varying leg on the right side", () => {
    const remove = buildLpDualMatchInput("lp_remove_dual", "sess-1", {}, legs());
    const add = buildLpDualMatchInput("lp_add_keep_yt", "sess-1", {}, legs());
    expect(remove).toMatchObject({ kind: "lp_remove_dual", market: MARKET, tokenOut: WSTETH, receiver: WALLET });
    expect(add).toMatchObject({ kind: "lp_add_keep_yt", market: MARKET, tokenIn: WSTETH, receiver: WALLET });
  });

  it("a fractional slippage is refused, never truncated into the digest", () => {
    expect(() => buildLpDualMatchInput("lp_remove_dual", "s", { slippageBps: 0.5 }, legs())).toThrow();
    expect(() => buildLpDualMatchInput("lp_add_keep_yt", "s", { slippageBps: "50" }, legs())).toThrow();
  });
});

// ── 4. The receipt must prove BOTH legs ──────────────────────────────

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One ERC-20 Transfer log, as the settlement decoder reads them. */
function transferLog(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
    data: pad(toHex(amount), { size: 32 }),
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

const dualSettlementInput = (logs: ReturnType<typeof transferLog>[]) => ({
  receipt: { logs },
  protocolExecutionId: 0,
  chainId: 1,
  walletAddress: WALLET,
  tokenInAddress: MARKET,
  tokenOutAddress: WSTETH,
  tokenIn2Address: null,
  tokenOut2Address: PT,
  eventRole: "yield_lp" as const,
});

describe("a confirmed dual yield_lp row proves BOTH output legs", () => {
  it("both proven inflows decode into the two executed amounts", () => {
    const decoded = decodePendleSettlement(
      dualSettlementInput([
        transferLog(MARKET, WALLET, ZERO, ONE),
        transferLog(WSTETH, ZERO, WALLET, 1_691_767_389_559_584_722n),
        transferLog(PT, ZERO, WALLET, 121_462_685_181_226_835n),
      ]),
    );
    expect(decoded).toEqual({
      executedAmountInRaw: ONE.toString(),
      executedAmountOutRaw: "1691767389559584722",
      executedAmountOut2Raw: "121462685181226835",
    });
  });

  it("a receipt missing the PT leg decodes to NOTHING — the row stays pending rather than reporting half a fill", () => {
    const decoded = decodePendleSettlement(
      dualSettlementInput([
        transferLog(MARKET, WALLET, ZERO, ONE),
        transferLog(WSTETH, ZERO, WALLET, 1_691_767_389_559_584_722n),
      ]),
    );
    expect(decoded).toBeNull();
  });
});

// ── 5. The manifests ─────────────────────────────────────────────────

const manifestFor = (toolId: string) => {
  const found = PENDLE_LP_DUAL_TOOLS.find((t) => t.toolId === toolId);
  if (!found) throw new Error(`no manifest for ${toolId}`);
  return found;
};

describe("the dual-LP manifests meet the context-free agent bar", () => {
  it("both tools are approval-gated broadcast tools carrying dryRun", () => {
    for (const toolId of ["pendle.lp.removeDual", "pendle.lp.addKeepYt"]) {
      const m = manifestFor(toolId);
      expect(m.mutating).toBe(true);
      expect(m.actionKind).toBe("user_wallet_broadcast");
      expect(m.lifecycle).toBe("active");
      expect(m.params.some((param) => param.key === "dryRun")).toBe(true);
      expect(m.discovery?.embeddingText?.length ?? 0).toBeGreaterThan(0);
      expect(m.discovery?.exampleIntents?.length).toBe(3);
    }
  });

  it("removeDual takes the LP amount with an OPTIONAL token leg; addKeepYt requires its payment token", () => {
    expect(manifestFor("pendle.lp.removeDual").params.map((param) => param.key)).toEqual([
      "chain", "market", "tokenOut", "amountIn", "slippageBps", "dryRun",
    ]);
    expect(
      manifestFor("pendle.lp.removeDual").params.filter((param) => param.required).map((param) => param.key),
    ).toEqual(["chain", "market", "amountIn"]);
    expect(manifestFor("pendle.lp.addKeepYt").params.map((param) => param.key)).toEqual([
      "chain", "market", "tokenIn", "amountIn", "slippageBps", "dryRun",
    ]);
    expect(
      manifestFor("pendle.lp.addKeepYt").params.filter((param) => param.required).map((param) => param.key),
    ).toEqual(["chain", "market", "tokenIn", "amountIn"]);
  });

  it("each description states the dryRun-then-execute contract and what the tool CANNOT do", () => {
    for (const toolId of ["pendle.lp.removeDual", "pendle.lp.addKeepYt"]) {
      const d = manifestFor(toolId).description;
      expect(d).toMatch(/dryRun: true/);
      expect(d).toMatch(/EXACT same params/);
      expect(d).toMatch(/CANNOT/);
      expect(d).toMatch(/Approval-gated/);
      expect(d).toMatch(/human-readable units/);
      // BOTH legs are the product; a description that named one would sell a
      // single-token action.
      expect(d).toMatch(/TWO/);
    }
  });

  it("slippage is documented as whole basis points with the policy maximum, covering both legs", () => {
    const slippage = manifestFor("pendle.lp.removeDual").params.find((param) => param.key === "slippageBps");
    expect(slippage?.unit).toBe("bps");
    expect(slippage?.description).toMatch(/0\.50%/);
    expect(slippage?.description).toMatch(/1000 = 10%/);
    expect(slippage?.description).toMatch(/BOTH output legs/);
  });

  it("neither tool implies an add-liquidity-DUAL exists — the keep-YT add says so out loud", () => {
    const add = manifestFor("pendle.lp.addKeepYt");
    expect(add.description).toMatch(/SINGLE-token deposit/);
    expect(add.description).toMatch(/no two-token 'dual add'/);
    expect(add.description).toMatch(/CANNOT: deposit two tokens/);
    // The only mention of a "dual add" anywhere in this family is a DENIAL that
    // one exists — the retrieval passage states it too, so an agent that finds
    // the tool by dense search reads the same boundary the manifest states.
    expect(add.discovery?.embeddingText ?? "").toMatch(/Pendle has no dual add/);
    for (const tool of PENDLE_LP_DUAL_TOOLS) {
      expect(tool.description).not.toMatch(/dual add liquidity/i);
      expect(tool.description).not.toMatch(/add liquidity dual/i);
      expect(tool.discovery?.embeddingText ?? "").not.toMatch(/dual add liquidity/i);
    }
  });

  it("the exit-shaped tool documents that it works after expiry; the buy-shaped one that it does not", () => {
    expect(manifestFor("pendle.lp.removeDual").description).toMatch(/AFTER the market's expiry/);
    expect(manifestFor("pendle.lp.addKeepYt").description).toMatch(/must NOT have expired/);
  });
});
