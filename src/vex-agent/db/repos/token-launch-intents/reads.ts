/**
 * Token-launch intents — the READ queries.
 *
 * A different reason to change from `./writers.js` (which owns what a legal
 * state transition is): here it is candidate ordering, scoping and pagination.
 *
 * Pool-level, deliberately. Reads do not change the compaction safe-moment
 * gate's answer, so — unlike every writer — they do not need to serialize with
 * it on the session control lock. Re-exported unchanged from the parent
 * `../token-launch-intents.js` facade.
 */

import { query, queryOne } from "../../client.js";
import {
  LIVE_TOKEN_LAUNCH_INTENT_STATUSES,
  mapRow,
  SELECT_COLUMNS,
  type TokenLaunchIntent,
} from "./types.js";

/**
 * Session-scoped BY CONTRACT: another session's intent id must MISS even when
 * it is known. This is the same ownership invariant `wallet-intents.getById`
 * enforces, and the reason it is a two-argument lookup rather than a primary-key
 * fetch.
 */
export async function getById(
  intentId: string,
  sessionId: string,
): Promise<TokenLaunchIntent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE intent_id = $1 AND session_id = $2`,
    [intentId, sessionId],
  );
  return row ? mapRow(row) : null;
}

/**
 * The dialog's "is a launch waiting for me?" query. Newest first.
 *
 * `expires_at > NOW()` is part of the QUESTION, not an optimisation. The expiry
 * sweep is periodic, so between a form lapsing and the sweep stamping it the
 * row still reads `awaiting_user_form` — and without this predicate the modal
 * would open a DEAD form the user could fill in and submit, only to be refused
 * by the CAS at the end. A form the user cannot successfully deploy must never
 * be presented as one they can.
 */
export async function getAwaitingForSession(
  sessionId: string,
): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE session_id = $1 AND status = 'awaiting_user_form' AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [sessionId],
  );
  return rows.map(mapRow);
}

/**
 * The expiry sweep's candidate set: forms whose window has LAPSED but whose row
 * still says it is waiting.
 *
 * Oldest first and bounded, like every other sweep read. Unscoped by session
 * for the same reason the identity sweep is — this is global housekeeping whose
 * rows span arbitrary sessions — and every WRITE it then performs goes back
 * through the session-scoped CAS writer using the session id carried on the row
 * it just read.
 *
 * No rotation stamp is needed here (unlike the identity claim): expiry is
 * TERMINAL, so a swept row leaves the candidate set permanently and cannot
 * starve the ones behind it.
 */
export async function listOverdueAwaitingForms(limit: number): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE status = 'awaiting_user_form' AND expires_at <= NOW()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

// The identity-sweep candidate set moved to `./sweep-claim.js` and became a
// CLAIM (`claimBroadcastPendingForSweep`): serving a row now stamps
// `last_checked_at` in the same statement, which is a WRITE and so does not
// belong in this read-only module. See that file for the starvation it fixes.

/**
 * Forms whose result was never appended — the DURABLE floor under the §C3b
 * resume, and the exact analogue of the approvals' "dispatched but unresumed"
 * shape (`approval-runtime/deferred-resume.ts`).
 *
 * Eligibility needs no new column, deliberately. A row qualifies when it PARKED
 * an agent turn (`tool_call_id IS NOT NULL`), that turn has never been answered
 * (`result_message_id IS NULL`), and the form itself is settled — the intent
 * left the live set, so there is a real outcome to report. Anything still live
 * is a form the user can still act on, and waking the agent over it would
 * answer a question that is still open.
 *
 * Oldest first: the longest-hanging turn is the one a user is actually waiting
 * on. Not session-scoped, because a sweeper works across sessions by definition;
 * every ACT it takes is scoped through `resumeAgentAfterUserForm`.
 */
export async function listOutstandingUserFormResumes(
  limit = 50,
): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE tool_call_id IS NOT NULL
        AND result_message_id IS NULL
        AND status <> ALL($1::text[])
      ORDER BY created_at ASC
      LIMIT $2`,
    [LIVE_TOKEN_LAUNCH_INTENT_STATUSES, limit],
  );
  return rows.map(mapRow);
}
