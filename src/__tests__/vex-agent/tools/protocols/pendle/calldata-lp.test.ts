/**
 * Pendle LP single-token add/remove fund-safety extractor — poisoned matrix
 * (P5, FULL ABI decode). Clean live-probed routes pass; every poisoning throws
 * PENDLE_UNSAFE_TX → ZERO approve, ZERO send. Tampering is decode → mutate →
 * re-encode against the complete Router ABI (so the poisoned calldata is
 * structurally valid — only the FULL decode + intent binding catches it).
 *
 * lp-add   : addLiquiditySingleToken (0x12599ac6) — arg1 = MARKET, TokenInput at
 *            arg 4, approves EXACTLY the input token.
 * lp-remove: removeLiquiditySingleToken (0x60da0860) — arg1 = MARKET,
 *            netLpToRemove at arg 2, TokenOutput at arg 3, approves EXACTLY the
 *            LP/market token.
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

const clone = mutableConvertFixture;

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const WSTETH = getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0");
const MARKET = getAddress("0x34280882267ffa6383b363e278b027be083bbe3b");
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");
const ONE = 1000000000000000000n;

function tamper(data: string, mutate: (args: unknown[]) => void): string {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

function lpAddIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "lp-add",
    wallet: WALLET,
    // 51, not the 50 this capture was requested at — a MEASURED property of the
    // provider, not a fudge. LP add is the ONE action whose min-out is not a
    // clean function of the quoted output, because minLpOut also absorbs the
    // on-chain `guessPtReceivedFromSy` search. This 2026-07-06 capture embeds a
    // ~50.25 bps haircut for a 50 bps request, i.e. fractionally BELOW our
    // floor; a 2026-07-27 sweep (25/50/100/200/500 bps × two sizes — see
    // `price-floor.test.ts`) found the provider applying only ~HALF the
    // requested haircut, comfortably above it. The guard refuses the first shape
    // and passes the second, which is the fail-safe direction: no funds can
    // leak, and the remedy for a false refusal is a higher slippageBps, never a
    // wider allowance (rules/90 — absolute, never a percentage).
    slippageBps: 51,
    inputToken: WSTETH,
    inputAmountWei: ONE,
    isNative: false,
    expectedMarket: MARKET,
    ...over,
  };
}

function lpRemoveIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "lp-remove",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    // The LP (market) token is the spend token — approvals bind to it.
    inputToken: MARKET,
    inputAmountWei: ONE,
    isNative: false,
    expectedMarket: MARKET,
    expectedOutputToken: WSTETH,
    ...over,
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

describe("pendle LP full calldata decode (live-probed)", () => {
  it("decodes the add route: MARKET at arg1, TokenInput spend at arg4", () => {
    const call = decodeRouterCall(F.lpAdd.routes[0].tx.data);
    expect(call.method).toBe("addLiquiditySingleToken");
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(MARKET);
    expect(call.spendWei).toBe(ONE);
    expect(call.input?.token).toBe(WSTETH);
  });

  it("decodes the remove route: MARKET, netLpToRemove, output token", () => {
    const call = decodeRouterCall(F.lpRemove.routes[0].tx.data);
    expect(call.method).toBe("removeLiquiditySingleToken");
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(MARKET);
    expect(call.spendWei).toBe(ONE);
    expect(call.output?.token).toBe(WSTETH);
  });
});

describe("pendle LP clean routes pass", () => {
  it("accepts the live-probed add route (market + single input approval bound)", () => {
    const route = assertRouteSafe(lpAddIntent(), clone(F.lpAdd), clone(F.lpAdd).routes[0]);
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
  it("accepts the live-probed remove route (market + LP approval + output bound)", () => {
    const route = selectSafeRoute(lpRemoveIntent(), clone(F.lpRemove));
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
});

describe("pendle lp-add — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.lpAdd); resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("wrong receiver inside the calldata", () => {
    const resp = clone(F.lpAdd);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("wrong market (intent market != decoded market)", () => {
    expectUnsafe(() => selectSafeRoute(lpAddIntent({ expectedMarket: ATTACKER }), clone(F.lpAdd)));
  });
  it("wrong selector — a removeLiquiditySingleToken can never satisfy an lp-add intent", () => {
    const resp = clone(F.lpAdd); resp.routes[0].tx.data = F.lpRemove.routes[0].tx.data;
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("extra approval entry (lp-add approves EXACTLY the input token)", () => {
    const resp = clone(F.lpAdd); resp.requiredApprovals.push({ token: MARKET, amount: "1000000000000000000" });
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("foreign approval token (not the input token)", () => {
    const resp = clone(F.lpAdd); resp.requiredApprovals[0].token = ATTACKER;
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("inflated approval amount", () => {
    const resp = clone(F.lpAdd); resp.requiredApprovals[0].amount = "999999999999999999999";
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("non-native trade must not send native value", () => {
    const resp = clone(F.lpAdd); resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("INFLATED TokenInput.netTokenIn (spend > quoted input) — arg4.netTokenIn", () => {
    const resp = clone(F.lpAdd);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[4] as { netTokenIn: bigint }).netTokenIn = 999999999999999999999n; });
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
  it("WRONG TokenInput.tokenIn (spend token != quoted input) — arg4.tokenIn", () => {
    const resp = clone(F.lpAdd);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[4] as { tokenIn: string }).tokenIn = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(lpAddIntent(), resp));
  });
});

describe("pendle lp-remove — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.lpRemove); resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("wrong receiver on the remove (proceeds redirected)", () => {
    const resp = clone(F.lpRemove);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("wrong market (intent market != decoded market)", () => {
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent({ expectedMarket: ATTACKER }), clone(F.lpRemove)));
  });
  it("wrong selector — an addLiquiditySingleToken can never satisfy an lp-remove intent", () => {
    const resp = clone(F.lpRemove); resp.routes[0].tx.data = F.lpAdd.routes[0].tx.data;
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("extra approval entry (lp-remove approves EXACTLY the LP/market token)", () => {
    const resp = clone(F.lpRemove); resp.requiredApprovals.push({ token: WSTETH, amount: "1000000000000000000" });
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("foreign approval token (not the LP/market token)", () => {
    const resp = clone(F.lpRemove); resp.requiredApprovals[0].token = ATTACKER;
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("inflated approval amount", () => {
    const resp = clone(F.lpRemove); resp.requiredApprovals[0].amount = "500000000000000000000";
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("non-native trade must not send native value", () => {
    const resp = clone(F.lpRemove); resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("INFLATED netLpToRemove (spend > quoted input) — arg2", () => {
    const resp = clone(F.lpRemove);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[2] = 5000000000000000000n; });
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
  it("WRONG TokenOutput.tokenOut (output token != quoted output) — arg3.tokenOut", () => {
    const resp = clone(F.lpRemove);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[3] as { tokenOut: string }).tokenOut = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(lpRemoveIntent(), resp));
  });
});
