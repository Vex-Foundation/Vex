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
// E3c adds the four Morpho Blue BORROW-lane operations (DB CHECK widened by
// migration 081). ONE KIND PER OPERATION, not one shared borrow kind: the four
// run against the same market id and the same wallet, and two of them can carry
// the same raw amount, so a shared kind would let a collateral-supply quote
// authorize a BORROW execute. Same reasoning as 054's lp_add/lp_remove split
// and 080's lend_deposit/lend_withdraw split.
//   - 'lend_supply_collateral'   : collateral token -> market position.
//   - 'lend_withdraw_collateral' : market position -> collateral token.
//   - 'lend_borrow'              : loan token drawn as debt.
//   - 'lend_repay'               : loan token returned against debt.
// There is NO authorization kind: the borrow leg calls Morpho Blue directly
// with `msg.sender == onBehalf`, so no `setAuthorization` is ever granted. All
// four report under the EXISTING 'lend_borrow_operate' `event_role`; the gate
// needs per-operation resolution, the ledger reads the lane as one activity.
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
  | "lend_withdraw"
  | "lend_supply_collateral"
  | "lend_withdraw_collateral"
  | "lend_borrow"
  | "lend_repay";
export type SafetyVerdict = "pass" | "fail" | "unknown";

/**
 * The closed quote-eligibility union, mirrored from
 * `tools/protocols/quote-authority/eligibility.ts`. Only `executable` may be
 * claimed by an execute; the other seven are the REASONS a quote authorized
 * nothing, recorded so a later ineligible quote still supersedes an older
 * priced one for the same identity.
 *
 * The last three are SPENDABILITY reasons (WP2, contract C2): the wallet could
 * not pay the principal, a balance could not be read at all, or the native
 * balance did not cover the swap's full fee debit. `balance_unavailable` is
 * deliberately its own member and is never merged into `insufficient_balance` -
 * an unreadable balance and a known shortfall are different facts with
 * different remedies.
 *
 * Held in lockstep with the SQL CHECK (migration 095, widened by 097) by
 * `__tests__/vex-agent/db/repos/swap-prequotes-kind-lockstep.test.ts`.
 */
export type PrequoteEligibilityKind =
  | "executable"
  | "unpriceable_output"
  | "excessive_impact"
  | "oversize_snapshot"
  | "provider_usd_invalid"
  | "insufficient_balance"
  | "balance_unavailable"
  | "gas_reserve_insufficient";

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
  eligibilityKind: PrequoteEligibilityKind;
  /** Set once by the atomic claim; `null` while the quote is still unclaimed. */
  claimedAt: string | null;
  /** The execute correlation that won the claim, paired with `claimedAt`. */
  claimedBy: string | null;
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
  /**
   * Whether this quote may authorize an execute. Defaults to `"executable"` for
   * the providers that record no snapshot, whose executes are gated on safety
   * alone and never take the claim path.
   */
  eligibilityKind?: PrequoteEligibilityKind;
  expiresAt: string;
}

// ── ISO normalisation (TIMESTAMPTZ → Date, see wallet-intents repo) ──

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const SELECT_COLUMNS =
  "prequote_id, session_id, match_hash, kind, family, provider, " +
  "chain_id, wallet_address, token_in, token_out, amount, slippage_bps, " +
  "safety_verdict, safety_detail, route_ref, eligibility_kind, " +
  "claimed_at, claimed_by, created_at, expires_at";

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
    eligibilityKind: (r.eligibility_kind as PrequoteEligibilityKind | null) ?? "executable",
    claimedAt: r.claimed_at === null || r.claimed_at === undefined ? null : toIso(r.claimed_at as string | Date),
    claimedBy: (r.claimed_by as string | null) ?? null,
    createdAt: toIso(r.created_at as string | Date),
    expiresAt: toIso(r.expires_at as string | Date),
  };
}

// ── create ──────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO swap_prequotes (
  prequote_id, session_id, match_hash, kind, family, provider,
  chain_id, wallet_address, token_in, token_out, amount, slippage_bps,
  safety_verdict, safety_detail, route_ref, eligibility_kind, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17)`;

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
    input.eligibilityKind ?? "executable",
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
 * Ordering is `(created_at, prequote_id)` DESC, the SAME total order the claim's
 * supersession clause uses. It has to be: this read is what the approval card
 * describes, and if it named a different row than the claim considers current,
 * the human would consent to one quote while the execute bound another whenever
 * two rows share a clock tick.
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
      ORDER BY created_at DESC, prequote_id DESC
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

// ── findLatestExecutableByMatch ─────────────────────────────────────────

/**
 * Newest non-expired, UNCLAIMED, `executable` row for a (session, match_hash,
 * kind) - the candidate an execute attempts to claim.
 *
 * This read deliberately does NOT check supersession: the claim's own predicate
 * owns that, atomically. Selecting the newest executable row here and letting
 * the claim refuse it is what makes "a later ineligible Q2 retires an earlier
 * priced Q1" observable as a typed `superseded` refusal rather than as a
 * silently missing row.
 */
export async function findLatestExecutableByMatch(
  sessionId: string,
  matchHash: string,
  kind: PrequoteKind,
): Promise<SwapPrequote | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM swap_prequotes
      WHERE session_id = $1
        AND match_hash = $2
        AND kind = $3
        AND eligibility_kind = 'executable'
        AND claimed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC, prequote_id DESC
      LIMIT 1`,
    [sessionId, matchHash, kind],
  );
  return row ? mapRow(row) : null;
}

// ── read, then claim (atomic, single-use) ────────────────────

/**
 * The claimable predicate, shared by the non-destructive read, the claim and
 * the diagnosis below so the three can never disagree about what "claimable"
 * means.
 *
 * `NOT EXISTS (newer row for this identity)` is the supersession clause: a
 * later quote for the same (session, match_hash, kind) makes every earlier one
 * unclaimable the moment it is written, whatever the later quote's own
 * eligibility says. Ordering is `(created_at, prequote_id)` so two rows in one
 * clock tick still have exactly one newest.
 */
const CLAIMABLE_PREDICATE = `
    p.claimed_at IS NULL
    AND p.expires_at > NOW()
    AND p.eligibility_kind = 'executable'
    AND NOT EXISTS (
      SELECT 1 FROM swap_prequotes AS newer
       WHERE newer.session_id = p.session_id
         AND newer.match_hash = p.match_hash
         AND newer.kind = p.kind
         AND (newer.created_at, newer.prequote_id) > (p.created_at, p.prequote_id)
    )`;

/**
 * The exact row a claim would consume, read WITHOUT consuming it.
 *
 * This exists because of the ordering the money path requires (Codex round-2
 * blocker 1): an executor must be able to re-derive its fee statement and its
 * router input against the row that authorizes the fill, and REFUSE, before the
 * row is spent. Claiming first turned every divergence into a burnt quote - the
 * refusal was correct and the retry got `already_claimed`.
 *
 * It applies the SAME predicate the claim applies, so a row this read returns is
 * a row the claim would have taken at that instant. It is deliberately NOT
 * authority: the claim re-evaluates the predicate atomically, and between the
 * two statements a concurrent execute or a newer quote can still take the row
 * away. That is a typed refusal, not a fill.
 *
 * Identity is asserted, never assumed: `matchHash` and `kind` are what tie a
 * stored id to the trade the params describe, so a bound id belonging to another
 * trade reads as `null` here exactly as it claims nothing below.
 */
export async function findClaimableForExecute(
  sessionId: string,
  prequoteId: string,
  matchHash: string,
  kind: PrequoteKind,
): Promise<SwapPrequote | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM swap_prequotes AS p
      WHERE p.prequote_id = $1
        AND p.session_id = $2
        AND p.match_hash = $3
        AND p.kind = $4
        AND ${CLAIMABLE_PREDICATE}`,
    [prequoteId, sessionId, matchHash, kind],
  );
  return row ? mapRow(row) : null;
}

/**
 * Consume ONE named prequote row for exactly one execute, after its caller has
 * already compared everything the row disclosed against what this execution
 * would actually do.
 *
 * ONE statement, so the read of the claimable predicate and the write of the
 * claim cannot be separated by another caller: Postgres serializes concurrent
 * updates of the same row, and the loser re-evaluates the predicate against the
 * committed claim and matches zero rows. Exactly one caller ever receives a
 * row.
 *
 * FOUR things are asserted, and each closes a different substitution:
 *
 *   `prequote_id` + `session_id` - the row the caller read and compared, owned
 *      by the session that quoted it.
 *   `match_hash` + `kind`        - the TRADE that row authorizes. A bound id
 *      belonging to another trade matches zero rows and consumes nothing.
 *   `CLAIMABLE_PREDICATE`        - still unclaimed, unexpired, executable and
 *      current (a quote recorded while the human decided supersedes it).
 *   `safety_detail`              - THE DISCLOSURE FENCE. The caller compared the
 *      fee statement, the spendability plan and the safety detail this row
 *      carried; this makes the claim itself conditional on that block still
 *      being byte-equal, so a row rewritten between the read and the claim
 *      matches zero rows and is diagnosed `disclosure_changed` rather than
 *      claimed silently. Postgres `jsonb` equality is canonical (key order and
 *      whitespace are normalised at write time), so passing the block read back
 *      IS the digest comparison, with no second column to keep in step.
 *
 * Returns `null` when the row was not claimable for ANY reason. The caller asks
 * `diagnoseUnclaimable` for the reason - deliberately a second, non-atomic read,
 * because it feeds a refusal message only and must never decide anything.
 *
 * `claimedBy` is the caller's correlation for the audit trail; it is stored on
 * the row and never used to decide anything.
 */
export async function claimVerifiedRowForExecute(input: {
  readonly sessionId: string;
  readonly prequoteId: string;
  readonly matchHash: string;
  readonly kind: PrequoteKind;
  /** The `safetyDetail` block the caller read and compared against. */
  readonly expectedDisclosure: Record<string, unknown>;
  readonly claimedBy: string;
}): Promise<SwapPrequote | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE swap_prequotes AS p
        SET claimed_at = NOW(), claimed_by = $6
      WHERE p.prequote_id = $1
        AND p.session_id = $2
        AND p.match_hash = $3
        AND p.kind = $4
        AND p.safety_detail = $5::jsonb
        AND ${CLAIMABLE_PREDICATE}
      RETURNING ${SELECT_COLUMNS}`,
    [
      input.prequoteId,
      input.sessionId,
      input.matchHash,
      input.kind,
      jsonb(input.expectedDisclosure),
      input.claimedBy,
    ],
  );
  return row ? mapRow(row) : null;
}

/** Why a claim found no row. Ordered most-specific-first by the query below. */
export type UnclaimableReason =
  | "missing"
  | "already_claimed"
  | "expired"
  | "not_executable"
  | "superseded"
  | "disclosure_changed";

/**
 * Explain a failed claim for the agent-facing refusal. Read-only and
 * advisory: the claim itself already decided, and a state that changed between
 * the two statements can only make this message less specific, never let an
 * unclaimed row through.
 *
 * `expectedDisclosure` is the block the caller compared against, so a claim that
 * missed on the disclosure fence alone is reported as what it is rather than as
 * the conservative `superseded`.
 */
export async function diagnoseUnclaimable(
  sessionId: string,
  prequoteId: string,
  expectedDisclosure: Record<string, unknown>,
): Promise<UnclaimableReason> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
        (p.claimed_at IS NOT NULL)              AS claimed,
        (p.expires_at <= NOW())                 AS expired,
        (p.eligibility_kind <> 'executable')    AS ineligible,
        EXISTS (
          SELECT 1 FROM swap_prequotes AS newer
           WHERE newer.session_id = p.session_id
             AND newer.match_hash = p.match_hash
             AND newer.kind = p.kind
             AND (newer.created_at, newer.prequote_id) > (p.created_at, p.prequote_id)
        )                                       AS superseded,
        (p.safety_detail IS DISTINCT FROM $3::jsonb) AS disclosure_changed
       FROM swap_prequotes AS p
      WHERE p.prequote_id = $1 AND p.session_id = $2`,
    [prequoteId, sessionId, jsonb(expectedDisclosure)],
  );
  if (row === null) return "missing";
  if (row.claimed === true) return "already_claimed";
  if (row.expired === true) return "expired";
  if (row.ineligible === true) return "not_executable";
  if (row.superseded === true) return "superseded";
  if (row.disclosure_changed === true) return "disclosure_changed";
  // The claim's own predicate and this read disagree only when the row became
  // claimable again between the two statements, which nothing does. Report the
  // conservative reason rather than inventing a seventh state.
  return "superseded";
}
