/**
 * Vex's 25 bps integrator fee on a Virtuals bonding-curve trade.
 *
 * ## The policy, and why the two sides are not symmetric (owner F1/F2)
 *
 * BUY - 25 bps of the VIRTUAL the user COMMITS, deducted from the input before
 * the curve. `committed = curveAmount + vexFee` with integer-floor arithmetic,
 * which is the same `currency_in` model KyberSwap, Uniswap and the bridges use:
 * the caller names the total they are willing to spend, the fee comes off it,
 * and the curve is quoted for the remainder. The exact fee is known before the
 * trade, so it is stated exactly.
 *
 * SELL - 25 bps of the PROVEN executed VIRTUAL output, taken as a separate
 * ERC-20 leg AFTER the sale settles. That number does not exist until the
 * receipt does: the curve removes its own protocol tax and any anti-sniper tax
 * from the router's gross output inside the transaction, so the wallet's real
 * proceeds are a receipt fact. The quote therefore states the RATE and an
 * ESTIMATE at the quoted gross, labelled as an estimate, and the fee leg is
 * built from the decoded receipt or not at all. This is the same asymmetry
 * `engine/core/approval-vex-fee.ts` already describes for the other curve venue,
 * and the same reason that venue is absent from the prequote fee channel: a
 * `currency_in` block cannot express a fee on the output.
 *
 * ## THE ORDER IS THE SAFETY PROPERTY
 *
 * The fee leg is signed only after the trade CONFIRMS, on both sides. A trade
 * that reverts, is refused, or cannot be proven is never charged. The worst case
 * is that Vex misses revenue; never that the user pays for nothing.
 *
 * ## Why there is no fee-eligibility oracle here
 *
 * The sibling venues screen the fee token for fee-on-transfer and honeypot
 * behaviour because the CALLER names it. Here the fee token is always VIRTUAL -
 * a per-chain product constant read back from `FRouterV3.assetToken()` - so
 * there is no caller-chosen token to screen. Declared omission, not an oversight.
 */

import { formatUnits, type Address } from "viem";

import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";
import { splitAmountForFeeBps } from "../../vex-fee/bps-split.js";

import type { VirtualsCurveDeployment } from "./deployments.js";

/** Base is 10000, so 25 = 0.25 percent - the same rate every Vex venue charges. */
export const VIRTUALS_CURVE_FEE_BPS = 25;

/** Fee destination - Vex treasury (token buyback and burn). NEVER from params. */
export const VIRTUALS_CURVE_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * The `agent_activity` `event_role` the fee leg is recorded under.
 *
 * `vex_fee` (migration 102) rather than `swap_fee`: the launchpad family names
 * roles by WHAT happened, and the fold read model asks only whether Vex charged.
 */
export const VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE = "vex_fee" as const;

const BUY_NOTE =
  `Vex charges ${VIRTUALS_CURVE_FEE_BPS} bps (0.25%) of the VIRTUAL you commit on a Virtuals curve buy. `
  + "It is deducted from your input before the curve, so the curve is quoted for the remainder and "
  + "`totalDebitedRaw` is what leaves the wallet in total. The transfer to the Vex treasury runs only "
  + "AFTER the buy confirms, so a buy that does not happen is never charged. The curve's own protocol "
  + "tax and any anti-sniper tax are separate and are already inside the quote.";

const SELL_NOTE =
  `Vex charges ${VIRTUALS_CURVE_FEE_BPS} bps (0.25%) of the VIRTUAL you actually RECEIVE on a Virtuals curve sell, `
  + "as a separate transfer that runs after the sale settles. The exact amount does not exist until then, "
  + "because the curve removes its protocol tax and any anti-sniper tax inside the transaction; the figure "
  + "below is an ESTIMATE at the quoted gross. If the VIRTUAL proceeds cannot be decoded from the receipt, "
  + "Vex takes no fee at all.";

const DUST_REASON = "the fee rounds to zero at this size, so no transfer is made";

/** The buy-side split: what the curve gets, what Vex takes, what the wallet pays. */
export interface VirtualsCurveBuyFee {
  readonly side: "buy";
  /** What leaves the wallet in total - the `amountIn` the caller asked for. */
  readonly committedRaw: bigint;
  /** `committed - fee`; the `amountIn_` argument of `BondingV5.buy`. */
  readonly curveAmountRaw: bigint;
  /** `null` when the fee floors to zero: no leg, no row, no index. */
  readonly feeRaw: bigint | null;
  readonly disclosure: VirtualsCurveFeeDisclosure;
}

/** The sell-side statement: a rate now, an exact amount only after settlement. */
export interface VirtualsCurveSellFee {
  readonly side: "sell";
  /** The VIRTUAL the wallet is estimated to receive, at the quoted gross. */
  readonly estimatedProceedsRaw: bigint;
  /** `floor(estimatedProceeds * bps / 10000)`. An ESTIMATE, never a charge. */
  readonly estimatedFeeRaw: bigint;
  readonly disclosure: VirtualsCurveFeeDisclosure;
}

/** The agent-facing `vexFee` block, one shape for both sides. */
export type VirtualsCurveFeeDisclosure =
  | {
      readonly charged: true;
      readonly bps: number;
      readonly chargedOn: "currency_in";
      readonly tokenAddress: string;
      readonly tokenSymbol: "VIRTUAL";
      readonly tokenDecimals: number;
      readonly feeAmountRaw: string;
      readonly feeAmountDecimal: string;
      readonly receiver: string;
      /** What the curve is quoted for and actually swaps. */
      readonly netAmountRaw: string;
      readonly totalDebitedRaw: string;
      readonly collectedWhen: "separate_transfer_after_success";
      readonly note: string;
    }
  | {
      readonly charged: false;
      readonly bps: 0;
      readonly reason: string;
      readonly netAmountRaw: string;
      readonly totalDebitedRaw: string;
      readonly collectedWhen: "separate_transfer_after_success";
      readonly note: string;
    }
  | {
      /** The SELL arm: a rate and an estimate, settled from the receipt. */
      readonly charged: "after_settlement";
      readonly bps: number;
      readonly chargedOn: "currency_out";
      readonly tokenAddress: string;
      readonly tokenSymbol: "VIRTUAL";
      readonly tokenDecimals: number;
      readonly estimatedFeeAmountRaw: string;
      readonly estimatedFeeAmountDecimal: string;
      readonly estimatedProceedsRaw: string;
      readonly receiver: string;
      readonly collectedWhen: "separate_transfer_after_success";
      readonly note: string;
    };

/**
 * Split the committed VIRTUAL into the curve amount and Vex's fee.
 *
 * `committedRaw` must be positive; a zero or negative amount is refused by
 * `splitAmountForFeeBps` rather than silently charged nothing.
 */
export function resolveVirtualsCurveBuyFee(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly committedRaw: bigint;
}): VirtualsCurveBuyFee {
  const { deployment } = input;
  const split = splitAmountForFeeBps(input.committedRaw, {
    bps: VIRTUALS_CURVE_FEE_BPS,
    amountLabel: "Curve buy amount",
  });
  if (!split.charged) {
    return {
      side: "buy",
      committedRaw: split.totalRaw,
      curveAmountRaw: split.totalRaw,
      feeRaw: null,
      disclosure: {
        charged: false,
        bps: 0,
        reason: DUST_REASON,
        netAmountRaw: split.totalRaw.toString(),
        totalDebitedRaw: split.totalRaw.toString(),
        collectedWhen: "separate_transfer_after_success",
        note: BUY_NOTE,
      },
    };
  }
  return {
    side: "buy",
    committedRaw: split.totalRaw,
    curveAmountRaw: split.netRaw,
    feeRaw: split.feeRaw,
    disclosure: {
      charged: true,
      bps: VIRTUALS_CURVE_FEE_BPS,
      chargedOn: "currency_in",
      tokenAddress: deployment.virtual,
      tokenSymbol: "VIRTUAL",
      tokenDecimals: deployment.virtualDecimals,
      feeAmountRaw: split.feeRaw.toString(),
      feeAmountDecimal: formatUnits(split.feeRaw, deployment.virtualDecimals),
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      netAmountRaw: split.netRaw.toString(),
      totalDebitedRaw: split.totalRaw.toString(),
      collectedWhen: "separate_transfer_after_success",
      note: BUY_NOTE,
    },
  };
}

/**
 * The sell-side statement at the quoted gross. NOTHING here is charged - the
 * real fee is computed from the receipt by {@link virtualsCurveSellFeeFromProceeds}.
 */
export function resolveVirtualsCurveSellFee(input: {
  readonly deployment: VirtualsCurveDeployment;
  /** The wallet's estimated NET proceeds at the quoted gross, after curve taxes. */
  readonly estimatedProceedsRaw: bigint;
}): VirtualsCurveSellFee {
  const { deployment } = input;
  const estimatedFeeRaw = virtualsCurveSellFeeFromProceeds(input.estimatedProceedsRaw);
  return {
    side: "sell",
    estimatedProceedsRaw: input.estimatedProceedsRaw,
    estimatedFeeRaw,
    disclosure: {
      charged: "after_settlement",
      bps: VIRTUALS_CURVE_FEE_BPS,
      chargedOn: "currency_out",
      tokenAddress: deployment.virtual,
      tokenSymbol: "VIRTUAL",
      tokenDecimals: deployment.virtualDecimals,
      estimatedFeeAmountRaw: estimatedFeeRaw.toString(),
      estimatedFeeAmountDecimal: formatUnits(estimatedFeeRaw, deployment.virtualDecimals),
      estimatedProceedsRaw: input.estimatedProceedsRaw.toString(),
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      collectedWhen: "separate_transfer_after_success",
      note: SELL_NOTE,
    },
  };
}

/**
 * `floor(proceeds * 25 / 10000)` on a PROVEN VIRTUAL amount.
 *
 * Returns `0n` for a non-positive or dust amount rather than throwing: on the
 * sell path this is called after a confirmed trade, and a throw there would turn
 * "no fee to take" into a failure report about a trade that succeeded.
 */
export function virtualsCurveSellFeeFromProceeds(proceedsRaw: bigint): bigint {
  if (proceedsRaw <= 0n) return 0n;
  return (proceedsRaw * BigInt(VIRTUALS_CURVE_FEE_BPS)) / 10_000n;
}
