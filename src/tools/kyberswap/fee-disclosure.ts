/**
 * Agent-facing disclosure of Vex's KyberSwap integrator fee.
 *
 * Same field names as the Uniswap disclosure (`src/tools/uniswap/fee/
 * disclosure.ts`) and the bridge one (`src/tools/bridge-fee/fee-disclosure.ts`),
 * so the model reads ONE `vexFee` shape across venues and the prequote
 * projection (`prequote/fee-disclosure.ts`) needs no venue-specific arm.
 *
 * ## What differs from the sibling venues, and why there is no skipped arm
 *
 * KyberSwap's router charges the fee INSIDE the swap transaction: Vex requests
 * it in basis points (`isInBps: true`) and the router keeps
 * `floor(amountIn * 25 / 10000)` of the source token before the route executes.
 * There is no separate treasury transfer to decline, no dust check and no
 * fee-on-transfer eligibility oracle on this lane, and the calldata guard
 * REFUSES to sign unless the decoded description carries `desc.feeAmounts ==
 * [KYBERSWAP_FEE_BPS]`, `_FEE_IN_BPS` set, `_FEE_ON_DST` clear and partial fill
 * forbidden. So the charged arm is the only disposition this venue can produce,
 * and a skipped builder here would be a shape nothing can construct.
 *
 * `feeAmountRaw` is DEFINED as the source-token amount the router keeps and
 * credits to the treasury; `swappedAmountRaw` is what the route actually
 * executes on, so the quoted output is already net of the fee.
 *
 * The amount is NOT read off the provider's `routeSummary.extraFee.feeAmount`:
 * because Vex sends the fee as a rate, the aggregator echoes the rate back
 * verbatim (the literal string "25"), which as an amount would be 25 atomic
 * units. `computeKyberVexFeeRaw` states the router's own arithmetic instead -
 * see the measurement recorded in `swap-vex-fee.ts`.
 */

import { formatUnits } from "viem";

import { KYBERSWAP_FEE_BPS, KYBERSWAP_FEE_CHARGE_BY } from "./constants.js";

export interface KyberFeeDisclosure {
  readonly charged: true;
  readonly bps: number;
  /** Always `currency_in` - the fee is taken from the token the user sends. */
  readonly chargedOn: typeof KYBERSWAP_FEE_CHARGE_BY;
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  /** Smallest units, exact - kept by the router and credited to the treasury. */
  readonly feeAmountRaw: string;
  /** Exact decimal string at the token's own decimals. */
  readonly feeAmountDecimal: string;
  /** Treasury address credited. Venue constant, never model input. */
  readonly receiver: string;
  /** Amount the route is quoted for and the router actually swaps. */
  readonly swappedAmountRaw: string;
  /** Amount the user is debited in total (the `amountIn` they asked for). */
  readonly totalDebitedRaw: string;
  readonly note: string;
}

const CHARGED_NOTE =
  `Vex charges ${KYBERSWAP_FEE_BPS} bps (0.25%) on the input token of every KyberSwap aggregator swap. The router `
  + "keeps it inside the swap transaction itself, so there is no separate transfer and a swap that does not "
  + "execute is never charged. The route is priced for `swappedAmountRaw`, so the quoted output is already net "
  + "of the fee, and `totalDebitedRaw` is what leaves the wallet in total.";

export function buildKyberFeeDisclosure(input: {
  readonly tokenAddress: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly feeRaw: bigint;
  readonly swappedRaw: bigint;
  readonly totalRaw: bigint;
  readonly receiver: string;
}): KyberFeeDisclosure {
  return {
    charged: true,
    bps: KYBERSWAP_FEE_BPS,
    chargedOn: KYBERSWAP_FEE_CHARGE_BY,
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
