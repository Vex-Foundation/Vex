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
import { mapRow, SELECT_COLUMNS, type TokenLaunchIntent } from "./types.js";

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

/** The dialog's "is a launch waiting for me?" query. Newest first. */
export async function getAwaitingForSession(
  sessionId: string,
): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE session_id = $1 AND status = 'awaiting_user_form'
      ORDER BY created_at DESC`,
    [sessionId],
  );
  return rows.map(mapRow);
}

// The identity-sweep candidate set moved to `./sweep-claim.js` and became a
// CLAIM (`claimBroadcastPendingForSweep`): serving a row now stamps
// `last_checked_at` in the same statement, which is a WRITE and so does not
// belong in this read-only module. See that file for the starvation it fixes.
