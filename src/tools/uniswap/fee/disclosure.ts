/**
 * Agent-facing disclosure of Vex's Uniswap integrator fee.
 *
 * Same field names as the bridge disclosure (`bridge-fee/fee-disclosure.ts`) so
 * the model reads one `vexFee` shape across venues, with the bridge-specific
 * `bridgedAmountRaw` replaced by `swappedAmountRaw`: the planned router input,
 * or a labelled native lower bound in a settlement result.
 *
 * `feeAmountRaw` is the fee plan's wallet debit. Collection is reported
 * separately. For an ordinary token it is also the amount to be credited;
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
  /** Quoted router input, or a labelled native lower bound after settlement. */
  readonly swappedAmountRaw: string;
  /** Planned total ceiling; NULL when settlement has only a native lower bound. */
  readonly totalDebitedRaw: string | null;
  readonly swappedAmountBasis?: "lower_bound";
  readonly totalDebitedLowerBoundRaw?: string;
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
      /** Exact atomic fee plan; collection is reported separately. */
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
  + "the Vex treasury after confirmation. These are planned amounts, not proof of collection. The quote uses "
  + "post-fee input; output remains an estimate. `totalDebitedRaw` is the requested ceiling. Native input bounds "
  + "can reduce the fee, and missing required evidence withholds it. The execute result states collection separately.";

const SKIPPED_NOTE =
  "No Vex fee is planned. The quote uses the full requested input; settlement determines the recorded amounts.";

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
