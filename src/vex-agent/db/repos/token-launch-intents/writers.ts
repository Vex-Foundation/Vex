/**
 * Token-launch intents — the state-machine WRITERS (contract C1).
 *
 * One reason to change: what a legal launch transition is. The row shape lives
 * in `./types.js` and the queries in `./reads.js`; the C1 contract and the
 * session-ownership / CAS / client-binding invariants these functions implement
 * are documented on the parent `../token-launch-intents.js` facade, which keeps
 * its name and public entry point so no caller's import changes.
 *
 * EVERY function here is client-bound and session-scoped, without exception.
 * Both properties are load-bearing, not stylistic — see the facade's header.
 */

import type { PoolClient } from "pg";

import { jsonb, nullableJsonb } from "../../params.js";
import { lockAndRequireLaunchImageWith } from "../launch-image-lock.js";
import {
  casRow,
  mapRow,
  SELECT_COLUMNS,
  type CreateTokenLaunchIntentInput,
  type LaunchAuthorizationKind,
  type TokenLaunchIntent,
} from "./types.js";

// ── create ──────────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO token_launch_intents (
  intent_id, session_id, origin, status, chain_id, wallet_address,
  name, symbol, description, links, image_id, prebuy_raw, prebuy_decimals,
  authorization_id, authorization_kind, authorization_json, authorized_at,
  tool_call_id, mission_run_id, expires_at
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10::jsonb, $11, $12, $13,
  $14, $15, $16::jsonb, CASE WHEN $14::text IS NULL THEN NULL ELSE NOW() END,
  $17, $18, $19
) RETURNING ${SELECT_COLUMNS}`;

/**
 * Insert a fresh intent at its path's ENTRY state — the moment a session gains
 * live launch money state.
 *
 * Client-bound for the reason `wallet-intents.createWith` documents: creation is
 * precisely the transition a row lock cannot exclude (the row has no identity to
 * lock until it exists), so it MUST happen under the session control lock, or
 * the compaction safe-moment gate can read `clear` a microsecond before the
 * intent appears.
 *
 * `authorized_at` is stamped BY THE DATABASE iff an authorization id was
 * supplied, rather than by the caller. A Path-2 intent enters at `authorized`,
 * and letting the caller pass the timestamp separately is how a row ends up
 * asserting an authorization with no time — or a time with no authorization.
 *
 * When the intent CAPTURES an image, this takes that image's advisory lock and
 * re-reads the row before inserting (`../launch-image-lock.js`), so the intent
 * cannot appear inside a concurrent deletion's reference-check window NOR
 * capture an id that deletion already removed. It THROWS
 * `LaunchImageMissingError` in the second case — a dangling `image_id` is a
 * launch that can reach signing with no bytes behind it.
 */
export async function createWith(
  client: PoolClient,
  input: CreateTokenLaunchIntentInput,
): Promise<TokenLaunchIntent> {
  if (input.imageId) await lockAndRequireLaunchImageWith(client, input.imageId);
  const res = await client.query<Record<string, unknown>>(INSERT_SQL, [
    input.intentId,
    input.sessionId,
    input.origin,
    input.status,
    input.chainId,
    input.walletAddress,
    input.name,
    input.symbol,
    input.description ?? null,
    jsonb(input.links ?? {}),
    input.imageId ?? null,
    input.prebuyRaw ?? null,
    input.prebuyDecimals ?? null,
    input.authorizationId ?? null,
    input.authorizationKind ?? null,
    // Persisted as-is; the reader validates it (see the type's comment).
    nullableJsonb(input.authorizationJson ?? null),
    input.toolCallId ?? null,
    input.missionRunId ?? null,
    input.expiresAt,
  ]);
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error("token_launch_intents: createWith returned no row");
  }
  return mapRow(row);
}

// ── authorize (CAS, session-scoped) ─────────────────────────────────────────

export interface AuthorizeTokenLaunchInput {
  authorizationId: string;
  authorizationKind: LaunchAuthorizationKind;
  /**
   * The token AS THE USER FINALLY CONFIRMED IT — not as the agent drafted it.
   *
   * These are REQUIRED, and that is the point. The dialog opens an agent's draft
   * with every field editable, and the C0 consent snapshot is built from the
   * submitted values. `execute-user-submit.ts` cross-checks that snapshot
   * against these very columns before signing, so a partial update here is a
   * launch that either REFUSES at the gate (an edited name or symbol) or signs
   * against stale metadata (an edited description or links). Making them
   * optional would reintroduce exactly that drift one forgetful caller later.
   */
  name: string;
  symbol: string;
  description: string | null;
  links: Record<string, unknown>;
  /** REQUIRED: a Vex launch refuses to execute without an image (product rule). */
  imageId: string;
  /** Raw wei. Travels with its decimals, always (rule 90). */
  prebuyRaw: string;
  prebuyDecimals: number;
  /**
   * The `user_submit` consent snapshot, persisted as-is. Same contract as the
   * create path: dumb writer, validating reader (`./types.js`).
   */
  authorizationJson?: unknown;
}

/**
 * `awaiting_user_form → authorized`: the human filled the form and MAIN — never
 * the renderer — reconstructed and persisted the C0 `user_submit` authorization
 * record.
 *
 * `expires_at > NOW()` is part of the predicate, so a click that arrives after
 * the form window lapsed CANNOT authorize a spend. `null` on any miss.
 *
 * EVERY EDITABLE TOKEN FIELD MOVES IN THIS ONE CAS — name, symbol, description,
 * links, image and prebuy. The user may edit any of them in the dialog before
 * clicking Deploy, and the consent snapshot written in the same statement
 * describes those submitted values; leaving the row on the agent's original
 * draft would make the two disagree, which the pre-sign cross-check in
 * `execute-user-submit.ts` treats as tampering and refuses.
 *
 * This is the other write that binds an image to a live intent, so it locks and
 * re-reads the image before the CAS, and throws `LaunchImageMissingError` when
 * the image lost the race, for the reasons `createWith` documents. The throw is
 * deliberately NOT the `null` return: `null` here means "the form window
 * lapsed", and a caller must not read a vanished image as a lapsed form.
 */
export async function authorizeWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  input: AuthorizeTokenLaunchInput,
): Promise<TokenLaunchIntent | null> {
  await lockAndRequireLaunchImageWith(client, input.imageId);
  return casRow(
    client,
    // The new columns are APPENDED at $9.. rather than woven into the existing
    // order, so the parameter-index pins on the fields above keep holding.
    // `origin`, `tool_call_id` and `mission_run_id` are absent by construction:
    // they are how the parked turn is found again, and this statement must not
    // be able to touch them.
    `UPDATE token_launch_intents
        SET status = 'authorized', authorization_id = $3, authorization_kind = $4,
            authorized_at = NOW(), image_id = $5,
            prebuy_raw = $6, prebuy_decimals = $7,
            authorization_json = $8::jsonb,
            name = $9, symbol = $10, description = $11, links = $12::jsonb
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'awaiting_user_form'
        AND expires_at > NOW()
      RETURNING ${SELECT_COLUMNS}`,
    [
      intentId,
      sessionId,
      input.authorizationId,
      input.authorizationKind,
      input.imageId,
      input.prebuyRaw,
      input.prebuyDecimals,
      nullableJsonb(input.authorizationJson ?? null),
      input.name,
      input.symbol,
      input.description,
      // `?? {}` matches `createWith`, and is a JSONB-serializability guard, not
      // a contract loosening: `links` is REQUIRED on the input type, so a typed
      // caller cannot reach it. `jsonb(undefined)` throws by design, and a
      // throw here would refuse an honest launch at the write.
      jsonb(input.links ?? {}),
    ],
  );
}

// ── consume (CAS, session-scoped) ───────────────────────────────────────────

/**
 * `authorized → consuming` — CAS-claim the intent for execution.
 *
 * THIS IS THE EXACTLY-ONCE GATE. A second caller for the same intent gets
 * `null` and MUST NOT sign. A caller that ignores the `null` return signs a
 * launch twice and spends real funds twice; there is no other guard behind it.
 */
export async function consumeIfAuthorizedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'consuming', consumed_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'authorized'
        AND expires_at > NOW()
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

// ── broadcast (CAS, session-scoped) ─────────────────────────────────────────

/**
 * `consuming → broadcast_pending`, persisting the SIGNED hash.
 *
 * `tx_hash IS NULL` is in the predicate so a retry or a duplicate call can never
 * OVERWRITE an already-staged hash — the same discipline `markActivityBroadcast`
 * enforces on `agent_activity`. Losing the first hash would destroy the only
 * evidence of a `create` that may already be mined, and the identity repair
 * would then have nothing to look up.
 */
export async function markBroadcastPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'broadcast_pending', tx_hash = $3, broadcast_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
        AND tx_hash IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash],
  );
}

// ── the §C3b continuation stamp ─────────────────────────────────────────────

/**
 * Stamp the `messages.id` of the tool-result row that answered this intent's
 * parked `trench.launch_request_form` call.
 *
 * THIS IS THE `stamp` CALLBACK for Lane F's `commitUserFormToolResult`, whose
 * signature is `(client, resultMessageId) => Promise<void>`. It runs on THAT
 * transaction — the same one that appends the transcript row — which is the
 * whole point: the tool-result row and this stamp commit together, so "the turn
 * resumed but no tool result exists" is UNREPRESENTABLE. Throwing from here
 * rolls the transcript row back with it, exactly as the approval path behaves.
 *
 * Session-scoped like every other writer, and CAS-guarded on
 * `result_message_id IS NULL` so a double resume cannot re-stamp an intent with
 * a second message id and silently orphan the first tool result. `null` means
 * the stamp did not apply — the caller (Lane F) decides whether that is a lost
 * race to abort on, and MUST NOT treat it as success.
 *
 * Deliberately NOT a status transition. Resuming the agent's turn and settling
 * the launch are different events: the tool result may say "you have the form
 * open", "the user dismissed it" or "it expired", and only the last two also
 * move the status — through `cancelIfAwaitingWith` / `expireIfAwaitingWith`.
 */
export async function stampResultMessageWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  resultMessageId: number,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET result_message_id = $3
      WHERE intent_id = $1
        AND session_id = $2
        AND tool_call_id IS NOT NULL
        AND result_message_id IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, resultMessageId],
  );
}

// ── terminal transitions ────────────────────────────────────────────────────

/**
 * `broadcast_pending → confirmed`, recording the token address decoded from the
 * receipt's `TokenCreated` event.
 *
 * `tokenAddress` is REQUIRED, deliberately. `confirmed` asserts that we know
 * WHICH token now exists; a settled create whose address could not be decoded
 * must stay `broadcast_pending` for the identity repair rather than confirm with
 * a NULL identity nobody can act on. Declining to answer beats guessing.
 */
export async function confirmWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  tokenAddress: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'confirmed', token_address = $3, confirmed_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'broadcast_pending'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, tokenAddress],
  );
}

/**
 * → `terminal_failure` from any live post-form state.
 *
 * Reachable from `authorized` and `consuming` (a PRE-broadcast refusal: no
 * image, the C6 spend ceiling breached, a reverted simulation) and from
 * `broadcast_pending` (a DEFINITIVE mined revert).
 *
 * It is NOT reachable on AMBIGUITY. An unresolved broadcast stays
 * `broadcast_pending` indefinitely rather than being terminalized on a guess,
 * because a launch marked failed is a launch a user may try again — and the
 * first `create` may already have minted their token.
 *
 * `reason` MUST be a structural-only `ErrorKind:errorHash` label. Raw RPC and
 * provider errors carry URLs, request bodies, addresses and auth headers. The
 * database does not enforce the format; the test suite pins it.
 */
export async function failWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'terminal_failure', failure_reason = $3
      WHERE intent_id = $1
        AND session_id = $2
        AND status IN ('authorized', 'consuming', 'broadcast_pending')
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

/**
 * `awaiting_user_form → cancelled` — the user dismissed the dialog.
 *
 * Only from `awaiting_user_form`, so a cancel can never race an in-flight
 * signature: once authorized, the only exits are the terminal ones above. The
 * §C3b continuation resumes the agent's turn with an honest "the user
 * dismissed it" tool result rather than hanging.
 */
export async function cancelIfAwaitingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'cancelled', cancelled_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'awaiting_user_form'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

/**
 * `awaiting_user_form → expired` — the form window lapsed.
 *
 * `expires_at <= NOW()` is in the predicate so this can only ever record an
 * expiry that actually happened; it is not a back door for cancelling a live
 * form. Same one-way discipline as cancel.
 */
export async function expireIfAwaitingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<TokenLaunchIntent | null> {
  return casRow(
    client,
    `UPDATE token_launch_intents
        SET status = 'expired'
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'awaiting_user_form'
        AND expires_at <= NOW()
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}
