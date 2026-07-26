/**
 * Moves DB helper — read-only per-session executed-trade activity (move 0.3;
 * Agent Scan plan §4.7/§11.1 added the `agent_activity` half).
 *
 * Mirrors `portfolio-db.ts`: own `pg.Client` per call, no
 * `@vex-agent/db/repos/*` import. Reads the same local `vex` Postgres the
 * engine writes to. Two sources, UNIONed:
 *
 *   proj_activity(id SERIAL, wallet_address TEXT, trade_side TEXT,
 *                 product_type TEXT, namespace TEXT,
 *                 input_token TEXT, input_amount TEXT, output_token TEXT,
 *                 output_amount TEXT, value_usd NUMERIC, capture_status TEXT,
 *                 instrument_key TEXT, created_at TIMESTAMPTZ, ...)
 *   agent_activity(id BIGSERIAL, wallet_address TEXT, session_id TEXT,
 *                 event_role TEXT, protocol TEXT, chain_id BIGINT,
 *                 chain_slug TEXT, status TEXT, failure_code TEXT,
 *                 token_in/out_address/symbol TEXT,
 *                 token_in/out_decimals SMALLINT, amount_in/out_human TEXT
 *                 (requested, quote-time), executed_amount_in/out_raw TEXT
 *                 (executed, base-unit — human computed HERE, see below),
 *                 usd_in/out_est NUMERIC, tx_hash TEXT, created_at
 *                 TIMESTAMPTZ, ...)
 *
 * `proj_activity` is success-only BY CONSTRUCTION (the engine writes an
 * activity row only after a capture succeeds), so there is NO `success = true`
 * predicate. `agent_activity` is append-mostly PER-ATTEMPT (the new-format
 * EVM swap truth store, `src/vex-agent/db/repos/transactions.ts` — read-only
 * reference, root `src/`, NOT imported): it carries `pending` /`confirmed` /
 * `definitively_failed` rows, so — unlike `proj_activity` — failed and
 * still-pending attempts are ALSO surfaced here (mapped to the DTO's
 * `status: "pending" | "confirmed" | "failed"`), each with its
 * `failureCode` and a chain+txHash pair the renderer resolves to an
 * explorer link via the existing `explorerTxUrl` (unchanged — the derived
 * `chain` column already carries what that helper expects). ONLY the
 * `event_role = 'swap'` row of an execution is surfaced for `kind = 'swap'` —
 * the `allowance_reset`/`allowance` rows are approval plumbing with no
 * meaningful IN→OUT legs and would read as a confusing "trade" if shown.
 * `kind = 'lend'`/`'prediction'` rows (migration 049, W5 — Jupiter Lend
 * deposit/withdraw, Jupiter Perp prediction buy/sell/claim/close) have no
 * such sub-events — Solana carries no allowance legs — so EVERY row of those
 * kinds is its own move, mapped to `productType: "lend"` / `"prediction"`.
 *
 * DEDUPE (mirrors the engine feed's semantics): the two sources cannot
 * naturally overlap by construction — the unified `kyberswap.swap.execute` /
 * `uniswap.swap.execute` handlers have `capture: "none"` in the mutation
 * matrix, so a NEW execution is written to EXACTLY ONE of the two tables,
 * never both. The `proj_activity` half still carries a defensive
 * `NOT EXISTS (agent_activity WHERE protocol_execution_id = …)` guard (the
 * same belt-and-suspenders posture `db/repos/transactions.ts` uses for its
 * failure half) so a future capture-matrix change can never silently
 * double-surface one execution under both sources.
 *
 * AMOUNT HONESTY (Codex final-review round 1 finding 5 / contract C20): a
 * `confirmed` agent_activity row NEVER displays the quote-time REQUESTED
 * amount as if it were settlement — the repair-sweep decoders intentionally
 * return only raw executed amounts (no human string), so a naive
 * `COALESCE(executed_human, requested_human)` would silently show the wrong
 * value for any row confirmed via repair. `resolveAgentActivityAmount`
 * (`./agent-activity-amount.js`, shared with `token-history-db.ts`) picks
 * the one honest value per status for a PLAIN SWAP: `confirmed` → computed
 * from `executed_amount_*_raw` + `token_*_decimals` (BigInt-safe, via
 * `viem`'s `formatUnits` — never `Number` on a wei-scale string); `pending` →
 * the requested echo (nothing has settled yet); anything else (`failed`) →
 * none. BRIDGE rows (Q2) and W5 `lend`/`prediction` rows (design REVISION 1
 * R3/R5) instead use `resolveAmountWithEstimateBasis`, which additionally
 * falls back to the quoted amount labelled `amountBasis: "estimated"` for a
 * confirmed-but-undecoded row, rather than going blank — see that function's
 * own doc comment for why plain swaps do not need this fallback.
 *
 * STRICT PER-SESSION attribution differs by source (no execution_id/session
 * join needed for the new half — `agent_activity` carries both columns
 * directly):
 *  - proj_activity: the read INNER JOINs `protocol_executions` on
 *    `proj_activity.execution_id = protocol_executions.id` and filters
 *    `protocol_executions.session_id = $2`, so ONLY moves whose originating
 *    execution was recorded under THIS session appear. Rows with a NULL
 *    `execution_id`, or an execution owned by another session / carrying a
 *    NULL `session_id` (historical or externally-detected activity), are
 *    excluded (fail-closed; externally-detected deposits intentionally drop
 *    out of the session view). `protocol_executions.session_id` is written
 *    by the engine's `recordExecution` from the same app session id used
 *    for the wallet scope (renderer sends session id → engine turn
 *    `context.sessionId` → capture), so the JOIN key and the wallet scope
 *    share one id space.
 *  - agent_activity: filters `session_id = $2` directly (its own native
 *    column — no join required).
 *
 * SECURITY (non-negotiable):
 *  - The SELECT carries `WHERE wallet_address = ANY($1::text[])` with a bound,
 *    finite array resolved from the session's wallet scope, AND
 *    `protocol_executions.session_id = $2` via the INNER JOIN. The wallet
 *    filter is retained as defense-in-depth and is never omitted.
 *  - addresses.length === 0 → return the EMPTY DTO (`ok([])`) BEFORE any SQL
 *    (empty session scope, or a session with no selected wallets). Fail closed.
 *  - addresses are resolved SERVER-SIDE (session scope); a renderer-supplied
 *    address is never accepted.
 *  - join key is the raw ADDRESS string — DO NOT lowercase (the engine stores
 *    raw checksum/base58 addresses).
 *  - The SELECT projects ONLY bounded, renderer-safe columns. It NEVER selects
 *    `params`, `result`, `meta`, or any raw JSONB blob. The sanctioned scalar
 *    extractions are: the on-chain tx reference from `external_refs`
 *    (`->>'txHash'` for EVM, `->>'signature'` for Solana — public on-chain
 *    data powering the renderer's block-explorer deep links), the
 *    input/output token display symbols from the activity row's EXACT
 *    capture item (`protocol_capture_items`, joined on `capture_item_id` AND
 *    `execution_id`), and (LOCAL SYMBOL FALLBACK) a bounded scalar AGGREGATE
 *    subquery against THIS WALLET's OWN `proj_balances` rows, matched on
 *    `(wallet_address, token_address)`. A scalar subquery (not a JOIN) is
 *    deliberate: `proj_balances` has no uniqueness guarantee on
 *    `(wallet_address, token_address)` alone (the real unique key also
 *    includes `chain_id` — a token contract address CAN collide across
 *    chains), so a JOIN could fan out and duplicate `proj_activity` rows.
 *    DETERMINISM (Codex review): the same `token_address` can be held on
 *    MULTIPLE chains with DIFFERENT `token_symbol`s, and `proj_activity.chain`
 *    is a free-text venue slug (`ethereum`, `solana`, `base`, …) that does
 *    NOT map to `proj_balances.chain_id` (BIGINT) via any repo-native
 *    function — so we cannot scope the lookup to the leg's own chain without
 *    inventing a fragile name→id mapping. Rather than a nondeterministic
 *    `LIMIT 1` guess, the subquery DECLINES ON AMBIGUITY: `MIN(token_symbol)`
 *    guarded by `HAVING COUNT(DISTINCT token_symbol) = 1` returns the symbol
 *    ONLY when the wallet holds exactly one distinct symbol for that address
 *    across every chain (0 rows or >1 distinct symbols → NULL → the renderer
 *    keeps its `truncateAddress` fallback). Honest over guessy. Symbol
 *    extraction is string-type checked and SQL-bounded to
 *    `MOVE_TOKEN_SYMBOL_MAX` chars, then re-validated in JS by the shared
 *    `sanitizeTokenSymbol` (ASCII allowlist — rejects control characters,
 *    bidi controls, zero-width characters, and Unicode confusables in one
 *    pass). BOTH the captured symbol and the local balances-derived symbol
 *    are UNTRUSTED display data (provider-supplied metadata) — the renderer
 *    must never let either override `input_token`/`output_token` identity or
 *    claim a brand icon without independent corroboration (`KNOWN_MINTS`).
 *    Neither raw `trade_capture` nor raw `external_refs` crosses IPC.
 *  - `wallet_address` IS projected (`walletAddress`) so the renderer can build
 *    an account block-explorer link for rows without a tx ref (HyperCore). This
 *    is the session's OWN wallet, already server-side scoped by the wallet
 *    filter — it is not a widening of the read. It is still NEVER logged (see
 *    below).
 *  - logging records sessionId + the row COUNT only; NEVER raw addresses,
 *    USD figures, token symbols, or tx hashes.
 *
 * Internals split into siblings (Card C5, move-only, once this file crossed
 * the repo's 500-line cap): `moves-db-types.ts` (the `MoveRow` shape),
 * `moves-db-query.ts` (connection helpers + the two SQL-half builders),
 * `moves-db-mappers.ts` (row → `MoveItem` mapping). This file stays the
 * public gate — `getMovesForSession` is the only export.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import { MOVES_MAX, type MovesDto } from "@shared/schemas/portfolio-moves.js";
import { log } from "../logger/index.js";
import { mapMoveRow } from "./moves-db-mappers.js";
import {
  buildAgentActivityMovesHalf,
  buildLegacyMovesHalf,
  dbError,
  resolveSessionAddresses,
  withClient,
} from "./moves-db-query.js";
import type { MoveRow } from "./moves-db-types.js";

/**
 * Read the session's executed-trade MOVES, newest first.
 *
 * Returns the EMPTY DTO (`ok([])`, no SQL issued) when the resolved allow-list
 * is empty. Otherwise selects up to `MOVES_MAX` bounded rows — UNIONing the
 * legacy `proj_activity` half (activity rows / fills, NOT executions) with
 * the new-format `agent_activity` half (one row per swap ATTEMPT, including
 * pending/failed) — both scoped to the session's wallets AND this session
 * (`session_id = $2`, via a JOIN for the legacy half, a native column for the
 * new half); newest first.
 */
export async function getMovesForSession(
  sessionId: string,
): Promise<Result<MovesDto, VexError>> {
  const resolved = await resolveSessionAddresses(sessionId);
  if (!resolved.ok) return resolved;
  const addresses = resolved.data;

  // Fail closed: no wallets → empty moves BEFORE any SQL.
  if (addresses.length === 0) {
    log.info(`[moves-db] getMovesForSession ok session=${sessionId} moves=0 (empty scope)`);
    return ok([]);
  }

  const addrParam = [...addresses];

  return withClient(async (client) => {
    try {
      const result = await client.query<MoveRow>(
        `${buildLegacyMovesHalf()}
          UNION ALL
          ${buildAgentActivityMovesHalf()}
          ORDER BY created_at DESC, id DESC
          LIMIT ${MOVES_MAX}`,
        [addrParam, sessionId],
      );

      const moves: MovesDto = result.rows.map(mapMoveRow);

      log.info(
        `[moves-db] getMovesForSession ok session=${sessionId} moves=${moves.length}`,
      );
      return ok(moves);
    } catch (cause) {
      return dbError("getMovesForSession query failed", cause);
    }
  });
}
