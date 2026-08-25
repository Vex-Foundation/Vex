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
 * ## OUTCOME HONESTY: the broadcast decides, bookkeeping never re-decides
 *
 * The attempt is split into TWO phases, and the split is the safety property.
 *
 *   PHASE 1, everything up to and including `signStageBroadcast`. A throw here
 *   is genuinely pre-broadcast - a native-value refusal, a gas-estimate refusal,
 *   a staging CAS miss, a pre-sign or pre-submit fence refusal - so
 *   `not_attempted` is the truth.
 *
 *   PHASE 2, classifying the outcome the chain produced. The durable writes here
 *   (`failActivityEvent` on a revert, the pending-reason note on an ambiguity,
 *   `confirmActivityEvent` on a confirm) are BOOKKEEPING ABOUT A TRANSACTION
 *   THAT ALREADY EXISTS. A failure of one of them is logged and nothing more:
 *   it can never rewrite a `reverted` or an `unconfirmed` into `not_attempted`,
 *   which would drop the hash a sweep needs and invite a second transfer for a
 *   fee that may already have been paid.
 *
 * Before the split, one `try` wrapped both phases, so a database hiccup during
 * phase 2 reported a broadcast fee as never attempted. That is the defect the
 * red-without-fix tests beside this file pin.
 *
 * The native-value gate runs here rather than at plan time: the fingerprint
 * binds the exact (chain, to, calldata, value) that reaches the signer, so it is
 * only meaningful immediately before signing.
 */

import { formatUnits } from "viem";

import {
  signStageBroadcast,
  type StagedBroadcastOutcome,
  type StagedFeeBounds,
  type StagedSigner,
} from "@tools/evm-chains/staged-broadcast.js";
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

/**
 * The caller's POST-STAGE, PRE-SUBMIT gate. `"refuse"` means the signed bytes
 * are never handed to `sendRawTransaction`.
 *
 * ITS POSITION IS THE SECURITY CONTRACT. It runs inside this module's own
 * `onHashStaged`, AFTER the staging write has recorded the locally derived hash
 * and BEFORE the submit - the one instant at which a fee leg is signed but not
 * yet sent. A caller uses it to re-ask an authority that the user can revoke
 * mid-flight. It exists here, and not as a second hook the caller passes to the
 * staged primitive, so no call site can move it earlier or later.
 */
export type NativeFeeLegPreSubmitDecision = "proceed" | "refuse";

export interface RunNativeFeeLegInput {
  readonly plan: NativeFeeLegPlan<string>;
  /** The pre-created `agent_activity` row for the fee leg. */
  readonly feeRowId: number;
  readonly chainId: number;
  readonly publicClient: Parameters<typeof signStageBroadcast>[0];
  /**
   * Who signs. The EAGER account-bound wallet client every venue passes, or the
   * DEFERRED arm the generic signing lane needs so no key exists until its own
   * pre-sign fence has passed.
   */
  readonly signer: StagedSigner;
  /** Anchor on the block the action confirmed in. */
  readonly priorLeg?: ConfirmedPriorLeg | undefined;
  /**
   * The APPROVED ceiling for THIS fee transfer, enforced by the staged
   * primitive on the request that is actually serialized. Omitted, the primitive
   * keeps every existing venue's prior behaviour byte for byte.
   */
  readonly bounds?: StagedFeeBounds | undefined;
  /** See `NativeFeeLegPreSubmitDecision`. Omitted, nothing runs between staging and submit. */
  readonly afterStageBeforeSubmit?: (() => Promise<NativeFeeLegPreSubmitDecision>) | undefined;
}

/**
 * The EXACT durable sentence a signed-but-never-submitted fee row carries.
 *
 * Written in the EXISTING closed failure vocabulary - `definitively_failed`
 * with `failure_code = 'unknown'` - because there is no honest new enum member
 * here and `status-and-failure.ts` records why codes are not invented per
 * situation. The row keeps the locally derived `tx_hash` it staged and never
 * gains a `broadcast_at`, so the pair says exactly what happened: bytes were
 * signed, nothing was sent.
 */
const NOT_SUBMITTED_FAILURE_REASON =
  "not submitted: authority changed after signing and staging; sendRawTransaction was never invoked";

/**
 * How many times the not-submitted terminalization is attempted.
 *
 * The write is an idempotent CAS on `status = 'pending'`, so a repeat is free
 * and a miss is conclusive. A signed-but-unsent row left `pending` would carry a
 * hash the receipt sweep then chases forever, which is worth two more attempts
 * before giving up and asking for reconciliation by name.
 */
const NOT_SUBMITTED_TERMINALIZE_ATTEMPTS = 3;

/** Thrown out of the staging hook so the primitive aborts before it submits. */
class FeeLegPreSubmitRefused extends Error {
  constructor() {
    super("native fee leg: refused after staging and before submission");
    this.name = "FeeLegPreSubmitRefused";
  }
}

/** Never throws. Every path returns a report. */
export async function runNativeFeeLeg(
  venue: Pick<NativeFeeVenue, "logPrefix" | "displayName" | "nativeDecimals">,
  input: RunNativeFeeLegInput,
): Promise<NativeFeeCollection> {
  const { plan, feeRowId } = input;

  // ── PHASE 1: everything that can still mean "nothing was broadcast" ──
  let outcome: StagedBroadcastOutcome;
  try {
    assertFeeValueAuthorized(input.chainId, plan);

    outcome = await signStageBroadcast(
      input.publicClient,
      input.signer,
      plan.txParams,
      {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(feeRowId, handles);
          if (!res.applied) {
            throw new Error(
              `agent_activity: markActivityBroadcast CAS miss for fee event ${feeRowId} - refusing to broadcast untracked`,
            );
          }
          // THE POST-STAGE GATE, deliberately AFTER the staging write: the row
          // must already carry the hash of the bytes that exist before anything
          // decides whether they may be sent.
          const gate = input.afterStageBeforeSubmit;
          if (gate === undefined) return;
          if ((await gate()) === "refuse") {
            await terminalizeNotSubmitted(venue, feeRowId);
            throw new FeeLegPreSubmitRefused();
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(feeRowId);
          if (!res.applied) logger.warn(`${venue.logPrefix}.broadcast_accept_miss`, { id: feeRowId });
        },
      },
      input.priorLeg,
      undefined,
      input.bounds,
    );
    // A non-outcome is NOT evidence of a broadcast. Checked INSIDE phase 1, so
    // this function keeps its "never throws" contract without letting phase 2
    // hold an unguarded read that could rewrite a real chain outcome. The real
    // primitive always answers; only a broken stand-in reaches this.
    if (outcome === null || typeof outcome !== "object" || !("kind" in outcome)) {
      throw new Error("signStageBroadcast returned no outcome for the fee leg");
    }
  } catch (err) {
    // Includes a native-value refusal, a gas-estimate refusal, a fee-bound
    // refusal, a staging CAS miss, and the post-stage refusal above. None of
    // them may touch the parent row, and on every one of them nothing was sent.
    if (err instanceof FeeLegPreSubmitRefused) {
      return {
        collection: "not_attempted",
        collectionNote:
          "The Vex fee transfer was signed but never submitted, because the authority it was "
          + "authorized under changed in between, so no fee was collected and nothing reached the "
          + "network. Your transaction is unaffected.",
        txHash: null,
      };
    }
    logger.warn(`${venue.logPrefix}.leg_failed`, { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return {
      collection: "not_attempted",
      collectionNote: "The Vex fee transfer was refused before signing, so no fee was collected - your trade is unaffected.",
      txHash: null,
    };
  }

  // ── PHASE 2: the chain has spoken. Bookkeeping cannot change the answer ──

  if (outcome.kind === "reverted") {
    try {
      await failActivityEvent(feeRowId, {
        failureCode: "mined_revert",
        failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the action itself was unaffected.`,
      });
    } catch (err) {
      // LOGGED, NEVER PROPAGATED. The transfer really did revert; a failed
      // write about it is audit drift, and reporting `not_attempted` here would
      // hide a real on-chain transaction from every surface that reads this.
      logger.warn(`${venue.logPrefix}.revert_record_failed`, {
        id: feeRowId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    return {
      collection: "reverted",
      collectionNote: "The Vex fee transfer reverted, so no fee was collected - your trade is unaffected.",
      txHash: outcome.txHash,
    };
  }

  if (outcome.kind === "ambiguous") {
    // Left PENDING with its staged hash for the receipt sweep. NEVER retried
    // here: a blind retry of an unconfirmed transfer could charge twice.
    logger.info(`${venue.logPrefix}.ambiguous`, { id: feeRowId, stage: outcome.stage });
    try {
      // Migration 067: the fee row's OWN pending reason - a fee that did not
      // confirm says nothing about whether the action did.
      await noteHandlerPendingReason(venue.logPrefix, feeRowId, "fee_broadcast_ambiguous");
    } catch (err) {
      // Same rule as the revert arm. The bytes are in flight either way, and the
      // hash is the one thing the sweep cannot do without.
      logger.warn(`${venue.logPrefix}.pending_note_failed`, {
        id: feeRowId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
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
}

/**
 * Terminalize a fee row whose signed bytes were staged and then refused before
 * submission, with a small bounded idempotent retry.
 *
 * Never throws: the caller is already aborting the broadcast, and a failure to
 * record why must not become a second, different failure. When every attempt
 * misses, the row is named in the log as needing reconciliation - it holds a
 * hash for a transaction that does not exist, which is the one state a receipt
 * sweep cannot resolve on its own.
 */
async function terminalizeNotSubmitted(
  venue: Pick<NativeFeeVenue, "logPrefix">,
  feeRowId: number,
): Promise<void> {
  for (let attempt = 1; attempt <= NOT_SUBMITTED_TERMINALIZE_ATTEMPTS; attempt += 1) {
    try {
      const res = await failActivityEvent(feeRowId, {
        failureCode: "unknown",
        failureReason: NOT_SUBMITTED_FAILURE_REASON,
      });
      // A MISS IS CONCLUSIVE, not a reason to retry: the CAS requires
      // `status = 'pending'`, so a miss means somebody already terminalized
      // this row and repeating the write would only overwrite their account.
      if (!res.applied) {
        logger.warn(`${venue.logPrefix}.not_submitted_terminalize_miss`, {
          id: feeRowId,
          rowStatus: res.row.status,
        });
      }
      return;
    } catch (err) {
      if (attempt === NOT_SUBMITTED_TERMINALIZE_ATTEMPTS) {
        logger.warn(`${venue.logPrefix}.not_submitted_terminalize_failed`, {
          id: feeRowId,
          attempts: attempt,
          error: err instanceof Error ? err.name : "unknown",
          needsReconciliation: true,
        });
        return;
      }
    }
  }
}

/**
 * The fee transaction's ENTIRE value is the Vex platform fee - Vex built it from
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
 * read as a clean confirm - mirrors `confirmSwapRow` on the trade path.
 *
 * The EXECUTED fee amount is written here rather than left at the planned value.
 * On a SELL the planned amount came from the quote and the signed one is the
 * rate applied to the native amount that actually arrived; recording the planned
 * figure as settled would be recording a quote as a settlement.
 */
async function confirmFeeRow(
  venue: Pick<NativeFeeVenue, "logPrefix" | "nativeDecimals">,
  feeRowId: number,
  txHash: string,
  feeWei: bigint,
): Promise<"confirmed" | "confirmed_unrecorded"> {
  try {
    const result = await confirmActivityEvent(feeRowId, {
      executedAmountInRaw: feeWei.toString(),
      // The VENUE's own decimals. See `plan.ts`: this lane is no longer
      // 18-decimal-ETH-only, and a human amount rendered at the wrong scale is
      // a money figure that is simply wrong.
      executedAmountInHuman: formatUnits(feeWei, venue.nativeDecimals),
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

/** There was no fee to take at all - the rate floored to zero at this size. */
export function nativeFeeNotCharged(): NativeFeeCollection {
  return {
    collection: "not_charged",
    collectionNote: "No Vex fee applies to this action at this size.",
    txHash: null,
  };
}
