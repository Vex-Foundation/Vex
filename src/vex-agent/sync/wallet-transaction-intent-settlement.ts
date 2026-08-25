/**
 * How a `wallet_transaction_intents` row reaches a terminal state after the
 * confirm handler has returned - lifecycle table T4a, T4b, T5 and T6.
 *
 * ## No second observer, and that is the design
 *
 * The EVM and Solana activity repair lanes ALREADY own chain observation: they
 * hold the receipt and signature-status lookups, the claim leases, the 90 s
 * handler window and the ambiguity rules. A second sweep asking the chain the
 * same questions about the same hashes would be two observers racing for one
 * row's terminality, which is the failure this module exists to avoid.
 *
 * So this module holds NO chain access at all. The pool-level activity writers
 * now settle their linked WTI and PE rows inside the same transaction. This
 * module owns crash recovery plus compatibility convergence for rows a prior
 * build already left partially terminal.
 *
 * ## And no rebroadcast, ever
 *
 * Nothing here signs, submits or re-sends. A `broadcast_unconfirmed` intent
 * settles from EVIDENCE - the lane's own - or stays where it is.
 *
 * ## The crash-recovery split
 *
 * A `consuming` intent whose handler died is recovered by the presence or
 * absence of a STAGED HASH on its linked activity row, because staging strictly
 * precedes broadcast:
 *
 *   T4a  no hash    -> `failed` / `crashed_before_broadcast`, and the activity
 *                      row is terminalized too. No hash PROVES no broadcast.
 *   T4b  hash       -> `broadcast_unconfirmed`. The activity row is left
 *                      exactly as it is: it is staged-with-hash, which is what
 *                      makes it a candidate for the lane that owns it.
 *
 * Both complete the `protocol_executions` row, which is otherwise left at
 * `intent` forever and blocks the compaction money-state gate on its own.
 */

import {
  failHashlessActivityEventWith,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  recoverLinkedBroadcastUnconfirmed,
  settleLinkedActivityRows,
  settleFromPersistedTerminalActivity,
} from "@vex-agent/db/repos/agent-activity/linked-transaction-settlement.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import logger from "@utils/logger.js";

import { REPAIR_CANDIDATE_AGE_MS } from "./handler-window.js";

/**
 * The verdict a repair lane just wrote onto an activity row, in the vocabulary
 * the intent's own lifecycle understands.
 *
 * `superseded_unproven` is carried through as itself and never folded into
 * `failed`: nobody established that the transaction did not happen, and the
 * intent has its own honest terminal for exactly that (T6).
 */
export type LinkedActivityVerdict = "confirmed" | "reverted" | "superseded_unproven";

/** How many stranded rows one recovery pass may take. Bounded like every sweep here. */
export const STRANDED_INTENT_RECOVERY_LIMIT = 25;

/**
 * T5 / T6 compatibility convergence.
 *
 * Current pool-level activity terminalizers already settle all three rows in
 * one transaction. The repair lanes keep calling this idempotent seam so older
 * partial rows and a lane-first row written by a previous build still converge.
 * A failure is logged and swallowed because this compatibility call runs only
 * after an activity verdict is already durable.
 *
 * ## Why `consuming` is settled here too
 *
 * The Solana fast lane can terminalize an activity row while its linked intent
 * is still `consuming` - the handler claimed, staged its hash, and then the
 * process died. Settling only `broadcast_unconfirmed` skipped that intent; the
 * stranded scan later moved it to `broadcast_unconfirmed`, and by then the
 * activity row it hangs off was ALREADY terminal, so no lane would ever select
 * it again and the intent blocked the money-state gate forever.
 *
 * So a `consuming` intent is CONVERGED in the same repair action, under the same
 * lock, from the verdict this lane just established - `consuming` ->
 * `broadcast_unconfirmed` (using the hash the lane's own row carries) -> the
 * verdict's terminal. No chain access, no second observer, and no re-send: this
 * spends evidence the caller already holds.
 *
 * A staged hash is required. Without one there is no proof anything was
 * broadcast, and T4a owns that row instead.
 */
export async function settleLinkedTransactionIntent(
  activityId: number,
  verdict: LinkedActivityVerdict,
  _protocolExecutionId: number | null,
  _stagedTxHash: string | null = null,
): Promise<void> {
  try {
    const intent = await intentsRepo.getByActivityId(activityId);
    if (intent === null) return;
    const settled = await settleFromPersistedTerminalActivity(
      activityId,
      intent.sessionId,
      verdict,
    );
    logger.info(
      settled
        ? "wallet.transaction.settled_from_repair"
        : "wallet.transaction.settle_linked_miss",
      { activityId, intentId: intent.intentId, verdict },
    );
  } catch (error) {
    logger.warn("wallet.transaction.settle_linked_failed", {
      activityId,
      verdict,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * The activity fields this module needs from a lane's row. Narrower than the
 * full event on purpose, so a lane can hand over what it already holds.
 *
 * `txHash` is the STAGED hash, and it is required here because it is the only
 * thing that lets a `consuming` intent be converged: it is the proof that the
 * handler got as far as broadcasting before it disappeared.
 */
export type LinkedActivityRow = Pick<
  AgentActivityEvent,
  "id" | "protocolExecutionId" | "txHash"
>;

/** Convenience for a lane that holds the whole row. */
export function settleLinkedIntentForRow(
  row: LinkedActivityRow,
  verdict: LinkedActivityVerdict,
): Promise<void> {
  return settleLinkedTransactionIntent(
    row.id,
    verdict,
    row.protocolExecutionId,
    row.txHash ?? null,
  );
}

export interface StrandedRecoveryResult {
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

/**
 * The CHAIN verdict an already-terminal activity row carries, or `null` when it
 * carries none that this module may act on.
 *
 * NO CHAIN ACCESS AND NO GUESSING. This reads a verdict a lane already
 * established, in the same vocabulary the lane would have handed over had it
 * been the one to find the intent - which is exactly why this is not a second
 * observer.
 *
 * `superseded_unproven` is kept as itself on BOTH of its shapes: the activity
 * status a lane writes when a nonce was consumed elsewhere, and the Solana
 * expiry failure code. Neither established that the transaction ran, and folding
 * either into `reverted` would tell the user it ran and failed. Any other
 * failure code returns `null` - an unrecognized terminal is not evidence, and
 * the row keeps today's behaviour of parking at `broadcast_unconfirmed`.
 */
function verdictOfTerminalActivity(
  status: string,
  failureCode: string | null,
): LinkedActivityVerdict | null {
  if (status === "confirmed") return "confirmed";
  if (status === "superseded_unproven") return "superseded_unproven";
  if (status !== "definitively_failed") return null;
  if (failureCode === "mined_revert") return "reverted";
  if (failureCode === "solana_signature_expired") return "superseded_unproven";
  return null;
}

/**
 * T4a / T4b. Recover linked `consuming` intents whose confirm handler is gone.
 *
 * Called from `syncTick` (`sync/index.ts`), the tick that runs unconditionally
 * on every cycle. It is NOT owned by a lane: it is family-agnostic, and hanging
 * it off the EVM sweep made Solana recovery depend on the EVM lane being
 * enabled. It performs NO chain access: the split is decided entirely by
 * whether the linked activity row carries the hash the handler stages before it
 * broadcasts.
 */
export async function recoverStrandedTransactionIntents(
  limit: number = STRANDED_INTENT_RECOVERY_LIMIT,
): Promise<StrandedRecoveryResult> {
  let crashedBeforeBroadcast = 0;
  let recoveredUnconfirmed = 0;
  let convergedFromTerminalActivity = 0;

  let stranded: readonly intentsRepo.StrandedTransactionIntent[];
  try {
    stranded = await intentsRepo.listStrandedConsuming(REPAIR_CANDIDATE_AGE_MS, limit);
  } catch (error) {
    logger.warn("wallet.transaction.stranded_scan_failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return {
      examined: 0,
      crashedBeforeBroadcast: 0,
      recoveredUnconfirmed: 0,
      convergedFromTerminalActivity: 0,
    };
  }

  for (const row of stranded) {
    const { intent } = row;
    try {
      if (row.stagedTxHash === null) {
        // T4a. Staging strictly precedes broadcast, so the absence of a hash is
        // POSITIVE evidence that nothing was sent. The intent is honestly
        // terminal with `tx_hash` NULL, and the activity row is terminalized
        // with it - no lane will ever look at a hashless row.
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
              "the confirm handler stopped before the transaction was broadcast; no signed hash was "
              + "ever staged, so nothing reached the network",
          }),
        });
        // A prior terminal writer may already have recorded another failure
        // code, notably the old hashless reaper's `unknown`. The coordinator
        // adopts that persisted hashless failure as crash-before-broadcast
        // evidence and advances WTI plus PE. Count convergence from the durable
        // intent, not from whether this invocation won the AA CAS.
        if (
          terminalized.row.status === "definitively_failed"
          && terminalized.row.txHash === null
        ) {
          const after = await intentsRepo.getById(intent.intentId, intent.sessionId);
          if (
            after?.status === "failed"
            && after.failureStage === "crashed_before_broadcast"
          ) {
            crashedBeforeBroadcast++;
          }
        }
        continue;
      }

      // THE INVERSE ORDERING. The lane got to the activity row FIRST and
      // terminalized it while this intent was still `consuming`, so it will
      // never be selected again and nothing would ever move the intent off
      // `broadcast_unconfirmed`. The verdict it needs is already written on the
      // row in front of us, so it is applied here - through the same settlement
      // the lane itself would have called, with no chain access and no re-send.
      const terminalVerdict = verdictOfTerminalActivity(
        row.activityStatus,
        row.activityFailureCode,
      );
      if (terminalVerdict !== null) {
        await settleLinkedTransactionIntent(
          row.activityId,
          terminalVerdict,
          row.protocolExecutionId,
          row.stagedTxHash,
        );
        const after = await intentsRepo.getById(intent.intentId, intent.sessionId);
        if (after !== null && after.status !== "consuming") convergedFromTerminalActivity++;
        continue;
      }

      // T4b. A hash exists, so bytes may be on the network. This is never
      // `failed`-with-a-hash: that shape cannot be told apart from a revert,
      // and a caller who reads "failed" retries. The ACTIVITY row is left
      // alone - it is staged-with-hash, which is precisely what makes it a
      // candidate for the lane that owns chain observation.
      const recovered = await recoverLinkedBroadcastUnconfirmed(
        row.activityId,
        intent.sessionId,
      );
      if (recovered) recoveredUnconfirmed++;
      // `success: false`, and deliberately so: recovery learned that bytes MAY
      // be on the network, which is not a success. The intent's own
      // `broadcast_unconfirmed` status is what keeps saying the outcome is
      // unproven; completing the ATTEMPT only stops it blocking the gate.
    } catch (error) {
      logger.warn("wallet.transaction.stranded_recovery_failed", {
        intentId: intent.intentId,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  if (stranded.length > 0) {
    logger.info("wallet.transaction.stranded_recovery", {
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
