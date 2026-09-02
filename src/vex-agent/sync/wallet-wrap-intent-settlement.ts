/**
 * How a `wallet_wrap_intents` row reaches a terminal state after the wrap
 * confirm handler has returned - the wrap lane's half of lifecycle T4a, T4b,
 * T5 and T6.
 *
 * This is the sibling of `./wallet-transaction-intent-settlement.ts` and it is
 * deliberately a near-mirror of it: the wrap table is a THIRD state machine
 * with the same status vocabulary and the same evidence rule, so the recovery
 * it needs is the same recovery, driven off its own stranded scan. Before this
 * module the wrap repo shipped `listStrandedConsuming` and the
 * `broadcast_unconfirmed` settlement CASes with NO production consumer: a crash
 * after the claim left a row `consuming` forever, and nothing in production
 * ever moved a `broadcast_unconfirmed` wrap intent at all.
 *
 * ## No second observer, no chain access, no rebroadcast
 *
 * Exactly as in the transaction sibling. This module asks the chain nothing.
 * The split between "nothing was broadcast" and "bytes may be on the network"
 * is decided entirely by whether the linked ACTIVITY row carries the hash the
 * handler stages immediately before it broadcasts, and every terminal it writes
 * spends a verdict some lane already established:
 *
 *   T4a  no staged hash -> `failed` / `crashed_before_broadcast`, and the
 *                          activity row is terminalized with it in ONE
 *                          transaction. No hash PROVES no broadcast.
 *   T4b  staged hash    -> `broadcast_unconfirmed`. The activity row is left
 *                          exactly as it is, because staged-with-hash is what
 *                          makes it a candidate of the lane that owns chain
 *                          observation.
 *
 * An UNKNOWN outcome is not a case here. It writes nothing terminal and the row
 * stays pending for the next pass, which is the honest state.
 *
 * The actual row writes belong to the shared coordinator
 * (`db/repos/agent-activity/linked-transaction-settlement.ts`) and its wrap arm,
 * so this module holds no SQL and no second copy of the settlement rules.
 */

import {
  failHashlessActivityEventWith,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  recoverLinkedBroadcastUnconfirmed,
  settleLinkedActivityRows,
  settleFromPersistedTerminalActivity,
} from "@vex-agent/db/repos/agent-activity/linked-transaction-settlement.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import logger from "@utils/logger.js";

import { REPAIR_CANDIDATE_AGE_MS } from "./handler-window.js";

/**
 * The verdict a repair lane wrote onto a wrap activity row, in the vocabulary
 * the wrap intent's own lifecycle understands. Identical to the transaction
 * lane's, and `superseded_unproven` is likewise carried through as itself
 * rather than folded into `failed`.
 */
export type LinkedWrapVerdict = "confirmed" | "reverted" | "superseded_unproven";

/** How many stranded wrap rows one recovery pass may take. Bounded like every sweep here. */
export const STRANDED_WRAP_RECOVERY_LIMIT = 25;

/**
 * Settle the wrap INTENT from a verdict already durable on its activity row.
 *
 * Idempotent by construction: the coordinator re-reads the row and treats a CAS
 * miss whose durable state already states the same outcome as a continue. A
 * failure is logged and swallowed because this runs only AFTER the activity
 * verdict is durable, and throwing here would turn a settled transaction into a
 * lane error.
 */
export async function settleLinkedWrapIntent(
  activityId: number,
  verdict: LinkedWrapVerdict,
): Promise<void> {
  try {
    const intent = await wrapIntentsRepo.getByActivityId(activityId);
    if (intent === null) return;
    const settled = await settleFromPersistedTerminalActivity(
      activityId,
      intent.sessionId,
      verdict,
    );
    logger.info(
      settled ? "wallet.wrap.settled_from_repair" : "wallet.wrap.settle_linked_miss",
      { activityId, intentId: intent.intentId, verdict },
    );
  } catch (error) {
    logger.warn("wallet.wrap.settle_linked_failed", {
      activityId,
      verdict,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

export interface StrandedWrapRecoveryResult {
  readonly examined: number;
  /** T4a - no staged hash, so no broadcast happened. */
  readonly crashedBeforeBroadcast: number;
  /** T4b - a staged hash exists, so the outcome is unknown and stays tracked. */
  readonly recoveredUnconfirmed: number;
  /**
   * The INVERSE ordering: the activity row was already terminal when this scan
   * reached the intent, so the intent was driven straight to the verdict that
   * row already carries instead of parking at `broadcast_unconfirmed` under a
   * row no lane will select again.
   */
  readonly convergedFromTerminalActivity: number;
}

const EMPTY_RESULT: StrandedWrapRecoveryResult = {
  examined: 0,
  crashedBeforeBroadcast: 0,
  recoveredUnconfirmed: 0,
  convergedFromTerminalActivity: 0,
};

/**
 * The CHAIN verdict an already-terminal wrap activity row carries, or `null`
 * when it carries none this module may act on. No chain access and no guessing:
 * this reads a verdict a lane already established. An unrecognized terminal is
 * NOT evidence and returns `null`, which leaves the row for the T4b branch.
 */
function verdictOfTerminalActivity(
  status: string,
  failureCode: string | null,
): LinkedWrapVerdict | null {
  if (status === "confirmed") return "confirmed";
  if (status === "superseded_unproven") return "superseded_unproven";
  if (status !== "definitively_failed") return null;
  if (failureCode === "mined_revert") return "reverted";
  return null;
}

/**
 * T4a / T4b for the wrap lane. Recover linked `consuming` wrap intents whose
 * confirm handler is gone.
 *
 * Called from `syncTick` (`sync/index.ts`) beside its transaction sibling, for
 * the same reason: it is family- and lane-independent, so hanging it off a lane
 * would make wrap recovery depend on that lane being enabled.
 *
 * The `consumed_at` age gate inside the repo scan is what makes this recovery
 * and not interference - a live confirm handler's row is legitimately
 * `consuming`, and terminalizing it would race a signing path.
 */
export async function recoverStrandedWrapIntents(
  limit: number = STRANDED_WRAP_RECOVERY_LIMIT,
): Promise<StrandedWrapRecoveryResult> {
  let crashedBeforeBroadcast = 0;
  let recoveredUnconfirmed = 0;
  let convergedFromTerminalActivity = 0;

  let stranded: readonly wrapIntentsRepo.StrandedWrapIntent[];
  try {
    stranded = await wrapIntentsRepo.listStrandedConsuming(REPAIR_CANDIDATE_AGE_MS, limit);
  } catch (error) {
    logger.warn("wallet.wrap.stranded_scan_failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return EMPTY_RESULT;
  }

  for (const row of stranded) {
    const { intent } = row;
    try {
      if (row.stagedTxHash === null) {
        // T4a. Staging strictly precedes broadcast, so the absence of a hash is
        // POSITIVE evidence that nothing was sent. Intent and activity row are
        // terminalized together; no lane will ever look at a hashless row.
        const terminalized = await settleLinkedActivityRows({
          activityId: row.activityId,
          sessionId: intent.sessionId,
          intentOutcome: "crashed_before_broadcast",
          activityTarget: {
            status: "definitively_failed",
            failureCode: "broadcast_error",
          },
          activityWrite: (client) => failHashlessActivityEventWith(client, row.activityId, {
            failureCode: "broadcast_error",
            failureReason:
              "the wrap confirm handler stopped before the transaction was broadcast; no signed "
              + "hash was ever staged, so nothing reached the network",
          }),
        });
        // Count convergence from the DURABLE intent rather than from whether
        // this invocation won the activity CAS: a prior terminal writer may
        // already have recorded another hashless failure code, which the
        // coordinator adopts as crash-before-broadcast evidence.
        if (
          terminalized.row.status === "definitively_failed"
          && terminalized.row.txHash === null
        ) {
          const after = await wrapIntentsRepo.getById(intent.intentId, intent.sessionId);
          if (after?.status === "failed" && after.failureStage === "crashed_before_broadcast") {
            crashedBeforeBroadcast++;
          }
        }
        continue;
      }

      // THE INVERSE ORDERING. The lane terminalized the activity row while this
      // intent was still `consuming`, so it will never be selected again and
      // nothing would move the intent off `broadcast_unconfirmed`. The verdict
      // it needs is already on the row in front of us.
      const terminalVerdict = verdictOfTerminalActivity(
        row.activityStatus,
        row.activityFailureCode,
      );
      if (terminalVerdict !== null) {
        await settleLinkedWrapIntent(row.activityId, terminalVerdict);
        const after = await wrapIntentsRepo.getById(intent.intentId, intent.sessionId);
        if (after !== null && after.status !== "consuming") convergedFromTerminalActivity++;
        continue;
      }

      // T4b. A hash exists, so bytes may be on the network. This is never
      // `failed`-with-a-hash: that shape cannot be told apart from a revert,
      // and a caller who reads "failed" retries. The ACTIVITY row is left
      // alone, because that is what keeps it a candidate of the lane that owns
      // chain observation.
      const recovered = await recoverLinkedBroadcastUnconfirmed(
        row.activityId,
        intent.sessionId,
      );
      if (recovered) recoveredUnconfirmed++;
    } catch (error) {
      logger.warn("wallet.wrap.stranded_recovery_failed", {
        intentId: intent.intentId,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  if (stranded.length > 0) {
    logger.info("wallet.wrap.stranded_recovery", {
      examined: stranded.length,
      crashedBeforeBroadcast,
      recoveredUnconfirmed,
      convergedFromTerminalActivity,
    });
  }

  return {
    examined: stranded.length,
    crashedBeforeBroadcast,
    recoveredUnconfirmed,
    convergedFromTerminalActivity,
  };
}
