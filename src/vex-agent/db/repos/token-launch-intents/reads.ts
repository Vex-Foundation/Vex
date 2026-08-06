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
  OUTSTANDING_USER_FORM_PREDICATE,
  USER_FORM_RESULT_ALREADY_APPENDED,
} from "../../contracts/user-form-lifecycle-predicates.js";
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
 * Forms whose CONTINUATION is still owed — the DURABLE floor under the §C3b
 * resume, and the exact analogue of the approvals' "dispatched but unresumed"
 * shape (`approval-runtime/deferred-resume.ts`).
 *
 * ## Two halves, one set
 *
 * A row qualifies when it PARKED an agent turn and no resumed turn has
 * COMPLETED for it (the shared predicate). What is still owed differs:
 *
 *   - RESULT NOT YET APPENDED — the outcome must be written and then
 *     dispatched. Restricted to settled intents, because there is nothing
 *     honest to tell the model while the human can still fill the form in.
 *   - RESULT ALREADY APPENDED — the transcript has its answer and only the
 *     DISPATCH is missing. NOT status-restricted, and that is not an oversight:
 *     an `unconfirmed` outcome writes its result while the intent is still
 *     `broadcast_pending`, which IS a live status. Applying the settled filter
 *     to this half would make exactly those rows invisible to their own
 *     recovery.
 *
 * Keying eligibility off `resume_consumed_at` rather than off the result stamp
 * is what makes the second half representable at all. While the predicate was
 * "result not appended", a row lost its continuation the moment the transcript
 * was written — so a busy lease, a crash or a restart between the stamp and the
 * dispatch stranded the turn permanently, with no scan able to see it.
 *
 * Oldest first: the longest-hanging turn is the one a user is actually waiting
 * on. Not session-scoped, because a sweeper works across sessions by
 * definition; every ACT it takes is scoped through `resumeAgentAfterUserForm`.
 */
export async function listOutstandingUserFormResumes(
  limit = 50,
): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE ${OUTSTANDING_USER_FORM_PREDICATE}
        AND (
              ${USER_FORM_RESULT_ALREADY_APPENDED}
           OR status <> ALL($1::text[])
            )
      ORDER BY created_at ASC
      LIMIT $2`,
    [LIVE_TOKEN_LAUNCH_INTENT_STATUSES, limit],
  );
  return rows.map(mapRow);
}

/**
 * The statuses a launch can hold once it has been SIGNED AND PAID FOR but has
 * no proven token identity — the exact set `launched_tokens` will never contain
 * and the user must still be able to see.
 *
 * `broadcast_pending` is the launch still being checked. `superseded_unproven`
 * is the launch whose hash is no longer tracked, with its outcome never
 * established (migration 072). Both spent the user's gas; neither
 * proves a token. Terminalizing the second one WITHOUT adding it here would have
 * made a paid-for launch vanish from the list the moment it stopped being
 * re-checked, which is the very defect this read exists to close.
 *
 * `terminal_failure`, `cancelled` and `expired` are deliberately absent: a
 * proven revert minted nothing and the other two never signed.
 */
const UNSETTLED_MY_LAUNCH_STATUSES = ["broadcast_pending", "superseded_unproven"] as const;

/**
 * UNSETTLED launches for a set of wallets — the read behind "My Launches shows
 * the launch you just made, not only the ones that finished".
 *
 * The defect it closes: `launched_tokens` is written ONLY once a token identity
 * is proven, so a launch that is broadcast, mempool-stuck or superseded exists
 * nowhere the user can see it. The owner watched exactly this — a launch he had
 * paid for, absent from his own launch list, with nothing to tell him why.
 *
 * WALLET-SCOPED BY CONTRACT, like every other read here: the caller passes the
 * server-resolved wallet set, and a wallet outside it must MISS even when its
 * intent id is known. Addresses are compared case-insensitively because EVM
 * addresses are persisted in mixed checksum case by different writers.
 *
 * Scoped to {@link UNSETTLED_MY_LAUNCH_STATUSES}. An `awaiting_user_form` or
 * `authorized` intent is not a launch yet — nothing was signed, nothing was
 * spent, and listing it would turn a form the user abandoned into a launch they
 * appear to have made. The caller reads each row's `status` to say which of the
 * two unsettled things it is; this read never collapses them.
 */
export async function listUnsettledForWallets(input: {
  readonly walletAddresses: readonly string[];
  readonly chainId: number;
  readonly limit: number;
}): Promise<TokenLaunchIntent[]> {
  if (input.walletAddresses.length === 0) return [];
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM token_launch_intents
      WHERE status = ANY($4::text[])
        AND chain_id = $2
        AND LOWER(wallet_address) = ANY($1::text[])
      ORDER BY COALESCE(broadcast_at, created_at) DESC, intent_id DESC
      LIMIT $3`,
    [
      input.walletAddresses.map((address) => address.toLowerCase()),
      input.chainId,
      input.limit,
      UNSETTLED_MY_LAUNCH_STATUSES,
    ],
  );
  return rows.map(mapRow);
}
