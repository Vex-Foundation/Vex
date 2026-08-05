/**
 * Pendle fund-safety extractor — G2#1 calldata intent-binding poisoned matrix
 * (FULL ABI decode per Codex final review).
 *
 * Clean live-probed routes pass; every poisoning throws PENDLE_UNSAFE_TX →
 * ZERO approve, ZERO send. Tampering is done by decode → mutate → re-encode
 * against the complete Router ABI (so the poisoned calldata is structurally
 * valid — only the FULL decode + intent binding can catch it):
 *   wrong Router, wrong receiver, wrong market/YT, unknown selector, tx.from
 *   mismatch, extra approval, inflated approval, value-on-non-native, wrong
 *   native value, inflated netTokenIn / exactPtIn / netPyIn, wrong tuple
 *   input/output token.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import {
  assertRouteSafe,
  decodeRouterCall,
  selectSafeRoute,
  type PendleTxIntent,
} from "@vex-agent/tools/protocols/pendle/calldata.js";
import { PENDLE_ROUTER, PENDLE_ROUTER_ABI } from "@tools/pendle/constants.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_LIVE_FIXTURES as F } from "./fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

// sUSDe YT + market (the P3 YT/claim fixtures live on this market).
const YT_SUSDE = getAddress("0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2");

const clone = mutableConvertFixture;

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const PT = getAddress("0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb");
const MARKET = getAddress("0x177768caf9d0e036725a51d3f60d7e20f2d4d194");
const PT_REDEEM = getAddress("0x1a69154f6f6247e4457332860fb173251a36e03f");
const YT = getAddress("0x8a9e90fe18e9d243f804022224fbd8380d6b76f6");
const REDEEM_OUT = getAddress("0x6bf7788eaa948d9ffba7e9bb386e2d3c9810e0fc");
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");

/** Decode live calldata, mutate the decoded args, re-encode (still ABI-valid). */
function tamper(data: string, mutate: (args: unknown[]) => void): string {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({
    abi: PENDLE_ROUTER_ABI,
    functionName: d.functionName,
    args: args as never,
  });
}

function buyIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "buy",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    inputToken: USDC,
    inputAmountWei: 100000000n,
    isNative: false,
    expectedMarket: MARKET,
    ptAddress: PT,
    ...over,
  };
}

function sellIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "sell",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    inputToken: PT,
    inputAmountWei: 100000000000000000000n,
    isNative: false,
    expectedMarket: MARKET,
    ptAddress: PT,
    expectedOutputToken: USDC,
    ...over,
  };
}

function redeemIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "redeem",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    inputToken: PT_REDEEM,
    inputAmountWei: 100000000n,
    isNative: false,
    expectedYt: YT,
    ptAddress: PT_REDEEM,
    expectedOutputToken: REDEEM_OUT,
    ...over,
  };
}

/** A structurally-valid (ABI-encodable) maker-order fill for limit-tuple poisons. */
function poisonFill(): unknown {
  return {
    order: {
      salt: 0n,
      expiry: 0n,
      nonce: 0n,
      orderType: 0,
      token: ATTACKER,
      YT: ATTACKER,
      maker: ATTACKER,
      receiver: ATTACKER,
      makingAmount: 1n,
      lnImpliedRate: 0n,
      failSafeRate: 0n,
      permit: "0x",
    },
    signature: "0x",
    makingAmount: 1n,
  };
}

function expectUnsafe(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected PENDLE_UNSAFE_TX, but the call succeeded");
  } catch (err) {
    expect((err as { code?: string }).code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
  }
}

describe("pendle full calldata decode (live-probed)", () => {
  it("decodes the buy route: receiver, market, AND the TokenInput spend", () => {
    const call = decodeRouterCall(F.buy.routes[0].tx.data);
    expect(call.method).toBe("swapExactTokenForPt");
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(MARKET);
    expect(call.spendWei).toBe(100000000n);
    expect(call.input?.token).toBe(USDC);
  });

  it("decodes the sell route: exactPtIn AND the TokenOutput token", () => {
    const call = decodeRouterCall(F.sell.routes[0].tx.data);
    expect(call.method).toBe("swapExactPtForToken");
    expect(call.spendWei).toBe(100000000000000000000n);
    expect(call.output?.token).toBe(USDC);
  });

  it("decodes the native buy route: zero-address tokenIn + netTokenIn", () => {
    const call = decodeRouterCall(F.native.routes[0].tx.data);
    expect(call.input?.token).toBe(getAddress("0x0000000000000000000000000000000000000000"));
    expect(call.spendWei).toBe(1000000000000000000n);
  });

  it("decodes the redeem route: YT, netPyIn, output token", () => {
    const call = decodeRouterCall(F.redeem.routes[0].tx.data);
    expect(call.method).toBe("redeemPyToToken");
    expect(call.marketOrYt).toBe(YT);
    expect(call.spendWei).toBe(100000000n);
    expect(call.output?.token).toBe(REDEEM_OUT);
  });

  it("decodes the redeemPyToSy fallback route", () => {
    const call = decodeRouterCall(F.redeemSy.routes[0].tx.data);
    expect(call.method).toBe("redeemPyToSy");
    expect(call.marketOrYt).toBe(YT);
    expect(call.spendWei).toBe(100000000n);
  });
});

describe("pendle clean routes pass", () => {
  it("accepts the live-probed buy route", () => {
    const resp = clone(F.buy);
    const route = selectSafeRoute(buyIntent(), resp);
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });

  it("accepts the live-probed sell route (output token bound)", () => {
    const resp = clone(F.sell);
    const route = selectSafeRoute(sellIntent(), resp);
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });

  it("accepts the live-probed redeem route (YT + PT approvals + output bound)", () => {
    const resp = clone(F.redeem);
    const route = selectSafeRoute(redeemIntent(), resp);
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
});

describe("pendle buy — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("wrong receiver inside the calldata", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      args[0] = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("wrong market (intent market != decoded market)", () => {
    const resp = clone(F.buy);
    expectUnsafe(() => selectSafeRoute(buyIntent({ expectedMarket: ATTACKER }), resp));
  });

  it("unknown selector", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = "0xdeadbeef" + resp.routes[0].tx.data.slice(10);
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("tx.from mismatch", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.from = ATTACKER;
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("extra approval entry", () => {
    const resp = clone(F.buy);
    resp.requiredApprovals.push({ token: ATTACKER, amount: "100000000" });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("inflated approval amount", () => {
    const resp = clone(F.buy);
    resp.requiredApprovals[0].amount = "999999999999";
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("non-native trade must not send native value", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("INFLATED TokenInput.netTokenIn (spend > quoted input)", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[4] as { netTokenIn: bigint }).netTokenIn = 999999999999n;
    });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("WRONG TokenInput.tokenIn (spend token != quoted input token)", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[4] as { tokenIn: string }).tokenIn = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("INJECTED limit-order fill (useLimitOrder is disabled — limit tuple must be empty)", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[5] as { normalFills: unknown[] }).normalFills.push(poisonFill());
    });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });

  it("INJECTED flash fill (limit tuple must be empty)", () => {
    const resp = clone(F.buy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[5] as { flashFills: unknown[] }).flashFills.push(poisonFill());
    });
    expectUnsafe(() => selectSafeRoute(buyIntent(), resp));
  });
});

describe("pendle sell — poisoned matrix", () => {
  it("INJECTED limit-order fill (sell-side limit tuple must be empty)", () => {
    const resp = clone(F.sell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[4] as { normalFills: unknown[] }).normalFills.push(poisonFill());
    });
    expectUnsafe(() => selectSafeRoute(sellIntent(), resp));
  });

  it("INFLATED exactPtIn (spend > quoted input)", () => {
    const resp = clone(F.sell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      args[2] = 200000000000000000000n;
    });
    expectUnsafe(() => selectSafeRoute(sellIntent(), resp));
  });

  it("WRONG TokenOutput.tokenOut (output token != quoted output)", () => {
    const resp = clone(F.sell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[3] as { tokenOut: string }).tokenOut = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(sellIntent(), resp));
  });

  it("wrong receiver on the sell (proceeds redirected)", () => {
    const resp = clone(F.sell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      args[0] = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(sellIntent(), resp));
  });
});

describe("pendle native buy — value binding", () => {
  const nativeIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
    action: "buy",
    wallet: WALLET,
    slippageBps: 100,
    inputToken: getAddress("0x0000000000000000000000000000000000000000"),
    inputAmountWei: 1000000000000000000n,
    isNative: true,
    expectedMarket: MARKET,
    ptAddress: PT,
    ...over,
  });

  it("accepts native input with matching value + empty approvals", () => {
    const resp = clone(F.native);
    const route = assertRouteSafe(nativeIntent(), resp, resp.routes[0]);
    expect(route.tx.value).toBe("1000000000000000000");
  });

  it("rejects native input whose value != input amount", () => {
    const resp = clone(F.native);
    resp.routes[0].tx.value = "500000000000000000";
    expectUnsafe(() => selectSafeRoute(nativeIntent(), resp));
  });

  it("rejects native input that still requires an approval", () => {
    const resp = clone(F.native);
    resp.requiredApprovals.push({ token: USDC, amount: "1000000000000000000" });
    expectUnsafe(() => selectSafeRoute(nativeIntent(), resp));
  });
});

describe("pendle redeem — poisoned matrix", () => {
  it("rejects a redeem with an extra (non YT/PT) approval", () => {
    const resp = clone(F.redeem);
    resp.requiredApprovals.push({ token: ATTACKER, amount: "100000000" });
    expectUnsafe(() => selectSafeRoute(redeemIntent(), resp));
  });

  it("rejects a redeem with an inflated approval amount", () => {
    const resp = clone(F.redeem);
    resp.requiredApprovals[0].amount = "500000000";
    expectUnsafe(() => selectSafeRoute(redeemIntent(), resp));
  });

  it("rejects a redeem whose YT != the position's YT", () => {
    const resp = clone(F.redeem);
    expectUnsafe(() => selectSafeRoute(redeemIntent({ expectedYt: ATTACKER }), resp));
  });

  it("INFLATED netPyIn (spend > quoted input)", () => {
    const resp = clone(F.redeem);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      args[2] = 500000000n;
    });
    expectUnsafe(() => selectSafeRoute(redeemIntent(), resp));
  });

  it("WRONG TokenOutput.tokenOut on the redeem", () => {
    const resp = clone(F.redeem);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      (args[3] as { tokenOut: string }).tokenOut = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(redeemIntent(), resp));
  });

  it("wrong receiver on the redeem (principal redirected)", () => {
    const resp = clone(F.redeem);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => {
      args[0] = ATTACKER;
    });
    expectUnsafe(() => selectSafeRoute(redeemIntent(), resp));
  });
});

// ── YT swaps (P3) — IPActionSwapYTV3, identical layout to the PT swaps ──

function ytBuyIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "yt-buy",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 50,
    inputToken: USDC,
    inputAmountWei: 100000000n,
    isNative: false,
    expectedMarket: MARKET,
    ...over,
  };
}

function ytSellIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "yt-sell",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 50,
    inputToken: YT_SUSDE,
    inputAmountWei: 1000000000000000000000n,
    isNative: false,
    expectedMarket: MARKET,
    expectedOutputToken: USDC,
    ...over,
  };
}

describe("pendle YT full calldata decode (live-probed)", () => {
  it("decodes the YT buy route: receiver, market, TokenInput spend", () => {
    const call = decodeRouterCall(F.ytBuy.routes[0].tx.data);
    expect(call.method).toBe("swapExactTokenForYt");
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(MARKET);
    expect(call.spendWei).toBe(100000000n);
    expect(call.input?.token).toBe(USDC);
  });

  it("decodes the YT sell route: exactYtIn AND the TokenOutput token", () => {
    const call = decodeRouterCall(F.ytSell.routes[0].tx.data);
    expect(call.method).toBe("swapExactYtForToken");
    expect(call.spendWei).toBe(1000000000000000000000n);
    expect(call.output?.token).toBe(USDC);
  });
});

describe("pendle YT clean routes pass", () => {
  it("accepts the live-probed YT buy route", () => {
    const route = selectSafeRoute(ytBuyIntent(), clone(F.ytBuy));
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
  it("accepts the live-probed YT sell route (output token bound)", () => {
    const route = selectSafeRoute(ytSellIntent(), clone(F.ytSell));
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
});

describe("pendle YT buy — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.ytBuy); resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("wrong receiver inside the calldata", () => {
    const resp = clone(F.ytBuy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("wrong market (intent market != decoded market)", () => {
    expectUnsafe(() => selectSafeRoute(ytBuyIntent({ expectedMarket: ATTACKER }), clone(F.ytBuy)));
  });
  it("wrong selector — a PT-buy method can never satisfy a YT-buy intent", () => {
    const resp = clone(F.ytBuy); resp.routes[0].tx.data = F.buy.routes[0].tx.data;
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("extra approval entry", () => {
    const resp = clone(F.ytBuy); resp.requiredApprovals.push({ token: ATTACKER, amount: "100000000" });
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("non-native trade must not send native value", () => {
    const resp = clone(F.ytBuy); resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("INFLATED TokenInput.netTokenIn (spend > quoted input)", () => {
    const resp = clone(F.ytBuy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[4] as { netTokenIn: bigint }).netTokenIn = 999999999999n; });
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
  it("WRONG TokenInput.tokenIn (spend token != quoted input)", () => {
    const resp = clone(F.ytBuy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[4] as { tokenIn: string }).tokenIn = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(ytBuyIntent(), resp));
  });
});

describe("pendle YT sell — poisoned matrix", () => {
  it("INFLATED exactYtIn (spend > quoted input)", () => {
    const resp = clone(F.ytSell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[2] = 2000000000000000000000n; });
    expectUnsafe(() => selectSafeRoute(ytSellIntent(), resp));
  });
  it("WRONG TokenOutput.tokenOut (output != quoted output)", () => {
    const resp = clone(F.ytSell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[3] as { tokenOut: string }).tokenOut = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(ytSellIntent(), resp));
  });
  it("wrong receiver on the sell (proceeds redirected)", () => {
    const resp = clone(F.ytSell);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(ytSellIntent(), resp));
  });
});
