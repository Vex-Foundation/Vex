/**
 * The three transactions a Virtuals curve trade can send, built locally.
 *
 * Nothing here comes from a provider: BondingV5 and FRouterV3 are pinned
 * addresses (`./deployments.ts`), the ABI is transcribed from the first-party
 * source (`./abi.ts`), and every argument is a figure Vex computed. There is no
 * "provider `to`/`data`" to trust on this lane, which removes a whole class of
 * calldata-substitution risk the aggregator venues have to guard against.
 *
 * ALLOWANCE IS EXACT, NEVER INFINITE. The spender is FRouterV3 (it is what calls
 * `transferFrom`), the amount is exactly what this trade spends, and the leg is
 * its own signed transaction with its own `allowance` activity row.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";

import { BONDING_V5_ABI, CURVE_ERC20_ABI } from "./abi.js";
import type { VirtualsCurveDeployment } from "./deployments.js";

/**
 * How long a signed curve trade stays valid, in seconds.
 *
 * `BondingV5.buy`/`.sell` revert with `InvalidInput` once `block.timestamp`
 * passes the deadline, so this is the window in which the transaction may be
 * included at all. Ten minutes: long enough for a congested block on either
 * chain, short enough that a transaction stuck in the mempool expires rather
 * than landing against a curve that has moved on.
 */
export const VIRTUALS_CURVE_DEADLINE_SECONDS = 600;

export interface BuiltCurveTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** `approve(FRouterV3, amount)` on the token this side spends. EXACT amount. */
export function buildCurveApproveTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  /** VIRTUAL on a buy, the agent token on a sell. */
  readonly spendToken: Address;
  readonly amountRaw: bigint;
}): BuiltCurveTx {
  return {
    to: input.spendToken,
    data: encodeFunctionData({
      abi: CURVE_ERC20_ABI,
      functionName: "approve",
      args: [input.deployment.frouterV3, input.amountRaw],
    }),
    value: 0n,
  };
}

/**
 * `BondingV5.buy(curveAmount, token, contractMinOut, deadline)`.
 *
 * `curveAmount` is the amount AFTER Vex's fee and BEFORE the curve's own taxes:
 * the router splits it into `taxedIn` plus the two tax legs and pulls all three
 * from the wallet, which is why the allowance is sized on this number.
 *
 * `value` is 0. The function is `payable`, but a VIRTUAL-denominated curve takes
 * nothing in native value, and sending some would be unattributed native value
 * leaving the wallet.
 */
export function buildCurveBuyTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly curveAmountRaw: bigint;
  readonly contractMinOutRaw: bigint;
  readonly deadlineSeconds: bigint;
}): BuiltCurveTx {
  return {
    to: input.deployment.bondingV5,
    data: encodeFunctionData({
      abi: BONDING_V5_ABI,
      functionName: "buy",
      args: [input.curveAmountRaw, input.token, input.contractMinOutRaw, input.deadlineSeconds],
    }),
    value: 0n,
  };
}

/**
 * `BondingV5.sell(amountIn, token, contractGrossMin, deadline)`.
 *
 * `contractGrossMin` is compared against the router's GROSS output
 * (`BondingV5.sell` :687-688), before the protocol and anti-sniper taxes are
 * removed. It is the only floor the chain enforces on this side.
 */
export function buildCurveSellTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly amountInRaw: bigint;
  readonly contractGrossMinRaw: bigint;
  readonly deadlineSeconds: bigint;
}): BuiltCurveTx {
  return {
    to: input.deployment.bondingV5,
    data: encodeFunctionData({
      abi: BONDING_V5_ABI,
      functionName: "sell",
      args: [input.amountInRaw, input.token, input.contractGrossMinRaw, input.deadlineSeconds],
    }),
    value: 0n,
  };
}

/** The deadline a leg signed now would carry. Seconds since the epoch. */
export function curveDeadlineFrom(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000) + VIRTUALS_CURVE_DEADLINE_SECONDS);
}
