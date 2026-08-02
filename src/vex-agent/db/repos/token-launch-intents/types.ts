/**
 * Token-launch intents — row shape, domain types, and the row→domain mapper
 * (migration `062_trench_launch.sql`).
 *
 * Pure shape only: no state-machine policy (that lives in `./writers.js`) and no
 * queries (`./reads.js`). Extracted from the parent `../token-launch-intents.js`
 * facade, which keeps its name and its public entry point so no caller's import
 * changes; see that file for the C1 contract this shape serves.
 */

import type { PoolClient } from "pg";

export type TokenLaunchIntentOrigin = "user" | "agent_requested_form" | "agent";

export type TokenLaunchIntentStatus =
  | "awaiting_user_form"
  | "authorized"
  | "consuming"
  | "broadcast_pending"
  | "confirmed"
  | "terminal_failure"
  | "cancelled"
  | "expired";

/**
 * Which C0 authorization variant authorized this launch.
 *
 * `full_autonomy` is deliberately NOT called consent anywhere in this codebase:
 * it is trusted host/engine evidence that a mission was permitted to spend, and
 * no human acted. Naming it consent would misdescribe the audit record.
 */
export type LaunchAuthorizationKind = "user_submit" | "approval_card" | "full_autonomy";

/**
 * The statuses that still hold LIVE money state — an intent that may yet sign,
 * or one that has signed and not settled.
 *
 * Consumed by the image-locker delete refusal (C2: an image may not be deleted
 * while a live intent references it) and by anything asking "is this session
 * mid-launch?". Kept here rather than inlined at each call site so the two
 * cannot drift into disagreeing about what "live" means.
 */
export const LIVE_TOKEN_LAUNCH_INTENT_STATUSES: readonly TokenLaunchIntentStatus[] = [
  "awaiting_user_form",
  "authorized",
  "consuming",
  "broadcast_pending",
];

export interface TokenLaunchIntent {
  intentId: string;
  sessionId: string;
  origin: TokenLaunchIntentOrigin;
  status: TokenLaunchIntentStatus;
  chainId: number;
  walletAddress: string;
  name: string;
  symbol: string;
  description: string | null;
  links: Record<string, unknown>;
  imageId: string | null;
  /** Raw wei. Always read WITH `prebuyDecimals` — a bare raw amount is unreadable (rule 90). */
  prebuyRaw: string | null;
  prebuyDecimals: number | null;
  authorizationId: string | null;
  authorizationKind: LaunchAuthorizationKind | null;
  authorizedAt: string | null;
  /**
   * The §C3b continuation's durable anchors — set only on the
   * `agent_requested_form` path, the ONE path where an agent's turn is parked.
   * A `user`-origin launch resumes nothing; an `agent` (Path 2) launch never
   * parked. `toolCallId` is the id of the ORIGINAL parked
   * `trench.launch_request_form` call, without which a resumed tool result
   * answers no pending call.
   */
  toolCallId: string | null;
  missionRunId: string | null;
  /** `messages.id` of the appended tool-result row — stamped in the SAME transaction as that row. */
  resultMessageId: number | null;
  txHash: string | null;
  tokenAddress: string | null;
  failureReason: string | null;
  expiresAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface CreateTokenLaunchIntentInput {
  intentId: string;
  sessionId: string;
  origin: TokenLaunchIntentOrigin;
  /**
   * The path's ENTRY state — `awaiting_user_form` when a human still has to fill
   * the form, `authorized` when the C0 record IS the entry (Path 2 full autonomy
   * and the restricted approval path). Deliberately explicit and deliberately
   * narrowed to those two: defaulting it would make one of the two paths
   * silently wrong, and every other status must be reached by a CAS transition.
   */
  status: Extract<TokenLaunchIntentStatus, "awaiting_user_form" | "authorized">;
  chainId: number;
  walletAddress: string;
  name: string;
  symbol: string;
  description?: string | null;
  links?: Record<string, unknown>;
  imageId?: string | null;
  prebuyRaw?: string | null;
  prebuyDecimals?: number | null;
  authorizationId?: string | null;
  authorizationKind?: LaunchAuthorizationKind | null;
  /**
   * REQUIRED on the `agent_requested_form` path and forbidden nowhere else —
   * the DB CHECK `token_launch_intents_form_path_has_tool_call` enforces it.
   * Optional in the type because the other two origins genuinely have no parked
   * call to name.
   */
  toolCallId?: string | null;
  missionRunId?: string | null;
  /**
   * The whole pre-authorization window AND the §C3b continuation's expiry — one
   * timestamp, deliberately. Two could only ever disagree, and a continuation
   * that expires at a different moment from the form it resumes is how a turn
   * hangs or resumes against a form the user can still submit.
   */
  expiresAt: string;
}

// ── ISO normalisation (TIMESTAMPTZ → Date; mirrors the wallet-intents repo) ──

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/**
 * `null` stays `null`; anything else becomes a number.
 *
 * NOT truthiness: `0` decimals is a real, valid answer and must survive. node-pg
 * returns SMALLINT as a number and BIGINT as a string, so both are normalised
 * through one place.
 */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Every column of the table, in declaration order. The ONE list both writers and reads select. */
export const SELECT_COLUMNS =
  "intent_id, session_id, origin, status, chain_id, wallet_address, " +
  "name, symbol, description, links, image_id, prebuy_raw, prebuy_decimals, " +
  "authorization_id, authorization_kind, authorized_at, " +
  "tool_call_id, mission_run_id, result_message_id, tx_hash, token_address, " +
  "failure_reason, expires_at, consumed_at, cancelled_at, broadcast_at, " +
  "confirmed_at, created_at";

export function mapRow(r: Record<string, unknown>): TokenLaunchIntent {
  return {
    intentId: r.intent_id as string,
    sessionId: r.session_id as string,
    origin: r.origin as TokenLaunchIntentOrigin,
    status: r.status as TokenLaunchIntentStatus,
    chainId: Number(r.chain_id),
    walletAddress: r.wallet_address as string,
    name: r.name as string,
    symbol: r.symbol as string,
    description: (r.description as string | null) ?? null,
    links: (r.links as Record<string, unknown>) ?? {},
    imageId: (r.image_id as string | null) ?? null,
    prebuyRaw: (r.prebuy_raw as string | null) ?? null,
    prebuyDecimals: nullableInt(r.prebuy_decimals),
    authorizationId: (r.authorization_id as string | null) ?? null,
    authorizationKind: (r.authorization_kind as LaunchAuthorizationKind | null) ?? null,
    authorizedAt: toIsoOrNull(r.authorized_at as string | Date | null),
    toolCallId: (r.tool_call_id as string | null) ?? null,
    missionRunId: (r.mission_run_id as string | null) ?? null,
    resultMessageId: nullableInt(r.result_message_id),
    txHash: (r.tx_hash as string | null) ?? null,
    tokenAddress: (r.token_address as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? null,
    expiresAt: toIso(r.expires_at as string | Date),
    consumedAt: toIsoOrNull(r.consumed_at as string | Date | null),
    cancelledAt: toIsoOrNull(r.cancelled_at as string | Date | null),
    broadcastAt: toIsoOrNull(r.broadcast_at as string | Date | null),
    confirmedAt: toIsoOrNull(r.confirmed_at as string | Date | null),
    createdAt: toIso(r.created_at as string | Date),
  };
}

/**
 * Run one CAS `UPDATE … RETURNING` on the caller's transaction and map the row.
 *
 * `null` means the predicate MISSED — a hard "race lost" signal, never a silent
 * success. Callers MUST gate on it; for `consumeIfAuthorizedWith` in particular,
 * ignoring `null` would mean signing a launch twice.
 */
export async function casRow(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<TokenLaunchIntent | null> {
  const res = await client.query<Record<string, unknown>>(sql, [...params]);
  const row = res.rows[0];
  return row === undefined ? null : mapRow(row);
}
