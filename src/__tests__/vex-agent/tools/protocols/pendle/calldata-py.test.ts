/**
 * Pendle PY (mint / pre-expiry redeem) fund-safety extractor — poisoned matrix
 * (P4, FULL ABI decode). Clean live-probed routes pass; every poisoning throws
 * PENDLE_UNSAFE_TX → ZERO approve, ZERO send. Tampering is decode → mutate →
 * re-encode against the complete Router ABI (so the poisoned calldata is
 * structurally valid — only the FULL decode + intent binding catches it).
 *
 * py-mint : mintPyFromToken (0xd0f42385) — arg1 = YT, TokenInput at arg 3,
 *           approves EXACTLY the input token.
 * py-redeem: redeemPyToToken (0x47f1de22) — arg1 = YT, TokenOutput at arg 3,
 *           approves EXACTLY {YT, PT}. Distinct from the matured-PT `redeem`
 *           (which also allows the SY fallback); py-redeem is redeemPyToToken ONLY.
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
const PT = getAddress("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
const YT = getAddress("0x04b7fa1e727d7290d6e24fa9b426d0c940283a95");
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");
const ONE = 1000000000000000000n;

function tamper(data: string, mutate: (args: unknown[]) => void): string {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

function mintIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "py-mint",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    inputToken: WSTETH,
    inputAmountWei: ONE,
    isNative: false,
    expectedYt: YT,
    ptAddress: PT,
    ...over,
  };
}

function redeemPyIntent(over: Partial<PendleTxIntent> = {}): PendleTxIntent {
  return {
    action: "py-redeem",
    wallet: WALLET,
    // The tolerance this LIVE capture was quoted at, measured from its own
    // embedded min-out vs its quoted output (see price-floor.test.ts).
    slippageBps: 100,
    inputToken: PT,
    inputAmountWei: ONE,
    isNative: false,
    expectedYt: YT,
    ptAddress: PT,
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

describe("pendle PY full calldata decode (live-probed)", () => {
  it("decodes the mint route: YT at arg1, TokenInput spend at arg3", () => {
    const call = decodeRouterCall(F.mintPy.routes[0].tx.data);
    expect(call.method).toBe("mintPyFromToken");
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(YT);
    expect(call.spendWei).toBe(ONE);
    expect(call.input?.token).toBe(WSTETH);
  });

  it("decodes the pre-expiry redeem route: YT, netPyIn, output token", () => {
    const call = decodeRouterCall(F.redeemPy.routes[0].tx.data);
    expect(call.method).toBe("redeemPyToToken");
    expect(call.marketOrYt).toBe(YT);
    expect(call.spendWei).toBe(ONE);
    expect(call.output?.token).toBe(WSTETH);
  });
});

describe("pendle PY clean routes pass", () => {
  it("accepts the live-probed mint route (YT + single input approval bound)", () => {
    const route = assertRouteSafe(mintIntent(), clone(F.mintPy), clone(F.mintPy).routes[0]);
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
  it("accepts the live-probed pre-expiry redeem route (YT + {PT,YT} approvals + output bound)", () => {
    const route = selectSafeRoute(redeemPyIntent(), clone(F.redeemPy));
    expect(getAddress(route.tx.to)).toBe(PENDLE_ROUTER);
  });
});

describe("pendle py-mint — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.mintPy); resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("wrong receiver inside the calldata", () => {
    const resp = clone(F.mintPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("wrong YT (intent YT != decoded YT)", () => {
    expectUnsafe(() => selectSafeRoute(mintIntent({ expectedYt: ATTACKER }), clone(F.mintPy)));
  });
  it("wrong selector — a redeemPyToToken can never satisfy a py-mint intent", () => {
    const resp = clone(F.mintPy); resp.routes[0].tx.data = F.redeemPy.routes[0].tx.data;
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("extra approval entry (py-mint approves EXACTLY the input token)", () => {
    const resp = clone(F.mintPy); resp.requiredApprovals.push({ token: YT, amount: "1000000000000000000" });
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("foreign approval token (not the input token)", () => {
    const resp = clone(F.mintPy); resp.requiredApprovals[0].token = ATTACKER;
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("inflated approval amount", () => {
    const resp = clone(F.mintPy); resp.requiredApprovals[0].amount = "999999999999999999999";
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("non-native trade must not send native value", () => {
    const resp = clone(F.mintPy); resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("INFLATED TokenInput.netTokenIn (spend > quoted input) — arg3.netTokenIn", () => {
    const resp = clone(F.mintPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[3] as { netTokenIn: bigint }).netTokenIn = 999999999999999999999n; });
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
  it("WRONG TokenInput.tokenIn (spend token != quoted input) — arg3.tokenIn", () => {
    const resp = clone(F.mintPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[3] as { tokenIn: string }).tokenIn = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(mintIntent(), resp));
  });
});

describe("pendle py-redeem — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = clone(F.redeemPy); resp.routes[0].tx.to = ATTACKER;
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("wrong receiver on the redeem (proceeds redirected)", () => {
    const resp = clone(F.redeemPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[0] = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("wrong YT (intent YT != the position's YT)", () => {
    expectUnsafe(() => selectSafeRoute(redeemPyIntent({ expectedYt: ATTACKER }), clone(F.redeemPy)));
  });
  it("extra (non YT/PT) approval", () => {
    const resp = clone(F.redeemPy); resp.requiredApprovals.push({ token: ATTACKER, amount: "1000000000000000000" });
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("foreign approval token (outside {YT, PT})", () => {
    const resp = clone(F.redeemPy); resp.requiredApprovals[0].token = ATTACKER;
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("inflated approval amount", () => {
    const resp = clone(F.redeemPy); resp.requiredApprovals[0].amount = "500000000000000000";
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("non-native trade must not send native value", () => {
    const resp = clone(F.redeemPy); resp.routes[0].tx.value = "1000000000000000000";
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("INFLATED netPyIn (spend > quoted input) — arg2", () => {
    const resp = clone(F.redeemPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { args[2] = 5000000000000000000n; });
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("WRONG TokenOutput.tokenOut (output token != quoted output) — arg3.tokenOut", () => {
    const resp = clone(F.redeemPy);
    resp.routes[0].tx.data = tamper(resp.routes[0].tx.data, (args) => { (args[3] as { tokenOut: string }).tokenOut = ATTACKER; });
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
  it("wrong selector — redeemPyToSy (SY fallback) can never satisfy a py-redeem intent", () => {
    const resp = clone(F.redeemPy); resp.routes[0].tx.data = F.redeemSy.routes[0].tx.data;
    expectUnsafe(() => selectSafeRoute(redeemPyIntent(), resp));
  });
});
