/**
 * How much of a Uniswap swap is Vex's fee, and how much reaches the router.
 *
 * ONE function for both `uniswap.swap.quote` and `uniswap.swap.execute`, so the
 * pair can never disagree about the amount the route was priced for. The quote
 * that says "you get X for 1 WETH" must be the quote the execute actually
 * signs, and both are for `amountIn − fee`.
 *
 * ORDER MATTERS: the eligibility check runs BEFORE the quote, because the
 * quoted amount depends on its answer. A fee-on-transfer or honeypot input
 * declines the fee (a `transfer` of it would not deliver what we would record),
 * and then the swap runs on the FULL requested amount.
 */

import { evaluateEvmBridgeFeeEligibility } from "../../bridge-fee/fee-eligibility.js";
import { splitAmountForFeeBps } from "../../vex-fee/bps-split.js";
import { NATIVE_TOKEN_ADDRESS } from "../execute.js";
import type { UniswapToken } from "../types.js";
import { UNISWAP_FEE_BPS, UNISWAP_FEE_RECEIVER_EVM } from "./constants.js";
import {
  buildUniswapFeeDisclosure,
  buildUniswapFeeSkippedDisclosure,
  type UniswapFeeDisclosure,
} from "./disclosure.js";

export interface UniswapFeeCharge {
  /** `null` means NO FEE AT ALL — no leg, no `agent_activity` row, no index. */
  readonly feeRaw: bigint | null;
  /** The amount the route is quoted for and the router is called with. */
  readonly swapAmountRaw: bigint;
  /** What the user is debited in total — always the requested `amountIn`. */
  readonly totalRaw: bigint;
  /**
   * The address the fee leg transfers. The native sentinel for a native input
   * (a value transfer), the ERC-20 contract otherwise. `null` when no fee
   * applies.
   */
  readonly feeTokenAddress: string | null;
  readonly disclosure: UniswapFeeDisclosure;
}

/**
 * Resolve the fee for `amountInRaw` of `tokenIn`. Never throws for a market
 * condition: a provider failure inside the eligibility check is fail-soft
 * (charge, under the "amount sent" semantics the disclosure states), and a fee
 * that floors to zero at this size is simply not charged.
 */
export async function resolveUniswapFeeCharge(input: {
  readonly chainId: number;
  readonly tokenIn: UniswapToken;
  readonly amountInRaw: bigint;
}): Promise<UniswapFeeCharge> {
  const { tokenIn, amountInRaw } = input;
  // A native input is spelled as the shared sentinel, never as the deployment's
  // WETH: the fee leg for it is a VALUE transfer, and an ERC-20 `transfer` call
  // against WETH would move a token the user never wrapped.
  const feeTokenAddress = tokenIn.isNative ? NATIVE_TOKEN_ADDRESS : tokenIn.address;

  const eligibility = await evaluateEvmBridgeFeeEligibility(input.chainId, feeTokenAddress);
  if (!eligibility.charge) {
    return skipped(eligibility.reason, amountInRaw);
  }

  const split = splitAmountForFeeBps(amountInRaw, { bps: UNISWAP_FEE_BPS, amountLabel: "Swap amount" });
  if (!split.charged) {
    return skipped("the fee rounds to zero at this size, so no transfer is made", amountInRaw);
  }

  return {
    feeRaw: split.feeRaw,
    swapAmountRaw: split.netRaw,
    totalRaw: split.totalRaw,
    feeTokenAddress,
    disclosure: buildUniswapFeeDisclosure({
      tokenAddress: feeTokenAddress,
      tokenSymbol: tokenIn.symbol,
      tokenDecimals: tokenIn.decimals,
      feeRaw: split.feeRaw,
      swappedRaw: split.netRaw,
      totalRaw: split.totalRaw,
      receiver: UNISWAP_FEE_RECEIVER_EVM,
    }),
  };
}

function skipped(reason: string, totalRaw: bigint): UniswapFeeCharge {
  return {
    feeRaw: null,
    swapAmountRaw: totalRaw,
    totalRaw,
    feeTokenAddress: null,
    disclosure: buildUniswapFeeSkippedDisclosure({ reason, totalRaw }),
  };
}
