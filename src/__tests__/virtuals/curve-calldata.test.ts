/**
 * The bytes a curve trade actually signs, and what a revert from them MEANS.
 *
 * Nothing on this lane comes from a provider: BondingV5 and FRouterV3 are pinned
 * addresses and every argument is a figure Vex computed, which removes the
 * calldata-substitution risk the aggregator venues carry. What it does NOT
 * remove is the risk of building the RIGHT function with the WRONG arguments, so
 * these tests decode the produced calldata back and assert the four arguments
 * positionally against the Solidity signatures:
 *
 *   BondingV5.buy (uint256 amountIn_, address tokenAddress_, uint256 amountOutMin_, uint256 deadline_)
 *   BondingV5.sell(uint256 amountIn_, address tokenAddress_, uint256 amountOutMin_, uint256 deadline_)
 *
 * The two are argument-identical, which is exactly why a positional test is
 * worth writing: a swapped `amountIn`/`amountOutMin` would still encode, still
 * estimate, and would sign away the whole balance at a floor of nothing.
 *
 * The allowance assertions pin the two product decisions that are easy to
 * regress into: the spender is FRouterV3 (the contract that calls
 * `transferFrom`), NEVER BondingV5, and the amount is EXACT, never infinite.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, maxUint256, toFunctionSelector } from "viem";

import {
  VIRTUALS_CURVE_DEADLINE_SECONDS,
  buildCurveApproveTx,
  buildCurveBuyTx,
  buildCurveSellTx,
  curveDeadlineFrom,
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { BONDING_V5_ABI, CURVE_ERC20_ABI } from "@tools/virtuals/curve/abi.js";
import { classifyCurveRevert } from "@tools/virtuals/curve/revert-mapping.js";

const TOKEN = "0x1984edF491D3399FBc09E6d0856E01fF3721f952";
const CURVE_AMOUNT = 498_750_000_000_000_000n;
const FLOOR = 5_646_592_476_387_574_784_133n;
const DEADLINE = 1_788_530_901n;

function deployment(key: string): VirtualsCurveDeployment {
  const d = virtualsCurveDeployment(key);
  if (d === undefined) throw new Error(`no Virtuals curve deployment for ${key}`);
  return d;
}

const BASE = deployment("base");

describe("buildCurveBuyTx", () => {
  const tx = buildCurveBuyTx({
    deployment: BASE,
    token: TOKEN,
    curveAmountRaw: CURVE_AMOUNT,
    contractMinOutRaw: FLOOR,
    deadlineSeconds: DEADLINE,
  });

  it("calls BondingV5, not the router the allowance is granted to", () => {
    expect(tx.to).toBe(BASE.bondingV5);
    expect(tx.to).not.toBe(BASE.frouterV3);
  });

  it("encodes buy(amountIn, token, amountOutMin, deadline) in that order", () => {
    const decoded = decodeFunctionData({ abi: BONDING_V5_ABI, data: tx.data });
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args).toEqual([CURVE_AMOUNT, getAddress(TOKEN), FLOOR, DEADLINE]);
  });

  it("carries the selector of the four-argument buy and no other overload", () => {
    expect(tx.data.slice(0, 10)).toBe(
      toFunctionSelector("buy(uint256,address,uint256,uint256)"),
    );
  });

  it("sends ZERO native value even though buy is payable", () => {
    // A VIRTUAL-denominated curve takes nothing in ETH; any value here would be
    // unattributed native value leaving the wallet.
    expect(tx.value).toBe(0n);
  });
});

describe("buildCurveSellTx", () => {
  const tx = buildCurveSellTx({
    deployment: BASE,
    token: TOKEN,
    amountInRaw: CURVE_AMOUNT,
    contractGrossMinRaw: FLOOR,
    deadlineSeconds: DEADLINE,
  });

  it("encodes sell(amountIn, token, amountOutMin, deadline) in that order", () => {
    const decoded = decodeFunctionData({ abi: BONDING_V5_ABI, data: tx.data });
    expect(decoded.functionName).toBe("sell");
    expect(decoded.args).toEqual([CURVE_AMOUNT, getAddress(TOKEN), FLOOR, DEADLINE]);
  });

  it("is a DIFFERENT function from buy despite the identical argument list", () => {
    const buy = buildCurveBuyTx({
      deployment: BASE, token: TOKEN, curveAmountRaw: CURVE_AMOUNT,
      contractMinOutRaw: FLOOR, deadlineSeconds: DEADLINE,
    });
    expect(tx.data.slice(0, 10)).not.toBe(buy.data.slice(0, 10));
    // Only the selector differs: the four encoded words are the same, which is
    // what makes the side a thing the prequote identity must bind rather than a
    // thing the calldata reveals.
    expect(tx.data.slice(10)).toBe(buy.data.slice(10));
  });

  it("sends zero native value", () => {
    expect(tx.value).toBe(0n);
  });
});

describe("buildCurveApproveTx - exact, and to the router", () => {
  it("approves the SPENDER that actually calls transferFrom", () => {
    const tx = buildCurveApproveTx({ deployment: BASE, spendToken: BASE.virtual, amountRaw: CURVE_AMOUNT });
    const decoded = decodeFunctionData({ abi: CURVE_ERC20_ABI, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[0]).toBe(getAddress(BASE.frouterV3));
    expect(decoded.args?.[0]).not.toBe(getAddress(BASE.bondingV5));
  });

  it("approves the EXACT amount and never an unlimited allowance", () => {
    const tx = buildCurveApproveTx({ deployment: BASE, spendToken: BASE.virtual, amountRaw: CURVE_AMOUNT });
    const decoded = decodeFunctionData({ abi: CURVE_ERC20_ABI, data: tx.data });
    expect(decoded.args?.[1]).toBe(CURVE_AMOUNT);
    expect(decoded.args?.[1]).not.toBe(maxUint256);
  });

  it("targets the TOKEN this side spends, so a sell approves the agent token", () => {
    const buyApprove = buildCurveApproveTx({ deployment: BASE, spendToken: BASE.virtual, amountRaw: 1n });
    const sellApprove = buildCurveApproveTx({ deployment: BASE, spendToken: TOKEN, amountRaw: 1n });
    expect(buyApprove.to).toBe(BASE.virtual);
    expect(sellApprove.to).toBe(TOKEN);
  });

  it("can build the ZERO reset leg the USDT-style rule needs", () => {
    const tx = buildCurveApproveTx({ deployment: BASE, spendToken: BASE.virtual, amountRaw: 0n });
    const decoded = decodeFunctionData({ abi: CURVE_ERC20_ABI, data: tx.data });
    expect(decoded.args?.[1]).toBe(0n);
  });
});

describe("curveDeadlineFrom", () => {
  it("is a bounded window in whole seconds since the epoch", () => {
    const nowMs = 1_788_530_301_777;
    expect(curveDeadlineFrom(nowMs)).toBe(
      BigInt(Math.floor(nowMs / 1000) + VIRTUALS_CURVE_DEADLINE_SECONDS),
    );
  });

  it("is short enough that a stuck transaction expires rather than landing stale", () => {
    // BondingV5 reverts with InvalidInput once block.timestamp passes it, so the
    // window is the whole time a signed trade can be included at all.
    expect(VIRTUALS_CURVE_DEADLINE_SECONDS).toBeGreaterThan(0);
    expect(VIRTUALS_CURVE_DEADLINE_SECONDS).toBeLessThanOrEqual(900);
  });
});

describe("classifyCurveRevert - four situations, not one 'execution reverted'", () => {
  it.each([
    ["SlippageTooHigh()", "slippage"],
    ["InvalidTokenStatus()", "token_status"],
    ["InvalidInput()", "invalid_input"],
  ] as const)("maps the %s SELECTOR a bare node returns", (signature, kind) => {
    const selector = toFunctionSelector(signature);
    expect(classifyCurveRevert({ details: `execution reverted: ${selector}` }).kind).toBe(kind);
  });

  it.each([
    ["SlippageTooHigh", "slippage"],
    ["InvalidTokenStatus", "token_status"],
    ["InvalidInput", "invalid_input"],
  ] as const)("maps the %s NAME a decoding node returns", (name, kind) => {
    expect(classifyCurveRevert({ shortMessage: `The contract reverted with ${name}.` }).kind).toBe(kind);
  });

  it("reads a nested viem cause rather than only the top-level message", () => {
    const err = { shortMessage: "Execution reverted.", cause: { details: "reverted: SlippageTooHigh" } };
    expect(classifyCurveRevert(err).kind).toBe("slippage");
  });

  it("names an allowance or balance shortfall as its own class", () => {
    expect(classifyCurveRevert({ details: "ERC20: insufficient allowance" }).kind).toBe("allowance_or_balance");
    expect(classifyCurveRevert({ details: "transfer amount exceeds balance" }).kind).toBe("allowance_or_balance");
  });

  it("says UNKNOWN rather than guessing when the contract gave no reason", () => {
    const verdict = classifyCurveRevert({ shortMessage: "Execution reverted for an unknown reason." });
    expect(verdict.kind).toBe("unknown");
    expect(verdict.reason).toContain("no reason Vex can name");
  });

  it("tolerates a non-object error without throwing on the failure path", () => {
    expect(classifyCurveRevert("SlippageTooHigh").kind).toBe("slippage");
    expect(classifyCurveRevert(null).kind).toBe("unknown");
    expect(classifyCurveRevert(undefined).kind).toBe("unknown");
  });

  it("tells the agent that NOTHING was traded on every class", () => {
    for (const err of [
      { details: toFunctionSelector("SlippageTooHigh()") },
      { details: toFunctionSelector("InvalidTokenStatus()") },
      { details: toFunctionSelector("InvalidInput()") },
      { details: "ERC20: insufficient allowance" },
      { details: "who knows" },
    ]) {
      const { reason } = classifyCurveRevert(err);
      expect(reason.toLowerCase()).toMatch(/nothing (was|moved)|not lowered|nothing moved/);
    }
  });
});
