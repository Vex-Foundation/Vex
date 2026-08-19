/**
 * Running a native Vex fee leg - AFTER the action confirmed, and never before.
 *
 * THE INVARIANT (copied from `src/tools/bridge-fee/index.ts:16-18`, which says
 * it about bridges and means it identically at every venue on this lane):
 *
 *   "a bridge that fails at any point NEVER charges a fee for a bridge that did
 *    not happen. The worst case is that Vex misses revenue - never that the user
 *    pays for nothing. Do not reorder to fee-first."
 *
 * Concretely, and every one of these is pinned by a test:
 *
 *   - A REVERTED or AMBIGUOUS action means this function is never called at all:
 *     the fee is not signed, and the caller finalizes the fee row as
 *     never-attempted.
 *   - A FAILED fee leaves the action UNAFFECTED. Nothing here throws, nothing
 *     here aborts or fails the parent row, and no caller may mark a confirmed
 *     action failed because its fee did not land. That is missed Vex revenue and
 *     nothing more.
 *   - An AMBIGUOUS fee is NEVER retried. It is left pending with its staged hash
 *     for the receipt sweep, because a blind retry of an unconfirmed transfer
 *     could charge the user TWICE.
 *
 * The native-value gate runs here rather than at plan time: the fingerprint
 * binds the exact (chain, to, calldata, value) that reaches the signer, so it is
 * only meaningful immediately before signing.
 */

import { formatEther } from "viem";

import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  classifyNativeValue,
  checkNativeValueAuthorizedForCall,
} from "@tools/evm-chains/native-value-authorization/index.js";
import {
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import type { NativeFeeVenue } from "@tools/vex-fee/native-leg/index.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { noteHandlerPendingReason } from "../../runtime/pending-provenance.js";
import type { NativeFeeLegPlan } from "./plan.js";

/**
 * How the fee attempt ended. Richer than a boolean deliberately: `not_charged`
 * (there was no fee to take) and `not_attempted` (there was, and it never
 * reached the network) are different truths, and the audit surface must be able
 * to tell them apart.
 */
export interface NativeFeeCollection {
  readonly collection:
    | "confirmed"
    | "confirmed_unrecorded"
    | "reverted"
    | "unconfirmed"
    | "not_attempted"
    | "not_charged";
  /** Plain-language, agent-facing. Always states that the action itself is unaffected. */
  readonly collectionNote: string;
  readonly txHash: string | null;
}

export interface RunNativeFeeLegInput {
  readonly plan: NativeFeeLegPlan<string>;
  /** The pre-created `agent_activity` row for the fee leg. */
  readonly feeRowId: number;
  readonly chainId: number;
  readonly publicClient: Parameters<typeof signStageBroadcast>[0];
  readonly walletClient: Parameters<typeof signStageBroadcast>[1];
  /** Anchor on the block the action confirmed in. */
  readonly priorLeg?: ConfirmedPriorLeg | undefined;
}

/** Never throws. Every path returns a report. */
export async function runNativeFeeLeg(
  venue: Pick<NativeFeeVenue, "logPrefix" | "displayName">,
  input: RunNativeFeeLegInput,
): Promise<NativeFeeCollection> {
  const { plan, feeRowId } = input;
  try {
    assertFeeValueAuthorized(input.chainId, plan);

    const outcome: StagedBroadcastOutcome = await signStageBroadcast(
      input.publicClient,
      input.walletClient,
      plan.txParams,
      {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(feeRowId, handles);
          if (!res.applied) {
            throw new Error(`agent_activity: markActivityBroadcast CAS miss for fee event ${feeRowId} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(feeRowId);
          if (!res.applied) logger.warn(`${venue.logPrefix}.broadcast_accept_miss`, { id: feeRowId });
        },
      },
      input.priorLeg,
    );

    if (outcome.kind === "reverted") {
      await failActivityEvent(feeRowId, {
        failureCode: "mined_revert",
        failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the trade itself was unaffected.`,
      });
      return {
        collection: "reverted",
        collectionNote: "The Vex fee transfer reverted, so no fee was collected — your trade is unaffected.",
        txHash: outcome.txHash,
      };
    }

    if (outcome.kind === "ambiguous") {
      // Left PENDING with its staged hash for the receipt sweep. NEVER retried
      // here: a blind retry of an unconfirmed transfer could charge twice.
      logger.info(`${venue.logPrefix}.ambiguous`, { id: feeRowId, stage: outcome.stage });
      // Migration 067: the fee row's OWN pending reason — a fee that did not
      // confirm says nothing about whether the trade did.
      await noteHandlerPendingReason(venue.logPrefix, feeRowId, "fee_broadcast_ambiguous");
      return {
        collection: "unconfirmed",
        collectionNote: "The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent. Your trade is unaffected.",
        txHash: outcome.txHash,
      };
    }

    return {
      collection: await confirmFeeRow(venue, feeRowId, outcome.txHash, plan.feeWei),
      collectionNote: "The Vex fee was transferred to the treasury.",
      txHash: outcome.txHash,
    };
  } catch (err) {
    // Includes a native-value refusal, a gas-estimate refusal, and a staging CAS
    // miss. None of them may touch the parent row.
    logger.warn(`${venue.logPrefix}.leg_failed`, { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return {
      collection: "not_attempted",
      collectionNote: "The Vex fee transfer was refused before signing, so no fee was collected — your trade is unaffected.",
      txHash: null,
    };
  }
}

/**
 * The fee transaction's ENTIRE value is the Vex platform fee — Vex built it from
 * its own arithmetic on the user's own native leg, and there is no other party's
 * number in it. Without this classification `checkNativeValueAuthorizedForCall`
 * refuses the transfer as unattributed native value.
 */
function assertFeeValueAuthorized(chainId: number, plan: NativeFeeLegPlan<string>): void {
  const call = { chainId, to: plan.txParams.to, data: plan.txParams.data, valueWei: plan.txParams.value };
  const authorization = classifyNativeValue({
    call,
    vexPlatformFee: {
      amountWei: plan.txParams.value,
      recipient: plan.txParams.to,
      refund: "spent_not_recoverable",
      evidence: {
        source: "vex_constructed",
        detail: "the whole value is the Vex integrator fee of a Vex-built native transfer leg",
      },
    },
  });
  const verdict = checkNativeValueAuthorizedForCall(authorization, call);
  if (!verdict.ok) {
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      "Refused before signing: the Vex fee transfer's value could not be fully attributed to the fee.",
    );
  }
}

/**
 * A non-applied CAS confirm (the reconciler already finalized this row) must not
 * read as a clean confirm — mirrors `confirmSwapRow` on the trade path.
 *
 * The EXECUTED fee amount is written here rather than left at the planned value.
 * On a SELL the planned amount came from the quote and the signed one is the
 * rate applied to the native amount that actually arrived; recording the planned
 * figure as settled would be recording a quote as a settlement.
 */
async function confirmFeeRow(
  venue: Pick<NativeFeeVenue, "logPrefix">,
  feeRowId: number,
  txHash: string,
  feeWei: bigint,
): Promise<"confirmed" | "confirmed_unrecorded"> {
  try {
    const result = await confirmActivityEvent(feeRowId, {
      executedAmountInRaw: feeWei.toString(),
      executedAmountInHuman: formatEther(feeWei),
    });
    if (result.applied) return "confirmed";
    if (result.row.status === "confirmed" && result.row.txHash === txHash) return "confirmed";
    logger.warn(`${venue.logPrefix}.confirm_cas_miss`, { id: feeRowId, rowStatus: result.row.status });
    return "confirmed_unrecorded";
  } catch (err) {
    logger.warn(`${venue.logPrefix}.confirm_failed`, { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return "confirmed_unrecorded";
  }
}

/** The fee row exists but the action never reached the point where it is taken. */
export function nativeFeeNotAttempted(reason: string): NativeFeeCollection {
  return {
    collection: "not_attempted",
    collectionNote: `No Vex fee was taken: ${reason}.`,
    txHash: null,
  };
}

/** There was no fee to take at all — the rate floored to zero at this size. */
export function nativeFeeNotCharged(): NativeFeeCollection {
  return {
    collection: "not_charged",
    collectionNote: "No Vex fee applies to this action at this size.",
    txHash: null,
  };
}
