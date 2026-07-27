/**
 * Agent Scan DB helper — read-only, GLOBAL-scope, full-history agent activity.
 * Backs `vex:portfolio:listAgentScan`.
 *
 * Mirrors `portfolio-db.ts` / `moves-db.ts` / `token-history-db.ts`: its own
 * `pg.Client` per call, no `@vex-agent/db/repos/*` import, reading the same
 * local `vex` Postgres the engine writes to.
 *
 * SOURCE — `agent_activity` ONLY (single arm, deliberately). The two existing
 * feeds UNION the legacy `proj_activity` / `wallet_intents` projections; this
 * one does not. Those arms keep serving the feeds that already depend on them,
 * and Agent Scan gets to be built purely on the canonical vocabulary
 * (`@shared/agent-activity-vocabulary.js`) instead of inheriting the SPOT
 * taxonomy the legacy arms were minted with. One arm also means one cursor and
 * no `sourceRank` tie-break — see `agent-scan-feed.ts`'s header.
 *
 * ROW SELECTION — one row per LOGICAL activity (owner decision): the swap row,
 * a bridge's `bridge_fill_expected` marker, and every `lend`/`prediction`/
 * `wrap` row (those kinds have no sub-events — one role per on-chain tx).
 * `wrap` is here FROM DAY ONE: migration 051:129-135 warns that all three
 * pre-existing agent-visible SQL surfaces either omit it or fold it into
 * `'spot'`, so a wrap is written correctly and then either invisible or
 * displayed as a trade it is not. Allowance plumbing and a bridge's
 * deposit/fee/observed-fill/refund legs ride the logical row's `legs` array;
 * they are never their own ledger entries, so a bridge appears ONCE.
 *
 * SECURITY — the read is GLOBAL, so the wallet allow-list is the only thing
 * bounding it. `resolveInventoryWalletAddresses()` (the same resolution
 * `portfolio-db.ts` uses for `scope: "global"` and `token-history-db.ts` uses
 * outright) is applied UNCONDITIONALLY as `$1`, before any optional predicate.
 * The renderer never supplies an address. `filters.sessionId` adds an `AND` on
 * top; there is no code path in which it replaces the wallet predicate, so it
 * can only ever NARROW the result set. An empty inventory returns the empty
 * page before any SQL is issued (fail closed).
 *
 * BOUNDED READ WITHOUT A MIGRATION (the pattern `token-history-db.ts`
 * negotiated): the read runs inside `BEGIN READ ONLY; SET LOCAL
 * statement_timeout = '2s'` with a guaranteed COMMIT/ROLLBACK. A SQLSTATE
 * 57014 fails the WHOLE read closed to `{status:"unavailable",
 * reason:"query_timeout"}` — never a silent empty page, which would read as
 * "this agent has no history". The IPC handler, not this module, decides
 * whether an `"unavailable"` is really a user cancellation
 * (`ctx.signal.aborted`); this module has no `ctx`.
 *
 * AMOUNT / SYMBOL / URL HONESTY — all three live in
 * `agent-scan-db-mappers.ts`; see its header. In short: the one honest amount
 * per status comes from the shared `agent-activity-amount.ts` (contract C20,
 * not re-implemented here), the native-symbol annotation is a separate
 * `displaySymbol` that never passes through the symbol sanitizer, and explorer
 * URLs are built here in main from the curated allowlist so no provider URL can
 * reach the renderer.
 *
 * LOGGING records counts and DTO status only — never addresses, amounts, token
 * identities, tx hashes, or filter values.
 *
 * Internals split into siblings, mirroring the two feeds' own layout:
 * `agent-scan-db-types.ts` (row shape), `agent-scan-db-query.ts` (connection,
 * filter compilation, page SQL), `agent-scan-db-mappers.ts` (row → DTO). This
 * file is the public gate — `getAgentScan` is the only export.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  AGENT_SCAN_PAGE_SIZE,
  type AgentScanCursor,
  type AgentScanDto,
  type AgentScanReadInput,
} from "@shared/schemas/agent-scan-feed.js";
import { resolveInventoryWalletAddresses } from "./inventory-wallets.js";
import { log } from "../logger/index.js";
import { mapAgentScanRow } from "./agent-scan-db-mappers.js";
import {
  buildAgentScanPageQuery,
  dbError,
  isStatementTimeout,
  rollbackQuietly,
  STATEMENT_TIMEOUT_SQL,
  withClient,
} from "./agent-scan-db-query.js";
import type { AgentScanRow } from "./agent-scan-db-types.js";

/**
 * @param correlationId the handler's `ctx.requestId`. Threaded in so a failure's
 *   redacted main-side log line and the error the renderer receives carry the
 *   SAME id — see `agent-scan-db-query.ts`'s note on why this module does not
 *   follow the sibling feeds' omit-and-let-the-framework-stamp pattern.
 */
export async function getAgentScan(
  input: AgentScanReadInput,
  correlationId: string,
): Promise<Result<AgentScanDto, VexError>> {
  const wallets = resolveInventoryWalletAddresses();

  // Fail closed: no configured wallets → the empty available page, before any SQL.
  if (wallets.length === 0) {
    log.info("[agent-scan-db] getAgentScan ok wallets=0 (empty inventory)");
    return ok({ status: "available", entries: [], nextCursor: null, hasMore: false });
  }

  const { sql, params } = buildAgentScanPageQuery({
    wallets,
    filters: input.filters,
    cursor: input.cursor,
  });

  return withClient<AgentScanDto>(correlationId, async (client) => {
    try {
      await client.query("BEGIN READ ONLY");
    } catch (cause) {
      return dbError(correlationId, "BEGIN READ ONLY failed", cause);
    }

    try {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_SQL}'`);
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError(correlationId, "SET LOCAL statement_timeout failed", cause);
    }

    let pageRows: AgentScanRow[];
    try {
      const result = await client.query<AgentScanRow>(sql, [...params]);
      pageRows = result.rows;
    } catch (cause) {
      await rollbackQuietly(client);
      if (isStatementTimeout(cause)) {
        log.info("portfolio.agent_scan_query_canceled phase=page");
        return ok({ status: "unavailable", reason: "query_timeout" });
      }
      return dbError(correlationId, "page query failed", cause);
    }

    // The read asked for `limit + 1`: the extra row proves there is another
    // page WITHOUT a second COUNT query, and is dropped before mapping.
    const hasMore = pageRows.length > AGENT_SCAN_PAGE_SIZE;
    const kept = hasMore ? pageRows.slice(0, AGENT_SCAN_PAGE_SIZE) : pageRows;
    const entries = kept.map(mapAgentScanRow);

    const lastKept = kept[kept.length - 1];
    // `cursor_ts` is the SQL-rendered microsecond string, NOT a `Date`
    // round-trip — a millisecond-truncated boundary would skip or repeat rows
    // whenever two activities share a millisecond.
    const nextCursor: AgentScanCursor | null =
      hasMore && lastKept !== undefined
        ? { createdAt: lastKept.cursor_ts, sourceId: lastKept.source_id }
        : null;

    try {
      await client.query("COMMIT");
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError(correlationId, "COMMIT failed", cause);
    }

    log.info(
      `[agent-scan-db] getAgentScan ok entries=${entries.length} hasMore=${hasMore}`,
    );
    return ok({ status: "available", entries, nextCursor, hasMore });
  });
}
