/**
 * Agent-facing disclosure of Vex's Uniswap integrator fee.
 *
 * Same field names as the bridge disclosure (`bridge-fee/fee-disclosure.ts`) so
 * the model reads one `vexFee` shape across venues, with the bridge-specific
 * `bridgedAmountRaw` replaced by `swappedAmountRaw` — the amount the swap
 * actually executes on.
 *
 * `feeAmountRaw` is DEFINED as the amount debited from the user's wallet and
 * SENT to the treasury. For an ordinary token that is also the amount credited;
 * for a taxing token it is not, which is why the eligibility check declines the
 * fee on tokens it can prove are fee-on-transfer, and why this note states the
 * semantics instead of leaving them implied.
 *
 * The fee is disclosure, NOT an approval gate (owner decision). It is exactly
 * computable before any quote exists, so it is stated truthfully on the quote
 * and the execute alike.
 */

import { formatUnits } from "viem";

import { UNISWAP_FEE_BPS, UNISWAP_FEE_CHARGE_BY } from "./constants.js";

interface UniswapFeeAmounts {
  /** Amount the route was quoted for and the router actually swaps (`amountIn − fee`). */
  readonly swappedAmountRaw: string;
  /** Amount the user is debited in total (the `amountIn` they asked for). */
  readonly totalDebitedRaw: string;
  readonly note: string;
}

export type UniswapFeeDisclosure =
  | (UniswapFeeAmounts & {
      readonly charged: true;
      readonly bps: number;
      /** Always `currency_in` — the fee is taken from the token the user sends. */
      readonly chargedOn: typeof UNISWAP_FEE_CHARGE_BY;
      readonly tokenAddress: string;
      readonly tokenSymbol: string;
      readonly tokenDecimals: number;
      /** Smallest units, exact — debited from the wallet and sent to the treasury. */
      readonly feeAmountRaw: string;
      /** Exact decimal string at the token's own decimals. */
      readonly feeAmountDecimal: string;
      /** Treasury address credited. */
      readonly receiver: string;
    })
  | (UniswapFeeAmounts & {
      readonly charged: false;
      readonly bps: 0;
      /** Plain-language reason no fee was taken. */
      readonly reason: string;
    });

const CHARGED_NOTE =
  `Vex charges ${UNISWAP_FEE_BPS} bps (0.25%) on the input token of every Uniswap swap, as a separate transfer to `
  + "the Vex treasury that runs AFTER the swap confirms — a swap that does not happen is never charged. The quoted "
  + "output is for the post-fee amount, so it is what actually arrives, and `totalDebitedRaw` is what leaves the "
  + "wallet in total. `feeAmountRaw` is the amount debited and sent to the treasury.";

const SKIPPED_NOTE =
  "No Vex fee was taken on this swap. The full requested amount is quoted and swapped.";

export function buildUniswapFeeDisclosure(input: {
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly feeRaw: bigint;
  readonly swappedRaw: bigint;
  readonly totalRaw: bigint;
  readonly receiver: string;
}): UniswapFeeDisclosure {
  return {
    charged: true,
    bps: UNISWAP_FEE_BPS,
    chargedOn: UNISWAP_FEE_CHARGE_BY,
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    feeAmountRaw: input.feeRaw.toString(),
    feeAmountDecimal: formatUnits(input.feeRaw, input.tokenDecimals),
    receiver: input.receiver,
    swappedAmountRaw: input.swappedRaw.toString(),
    totalDebitedRaw: input.totalRaw.toString(),
    note: CHARGED_NOTE,
  };
}

/** No fee was taken — a dust amount, or a token Vex declines to skim. */
export function buildUniswapFeeSkippedDisclosure(input: {
  readonly reason: string;
  readonly totalRaw: bigint;
}): UniswapFeeDisclosure {
  return {
    charged: false,
    bps: 0,
    reason: input.reason,
    swappedAmountRaw: input.totalRaw.toString(),
    totalDebitedRaw: input.totalRaw.toString(),
    note: SKIPPED_NOTE,
  };
}
