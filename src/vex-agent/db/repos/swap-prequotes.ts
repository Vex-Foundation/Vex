/**
 * Swap prequotes repo — durable swap-quote safety preview store (Stage 6c)
 * read by the Stage-7 execute gate.
 *
 * Every successful swap QUOTE records one row here capturing the token-safety
 * verdict computed at quote time, keyed by a deterministic match-hash over the
 * trade identity (see `src/vex-agent/tools/protocols/swap-prequote.ts` for the
 * hash + verdict computation and the gate). The Stage-7 gate reads two of the
 * three reads below before a swap EXECUTE: `existsFreshFailByMatch` (any fresh
 * `fail` → block) then `findLatestFreshByMatch` (no fresh *unconsumed* row →
 * block; else the verdict authorizes — `pass`/`unknown` allow, a `fail` latest
 * row is a belt-and-suspenders block). A successful gated execute CAS-consumes
 * the matched row (`consumeIfUnconsumed`) so one quote cannot authorize N
 * broadcasts. All reads are session- AND kind-scoped so a cross-session row or
 * a `bridge` prequote can never authorize/block a `swap`.
 *
 * Migrations: `029_swap_prequotes.sql`, `044_swap_prequotes_consumed_at.sql`.
 *
 * **Session ownership invariant** (mirrors wallet-intents): every lookup
 * includes `session_id` in the predicate — a read from a different session
 * must miss even when the `match_hash` is known. Tests pin the cross-session
 * miss.
 *
 * **Data-exposure invariant**: `safetyDetail` / `routeRef` carry ONLY bounded,
 * structural fields. Raw provider/HTTP/error text NEVER reaches these columns
 * (the recorder is responsible for building structural-only payloads).
 */

import { execute, queryOne } from "../client.js";
import { jsonb } from "../params.js";

export type PrequoteFamily = "eip155" | "solana";
// 'mint' / 'redeem_py' land with the Pendle PY surface (P4); 'lp_add' / 'lp_remove'
// with the LP surface (P5). All widen the DB CHECK via migration 035.
export type PrequoteKind =
  | "swap"
  | "bridge"
  | "redeem"
  | "mint"
  | "redeem_py"
  | "lp_add"
  | "lp_remove";
export type SafetyVerdict = "pass" | "fail" | "unknown";

export interface SwapPrequote {
  prequoteId: string;
  sessionId: string;
  matchHash: string;
  kind: PrequoteKind;
  family: PrequoteFamily;
  provider: string;
  chainId: number | null;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  slippageBps: number | null;
  safetyVerdict: SafetyVerdict;
  safetyDetail: Record<string, unknown>;
  routeRef: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  /** Set when a gated execute successfully consumed this ticket; null while reusable. */
  consumedAt: string | null;
}

export interface CreatePrequoteInput {
  prequoteId: string;
  sessionId: string;
  matchHash: string;
  kind: PrequoteKind;
  family: PrequoteFamily;
  provider: string;
  chainId: number | null;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  slippageBps: number | null;
  safetyVerdict: SafetyVerdict;
  /**
   * Structural-only safety block. MUST be a JSON object (DB CHECK
   * `jsonb_typeof = 'object'`). The recorder is responsible for building a
   * bounded payload — raw provider/HTTP/error text never reaches this field.
   */
  safetyDetail: Record<string, unknown>;
  /** Structural-only route reference, or null. */
  routeRef?: Record<string, unknown> | null;
  expiresAt: string;
}

// ── ISO normalisation (TIMESTAMPTZ → Date, see wallet-intents repo) ──

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const SELECT_COLUMNS =
  "prequote_id, session_id, match_hash, kind, family, provider, " +
  "chain_id, wallet_address, token_in, token_out, amount, slippage_bps, " +
  "safety_verdict, safety_detail, route_ref, created_at, expires_at, consumed_at";

function mapRow(r: Record<string, unknown>): SwapPrequote {
  return {
    prequoteId: r.prequote_id as string,
    sessionId: r.session_id as string,
    matchHash: r.match_hash as string,
    kind: r.kind as PrequoteKind,
    family: r.family as PrequoteFamily,
    provider: r.provider as string,
    // BIGINT comes back from node-postgres as a string; normalise to number.
    chainId: r.chain_id === null || r.chain_id === undefined ? null : Number(r.chain_id),
    walletAddress: r.wallet_address as string,
    tokenIn: r.token_in as string,
    tokenOut: r.token_out as string,
    amount: r.amount as string,
    slippageBps:
      r.slippage_bps === null || r.slippage_bps === undefined
        ? null
        : Number(r.slippage_bps),
    safetyVerdict: r.safety_verdict as SafetyVerdict,
    safetyDetail: (r.safety_detail as Record<string, unknown>) ?? {},
    routeRef: (r.route_ref as Record<string, unknown> | null) ?? null,
    createdAt: toIso(r.created_at as string | Date),
    expiresAt: toIso(r.expires_at as string | Date),
    consumedAt:
      r.consumed_at === null || r.consumed_at === undefined
        ? null
        : toIso(r.consumed_at as string | Date),
  };
}

// ── create ──────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO swap_prequotes (
  prequote_id, session_id, match_hash, kind, family, provider,
  chain_id, wallet_address, token_in, token_out, amount, slippage_bps,
  safety_verdict, safety_detail, route_ref, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16)`;

export async function create(input: CreatePrequoteInput): Promise<void> {
  await execute(INSERT_SQL, [
    input.prequoteId,
    input.sessionId,
    input.matchHash,
    input.kind,
    input.family,
    input.provider,
    input.chainId,
    input.walletAddress,
    input.tokenIn,
    input.tokenOut,
    input.amount,
    input.slippageBps,
    input.safetyVerdict,
    jsonb(input.safetyDetail),
    input.routeRef === null || input.routeRef === undefined
      ? null
      : jsonb(input.routeRef),
    input.expiresAt,
  ]);
}

// ── findLatestFreshByMatch (session + kind-scoped) ──────────────────────

/**
 * Newest non-expired, **unconsumed** prequote row for a (session, match_hash,
 * kind). Returns `null` when no usable row exists (including cross-session: a
 * row recorded under a different session never matches; cross-kind: a `bridge`
 * row never authorizes a `swap`; and already-consumed: a successful execute
 * burned the ticket). Freshness is `expires_at > NOW() AND consumed_at IS NULL`.
 *
 * The Stage-7 gate calls this with `kind = "swap"` AFTER `existsFreshFailByMatch`
 * has ruled out any fresh `fail` row, then inspects the returned `safetyVerdict`
 * (`pass` / `unknown` both authorize; `fail` is a belt-and-suspenders block —
 * see the gate's guardrail #1). The `kind` predicate keeps a future `bridge`
 * prequote from ever authorizing or blocking a `swap` (Stage 7 R1).
 */
export async function findLatestFreshByMatch(
  sessionId: string,
  matchHash: string,
  kind: PrequoteKind,
): Promise<SwapPrequote | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM swap_prequotes
      WHERE session_id = $1
        AND match_hash = $2
        AND kind = $3
        AND expires_at > NOW()
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, matchHash, kind],
  );
  return row ? mapRow(row) : null;
}

// ── consumeIfUnconsumed (CAS, session-scoped) ───────────────────────────

/**
 * Mark a prequote consumed after a successful gated broadcast. Session-scoped
 * CAS: only the owning session can burn the ticket, and only if it is still
 * unconsumed. Returns true when this caller won the consume; false when the
 * row was already consumed, missing, or belongs to another session.
 *
 * Call ONLY after `result.success` on a gated execute — never at gate-allow
 * time (restricted mode would burn the ticket before the human approves).
 */
export async function consumeIfUnconsumed(
  prequoteId: string,
  sessionId: string,
): Promise<boolean> {
  const n = await execute(
    `UPDATE swap_prequotes
        SET consumed_at = NOW()
      WHERE prequote_id = $1
        AND session_id = $2
        AND consumed_at IS NULL`,
    [prequoteId, sessionId],
  );
  return n > 0;
}

// ── existsFreshFailByMatch (session + kind-scoped) ──────────────────────

/**
 * True when ANY fresh `fail`-verdict prequote exists for a (session, match_hash,
 * kind). The Stage-7 gate calls this FIRST (before `findLatestFreshByMatch`) so a
 * confirmed-scam quote can NEVER be authorized even if a later `pass`/`unknown`
 * row exists for the identical identity (gate guardrail #1: a fresh `fail`
 * dominates the latest row). Freshness + session + kind scoping mirror
 * `findLatestFreshByMatch`. Returns a boolean only — never leaks row contents.
 */
export async function existsFreshFailByMatch(
  sessionId: string,
  matchHash: string,
  kind: PrequoteKind,
): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT 1 FROM swap_prequotes
      WHERE session_id = $1
        AND match_hash = $2
        AND kind = $3
        AND safety_verdict = 'fail'
        AND expires_at > NOW()
      LIMIT 1`,
    [sessionId, matchHash, kind],
  );
  return row !== null;
}
