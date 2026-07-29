/**
 * Approval runtime — the `approval_resolved` engine cue, appended exactly once
 * per approval.
 *
 * The cue is a prompt-contract artifact, not a log line: it tells the model WHY
 * it woke and where to find the outcome. Exactly one copy per approval — a
 * second would tell the model a second approval had resolved when none had, and
 * a wake it already handled would read as new work.
 *
 * Resume eligibility ends at COMPLETION, so an approval can legitimately be
 * attempted more than once: an attempt that claimed the lease and then died is
 * retried by the end-of-turn hook or the reconciler. Ordering alone cannot make
 * the cue safe under that rule, so it is bound to the approval instead.
 * `resume_cue_message_id` and the transcript row it names are written in ONE
 * transaction under a row lock, which makes the pairing indivisible in both
 * directions: no duplicate cue, and no recorded cue that is missing from the
 * conversation.
 *
 * This also removes the orphan the chat path used to accept. An attempt that
 * loses the race no longer needs to be ordered behind the winner — it simply
 * finds the slot taken and writes nothing.
 */

import { withTransaction } from "../../../db/client.js";
import * as approvalIntentsRepo from "../../../db/repos/approval-intents.js";
import {
  appendEngineMessage,
  emitTranscriptAppend,
  TRANSCRIPT_APPEND_EVENT_TYPE,
} from "../../events/index.js";
import logger from "@utils/logger.js";

import { APPROVAL_RESOLVED_CUE } from "./helpers.js";

/**
 * Deliberately NOT the operator-interrupt banner — that means "the user
 * interrupted you", the opposite of what happened here.
 */
const CUE_METADATA = {
  source: "engine",
  messageType: "approval_resolved",
  visibility: "internal",
} as const;

/**
 * Append the approval-resolved cue for `approvalId`, or do nothing because an
 * earlier attempt already appended it.
 *
 * Same caller-owned-transaction pattern as the tool-result commits: the INSERT
 * is storage-only inside the transaction and the transcript event is emitted
 * only after COMMIT, so a rollback can never publish an event for a row that
 * does not exist.
 */
export async function appendApprovalResolvedCueOnce(
  sessionId: string,
  approvalId: string,
): Promise<void> {
  const inserted = await withTransaction(async (client) => {
    const existingCueMessageId =
      await approvalIntentsRepo.lockResumeCueMessageIdWith(client, approvalId);
    if (existingCueMessageId !== null) return null;

    const row = await appendEngineMessage(
      sessionId,
      APPROVAL_RESOLVED_CUE,
      { ...CUE_METADATA },
      { client },
    );
    await approvalIntentsRepo.attachResumeCueMessageWith(
      client,
      approvalId,
      row.id,
    );
    return row;
  });

  if (inserted === null) {
    logger.info("engine.approval_runtime.resume_cue_already_appended", {
      sessionId,
      approvalId,
    });
    return;
  }

  emitTranscriptAppend({
    type: TRANSCRIPT_APPEND_EVENT_TYPE,
    sessionId,
    messageId: inserted.id,
    role: inserted.role,
    createdAt: inserted.timestamp,
    messageType: CUE_METADATA.messageType,
    correlationId: null,
  });
}
