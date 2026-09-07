/**
 * Vex's 25 bps fee on a Virtuals agent LAUNCH (owner F3).
 *
 * ## The policy, and the one thing that makes it different from every other fee
 *
 * The SPLIT is the ordinary `currency_in` model the buy side of the curve, the
 * swaps and the bridges all use: the caller names the VIRTUAL they are willing
 * to commit, `committed = launchAmount + vexFee` with integer-floor arithmetic,
 * the venue is given the remainder and Vex's share is a separate ERC-20
 * transfer.
 *
 * The COLLECTION is not ordinary, and this is the whole of F3. Vex does not
 * launch an agent - `preLaunch` only reserves one. What makes the agent real is
 * `launch(token)`, which the VIRTUALS KEEPER executes about a minute later
 * (measured on Base 2026-09-04: `preLaunch` `0xd0fbcca8`, keeper `launch()`
 * `0x9eca4cb5`, indexed as id 139289). Until the keeper acts, the creator's
 * VIRTUAL sits inside BondingV5 and the whole thing is still cancellable.
 *
 * So the fee is collectible in exactly one situation: `Launched` was OBSERVED
 * while this handler still owned the approved signer. If the bounded wait
 * elapses first, the launch is recorded `awaiting_keeper` and THE FEE IS WAIVED
 * PERMANENTLY - not deferred, not owed, not retried later. A reconciliation
 * sweep holds no signer and no approval, so a fee it collected would be a
 * transfer nobody authorized; and a "we will charge you when it lands" that
 * survives a restart is a standing claim on a user's wallet. Neither exists
 * here. The worst case is that Vex misses revenue on a slow keeper.
 *
 * ## Why the fee rides on the initial purchase and not on the protocol fee
 *
 * `calculateLaunchFee(false, false)` is 0 for a normal immediate launch on both
 * chains (read live, not assumed), so today `launchAmount` IS the initial
 * purchase. The split is written against the committed total anyway, because
 * the contract will happily charge a protocol fee on other launch shapes and a
 * fee computed on "the initial purchase" would silently change meaning if this
 * lane ever admitted one.
 */

import { formatUnits, type Address } from "viem";

import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";
import { splitAmountForFeeBps } from "../../vex-fee/bps-split.js";

import type { VirtualsCurveDeployment } from "../curve/deployments.js";

/** Base is 10000, so 25 = 0.25 percent - the rate every Vex venue charges. */
export const VIRTUALS_LAUNCH_FEE_BPS = 25;

/** Fee destination - Vex treasury. NEVER from params. */
export const VIRTUALS_LAUNCH_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * The `agent_activity` `event_role` the fee leg is recorded under.
 *
 * `vex_fee` (migration 107) on the LAUNCH arm, so the feed shows one entry for
 * the launch with the fee folded under it.
 */
export const VIRTUALS_LAUNCH_FEE_ACTIVITY_EVENT_ROLE = "vex_fee" as const;

const NOTE =
  `Vex charges ${VIRTUALS_LAUNCH_FEE_BPS} bps (0.25%) of the VIRTUAL you commit to the launch, deducted from your `
  + "input so the venue receives the remainder. It is a separate transfer that runs ONLY after the Virtuals keeper "
  + "has executed launch() and Vex has seen the Launched event while it still holds this approval. If the keeper "
  + "has not launched the agent by then, the launch is recorded as awaiting_keeper and THE FEE IS WAIVED "
  + "PERMANENTLY - it is never collected later, and no background job will charge you.";

const DUST_REASON = "the fee rounds to zero at this size, so no transfer is made";

/** The launch-side split: what the venue gets, what Vex takes, what the wallet pays. */
export interface VirtualsLaunchFee {
  /** What leaves the wallet in total - the `amountIn` the caller named. */
  readonly committedRaw: bigint;
  /** `committed - fee`; the `purchaseAmount_` argument of `preLaunch`. */
  readonly launchAmountRaw: bigint;
  /** `null` when the fee floors to zero: no leg, no row, no index. */
  readonly feeRaw: bigint | null;
  readonly disclosure: VirtualsLaunchFeeDisclosure;
}

export type VirtualsLaunchFeeDisclosure =
  | {
      readonly charged: "after_keeper_launch";
      readonly bps: number;
      readonly chargedOn: "currency_in";
      readonly tokenAddress: string;
      readonly tokenSymbol: "VIRTUAL";
      readonly tokenDecimals: number;
      readonly feeAmountRaw: string;
      readonly feeAmountDecimal: string;
      readonly receiver: string;
      /** What the venue is given and what `preLaunch` is called with. */
      readonly netAmountRaw: string;
      readonly totalDebitedRaw: string;
      readonly collectedWhen: "separate_transfer_after_observed_launch";
      readonly waivedWhen: "awaiting_keeper";
      readonly note: string;
    }
  | {
      readonly charged: false;
      readonly bps: 0;
      readonly reason: string;
      readonly netAmountRaw: string;
      readonly totalDebitedRaw: string;
      readonly collectedWhen: "separate_transfer_after_observed_launch";
      readonly waivedWhen: "awaiting_keeper";
      readonly note: string;
    };

/**
 * Split the committed VIRTUAL into the venue's amount and Vex's fee.
 *
 * `committedRaw` must be positive; a zero or negative amount is refused by
 * `splitAmountForFeeBps` rather than silently charged nothing.
 */
export function resolveVirtualsLaunchFee(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly committedRaw: bigint;
}): VirtualsLaunchFee {
  const { deployment } = input;
  const split = splitAmountForFeeBps(input.committedRaw, {
    bps: VIRTUALS_LAUNCH_FEE_BPS,
    amountLabel: "Launch amount",
  });
  if (!split.charged) {
    return {
      committedRaw: split.totalRaw,
      launchAmountRaw: split.totalRaw,
      feeRaw: null,
      disclosure: {
        charged: false,
        bps: 0,
        reason: DUST_REASON,
        netAmountRaw: split.totalRaw.toString(),
        totalDebitedRaw: split.totalRaw.toString(),
        collectedWhen: "separate_transfer_after_observed_launch",
        waivedWhen: "awaiting_keeper",
        note: NOTE,
      },
    };
  }
  return {
    committedRaw: split.totalRaw,
    launchAmountRaw: split.netRaw,
    feeRaw: split.feeRaw,
    disclosure: {
      charged: "after_keeper_launch",
      bps: VIRTUALS_LAUNCH_FEE_BPS,
      chargedOn: "currency_in",
      tokenAddress: deployment.virtual,
      tokenSymbol: "VIRTUAL",
      tokenDecimals: deployment.virtualDecimals,
      feeAmountRaw: split.feeRaw.toString(),
      feeAmountDecimal: formatUnits(split.feeRaw, deployment.virtualDecimals),
      receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
      netAmountRaw: split.netRaw.toString(),
      totalDebitedRaw: split.totalRaw.toString(),
      collectedWhen: "separate_transfer_after_observed_launch",
      waivedWhen: "awaiting_keeper",
      note: NOTE,
    },
  };
}
