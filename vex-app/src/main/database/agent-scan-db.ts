/**
 * Agent Scan DB helper — read-only, GLOBAL-scope, full-history agent activity.
 * Backs `vex:portfolio:listAgentScan`.
 *
 * Mirrors `portfolio-db.ts` / `token-history-db.ts`: its own
 * `pg.Client` per call, no `@vex-agent/db/repos/*` import, reading the same
 * local `vex` Postgres the engine writes to.
 *
 * SOURCE - TWO LOCAL LEDGERS, `agent_activity` and `lighter_fills`. The
 * token-history feed UNIONs the legacy `proj_activity` / `wallet_intents`
 * projections; this one does not. Those arms keep serving the feed that already
 * depends on them, and Agent Scan is built purely on the canonical vocabulary
 * (`@shared/agent-activity-vocabulary.js`) plus the venue's own fill ledger
 * (migration 152), instead of inheriting the SPOT taxonomy the legacy arms were
 * minted with.
 *
 * ONE PAGE, ONE SNAPSHOT, ONE CURSOR. Each arm has its own query
 * (`agent-scan-db-query.ts`, `agent-scan-lighter-query.ts`), both are issued
 * after the SAME 3-field keyset boundary with the same `limit + 1` probe, and
 * `agent-scan-merge.ts` interleaves them into one sequence - see its header for
 * why that is equivalent to a single ordered read, and for the late-attribution
 * limit it cannot remove. The transaction is `REPEATABLE READ` rather than the
 * default `READ COMMITTED` because the two statements must see ONE snapshot: at
 * READ COMMITTED each statement takes its own, so a fill inserted between them
 * could be counted by one arm's `hasMore` probe while the other arm's boundary
 * had already moved past it (PostgreSQL, "Transaction Isolation": a READ
 * COMMITTED statement sees a snapshot taken at the start of THAT statement,
 * while a REPEATABLE READ transaction sees one taken at its first statement).
 * The Lighter arm is SKIPPED ENTIRELY when the caller's filters exclude it, in
 * which case this read behaves exactly as the single-arm one did.
 *
 * ROW SELECTION — one row per LOGICAL activity (owner decision), selected by
 * the shared positive role allow-list in `agent-activity-logical-row.ts`.
 * `wrap` is here FROM DAY ONE: migration 051:129-135 warns that all three
 * pre-existing agent-visible SQL surfaces either omit it or fold it into
 * `'spot'`, so a wrap is written correctly and then either invisible or
 * displayed as a trade it is not. Allowance plumbing and a bridge's
 * deposit/fee/observed-fill/refund legs ride the logical row's `legs` array;
 * they are never their own ledger entries, so a bridge appears ONCE.
 *
 * SECURITY — the read is GLOBAL, so the wallet allow-list is the only thing
 * bounding it. `resolveInventoryWalletAddressLookupVariants()` supplies exact indexed
 * lookup variants (raw + lowercase for shape-valid EVM, raw only for Solana)
 * and is applied UNCONDITIONALLY as `$1`, before any optional predicate.
 * The renderer never supplies an address. `filters.sessionId` adds an `AND` on
 * top; there is no code path in which it replaces the wallet predicate, so it
 * can only ever NARROW the result set. An empty inventory returns the empty
 * page before any SQL is issued (fail closed).
 *
 * PROJECT SCOPE works the same way and is resolved with the same authority the
 * POSITION portfolio uses: `filters.projectId` is turned into the project's own
 * addresses HERE, in main, by `readProjectPortfolioScope` over
 * `project_wallets`, and those addresses are bound as a SECOND
 * `wallet_address = ANY(...)` predicate beside the inventory allow-list - an
 * INTERSECTION, never a replacement, so quoting a project id cannot reach a
 * wallet the inventory does not already hold. The renderer never filters a
 * global feed: the scope decision has one owner and it is this module. An
 * unknown project and a drifted selection are TYPED REFUSALS
 * (`projects.not_found` / `projects.wallet_drift`); only a project with nothing
 * selected is an empty page, because those are three different answers.
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
 * `agent-scan-db-types.ts` / `agent-scan-lighter-types.ts` (row shapes),
 * `agent-scan-db-query.ts` (connection, filter compilation, activity page SQL,
 * the shared keyset boundary) and `agent-scan-lighter-query.ts` (fill page
 * SQL), `agent-scan-db-mappers.ts` / `agent-scan-lighter-mappers.ts` (row →
 * DTO), `agent-scan-merge.ts` (the two arms → one page). This file is the
 * public gate - `getAgentScan` is the only export.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  AGENT_SCAN_PAGE_SIZE,
  type AgentScanCursor,
  type AgentScanDto,
  type AgentScanReadInput,
} from "@shared/schemas/agent-scan-feed.js";
import { resolveInventoryWalletAddressLookupVariants } from "./inventory-wallets.js";
import { log } from "../logger/index.js";
import { mapAgentScanRow } from "./agent-scan-db-mappers.js";
import {
  mapAgentScanLighterRow,
  type AgentScanLighterMappingStats,
} from "./agent-scan-lighter-mappers.js";
import { buildAgentScanLighterPageQuery } from "./agent-scan-lighter-query.js";
import { mergeAgentScanArms } from "./agent-scan-merge.js";
import {
  AGENT_SCAN_ACTIVITY_SOURCE_RANK,
  buildAgentScanPageQuery,
  dbError,
  isStatementTimeout,
  projectNotFound,
  projectWalletDrift,
  rollbackQuietly,
  STATEMENT_TIMEOUT_SQL,
  toAddressLookupVariants,
  withClient,
} from "./agent-scan-db-query.js";
import { readProjectPortfolioScope } from "./projects/portfolio-scope.js";
import type { AgentScanRow } from "./agent-scan-db-types.js";
import type { AgentScanLighterRow } from "./agent-scan-lighter-types.js";

/** The empty available page - the one shape "there is nothing to show" takes. */
const EMPTY_PAGE = {
  status: "available",
  entries: [],
  nextCursor: null,
  hasMore: false,
} as const satisfies AgentScanDto;

/**
 * What `filters.projectId` narrowed the read to.
 *
 * `null` addresses = the filter was absent. An EMPTY array is a real, distinct
 * state (an active project with nothing selected) and rule 04 forbids folding
 * it into either of the failures beside it.
 */
type ProjectNarrowing = Result<readonly string[] | null, VexError>;

/**
 * Resolve `filters.projectId` to the project's OWN address lookup variants.
 *
 * `project_wallets` is the authority, read through the projects repository
 * (`readProjectPortfolioScope`) so this feed and the POSITION portfolio share
 * ONE answer to "which wallets is this project" and one drift policy. Building
 * a second resolver here would be a second source of truth on a surface that
 * names whose funds are on screen.
 *
 * Every outcome is NAMED, and none of them is an empty page:
 *
 *   - unknown or tombstoned project     -> `projects.not_found`
 *   - a selection the inventory no longer backs -> `projects.wallet_drift`
 *   - incomplete rows / unreadable database     -> the generic redacted dbError
 *
 * A project with NOTHING selected resolves to `[]`, which the caller renders as
 * the empty page without issuing SQL. That is a real state, not a failure.
 */
async function resolveProjectWalletVariants(
  projectId: string,
  correlationId: string,
): Promise<ProjectNarrowing> {
  const scope = await readProjectPortfolioScope(projectId);
  if (scope.kind === "not_found") return projectNotFound(correlationId);
  if (scope.kind === "drift") return projectWalletDrift(scope.family, correlationId);
  if (scope.kind === "missing_family" || scope.kind === "unavailable") {
    // Infrastructure, not user-actionable: a project whose wallet rows are
    // incomplete was written around the repository, and an unreadable one is a
    // database problem. Neither is "this project has no activity".
    return dbError(correlationId, "the project's wallet selection could not be read");
  }
  const addresses = [scope.wallets.evm, scope.wallets.solana]
    .filter((ref): ref is { id: string; address: string } => ref !== null)
    .map((ref) => ref.address);
  return ok(toAddressLookupVariants(addresses));
}

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
  const wallets = resolveInventoryWalletAddressLookupVariants();

  // Fail closed: no configured wallets → the empty available page, before any SQL.
  if (wallets.length === 0) {
    log.info("[agent-scan-db] getAgentScan ok wallets=0 (empty inventory)");
    return ok(EMPTY_PAGE);
  }

  // The project scope is resolved SERVER-SIDE, before the query is built, and
  // is applied as an intersection with the allow-list above. The schema has
  // already refused a request carrying both scopes by name, so at most one
  // narrowing scope can be live here.
  let projectWallets: readonly string[] | null = null;
  if (input.filters.projectId !== undefined) {
    const resolved = await resolveProjectWalletVariants(
      input.filters.projectId,
      correlationId,
    );
    if (!resolved.ok) return resolved;
    projectWallets = resolved.data;
    // An active project with nothing selected: the empty page, before any SQL.
    // Distinct from every failure above, all of which are typed refusals.
    if (projectWallets !== null && projectWallets.length === 0) {
      log.info("[agent-scan-db] getAgentScan ok projectScoped=true selected=0");
      return ok(EMPTY_PAGE);
    }
  }

  const { sql, params } = buildAgentScanPageQuery({
    wallets,
    projectWallets,
    filters: input.filters,
    cursor: input.cursor,
  });
  // `null` = the caller's filters exclude the Lighter arm; no SQL is issued for
  // it and the page is whatever the activity arm returns, exactly as before.
  const lighterPlan = buildAgentScanLighterPageQuery({
    wallets,
    projectWallets,
    filters: input.filters,
    cursor: input.cursor,
  });

  return withClient<AgentScanDto>(correlationId, async (client) => {
    try {
      // REPEATABLE READ, not the default READ COMMITTED: both arm queries of one
      // page must read ONE snapshot, or a row written between them could be
      // seen by one arm's boundary and missed by the other's. READ ONLY keeps
      // the guarantee the single-arm read already had.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    } catch (cause) {
      return dbError(correlationId, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY failed", cause);
    }

    try {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_SQL}'`);
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError(correlationId, "SET LOCAL statement_timeout failed", cause);
    }

    let activityRows: AgentScanRow[];
    try {
      const result = await client.query<AgentScanRow>(sql, [...params]);
      activityRows = result.rows;
    } catch (cause) {
      await rollbackQuietly(client);
      if (isStatementTimeout(cause)) {
        log.info("portfolio.agent_scan_query_canceled phase=page");
        return ok({ status: "unavailable", reason: "query_timeout" });
      }
      return dbError(correlationId, "page query failed", cause);
    }

    // A timeout on EITHER arm fails the WHOLE read closed. Returning the arm
    // that answered would silently present a partial history as the history.
    let lighterRows: AgentScanLighterRow[] = [];
    if (lighterPlan !== null) {
      try {
        const result = await client.query<AgentScanLighterRow>(
          lighterPlan.sql,
          [...lighterPlan.params],
        );
        lighterRows = result.rows;
      } catch (cause) {
        await rollbackQuietly(client);
        if (isStatementTimeout(cause)) {
          log.info("portfolio.agent_scan_query_canceled phase=lighter");
          return ok({ status: "unavailable", reason: "query_timeout" });
        }
        return dbError(correlationId, "lighter page query failed", cause);
      }
    }

    // Each arm asked for `limit + 1`: the extra rows prove there is another page
    // WITHOUT a second COUNT query, and are dropped by the merge.
    const { kept, hasMore } = mergeAgentScanArms(
      activityRows,
      lighterRows,
      AGENT_SCAN_PAGE_SIZE,
    );
    const stats: AgentScanLighterMappingStats = { unreadablePositions: 0 };
    const entries = kept.map((row) =>
      Number(row.source_rank) === AGENT_SCAN_ACTIVITY_SOURCE_RANK
        ? mapAgentScanRow(row as AgentScanRow)
        : mapAgentScanLighterRow(row as AgentScanLighterRow, stats),
    );

    const lastKept = kept[kept.length - 1];
    // `cursor_ts` is the SQL-rendered microsecond string, NOT a `Date`
    // round-trip — a millisecond-truncated boundary would skip or repeat rows
    // whenever two activities share a millisecond. `sourceRank` travels with it
    // so the next page resumes on the right side of a cross-arm tie.
    const nextCursor: AgentScanCursor | null =
      hasMore && lastKept !== undefined
        ? {
            createdAt: lastKept.cursor_ts,
            sourceId: lastKept.source_id,
            sourceRank: Number(lastKept.source_rank) === AGENT_SCAN_ACTIVITY_SOURCE_RANK ? 0 : 1,
          }
        : null;

    try {
      await client.query("COMMIT");
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError(correlationId, "COMMIT failed", cause);
    }

    // COUNTS AND DTO STATUS ONLY - never an address, an amount, a market, a
    // position figure or a filter value.
    log.info(
      `[agent-scan-db] getAgentScan ok entries=${entries.length} hasMore=${hasMore}`
      + ` activityRows=${activityRows.length} lighterRows=${lighterRows.length}`
      + ` unreadablePositions=${stats.unreadablePositions}`,
    );
    return ok({ status: "available", entries, nextCursor, hasMore });
  });
}
