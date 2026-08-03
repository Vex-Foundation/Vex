/**
 * `khalani.bridge` Vex fee leg (step 13b of the staged-execute contract,
 * split out in 0R.4, refactor-only). The fee leg is planned LAST and driven
 * OUTSIDE the bridge loop: its outcome must never fail, abort, or delay the
 * bridge. Every path returns a report — none throws, none aborts the logical
 * row, none marks the bridge failed.
 */

import { signStageKhalaniLeg, type KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  confirmActivityEvent,
  failActivityEvent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import {
  abortRemaining,
  khalaniFailureMessage,
  type RecordedLeg,
  txExplorerUrl,
  type VexFeeCollection,
} from "../bridge-support.js";
import { khalaniStageHooksFor } from "./staging.js";

export interface KhalaniFeeLegInput {
  readonly executionId: number;
  /** `-1` when no fee applies to this bridge. */
  readonly feeLegIndex: number;
  readonly stagedLegs: readonly KhalaniStagedLeg[];
  readonly intentLegs: readonly AgentActivityEvent[];
  readonly sourceChain: KhalaniChain;
  readonly chains: KhalaniChain[];
  readonly signer: ChainWallet;
  readonly fromChainId: number;
  readonly fromChainName: string;
  /** Appended in place — the handler renders the same array in its result. */
  readonly recordedLegs: RecordedLeg[];
}

/**
 * Finalize a never-attempted fee row without touching the logical fill row.
 * Used by every exit that returns BEFORE the fee leg would run.
 */
export async function skipKhalaniFeeLeg(
  input: Pick<KhalaniFeeLegInput, "executionId" | "feeLegIndex">,
  reason: string,
): Promise<void> {
  if (input.feeLegIndex === -1) return;
  await abortRemaining(input.executionId, input.feeLegIndex, reason, input.feeLegIndex + 1);
}

/**
 * Sign, stage, broadcast and record the Vex fee transfer. Called ONLY after
 * the deposit is confirmed AND registered with the provider: the bridge
 * already happened, so a fee that does not land is missed Vex revenue and
 * nothing more.
 */
export async function runKhalaniVexFeeLeg(input: KhalaniFeeLegInput): Promise<VexFeeCollection> {
  const { executionId, feeLegIndex, stagedLegs, intentLegs, fromChainId, fromChainName, chains, recordedLegs } = input;
  if (feeLegIndex === -1) {
    return { collection: "not_charged", collectionNote: "No Vex fee applies to this bridge." };
  }
  const feeLeg = stagedLegs[feeLegIndex]!;
  const feeRow = intentLegs[feeLegIndex];
  if (!feeRow) {
    logger.warn("khalani.bridge.fee_leg_row_missing", { executionId, index: feeLegIndex });
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee had no recorded row, so no fee was taken.",
    };
  }
  try {
    const outcome = await signStageKhalaniLeg(
      feeLeg, input.sourceChain, chains, input.signer, khalaniStageHooksFor(feeRow.id),
    );
    const explorerUrl = txExplorerUrl(fromChainId, chains, outcome.txHash);
    if (outcome.kind === "reverted") {
      await failActivityEvent(feeRow.id, {
        failureCode: "mined_revert",
        failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the bridge itself was unaffected.`,
      });
      recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: "reverted" });
      return {
        collection: "reverted",
        collectionNote: "The bridge went through. The Vex fee transfer reverted, so no fee was collected — your bridge is unaffected.",
      };
    }
    if (outcome.kind === "ambiguous") {
      // Left PENDING with its staged hash for the receipt sweep. NEVER
      // retried here: a blind retry of an unconfirmed transfer could charge
      // the user twice.
      logger.info("khalani.bridge.fee_leg_ambiguous", { id: feeRow.id, stage: outcome.stage });
      recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: "broadcast_unconfirmed" });
      return {
        collection: "unconfirmed",
        collectionNote: "The bridge went through. The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent.",
      };
    }
    let legStatus = "confirmed";
    try {
      const confirmResult = await confirmActivityEvent(feeRow.id, {});
      if (!confirmResult.applied) {
        const alreadyMatches =
          confirmResult.row.status === "confirmed" && confirmResult.row.txHash === outcome.txHash;
        if (!alreadyMatches) {
          legStatus = "confirmed_unrecorded";
          logger.warn("khalani.bridge.fee_leg_confirm_cas_miss", { id: feeRow.id, rowStatus: confirmResult.row.status });
        }
      }
    } catch (err) {
      legStatus = "confirmed_unrecorded";
      logger.warn("khalani.bridge.fee_leg_confirm_failed", { id: feeRow.id, error: khalaniFailureMessage(err) });
    }
    recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: legStatus });
    return {
      collection: legStatus,
      collectionNote: "The bridge went through and the Vex fee was transferred to the treasury.",
    };
  } catch (err) {
    const safe = khalaniFailureMessage(err);
    logger.warn("khalani.bridge.fee_leg_failed", { executionId, error: safe });
    await skipKhalaniFeeLeg(input, "vex fee leg refused before signing");
    recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: null, status: "not_attempted" });
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee transfer was refused before signing, so no fee was collected — your bridge is unaffected.",
    };
  }
}
