/**
 * T3a-T3d TERMINALIZATION, as ONE transaction under ONE session control lock.
 *
 * ## Why one transaction
 *
 * The generic signing arc couples THREE rows: the `wallet_transaction_intents`
 * row (WTI), its `agent_activity` row (AA) and the `protocol_executions` row
 * (PE). Settling them in three separate transactions leaves partial states that
 * NOBODY owns:
 *
 *   - WTI fails while AA and PE succeed. Stranded recovery flips the WTI to
 *     `broadcast_unconfirmed`, but the AA row is already terminal, so the repair
 *     lane never reselects it and the two rows disagree forever.
 *   - WTI and AA succeed while the PE completion fails. No owner revisits a PE
 *     row left at `execution_status = 'intent'`, and that row is exactly what
 *     the compaction money-state gate blocks on.
 *
 * One transaction removes both states by construction: either all three rows are
 * terminal together, or none of them moved and the scheduled recovery finds the
 * intent exactly as it was.
 *
 * ## The transaction is DB-ONLY, and it commits AFTER the broadcast
 *
 * The broadcast itself happens OUTSIDE any lock, exactly as before - holding the
 * session control lock across a network submission would block the operator's
 * Stop with a fund transfer, the inversion that lock exists to prevent. This
 * transaction opens only once the execution outcome is already known, performs
 * three CAS writes and their reads, and commits.
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
 * a second, conflicting account of the same transaction over part of it.
 *
 * ## What a throw does NOT change
 *
 * It never changes the answer the caller receives. The transaction is already
 * whatever the chain made of it; this module settles the AUDIT, and a failure
 * to record an immutable fact is not a claim that the fact did not happen. The
 * caller logs the conflict structurally and still returns the honest outcome.
 */

import type { PoolClient } from "pg";

import {
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
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import type { TransactionExecution } from "./execution-outcome.js";

/**
 * A durable winner already terminalized one of the three rows with an
 * INCOMPATIBLE outcome, so this settlement rolled back rather than overwrite
 * part of it.
 *
 * Its own type because the caller's response is specific: log the conflict with
 * the row it is about, and still return the chain outcome. `row` and `detail`
 * are structural only - no provider text, no calldata, no key material.
 */
export class TerminalSettlementConflictError extends Error {
  readonly row: "wti" | "aa" | "pe";
  readonly detail: string;

  constructor(row: "wti" | "aa" | "pe", detail: string) {
    super(`wallet_transaction terminal settlement conflict on ${row}: ${detail}`);
    this.name = "TerminalSettlementConflictError";
    this.row = row;
    this.detail = detail;
  }
}

/** The three rows this settlement owns, as the claim transaction linked them. */
export interface TerminalSettlementTargets {
  readonly intentId: string;
  readonly sessionId: string;
  readonly activityId: number;
  readonly executionId: number;
  /** For the PE row's `duration_ms`. Not an outcome fact, so never compared. */
  readonly startedAtMs: number;
}

/** The AA half of a desired terminal outcome. `null` means this arm writes no AA row. */
type ActivityTarget =
  | { readonly kind: "confirmed" }
  | {
      readonly kind: "failed";
      readonly failureCode: AgentActivityFailureCode;
      readonly failureReason: string;
    }
  | null;

/** The exact durable outcome the three rows must end up in. */
interface DesiredTerminalState {
  readonly intentStatus: WalletTransactionIntent["status"];
  readonly intentFailureStage: WalletTransactionIntent["failureStage"];
  readonly intentTxHash: string | null;
  readonly intentFailureReason: string | null;
  readonly writeIntent: (client: PoolClient) => Promise<WalletTransactionIntent | null>;
  readonly activity: ActivityTarget;
  /** What `protocol_executions.result.status` must say. */
  readonly executionResultStatus: string;
  readonly executionTxHash: string | null;
  readonly executionSuccess: boolean;
}

function desiredStateOf(
  targets: TerminalSettlementTargets,
  execution: TransactionExecution,
): DesiredTerminalState {
  const { intentId, sessionId } = targets;
  switch (execution.kind) {
    case "confirmed":
      return {
        intentStatus: "executed",
        intentFailureStage: null,
        intentTxHash: execution.txHash,
        intentFailureReason: null,
        writeIntent: (client) =>
          intentsRepo.markExecutedWith(client, intentId, sessionId, execution.txHash),
        activity: { kind: "confirmed" },
        executionResultStatus: "confirmed",
        executionTxHash: execution.txHash,
        executionSuccess: true,
      };

    case "chain_failed": {
      const reason = `${execution.errorKind}:${execution.errorHash}`;
      return {
        intentStatus: "failed",
        intentFailureStage: "chain_reverted",
        intentTxHash: execution.txHash,
        intentFailureReason: reason,
        writeIntent: (client) =>
          intentsRepo.markChainFailedWith(client, intentId, sessionId, execution.txHash, reason),
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
          intentsRepo.markBroadcastUnconfirmedWith(client, intentId, sessionId, execution.txHash),
        // T3d: the activity row stays `pending` WITH its staged hash. It is the
        // only row allowed to hold an unknown fate, and terminalizing it here
        // would delete the repair lane's own candidate.
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
            ? intentsRepo.markAuditFailedWith(client, intentId, sessionId, reason)
            : intentsRepo.markPreBroadcastFailedWith(client, intentId, sessionId, reason),
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
 * Terminalize WTI, AA and PE for one execution outcome, atomically.
 *
 * THROWS `TerminalSettlementConflictError` when a durable winner already wrote
 * an incompatible outcome, having rolled everything back. Any other throw is an
 * infrastructure failure and also rolls back.
 */
export async function settleTerminalRows(
  targets: TerminalSettlementTargets,
  execution: TransactionExecution,
): Promise<void> {
  const desired = desiredStateOf(targets, execution);
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
  targets: TerminalSettlementTargets,
): Promise<void> {
  const intent = await intentsRepo.getByIdWith(client, targets.intentId, targets.sessionId);
  if (intent === null) {
    throw new TerminalSettlementConflictError("wti", "the intent row no longer exists");
  }
  if (intent.activityId !== String(targets.activityId)) {
    throw new TerminalSettlementConflictError(
      "wti",
      "the intent no longer points at the activity row this attempt created",
    );
  }

  const event = await getActivityEventByIdWith(client, targets.activityId);
  if (event === null) {
    throw new TerminalSettlementConflictError("aa", "the activity row no longer exists");
  }
  if (event.protocolExecutionId !== targets.executionId) {
    throw new TerminalSettlementConflictError(
      "aa",
      "the activity row belongs to a different execution",
    );
  }

  const completion = await readExecutionCompletionWith(client, targets.executionId);
  if (completion === null) {
    throw new TerminalSettlementConflictError("pe", "the execution row no longer exists");
  }
}

async function settleIntentRow(
  client: PoolClient,
  targets: TerminalSettlementTargets,
  desired: DesiredTerminalState,
): Promise<void> {
  const applied = await desired.writeIntent(client);
  if (applied !== null) return;

  const current = await intentsRepo.getByIdWith(client, targets.intentId, targets.sessionId);
  if (current === null) {
    throw new TerminalSettlementConflictError("wti", "the intent row vanished mid-settlement");
  }
  if (
    current.status !== desired.intentStatus
    || current.failureStage !== desired.intentFailureStage
    || current.txHash !== desired.intentTxHash
    || current.failureReason !== desired.intentFailureReason
  ) {
    throw new TerminalSettlementConflictError(
      "wti",
      `a durable winner left the intent at ${current.status}, not the ${desired.intentStatus} `
      + "this outcome describes",
    );
  }
}

async function settleActivityRow(
  client: PoolClient,
  targets: TerminalSettlementTargets,
  desired: DesiredTerminalState,
): Promise<void> {
  const target = desired.activity;
  if (target === null) return;

  const result: TerminalCasResult =
    target.kind === "confirmed"
      // No executed amounts: this kind has no asset leg to fill.
      ? await confirmActivityEventWith(client, targets.activityId, {})
      : await failActivityEventWith(client, targets.activityId, {
          failureCode: target.failureCode,
          failureReason: target.failureReason,
        });
  if (result.applied) return;

  assertActivityCompatible(result.row, target, desired.intentTxHash);
}

/**
 * The existing terminal activity row is compatible only when it states the same
 * outcome AND the same hash. A row confirmed for a different hash is a different
 * transaction's record.
 */
function assertActivityCompatible(
  row: AgentActivityEvent,
  target: Exclude<ActivityTarget, null>,
  expectedTxHash: string | null,
): void {
  const expectedStatus = target.kind === "confirmed" ? "confirmed" : "definitively_failed";
  if (row.status !== expectedStatus) {
    throw new TerminalSettlementConflictError(
      "aa",
      `a durable winner left the activity row at ${row.status}, not ${expectedStatus}`,
    );
  }
  if (expectedTxHash !== null && row.txHash !== expectedTxHash) {
    throw new TerminalSettlementConflictError(
      "aa",
      "the terminal activity row carries a different transaction hash",
    );
  }
  if (target.kind === "failed" && row.failureCode !== target.failureCode) {
    throw new TerminalSettlementConflictError(
      "aa",
      `the terminal activity row failed with ${String(row.failureCode)}, not ${target.failureCode}`,
    );
  }
}

async function settleExecutionRow(
  client: PoolClient,
  targets: TerminalSettlementTargets,
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
    externalRefs:
      desired.executionTxHash === null ? {} : { txHash: desired.executionTxHash },
    durationMs: Date.now() - targets.startedAtMs,
  });
  if (applied) return;

  const current = await readExecutionCompletionWith(client, targets.executionId);
  if (current === null) {
    throw new TerminalSettlementConflictError("pe", "the execution row vanished mid-settlement");
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
    throw new TerminalSettlementConflictError(
      "pe",
      `a durable winner completed the execution as ${current.executionStatus}, not the `
      + `${expectedStatus} this outcome describes`,
    );
  }
}
