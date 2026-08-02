/**
 * Agent-facing disclosure of the Vex Trench fee.
 *
 * ONE shape across `trench.trade_quote`, `trench.launch_preview` and both
 * execute handlers, so the model sees identical field names wherever it meets
 * the fee. Field names mirror `bridge-fee/fee-disclosure.ts` deliberately — the
 * agent already reads that shape on every bridge.
 *
 * Two things this disclosure must be honest about, and both are why it carries
 * more than a number:
 *
 *   `basis`   — WHICH leg the fee came out of. On a SELL that is the ETH the
 *               user RECEIVES, not the token they sent, which is a deviation
 *               from `currency_in` and would be misleading if merely implied.
 *   `note`    — that the fee leg runs AFTER the trade or launch confirms, as a
 *               separate transaction. A trade that does not happen is never
 *               charged, and a fee that fails leaves the trade untouched.
 *
 * The fee is disclosure, NOT an approval gate (owner decision, as on bridges).
 * It is exactly computable before any quote exists, so it can be stated
 * truthfully on every surface. USD figures are always labelled ESTIMATES and
 * degrade to `null` rather than to a fabricated figure.
 */

import { formatEther } from "viem";

import { TRENCH_FEE_BPS, TRENCH_FEE_RECEIVER_EVM, type TrenchFeeBasis } from "./constants.js";

/** Plain-language statement of which leg the fee was taken on. */
const BASIS_TEXT: Readonly<Record<TrenchFeeBasis, string>> = {
  buy_eth_in: "the ETH you spend on this buy",
  sell_eth_out: "the ETH you receive from this sell",
  launch_msg_value: "the ETH this launch sends (creation fee + prebuy)",
};

interface TrenchFeeAmounts {
  /**
   * The ETH-leg amount the fee was computed from, in wei — or `null` when Vex
   * could not prove one.
   *
   * `null` is load-bearing on a SELL whose proceeds failed to decode: the only
   * ETH figure available there is the QUOTE, and publishing it as the fee's base
   * would put an estimate into the record of a settled trade. Rule 90: a decoder
   * that cannot prove what happened declines instead of guessing.
   */
  readonly baseAmountWei: string | null;
  readonly note: string;
}

export type TrenchFeeDisclosure =
  | (TrenchFeeAmounts & {
      readonly charged: true;
      readonly bps: number;
      /** Which ETH leg the fee is taken on — the honest name for the sell deviation. */
      readonly basis: TrenchFeeBasis;
      readonly chargedOn: string;
      /** Smallest units, exact — debited from the wallet and sent to the treasury. */
      readonly feeAmountWei: string;
      /** Exact decimal ETH rendering of `feeAmountWei`. */
      readonly feeAmountEth: string;
      /**
       * What the curve is quoted for after the fee, on a BUY. `null` on a sell
       * (the fee comes out of the proceeds, not the input) and on a launch (the
       * fee is a separate transaction and does not reduce `msg.value`).
       */
      readonly netAmountWei: string | null;
      /** Nullable ESTIMATE. */
      readonly feeUsdEstimate: string | null;
      readonly receiver: string;
    })
  | (TrenchFeeAmounts & {
      readonly charged: false;
      readonly bps: 0;
      readonly basis: TrenchFeeBasis;
      /** Plain-language reason no fee was taken. */
      readonly reason: string;
    });

const ORDERING_NOTE =
  `Vex charges ${TRENCH_FEE_BPS} bps (0.25%) on the ETH leg of every Trench Express action, as a SEPARATE `
  + "transfer to the Vex treasury that runs AFTER the trade or launch confirms. A trade or launch that does "
  + "not happen is never charged, and a fee transfer that fails leaves the trade itself completely unaffected. "
  + "USD figures are estimates.";

const SKIPPED_NOTE =
  "No Vex fee was taken on this Trench Express action: 25 bps of the ETH leg floors to zero at this size, "
  + "so no fee transfer is made at all.";

const UNPROVEN_BASE_NOTE =
  "No Vex fee was taken on this Trench Express action: the ETH leg it would be charged on could not be "
  + "established from the transaction, and Vex does not charge a percentage of an amount it cannot prove. "
  + "The action itself is unaffected.";

export function buildTrenchFeeDisclosure(input: {
  readonly basis: TrenchFeeBasis;
  readonly baseWei: bigint;
  readonly feeWei: bigint;
  /** Only meaningful on a BUY — see `netAmountWei`. */
  readonly netWei?: bigint | undefined;
  readonly feeUsdEstimate?: string | undefined;
}): TrenchFeeDisclosure {
  return {
    charged: true,
    bps: TRENCH_FEE_BPS,
    basis: input.basis,
    chargedOn: BASIS_TEXT[input.basis],
    feeAmountWei: input.feeWei.toString(),
    feeAmountEth: formatEther(input.feeWei),
    netAmountWei: input.basis === "buy_eth_in" && input.netWei !== undefined ? input.netWei.toString() : null,
    feeUsdEstimate: input.feeUsdEstimate ?? null,
    receiver: TRENCH_FEE_RECEIVER_EVM,
    baseAmountWei: input.baseWei.toString(),
    note: ORDERING_NOTE,
  };
}

/**
 * No fee was taken. Either the 25 bps floored to zero, or — with `baseWei`
 * omitted — Vex could not prove a base at all and therefore took nothing rather
 * than charging a percentage of an estimate.
 */
export function buildTrenchFeeSkippedDisclosure(input: {
  readonly basis: TrenchFeeBasis;
  readonly baseWei?: bigint | undefined;
  readonly reason: string;
}): TrenchFeeDisclosure {
  return {
    charged: false,
    bps: 0,
    basis: input.basis,
    reason: input.reason,
    baseAmountWei: input.baseWei === undefined ? null : input.baseWei.toString(),
    note: input.baseWei === undefined ? UNPROVEN_BASE_NOTE : SKIPPED_NOTE,
  };
}
