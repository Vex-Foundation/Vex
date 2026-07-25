/**
 * Token history DB helper — read-only, global-scope per-token TX history
 * (chronos-shell). Mirrors `portfolio-db.ts` / `moves-db.ts`: own `pg.Client`
 * per call, no `@vex-agent/db/repos/*` import. Reads the same local `vex`
 * Postgres the engine writes to.
 *
 * SOURCES (UNIONed, keyset-paginated):
 *  (a) `proj_activity` — the wallet's success-only activity feed. A row
 *      matches when EITHER leg's token+chain identity equals the requested
 *      `(chainId, tokenAddress)`. Matching is LEG-AWARE because a bridge
 *      row's two legs can be on DIFFERENT chains: the INPUT leg is always on
 *      `proj_activity.chain` (the origin — both `relay.bridge` and
 *      `khalani.bridge` write `chain: String(originChainId)`, read-only
 *      reference: `tools/protocols/relay/handlers/bridge.ts`,
 *      `tools/protocols/khalani/handlers/bridge.ts`, root `src/`, NOT
 *      imported — the trust boundary forbids it), while the OUTPUT leg for a
 *      `product_type = 'bridge'` row is on `meta->>'destChain'` (both bridge
 *      handlers copy `{ sourceChain, destChain }` into `_tradeCapture.meta`,
 *      which `activity-populator.ts`'s `captureMeta` copies verbatim onto
 *      `proj_activity.meta`) — for every other product type the output leg
 *      shares the row's own `chain`. Bridge legs are recorded SYMBOL-first
 *      (`activity-populator.ts`'s `preferSymbolLegs`), so the AUTHORITATIVE
 *      address for matching/display is resolved via a `protocol_capture_items
 *      .trade_capture->>'{input,output}TokenAddress'` join (the same join key
 *      `moves-db.ts` already uses), falling back to the projected column when
 *      the JSONB field is absent.
 *  (b) `wallet_intents` — EXECUTED (`status='executed' AND tx_hash IS NOT
 *      NULL`) outbound sends, matched by ADDRESS ONLY: `token` is free-text,
 *      model-supplied (never validated at write time — see
 *      `tools/internal/wallet/send/validation.ts`, root `src/`, read-only
 *      reference), so a row whose `token` does not equal the requested
 *      address after normalization is EXCLUDED — never a symbol guess.
 *  (c) `agent_activity` (Agent Scan plan §4.1/§4.7; W5/migration 049 adds
 *      `kind='lend'`/`'prediction'`) — one row per EVM swap ATTEMPT
 *      (`event_role = 'swap'` only; allowance rows are approval plumbing,
 *      excluded) OR one row per Solana lend/prediction attempt (every
 *      `event_role` under those kinds, since Solana has no allowance legs).
 *      Matching is DIRECT and exact — `chain_id` is a real BIGINT column (no
 *      free-text alias dance) and `token_in_address`/`token_out_address` are
 *      real columns (no JSONB resolution needed): a row matches when
 *      `chain_id = $chainId` AND (input OR output token address = the
 *      requested address). Surfaces
 *      `status`/`failureCode` so a pending or failed attempt is visible too,
 *      not just confirmed fills — mirrors `db/repos/transactions.ts`'s
 *      compatibility feed (root `src/`, read-only reference — NOT imported).
 *      Dedupe (mirrors that same feed's semantics): the unified
 *      `kyberswap.swap.execute`/`uniswap.swap.execute` handlers have
 *      `capture: "none"`, so an execution is written to EXACTLY ONE of
 *      `proj_activity`/`agent_activity`, never both — no runtime overlap to
 *      guard against structurally, unlike the root feed's failure half.
 *
 * Total order: `created_at DESC, source_rank DESC, source_id DESC`
 * (source_rank: agent_activity=2, activity=1, intent=0 — fixed). `source_id`
 * is TEXT in every arm (the two BIGSERIAL/SERIAL arms zero-pad so
 * lexicographic order matches numeric order; intent ids are already opaque
 * text) so one UNION column type works for all three. Keyset `limit+1` →
 * `nextCursor`/`hasMore`, mirroring `src/vex-agent/db/repos/transactions.ts`
 * (read-only reference).
 *
 * BOUNDED READ WITHOUT A MIGRATION (round-2 negotiated): the read runs inside
 * `BEGIN READ ONLY; SET LOCAL statement_timeout = '2s'` … guaranteed
 * COMMIT/ROLLBACK. A SQLSTATE 57014 fails the WHOLE read closed
 * (`{status:"unavailable", reason:"query_timeout"}`). The IPC handler (not
 * this module) is responsible for checking `ctx.signal.aborted` before
 * trusting an `"unavailable"` result as a genuine timeout rather than a user
 * cancel (register-handler discipline — this module has no `ctx`).
 *
 * COST BASIS — RETIRED (Agent Scan plan §4.7): the former cost-basis phase
 * read `proj_pnl_lots`, which the PnL/lot-projection teardown deletes (the
 * unified Kyber/Uniswap handlers never populate a lot ledger). No
 * replacement; the page's `entries` are the whole result now.
 *
 * AMOUNT HONESTY (Codex final-review round 1 finding 5 / contract C20): a
 * `confirmed` agent_activity swap entry NEVER displays the quote-time
 * REQUESTED amount as if it were settlement. `resolveAgentActivityAmount`
 * (`./agent-activity-amount.js`, shared with `moves-db.ts`) picks the one
 * honest value per status: `confirmed` → computed from
 * `executed_amount_*_raw` + `token_*_decimals` (BigInt-safe, via `viem`'s
 * `formatUnits` — never `Number` on a wei-scale string, and never the
 * repair-sweep decoders' human column, which they intentionally leave
 * unpopulated); `pending` → the requested echo; anything else (`failed`) →
 * none.
 *
 * USD HONESTY (Codex final-review round 2 finding 7 / contract C35): unlike
 * the amount above, an `agent_activity` leg's `valueUsd` is ALWAYS a
 * quote-time estimate (`aa.usd_in/out_est`) — there is no settlement-time USD
 * repricing anywhere in this feed, so the tag does NOT vary with `status` the
 * way `resolveAgentActivityAmount` does. Every leg's `valueUsd` carries a
 * `usdProvenance` tag (`usdField()` below): `"estimated"` for the
 * `agent_activity` arm, `"recorded"` for the legacy `proj_activity` arm (its
 * own captured USD column). The renderer must show an `"estimated"` figure
 * with an explicit `~ … est.` marker — never bare "USD at execution".
 *
 * SECURITY: wallet allow-list is the GLOBAL configured inventory only
 * (`inventory-wallets.ts` — the same resolution `portfolio-db.ts` uses for
 * `scope: "global"`); the renderer never supplies an address. Logging records
 * ONLY counts + correlationId-free structural context — a cancellation logs
 * exactly one redacted event (`portfolio.token_history_query_canceled`),
 * never addresses/amounts.
 *
 * Internals split into siblings (Card C5, move-only, once this file crossed
 * the repo's 500-line cap): `token-history-db-types.ts` (the `PageRow`
 * shape), `token-history-db-query.ts` (connection helpers, chain-identity
 * resolution, cursor/keyset helpers, and the three SQL-half builders),
 * `token-history-db-mappers.ts` (row → `TokenHistoryEntry` mapping). This
 * file stays the public gate — `getTokenHistory` is the only export.
 */

import type { Result, VexError } from "@shared/ipc/result.js";
import { ok } from "@shared/ipc/result.js";
import { familyForChainId } from "@shared/chains/display.js";
import {
  TOKEN_HISTORY_PAGE_SIZE,
  type TokenHistoryCursor,
  type TokenHistoryDto,
  type TokenHistoryReadInput,
} from "@shared/schemas/token-history.js";
import { resolveInventoryWalletAddresses } from "./inventory-wallets.js";
import { log } from "../logger/index.js";
import { mapEntry, normalizeSourceRank } from "./token-history-db-mappers.js";
import {
  buildActivityHalf,
  buildAgentActivityHalf,
  buildIntentHalf,
  chainMatchCandidates,
  dbError,
  isStatementTimeout,
  keysetPredicate,
  rollbackQuietly,
  STATEMENT_TIMEOUT_SQL,
  withClient,
} from "./token-history-db-query.js";
import type { PageRow } from "./token-history-db-types.js";

// ── Main read ─────────────────────────────────────────────────────────────

export async function getTokenHistory(
  input: TokenHistoryReadInput,
): Promise<Result<TokenHistoryDto, VexError>> {
  const wallets = [...resolveInventoryWalletAddresses()];

  // Fail closed: no configured wallets → the empty available page, before any SQL.
  if (wallets.length === 0) {
    log.info("[token-history-db] getTokenHistory ok wallets=0 (empty inventory)");
    return ok({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
  }

  const family = familyForChainId(input.chainId);
  const network = family === "solana" ? "solana" : "eip155";
  const chainAliases = [...chainMatchCandidates(input.chainId)];
  // Defense in depth: `tokenHistoryReadInputSchema` already lower-cases EVM
  // addresses at the IPC boundary, but `addr()` below only wraps the STORED
  // COLUMN in `lower(...)` — the bound parameter must independently carry
  // the same casing, or `lower(column) = $param` would silently match zero
  // rows for any caller that reaches this function without going through
  // that schema (e.g. a direct call). Idempotent when the schema already ran.
  const normalizedAddress =
    family === "evm" ? input.tokenAddress.toLowerCase() : input.tokenAddress;
  const addr = (column: string): string => (family === "evm" ? `lower(${column})` : column);

  const cursor: TokenHistoryCursor | null = input.cursor;

  return withClient<TokenHistoryDto>(async (client) => {
    try {
      await client.query("BEGIN READ ONLY");
    } catch (cause) {
      return dbError("BEGIN READ ONLY failed", cause);
    }

    try {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_SQL}'`);
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError("SET LOCAL statement_timeout failed", cause);
    }

    // ── Phase 1: the page ────────────────────────────────────────────────
    const params: unknown[] = [];
    const push = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const walletsParam = push(wallets);
    const chainAliasesParam = push(chainAliases);
    const addressParam = push(normalizedAddress);
    const networkParam = push(network);
    const chainIdParam = push(input.chainId);

    const hasCursor = cursor !== null;
    const tsParam = cursor !== null ? push(cursor.createdAt) : 0;
    const rankParam = cursor !== null ? push(cursor.sourceRank) : 0;
    const idParam = cursor !== null ? push(cursor.sourceId) : 0;

    const limitParam = push(TOKEN_HISTORY_PAGE_SIZE + 1);

    const activityKeyset = keysetPredicate(
      "a.created_at",
      "lpad(a.id::text, 20, '0')",
      1,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );
    const intentKeyset = keysetPredicate(
      "wi.created_at",
      "wi.intent_id",
      0,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );
    const agentActivityKeyset = keysetPredicate(
      "aa.created_at",
      "lpad(aa.id::text, 20, '0')",
      2,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );

    const activityHalf = buildActivityHalf({
      walletsParam,
      chainAliasesParam,
      addressParam,
      addr,
      activityKeyset,
    });
    const intentHalf = buildIntentHalf({
      walletsParam,
      networkParam,
      chainAliasesParam,
      addressParam,
      addr,
      intentKeyset,
    });
    const agentActivityHalf = buildAgentActivityHalf({
      walletsParam,
      chainIdParam,
      addressParam,
      addr,
      agentActivityKeyset,
    });

    const pageSql = `${activityHalf}
      UNION ALL
      ${intentHalf}
      UNION ALL
      ${agentActivityHalf}
      ORDER BY created_at DESC, source_rank DESC, source_id DESC
      LIMIT $${limitParam}`;

    let pageRows: PageRow[];
    try {
      const result = await client.query<PageRow>(pageSql, params);
      pageRows = result.rows;
    } catch (cause) {
      await rollbackQuietly(client);
      if (isStatementTimeout(cause)) {
        log.info("portfolio.token_history_query_canceled phase=page");
        return ok({ status: "unavailable", reason: "query_timeout" });
      }
      return dbError("page query failed", cause);
    }

    const hasMore = pageRows.length > TOKEN_HISTORY_PAGE_SIZE;
    const kept = hasMore ? pageRows.slice(0, TOKEN_HISTORY_PAGE_SIZE) : pageRows;
    const entries = kept.map(mapEntry);
    const lastKept = kept[kept.length - 1];
    const nextCursor: TokenHistoryCursor | null =
      hasMore && lastKept !== undefined
        ? {
            createdAt: lastKept.cursor_ts,
            sourceRank: normalizeSourceRank(lastKept.source_rank),
            sourceId: lastKept.source_id,
          }
        : null;

    try {
      await client.query("COMMIT");
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError("COMMIT failed", cause);
    }

    log.info(
      `[token-history-db] getTokenHistory ok entries=${entries.length} hasMore=${hasMore}`,
    );
    return ok({ status: "available", entries, nextCursor, hasMore });
  });
}
