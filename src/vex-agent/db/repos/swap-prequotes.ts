/**
 * Swap prequotes repo — durable swap-quote safety preview store (Stage 6c)
 * read by the Stage-7 execute gate.
 *
 * Every successful swap QUOTE records one row here capturing the token-safety
 * verdict computed at quote time, keyed by a deterministic match-hash over the
 * trade identity (see `src/vex-agent/tools/protocols/swap-prequote.ts` for the
 * hash + verdict computation and the gate). The Stage-7 gate reads two of the
 * three reads below before a swap EXECUTE: `existsFreshFailByMatch` (any fresh
 * `fail` → block) then `findLatestFreshByMatch` (no fresh row → block; else the
 * verdict authorizes — `pass`/`unknown` allow, a `fail` latest row is a
 * belt-and-suspenders block). All reads are session- AND kind-scoped so a
 * cross-session row or a `bridge` prequote can never authorize/block a `swap`.
 *
 * Migration: `src/vex-agent/db/migrations/029_swap_prequotes.sql`.
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
//
// R5d adds the seven kinds below (DB CHECK widened by migration 054). Each is a
// SEPARATE kind rather than a reuse of an existing one because `kind` is what the
// two gate reads scope on: a kind shared between two actions lets one action's
// prequote authorize the other's execute even when the material differs, and a
// kind shared with `swap` lets an ordinary DEX quote authorize a Pendle write.
//   - 'sy_mint' / 'sy_redeem'   : the SY wrap/unwrap pair. They were BOTH stored
//     under 'swap' before this migration (`handlers/sy-prequote.ts` said so in a
//     comment: "no migration"), which is exactly the shortcut described above.
//   - 'lp_remove_dual'          : LP → (token, PT). Not 'lp_remove' — two output
//     legs, a different price floor, a different execute surface.
//   - 'lp_add_keep_yt'          : token → (LP, YT). Not 'lp_add', same reason.
//   - 'pt_rollover'             : PT(marketA) → PT(marketB).
//   - 'lp_transfer'             : LP(marketA) → LP(marketB).
//   - 'lp_to_pt'                : LP → PT.
//
// E3b-2 adds the two Morpho vault lend directions (DB CHECK widened by migration
// 080). Same rule: `swap` is not reusable (an ordinary DEX quote would authorize
// a protocol write), and the two DIRECTIONS get one kind each, exactly as
// 'lp_add' / 'lp_remove' do, so a deposit quote can never authorize a withdraw
// execute when the rest of the material agrees.
//   - 'lend_deposit'  : Morpho vault supply   (asset -> vault shares).
//   - 'lend_withdraw' : Morpho vault withdraw (vault shares -> asset).
// The names match the `event_role` vocabulary migration 079 uses on the
// `agent_activity` `lend` arm.
//
// The TS union and the SQL CHECK are held in lockstep by
// `__tests__/vex-agent/db/repos/swap-prequotes-kind-lockstep.test.ts`.
export type PrequoteKind =
  | "swap"
  | "bridge"
  | "redeem"
  | "mint"
  | "redeem_py"
  | "lp_add"
  | "lp_remove"
  | "sy_mint"
  | "sy_redeem"
  | "lp_remove_dual"
  | "lp_add_keep_yt"
  | "pt_rollover"
  | "lp_transfer"
  | "lp_to_pt"
  | "lend_deposit"
  | "lend_withdraw";
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
  "safety_verdict, safety_detail, route_ref, created_at, expires_at";

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
 * Newest non-expired prequote row for a (session, match_hash, kind). Returns
 * `null` when no fresh row exists (including cross-session: a row recorded under
 * a different session never matches; and cross-kind: a `bridge` row never
 * authorizes a `swap`). Freshness is `expires_at > NOW()` — an expired row is
 * invisible.
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
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, matchHash, kind],
  );
  return row ? mapRow(row) : null;
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
