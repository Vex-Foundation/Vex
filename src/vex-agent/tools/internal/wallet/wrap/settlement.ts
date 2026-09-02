/**
 * The wrap lane's TERMINALIZATION, as ONE transaction under ONE session control
 * lock, plus the `ToolResult` the caller returns.
 *
 * ## Why one transaction
 *
 * The wrap arc couples THREE rows: the `wallet_wrap_intents` row (WWI), its
 * `agent_activity` row (AA) and the `protocol_executions` row (PE). Settling
 * them in three separate transactions leaves partial states that NOBODY owns:
 *
 *   - WWI fails while AA and PE succeed. Stranded recovery flips the WWI to
 *     `broadcast_unconfirmed`, but the AA row is already terminal, so the repair
 *     lane never reselects it and the two rows disagree forever.
 *   - WWI and AA succeed while the PE completion fails. No owner revisits a PE
 *     row left at `execution_status = 'intent'`, and that row is exactly what
 *     the compaction money-state gate blocks on.
 *
 * One transaction removes both states by construction: either all three rows are
 * terminal together, or none of them moved and the scheduled recovery finds the
 * intent exactly as it was.
 *
 * ## The transaction is DB-ONLY, and it commits AFTER the broadcast
 *
 * The broadcast itself happens OUTSIDE any lock: holding the session control
 * lock across a network submission would block the operator's Stop with a fund
 * transfer, the inversion that lock exists to prevent. This transaction opens
 * only once the execution outcome is already known, performs three CAS writes
 * and their reads, and commits.
 *
 * ## A CAS miss here is NOT benign - the compatible-winner rule
 *
 * Every writer of these rows takes the SAME session control lock. So a miss
 * inside this transaction cannot be a concurrent writer racing us: it means a
 * durable winner COMMITTED BEFORE this transaction acquired the lock. For each
 * of the three writes:
 *
 *   - the CAS APPLIED                      -> continue;
 *   - the CAS MISSED but the existing row EXACTLY matches the outcome we were
 *     about to write (status, tx hash, and the failure evidence)
 *                                          -> idempotent continue;
 *   - anything else - the row is missing, differently terminal, carries another
 *     hash, or carries incompatible evidence
 *                                          -> THROW, and the whole transaction
 *                                             rolls back.
 *
 * Rolling back is the safe direction: it leaves the rows as the durable winner
 * wrote them and leaves this attempt visible to recovery, rather than stamping
 * a second, conflicting account of the same wrap over part of it.
 *
 * ## What a throw does NOT change
 *
 * It never changes the answer the caller receives. The transaction is already
 * whatever the chain made of it; this module settles the AUDIT, and a failure
 * to record an immutable fact is not a claim that the fact did not happen. The
 * caller logs the conflict structurally and still returns the honest outcome.
 *
 * ## The one divergence from the generic-signing lane: THE ROW HAS LEGS
 *
 * A `kind='transaction'` row has no asset leg, so that lane confirms with an
 * empty input. A wrap row has BOTH legs, and the confirm guard in
 * `agent-activity/swap-lifecycle/terminal-cas.ts` THROWS on a `wrap`/`unwrap`
 * row confirmed without both executed amounts. The decoded receipt is therefore
 * part of the confirmed arm's input, and the undecodable case has its own
 * branch rather than a legless confirm that would throw.
 */

import type { PoolClient } from "pg";

import {
  confirmActivityEventStatusOnlyWith,
  confirmActivityEventWith,
  failActivityEventWith,
  getActivityEventByIdWith,
  type AgentActivityEvent,
  type AgentActivityFailureCode,
  type TerminalCasResult,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  completeExecutionIntentWith,
  readExecutionCompletionWith,
} from "@vex-agent/db/repos/executions.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import { failWith, ok } from "../send/results.js";
import { summarizeWalletError } from "../send-types.js";
import type { TransactionExecution } from "../transaction/execution-outcome.js";

import type { WrapActivity } from "./activity-writer.js";
import type { WrapDecodedSettlement, WrapReceiptVerdict } from "./receipt-decode.js";

/**
 * A durable winner already terminalized one of the three rows with an
 * INCOMPATIBLE outcome, so this settlement rolled back rather than overwrite
 * part of it.
 *
 * Its own type because the caller's response is specific: log the conflict with
 * the row it is about, and still return the chain outcome. `row` and `detail`
 * are structural only - no provider text, no calldata, no key material.
 */
export class WrapSettlementConflictError extends Error {
  readonly row: "wwi" | "aa" | "pe";
  readonly detail: string;

  constructor(row: "wwi" | "aa" | "pe", detail: string) {
    super(`wallet_wrap terminal settlement conflict on ${row}: ${detail}`);
    this.name = "WrapSettlementConflictError";
    this.row = row;
    this.detail = detail;
  }
}

/** The three rows this settlement owns, as the claim transaction linked them. */
export interface WrapSettlementTargets {
  readonly intentId: string;
  readonly sessionId: string;
  readonly activityId: number;
  readonly executionId: number;
  /** For the PE row's `duration_ms`. Not an outcome fact, so never compared. */
  readonly startedAtMs: number;
}

/** The AA half of a desired terminal outcome. `null` means this arm writes no AA row. */
type ActivityTarget =
  | {
      readonly kind: "confirmed";
      /**
       * The proven legs, or `null` on the anomaly path where the receipt is
       * held but did not establish them. See `settleActivityRow`.
       */
      readonly decoded: WrapDecodedSettlement | null;
    }
  | {
      readonly kind: "failed";
      readonly failureCode: AgentActivityFailureCode;
      readonly failureReason: string;
    }
  | null;

/** The exact durable outcome the three rows must end up in. */
interface DesiredTerminalState {
  readonly intentStatus: WalletWrapIntent["status"];
  readonly intentFailureStage: WalletWrapIntent["failureStage"];
  readonly intentTxHash: string | null;
  readonly intentFailureReason: string | null;
  readonly writeIntent: (client: PoolClient) => Promise<WalletWrapIntent | null>;
  readonly activity: ActivityTarget;
  /** What `protocol_executions.result.status` must say. */
  readonly executionResultStatus: string;
  readonly executionTxHash: string | null;
  readonly executionSuccess: boolean;
}

function desiredStateOf(
  targets: WrapSettlementTargets,
  execution: TransactionExecution,
  verdict: WrapReceiptVerdict,
): DesiredTerminalState {
  const { intentId, sessionId } = targets;
  switch (execution.kind) {
    case "confirmed": {
      // THE ANOMALY. The transaction confirmed and its receipt proved a
      // quantity that CONTRADICTS the approved amount. `executed` would assert
      // the operation happened as approved, which is precisely what did not
      // happen - and writing it here is what made this anomaly read as
      // RESOLVED everywhere downstream. The intent row is the single owner of
      // "is this wrap settled", so the unresolved state lives THERE; the
      // activity row still records the chain event honestly.
      if (verdict.kind === "amount_mismatch") {
        const reason =
          `AmountMismatch:approved=${verdict.approvedAmountRaw}`
          + `:observed=${verdict.observedAmountRaw}`;
        return {
          intentStatus: "review_required",
          intentFailureStage: null,
          intentTxHash: execution.txHash,
          intentFailureReason: reason,
          writeIntent: (client) =>
            wrapIntentsRepo.markReviewRequiredWith(
              client,
              intentId,
              sessionId,
              execution.txHash,
              reason,
            ),
          // Status-only, legs left NULL: publishing EITHER number as an
          // executed leg would record a quantity the approval never authorized.
          activity: { kind: "confirmed", decoded: null },
          executionResultStatus: "review_required",
          executionTxHash: execution.txHash,
          executionSuccess: false,
        };
      }
      return {
        intentStatus: "executed",
        intentFailureStage: null,
        intentTxHash: execution.txHash,
        intentFailureReason: null,
        writeIntent: (client) =>
          wrapIntentsRepo.markExecutedWith(client, intentId, sessionId, execution.txHash),
        activity: {
          kind: "confirmed",
          decoded: verdict.kind === "settled" ? verdict.legs : null,
        },
        // The SAME string whether or not the legs decoded: the chain fact is
        // identical, and a durable winner that did decode must stay compatible
        // with an attempt that did not.
        executionResultStatus: "confirmed",
        executionTxHash: execution.txHash,
        executionSuccess: true,
      };
    }

    case "chain_failed": {
      const reason = `${execution.errorKind}:${execution.errorHash}`;
      return {
        intentStatus: "failed",
        intentFailureStage: "chain_reverted",
        intentTxHash: execution.txHash,
        intentFailureReason: reason,
        writeIntent: (client) =>
          wrapIntentsRepo.markChainFailedWith(client, intentId, sessionId, execution.txHash, reason),
        activity: {
          kind: "failed",
          failureCode: "mined_revert",
          failureReason: "the transaction reverted on-chain",
        },
        executionResultStatus: "reverted",
        executionTxHash: execution.txHash,
        executionSuccess: false,
      };
    }

    case "confirmation_unknown":
      return {
        intentStatus: "broadcast_unconfirmed",
        intentFailureStage: null,
        intentTxHash: execution.txHash,
        intentFailureReason: null,
        writeIntent: (client) =>
          wrapIntentsRepo.markBroadcastUnconfirmedWith(
            client,
            intentId,
            sessionId,
            execution.txHash,
          ),
        // The activity row stays `pending` WITH its staged hash. It is the only
        // row allowed to hold an unknown fate, and terminalizing it here would
        // delete the repair lane's own candidate.
        activity: null,
        executionResultStatus: "confirmation_unknown",
        executionTxHash: execution.txHash,
        executionSuccess: false,
      };

    case "pre_broadcast_failed": {
      const reason = `${execution.errorKind}:${execution.errorHash}`;
      const auditFailed = execution.auditFailed === true;
      return {
        intentStatus: auditFailed ? "audit_failed" : "failed",
        intentFailureStage: auditFailed ? null : "pre_broadcast",
        intentTxHash: null,
        intentFailureReason: reason,
        writeIntent: (client) =>
          auditFailed
            ? wrapIntentsRepo.markAuditFailedWith(client, intentId, sessionId, reason)
            : wrapIntentsRepo.markPreBroadcastFailedWith(client, intentId, sessionId, reason),
        activity: {
          kind: "failed",
          failureCode: "broadcast_error",
          failureReason: auditFailed ? `AuditWriteFailed:${reason}` : `PreBroadcast:${reason}`,
        },
        executionResultStatus: "failed_before_broadcast",
        executionTxHash: null,
        executionSuccess: false,
      };
    }
  }
}

/**
 * Terminalize WWI, AA and PE for one execution outcome, atomically.
 *
 * `decoded` is what the mined receipt PROVED about the two legs, and is read
 * only on the `confirmed` arm; every other arm has no settlement to record.
 *
 * THROWS `WrapSettlementConflictError` when a durable winner already wrote an
 * incompatible outcome, having rolled everything back. Any other throw is an
 * infrastructure failure and also rolls back.
 */
export async function settleWrapTerminalRows(
  targets: WrapSettlementTargets,
  execution: TransactionExecution,
  verdict: WrapReceiptVerdict,
): Promise<void> {
  const desired = desiredStateOf(targets, execution, verdict);
  await withSessionControlLock(targets.sessionId, async (client) => {
    await readAndValidateLinkedRows(client, targets);
    await settleIntentRow(client, targets, desired);
    await settleActivityRow(client, targets, desired);
    await settleExecutionRow(client, targets, desired);
  });
}

/**
 * The three rows must exist and must still be the ones the claim transaction
 * linked, read on the SHARED client so what is validated is what will be
 * written. A broken link is a conflict, not a warning: writing three rows that
 * do not describe one attempt is the state this module exists to prevent.
 */
async function readAndValidateLinkedRows(
  client: PoolClient,
  targets: WrapSettlementTargets,
): Promise<void> {
  const intent = await wrapIntentsRepo.getByIdWith(client, targets.intentId, targets.sessionId);
  if (intent === null) {
    throw new WrapSettlementConflictError("wwi", "the intent row no longer exists");
  }
  if (intent.activityId !== String(targets.activityId)) {
    throw new WrapSettlementConflictError(
      "wwi",
      "the intent no longer points at the activity row this attempt created",
    );
  }

  const event = await getActivityEventByIdWith(client, targets.activityId);
  if (event === null) {
    throw new WrapSettlementConflictError("aa", "the activity row no longer exists");
  }
  if (event.protocolExecutionId !== targets.executionId) {
    throw new WrapSettlementConflictError(
      "aa",
      "the activity row belongs to a different execution",
    );
  }

  const completion = await readExecutionCompletionWith(client, targets.executionId);
  if (completion === null) {
    throw new WrapSettlementConflictError("pe", "the execution row no longer exists");
  }
}

async function settleIntentRow(
  client: PoolClient,
  targets: WrapSettlementTargets,
  desired: DesiredTerminalState,
): Promise<void> {
  const applied = await desired.writeIntent(client);
  if (applied !== null) return;

  const current = await wrapIntentsRepo.getByIdWith(client, targets.intentId, targets.sessionId);
  if (current === null) {
    throw new WrapSettlementConflictError("wwi", "the intent row vanished mid-settlement");
  }
  if (
    current.status !== desired.intentStatus
    || current.failureStage !== desired.intentFailureStage
    || current.txHash !== desired.intentTxHash
    || current.failureReason !== desired.intentFailureReason
  ) {
    throw new WrapSettlementConflictError(
      "wwi",
      `a durable winner left the intent at ${current.status}, not the ${desired.intentStatus} `
      + "this outcome describes",
    );
  }
}

/**
 * THE DIVERGENCE FROM THE GENERIC-SIGNING LANE, and the reason this file exists
 * separately from `../transaction/terminal-settlement.ts`.
 *
 * A `kind='transaction'` row is legless, so that lane confirms with an empty
 * input. A `kind='wrap'` row is not: `roleLegsIncomplete` puts `wrap`/`unwrap`
 * on the both-legs arm, and the confirm guard in
 * `agent-activity/swap-lifecycle/terminal-cas.ts` THROWS on such a row confirmed
 * without both `executedAmountInRaw` and `executedAmountOutRaw`. Migration 061
 * dropped the SQL CHECK that used to say the same thing, so that guard is now
 * the ONLY enforcement point, and a legless confirm here would be an exception,
 * not a lenient write.
 *
 * So the confirmed arm has two shapes:
 *
 *  - THE NORMAL PATH: the receipt decoded, and both proven legs are written.
 *  - THE ANOMALY PATH (`decoded === null`): the transaction DID settle, so
 *    recording a failure would be a lie, and leaving the intent pending would
 *    contradict a receipt we hold. The intent therefore moves to `executed`
 *    with its hash, and the activity row is confirmed STATUS-ONLY: no amount
 *    column is written and `executed_*` stays NULL. Migration 051 states
 *    "Undecodable, or directionally wrong - stays pending. It is not a terminal
 *    failure", and this is the reachable form of that rule: the row becomes a
 *    candidate of `listAmountCorrectionCandidates` (which selects
 *    `status='confirmed'` with a missing leg), `roleLegsIncomplete` reports it
 *    incomplete, and the wrap arm already registered in
 *    `sync/executed-amount-fallback/venue-dispatch.ts` fills the legs on a later
 *    pass from the same receipt.
 *
 *    This does NOT violate the status-only writer's "NOT for venue handlers"
 *    header rule. That rule forbids a handler SKIPPING its own decode and
 *    settling on bare inclusion. This branch is taken only AFTER the decode was
 *    attempted on the real receipt and could not establish both legs, which is
 *    precisely the state the status-only write was built to record honestly.
 */
async function settleActivityRow(
  client: PoolClient,
  targets: WrapSettlementTargets,
  desired: DesiredTerminalState,
): Promise<void> {
  const target = desired.activity;
  if (target === null) return;

  let result: TerminalCasResult;
  if (target.kind === "confirmed") {
    result = target.decoded === null
      ? await confirmActivityEventStatusOnlyWith(
          client,
          targets.activityId,
          "receipt_status_only_evm",
        )
      : await confirmActivityEventWith(client, targets.activityId, {
          executedAmountInRaw: target.decoded.executedAmountInRaw,
          executedAmountOutRaw: target.decoded.executedAmountOutRaw,
        });
  } else {
    result = await failActivityEventWith(client, targets.activityId, {
      failureCode: target.failureCode,
      failureReason: target.failureReason,
    });
  }
  if (result.applied) return;

  assertActivityCompatible(result.row, target, desired.intentTxHash);
}

/**
 * The existing terminal activity row is compatible only when it states the same
 * outcome AND the same hash. A row confirmed for a different hash is a different
 * transaction's record.
 *
 * The executed legs are deliberately NOT compared. A durable winner may have
 * confirmed the same settled transaction status-only, or decoded it later and
 * filled the legs; both describe this hash and neither contradicts us. The legs
 * have their own writer and their own correction lane, so treating a filled row
 * as a conflict would roll back a settlement over agreement.
 */
function assertActivityCompatible(
  row: AgentActivityEvent,
  target: Exclude<ActivityTarget, null>,
  expectedTxHash: string | null,
): void {
  const expectedStatus = target.kind === "confirmed" ? "confirmed" : "definitively_failed";
  if (row.status !== expectedStatus) {
    throw new WrapSettlementConflictError(
      "aa",
      `a durable winner left the activity row at ${row.status}, not ${expectedStatus}`,
    );
  }
  if (expectedTxHash !== null && row.txHash !== expectedTxHash) {
    throw new WrapSettlementConflictError(
      "aa",
      "the terminal activity row carries a different transaction hash",
    );
  }
  if (target.kind === "failed" && row.failureCode !== target.failureCode) {
    throw new WrapSettlementConflictError(
      "aa",
      `the terminal activity row failed with ${String(row.failureCode)}, not ${target.failureCode}`,
    );
  }
}

async function settleExecutionRow(
  client: PoolClient,
  targets: WrapSettlementTargets,
  desired: DesiredTerminalState,
): Promise<void> {
  const applied = await completeExecutionIntentWith(client, {
    executionId: targets.executionId,
    // Structural only: no provider text, no calldata, no key material.
    result: {
      status: desired.executionResultStatus,
      ...(desired.executionTxHash === null ? {} : { txHash: desired.executionTxHash }),
    },
    success: desired.executionSuccess,
    tradeCapture: null,
    externalRefs: desired.executionTxHash === null ? {} : { txHash: desired.executionTxHash },
    durationMs: Date.now() - targets.startedAtMs,
  });
  if (applied) return;

  const current = await readExecutionCompletionWith(client, targets.executionId);
  if (current === null) {
    throw new WrapSettlementConflictError("pe", "the execution row vanished mid-settlement");
  }
  const expectedStatus = desired.executionSuccess ? "succeeded" : "failed";
  const resultStatus = current.result.status;
  const resultTxHash = current.result.txHash;
  if (
    current.executionStatus !== expectedStatus
    || current.success !== desired.executionSuccess
    || resultStatus !== desired.executionResultStatus
    || (desired.executionTxHash === null
      ? resultTxHash !== undefined
      : resultTxHash !== desired.executionTxHash)
  ) {
    throw new WrapSettlementConflictError(
      "pe",
      `a durable winner completed the execution as ${current.executionStatus}, not the `
      + `${expectedStatus} this outcome describes`,
    );
  }
}

// ── The caller-facing half ─────────────────────────────────────────────

/** Metadata-only explorer ref, model-invisible. Same channel every wallet path uses. */
function explorerRefsData(chain: string, txHash: string): Record<string, unknown> {
  return { _explorerRefs: [{ chain, txRef: txHash }] };
}

/**
 * Settle the intent, the activity row and the execution row for one wrap
 * execution outcome, then produce the `ToolResult`.
 *
 * ALL THREE ROWS MOVE IN ONE TRANSACTION under the session control lock, so the
 * partial states that had no repair owner - a terminal activity row beside a
 * stranded intent, a completed intent beside an open execution row - cannot
 * exist. THE EXECUTION ROW IS COMPLETED ON EVERY ARM, ambiguity included: the
 * tool attempt is over the moment this returns, and the compaction money-state
 * gate selects an `execution_status = 'intent'` row on its own, so leaving it
 * open would block compaction forever even after a repair lane settled the rest.
 *
 * A SETTLEMENT FAILURE NEVER CHANGES THE ANSWER. The transaction is already
 * whatever the chain made of it; a conflicting durable winner or an unavailable
 * database is audit drift, logged structurally, and the caller still receives
 * the honest chain outcome. It is never converted into a claim that the
 * transaction failed.
 */
export async function settleWrapExecution(
  intent: WalletWrapIntent,
  activity: WrapActivity,
  execution: TransactionExecution,
  verdict: WrapReceiptVerdict,
  echo: Record<string, unknown>,
): Promise<ToolResult> {
  const { intentId } = intent;
  await terminalize(intent, activity, execution, verdict);

  switch (execution.kind) {
    case "confirmed": {
      // THE ANOMALY, reported as one. The transaction is real and on-chain, so
      // this is not a failure - but it did NOT move the approved quantity, and
      // saying "executed" here would be the same lie the durable row no longer
      // tells. Both numbers travel so the model and the operator can see the
      // discrepancy without re-deriving it.
      if (verdict.kind === "amount_mismatch") {
        return ok({
          intentId,
          status: "review_required",
          outcome: "amount_mismatch",
          txHash: execution.txHash,
          approvedAmountRaw: verdict.approvedAmountRaw,
          observedAmountRaw: verdict.observedAmountRaw,
          // Deliberately NULL: neither number may be published as an executed
          // leg, because the approval authorized neither of them together.
          executedAmountInRaw: null,
          executedAmountOutRaw: null,
          note:
            "The transaction confirmed on-chain, but the wrapper event proved a quantity that "
            + "differs from the approved amount. The intent is held for review and was NOT "
            + "recorded as executed.",
          ...echo,
          ...execution.data,
        });
      }
      return ok({
        intentId,
        status: "executed",
        outcome: "confirmed",
        txHash: execution.txHash,
        // Honest about what the receipt proved. `null` says the conversion
        // settled and its executed legs are not established YET, which is the
        // state the correction lane will finish.
        executedAmountInRaw:
          verdict.kind === "settled" ? verdict.legs.executedAmountInRaw : null,
        executedAmountOutRaw:
          verdict.kind === "settled" ? verdict.legs.executedAmountOutRaw : null,
        ...echo,
        ...execution.data,
      });
    }

    case "chain_failed": {
      return failWith(
        "The transaction was broadcast and FAILED on-chain. It is real and the network fee was "
        + `paid. Tx hash: ${execution.txHash}. Error hash: ${execution.errorHash}. Intent `
        + `${intentId} is terminal; preparing the same wrap again would send a second one.`,
        {
          ...explorerRefsData(execution.chain, execution.txHash),
          outcome: "chain_failed",
          intentId,
          txHash: execution.txHash,
          ...echo,
        },
      );
    }

    case "confirmation_unknown": {
      // A NORMAL return, and never `failed`-with-a-hash: that shape cannot be
      // told apart from a revert, and a caller who reads "failed" retries. The
      // activity row stays staged-with-hash for the repair lane.
      return failWith(
        "The transaction was BROADCAST and its outcome is not yet known. It may be settling right "
        + `now. Tx hash: ${execution.txHash}. DO NOT send it again: Vex is tracking it and a repair `
        + "lane will settle it from chain evidence. Check the explorer for the current state.",
        {
          ...explorerRefsData(execution.chain, execution.txHash),
          outcome: "confirmation_unknown",
          intentId,
          txHash: execution.txHash,
          ...echo,
        },
      );
    }

    case "pre_broadcast_failed": {
      return failWith(execution.message, {
        outcome: "pre_broadcast_failed",
        intentId,
        errorHash: execution.errorHash,
        ...echo,
      });
    }
  }
}

/**
 * Run the ONE terminalizing transaction and report a failure structurally.
 *
 * A conflict means a durable winner - operator action, or a recovery lane that
 * got there first under the same lock - already wrote an INCOMPATIBLE outcome,
 * so this attempt rolled back rather than stamp a second account of the same
 * transaction over part of it. Either way the chain fact is unchanged, so this
 * never alters the answer the caller receives; it changes only what an auditor
 * can see, and the scheduled recovery still owns any row left behind.
 */
async function terminalize(
  intent: WalletWrapIntent,
  activity: WrapActivity,
  execution: TransactionExecution,
  verdict: WrapReceiptVerdict,
): Promise<void> {
  try {
    await settleWrapTerminalRows(
      {
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        activityId: activity.activityId,
        executionId: activity.executionId,
        startedAtMs: activity.startedAtMs,
      },
      execution,
      verdict,
    );
  } catch (err) {
    if (err instanceof WrapSettlementConflictError) {
      logger.warn("wallet.wrap.terminal_settlement_conflict", {
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        row: err.row,
        detail: err.detail,
        outcome: execution.kind,
      });
      return;
    }
    logger.warn("wallet.wrap.terminal_settlement_failed", {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      outcome: execution.kind,
      ...summarizeWalletError(err),
    });
  }
}
