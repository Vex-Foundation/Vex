/**
 * The Vex fee on a Trench curve TRADE — which base each side uses, and when the
 * leg may run.
 *
 * The two sides are asymmetric, and the asymmetry is the point:
 *
 *   BUY  — the base is the ETH the user SPENDS, which Vex knows exactly before
 *          anything is signed. The curve is therefore quoted for `amount − fee`,
 *          so the disclosed `expectedOut`/`minOut` are POST-fee and are what
 *          actually arrives.
 *   SELL — the base is the ETH the user RECEIVES, which does not exist until the
 *          transaction settles. The row is planned from the QUOTE so it exists
 *          before broadcast, and the leg that is actually signed is RE-PLANNED
 *          from the decoded proceeds. If the decode declines, Vex cannot prove
 *          what arrived and takes NO fee at all — 25 bps of a quote is 25 bps of
 *          a number that did not happen.
 *
 * In both cases the leg runs LAST, after the trade confirms. See
 * `../../fee/index.ts` for the ordering contract every caller honours.
 */

import type { Address } from "viem";

import { buildTrenchFeeSkippedDisclosure, type TrenchFeeDisclosure } from "@tools/trench-express/fee/index.js";
import { planTrenchFeeLeg, type TrenchFeeLegPlan } from "../../fee/index.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";

export interface TradeFeeIdentity {
  readonly chainId: number;
  readonly nativeAddress: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
}

/** No fee applies at this size — used for both the buy and the sell disclosure. */
export function tradeFeeSkipped(side: TrenchTradeSide, baseWei: bigint): TrenchFeeDisclosure {
  return buildTrenchFeeSkippedDisclosure({
    basis: side === "buy" ? "buy_eth_in" : "sell_eth_out",
    baseWei,
    reason: "25 bps of the ETH leg floors to zero at this size, so no fee transfer is made.",
  });
}

/**
 * A confirmed SELL whose ETH proceeds could not be decoded. No fee is taken, and
 * the disclosure carries NO base: the only ETH figure Vex has is the quote, and
 * publishing it as the fee's base would put an estimate into the record of a
 * settled trade.
 */
export function tradeFeeUnprovenBase(): TrenchFeeDisclosure {
  return buildTrenchFeeSkippedDisclosure({
    basis: "sell_eth_out",
    reason: "the ETH proceeds could not be decoded, so there is no proven amount to charge 25 bps of.",
  });
}

/** Plan the BUY fee from the ETH the user spends — known exactly, pre-intent. */
export function planBuyFeeLeg(identity: TradeFeeIdentity, ethInWei: bigint): TrenchFeeLegPlan | null {
  return planTrenchFeeLeg({
    base: { basis: "buy_eth_in", ethInWei },
    parentKind: "swap",
    ...identity,
  });
}

/**
 * Plan the SELL fee from an ETH-proceeds figure. Called TWICE with different
 * numbers, deliberately: once pre-intent with the QUOTE so the row exists, and
 * once post-confirm with the DECODED proceeds to produce the leg that is signed.
 */
export function planSellFeeLeg(identity: TradeFeeIdentity, ethOutWei: bigint): TrenchFeeLegPlan | null {
  return planTrenchFeeLeg({
    base: { basis: "sell_eth_out", ethOutWei },
    parentKind: "swap",
    ...identity,
  });
}
