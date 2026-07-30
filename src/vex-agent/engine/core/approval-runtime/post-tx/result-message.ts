/**
 * Approval runtime — post-tx result commit.
 *
 * The transcript row that records a decision's outcome and the intent columns
 * that describe it are written in ONE transaction. Before this was atomic, the
 * status was marked first and the transcript row appended second, so a crash
 * between them left an approval marked `succeeded` with no tool result in the
 * conversation — an orphaned tool call the agent could never answer, and no way
 * for any recovery pass to tell that the result was missing rather than merely
 * unread.
 *
 * With `result_message_id` written alongside the row itself, "succeeded with no
 * tool result" is unrepresentable, and `result_message_id IS NOT NULL AND
 * resume_consumed_at IS NULL` becomes a trustworthy durable-resume predicate.
 *
 * Both helpers use the caller-owned-transaction pattern from
 * `engine/events/append-transcript.ts`: `appendMessage(..., { client })` is
 * storage-only and the caller emits AFTER the COMMIT, so a rollback can never
 * publish an event for a row that does not exist.
 *
 * Every own-transaction helper here takes the SESSION CONTROL LOCK as its first
 * statement. These writes move `approval_intents` rows into terminal execution
 * and decision states, which the compaction safe-moment gate reads to decide
 * whether a transcript rewrite is safe; a reader under the lock is a boundary
 * only if the writers take it too. The `…With` variants do not take it —
 * their caller already holds it, and the advisory lock is transaction-scoped
 * and re-entrant, so a nested acquisition would be a no-op either way.
 */

import * as approvalIntentsRepo from "../../../../db/repos/approval-intents.js";
import { withTransaction } from "../../../../db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  appendMessage,
  emitTranscriptAppend,
  TRANSCRIPT_APPEND_EVENT_TYPE,
} from "../../../events/index.js";
import type { MessageMetadata } from "../../../../db/repos/messages.js";
import type { MessageWithId } from "../../../../db/repos/messages.js";
import type { ExplorerRef } from "../../explorer-refs.js";
import { shortSha256, toIsoNow } from "../helpers.js";
import { ApprovalResultSupersededError } from "../types.js";

/** The `PoolClient` shape `withTransaction` yields to its callback. */
type TxClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

/**
 * Insert a tool-result row and stamp the intent that owns it, on the CALLER's
 * transaction. Storage only — no event. Exposed so a caller that must decide
 * the intent's status and record its transcript row indivisibly (the
 * reconciler's `indeterminate` transition) can put both in one transaction
 * instead of two.
 */
async function insertToolResultRowWith(
  client: TxClient,
  sessionId: string,
  content: string,
  toolCallId: string,
  metadata: MessageMetadata,
  updateIntent: (client: TxClient, resultMessageId: number) => Promise<void>,
): Promise<MessageWithId> {
  const row = await appendMessage(
    sessionId,
    { role: "tool", content, toolCallId, timestamp: toIsoNow() },
    metadata,
    { client },
  );
  await updateIntent(client, row.id);
  return row;
}

/**
 * Publish the transcript append for a committed tool-result row. MUST be
 * called only after the writing transaction commits (`emit after commit`), so
 * a visible event always corresponds to a fetchable row.
 */
export function emitToolResultAppended(
  sessionId: string,
  row: MessageWithId,
  metadata: MessageMetadata,
): void {
  emitTranscriptAppend({
    type: TRANSCRIPT_APPEND_EVENT_TYPE,
    sessionId,
    messageId: row.id,
    role: row.role,
    createdAt: row.timestamp,
    messageType: metadata.messageType ?? null,
    correlationId: null,
  });
}

/**
 * Append a tool-result row and stamp the intent that owns it, atomically.
 * `updateIntent` runs on the same client as the INSERT; the transcript event
 * fires only after the whole transaction commits.
 */
async function commitToolResultRow(
  sessionId: string,
  content: string,
  toolCallId: string,
  metadata: MessageMetadata,
  updateIntent: (client: TxClient, resultMessageId: number) => Promise<void>,
): Promise<MessageWithId> {
  const inserted = await withTransaction(async (client) => {
    // FIRST statement of the transaction, per the global lock order. Every
    // caller of this helper settles an `approval_intents` decision or execution
    // status — rows the compaction safe-moment gate reads — so this writer must
    // serialize with that gate on the session control lock, or the gate's read
    // is a snapshot of the past rather than a boundary. DB-only and short: the
    // dispatch that produced `content` already finished, so nothing external
    // happens under the lock. See `db/repos/approval-intents/money-state.ts`.
    await acquireSessionControlLock(client, sessionId);
    return insertToolResultRowWith(
      client,
      sessionId,
      content,
      toolCallId,
      metadata,
      updateIntent,
    );
  });

  emitToolResultAppended(sessionId, inserted, metadata);

  return inserted;
}

/**
 * Settle an approved dispatch's execution row, or abort the transaction.
 *
 * The repo write is fenced on `execution_status = 'dispatching'`. A `false`
 * return means this dispatcher lost ownership while it was running — the
 * reconciler declared the outcome `indeterminate`, or another writer settled
 * it. Throwing here rolls the transcript INSERT back with it, which is exactly
 * the fix: no overwritten verdict, and no second tool result.
 */
async function settleExecutionOrThrow(
  client: TxClient,
  input: {
    readonly approvalId: string;
    readonly status: "succeeded" | "failed";
    readonly resultHash: string;
    readonly resultMessageId: number;
  },
): Promise<void> {
  const owned = await approvalIntentsRepo.commitExecutionResultWith(client, {
    approvalId: input.approvalId,
    status: input.status,
    resultHash: input.resultHash,
    resultMessageId: input.resultMessageId,
  });
  if (!owned) throw new ApprovalResultSupersededError(input.approvalId);
}

/**
 * Commit an approved dispatch's outcome: the real tool output (the user
 * explicitly approved this action, so unlike the dispatch-failure and rejection
 * paths it carries the genuine result), the `succeeded`/`failed` execution
 * status keyed by a short hash of the result, and the id of the row itself.
 *
 * `explorerRefs` (optional, additive) carries the coherent explorer refs the
 * caller derived from the dispatch result's `data` — approval-gated financial
 * actions are the most important case for a validated tx link. They ride under
 * `payload` (the only part of `MessageMetadata` persisted into the
 * `messages.metadata` JSONB column), surfacing as `metadata -> 'explorerRefs'`
 * for the desktop app. Omitted entirely when empty.
 */
export async function commitApprovedToolResult(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly dispatchResult: { success: boolean; output: string };
  readonly explorerRefs?: readonly ExplorerRef[];
}): Promise<MessageWithId> {
  const { dispatchResult } = input;
  const refs = input.explorerRefs ?? [];
  const resultHash = shortSha256(
    JSON.stringify({
      success: dispatchResult.success,
      output: dispatchResult.output,
    }),
  );

  return commitToolResultRow(
    input.sessionId,
    dispatchResult.output,
    input.toolCallId,
    {
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload: {
        success: dispatchResult.success,
        ...(refs.length > 0 ? { explorerRefs: refs } : {}),
      },
    },
    (client, resultMessageId) =>
      settleExecutionOrThrow(client, {
        approvalId: input.approvalId,
        status: dispatchResult.success ? "succeeded" : "failed",
        resultHash,
        resultMessageId,
      }),
  );
}

/**
 * Commit an unhandled dispatch throw: `failed` status, the structural-only
 * transcript row, and the result id, atomically.
 *
 * Content is structural (errorKind + errorHash, no raw message) because
 * tool/protocol/wallet errors can carry API keys, bearer tokens, DB URLs, and
 * key material, and the transcript is re-read by the model every turn.
 */
export async function commitDispatchFailureToolResult(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly content: string;
  readonly errorHash: string;
}): Promise<MessageWithId> {
  return commitToolResultRow(
    input.sessionId,
    input.content,
    input.toolCallId,
    {
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload: { success: false, dispatchError: true },
    },
    (client, resultMessageId) =>
      settleExecutionOrThrow(client, {
        approvalId: input.approvalId,
        status: "failed",
        resultHash: input.errorHash,
        resultMessageId,
      }),
  );
}

/**
 * Commit a decision that never dispatched a tool — reject, TTL expiry, or the
 * B-001 policy-drift block. `execution_status` is deliberately left at
 * `not_started` (nothing ran), but the result id still lands, so a rejection in
 * a chat session is just as recoverable as an approval: if the immediate resume
 * cannot be claimed, the reconciler finds the unconsumed result later.
 */
export async function commitDecisionToolResult(
  input: DecisionToolResultInput,
): Promise<MessageWithId> {
  const metadata = decisionResultMetadata(input.payload);
  return commitToolResultRow(
    input.sessionId,
    input.content,
    input.toolCallId,
    metadata,
    (client, resultMessageId) =>
      approvalIntentsRepo.attachResultMessageWith(
        client,
        input.approvalId,
        resultMessageId,
      ),
  );
}

export interface DecisionToolResultInput {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly content: string;
  readonly payload: Record<string, unknown>;
}

export function decisionResultMetadata(
  payload: Record<string, unknown>,
): MessageMetadata {
  return {
    source: "tool",
    messageType: "tool_result",
    visibility: "internal",
    payload,
  };
}

/**
 * Same write as `commitDecisionToolResult`, on the CALLER's transaction and
 * without the event. For the reconciler, whose `dispatching → indeterminate`
 * CAS and this transcript row must land together: a crash between two separate
 * commits would leave a TERMINAL `indeterminate` intent with no tool result in
 * the conversation and nothing left that would ever reconcile it again.
 *
 * The caller emits with `emitToolResultAppended` AFTER its COMMIT.
 */
export async function commitDecisionToolResultWith(
  client: TxClient,
  input: DecisionToolResultInput,
): Promise<MessageWithId> {
  return insertToolResultRowWith(
    client,
    input.sessionId,
    input.content,
    input.toolCallId,
    decisionResultMetadata(input.payload),
    (txClient, resultMessageId) =>
      approvalIntentsRepo.attachResultMessageWith(
        txClient,
        input.approvalId,
        resultMessageId,
      ),
  );
}
