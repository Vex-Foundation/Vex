/**
 * The Agent Scan feed's LIGHTER arm: the page SQL over `lighter_fills`
 * (migration 152), scoped by the same server-resolved wallet allow-list the
 * `agent_activity` arm is scoped by.
 *
 * The sibling `agent-scan-db-query.ts` owns the activity arm; this module owns
 * this one. They share the KEYSET BOUNDARY (`agentScanKeysetPredicate`) and
 * the microsecond cursor render (`agentScanCursorTsExpr`) - imported from
 * there, never re-spelled, because the two arms are merged into ONE sequence
 * and a boundary that disagreed by a character would skip or repeat rows.
 *
 * THREE PREDICATES CARRY THE WHOLE SCOPE, and each one has a specific failure
 * it exists to prevent.
 *
 * 1. `f.execution_intent_id IS NOT NULL` is MANDATORY, not a filter. Migration
 *    152: a fill with no intent is HELD - observed before Vex could prove which
 *    order owns it. Showing one would attribute a stranger's trading, or the
 *    user's own manual trading, to the agent.
 *
 * 2. The wallet scope is a CORRELATED `EXISTS` over
 *    `lighter_onboarding_workflows`, NEVER a JOIN. Migration 124 is unique on
 *    `(environment, wallet_address)` and NOT on `(environment,
 *    resolved_account_index)`: two of the user's wallets can legitimately
 *    resolve to one Lighter account (`lighter-position-snapshot.ts`'s scope
 *    query has to `GROUP BY` for exactly this reason), and a JOIN would emit
 *    the same fill once per matching wallet - a duplicated row in an audit
 *    feed, with a duplicated cursor id behind it. The project narrowing goes
 *    inside the SAME `EXISTS`, on the SAME workflow row, so the intersection is
 *    real rather than two independent existence claims.
 *
 *    There is deliberately NO `workflow_state` condition. A workflow that
 *    reached `ready_to_trade` can later fall back to a deposit or failure state
 *    while its `resolved_account_index` stays recorded, and history must
 *    survive that: an account's past fills do not stop being the user's because
 *    its onboarding regressed today.
 *
 * 3. The session narrowing is an `EXISTS` over the THREE intent tables that can
 *    own a fill (`lighter_order_execution_intents` migration 115,
 *    `lighter_order_lifecycle_intents` 140, `lighter_oco_execution_intents`
 *    148). `lighter_fills.execution_intent_id` has no foreign key precisely
 *    because one column points at several owning tables (migration 152's own
 *    comment), so the reader has to ask all three.
 *
 * CLAMPS ARE FOR DISPLAY TEXT ONLY. `LEFT(...)` is applied to the vocabularies
 * and labels whose bounds `AGENT_SCAN_LIGHTER_TEXT_BOUNDS` names, and to
 * nothing else. Amounts, USD figures, the block height, provider ids and the
 * intent id are selected AS-IS and validated by shape in the DTO: silently
 * clamping a number produces a different, valid-looking number, which on a
 * money surface is worse than failing the read.
 */

import {
  AGENT_SCAN_PAGE_SIZE,
  type AgentScanCursor,
  type AgentScanFilters,
} from "@shared/schemas/agent-scan-feed.js";
import { AGENT_SCAN_LIGHTER_TEXT_BOUNDS } from "@shared/schemas/agent-scan-lighter-entry.js";
import { TOKEN_SYMBOL_MAX_LENGTH } from "@shared/token-symbol-sanitizer.js";
import {
  agentScanCursorTsExpr,
  agentScanKeysetPredicate,
  type AgentScanQueryPlan,
} from "./agent-scan-db-query.js";
import { AGENT_SCAN_LIGHTER_SOURCE_RANK } from "./agent-scan-lighter-types.js";

/**
 * The FEED kind that routes this arm. Not an `agent_activity.kind` - the kind
 * lockstep gate reads that vocabulary and is untouched by this value.
 */
export const AGENT_SCAN_LIGHTER_FEED_KIND = "lighter_fill";
/** The protocol name this arm answers to in the `protocols` filter. */
export const AGENT_SCAN_LIGHTER_PROTOCOL = "lighter";
/** A fill is settled the moment the venue matched it: it has exactly one status. */
const AGENT_SCAN_LIGHTER_STATUS = "confirmed";

export interface AgentScanLighterQueryArgs {
  /** Server-resolved inventory allow-list. NEVER caller-supplied, never omitted. */
  readonly wallets: readonly string[];
  /**
   * The PROJECT's own server-resolved address lookup variants when
   * `filters.projectId` was supplied, else `null`. An INTERSECTION applied to
   * the SAME workflow row as the allow-list, never a replacement for it.
   */
  readonly projectWallets: readonly string[] | null;
  readonly filters: AgentScanFilters;
  readonly cursor: AgentScanCursor | null;
}

/**
 * Whether the caller's filters exclude this arm entirely.
 *
 * An EMPTY array means "no restriction", exactly as the filter schema says, so
 * only a NON-EMPTY list that omits this arm's value excludes it. `chainFamily`
 * excludes unconditionally: a venue is not a chain family, and a fill has no
 * chain of its own to claim one.
 */
function isLighterArmExcluded(filters: AgentScanFilters): boolean {
  const { kinds, protocols, statuses, chainFamily } = filters;
  if (kinds !== undefined && kinds.length > 0
    && !kinds.includes(AGENT_SCAN_LIGHTER_FEED_KIND)) return true;
  if (protocols !== undefined && protocols.length > 0
    && !protocols.includes(AGENT_SCAN_LIGHTER_PROTOCOL)) return true;
  if (chainFamily !== undefined) return true;
  if (statuses !== undefined && statuses.length > 0
    && !statuses.includes(AGENT_SCAN_LIGHTER_STATUS)) return true;
  return false;
}

/**
 * The Lighter arm's page query, or `null` when the caller's filters exclude
 * the arm (in which case no SQL is issued for it at all).
 *
 * `null` is the arm's own "no restriction matched me" answer and is NOT an
 * empty page: the other arm still runs, and the merged page is whatever it
 * returns.
 */
export function buildAgentScanLighterPageQuery(
  args: AgentScanLighterQueryArgs,
): AgentScanQueryPlan | null {
  const { wallets, projectWallets, filters, cursor } = args;
  if (isLighterArmExcluded(filters)) return null;

  const params: unknown[] = [];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };

  // $1 is the wallet allow-list, always, before any optional predicate - the
  // same position it holds on the activity arm.
  const walletsParam = push([...wallets]);
  const projectClause = projectWallets === null
    ? ""
    : `\n             AND w.wallet_address = ANY($${push([...projectWallets])}::text[])`;

  const predicates: string[] = [];

  // NARROWS to one session. The wallet EXISTS above is unconditional, so this
  // can only ever remove rows. All three owning intent tables are asked: the
  // column points at whichever one authorized the money.
  if (filters.sessionId !== undefined) {
    const sessionParam = push(filters.sessionId);
    predicates.push(
      `AND EXISTS (`
      + `SELECT 1 FROM lighter_order_execution_intents i`
      + ` WHERE i.intent_id = f.execution_intent_id AND i.session_id = $${sessionParam}`
      + ` UNION ALL`
      + ` SELECT 1 FROM lighter_order_lifecycle_intents l`
      + ` WHERE l.intent_id = f.execution_intent_id AND l.session_id = $${sessionParam}`
      + ` UNION ALL`
      + ` SELECT 1 FROM lighter_oco_execution_intents o`
      + ` WHERE o.intent_id = f.execution_intent_id AND o.session_id = $${sessionParam}`
      + `)`,
    );
  }

  if (cursor !== null) {
    const tsParam = push(cursor.createdAt);
    const rankParam = push(cursor.sourceRank);
    // Compared as a BIGINT, not text: `id` is a BIGSERIAL, and a lexicographic
    // compare would order "9" after "10" and drop rows from the next page.
    const idParam = push(cursor.sourceId);
    predicates.push(
      agentScanKeysetPredicate({
        createdAtColumn: "f.traded_at",
        idColumn: "f.id",
        sourceRankLiteral: AGENT_SCAN_LIGHTER_SOURCE_RANK,
        tsParam,
        rankParam,
        idParam,
      }),
    );
  }

  const limitParam = push(AGENT_SCAN_PAGE_SIZE + 1);

  const sql = `
      SELECT
        ${AGENT_SCAN_LIGHTER_SOURCE_RANK} AS source_rank,
        f.id::text AS source_id,
        ${agentScanCursorTsExpr("f.traded_at")} AS cursor_ts,
        f.traded_at,
        f.observed_at,
        LEFT(f.environment, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.environment}) AS environment,
        f.market_index,
        LEFT(f.market_symbol, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marketSymbol}) AS market_symbol,
        LEFT(f.side, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.side}) AS side,
        LEFT(f.trade_type, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.tradeType}) AS trade_type,
        LEFT(f.position_effect, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.positionEffect}) AS position_effect,
        f.base_size,
        f.price,
        f.quote_notional,
        f.usd_amount,
        f.block_height,
        LEFT(f.base_asset_symbol, ${TOKEN_SYMBOL_MAX_LENGTH}) AS base_asset_symbol,
        f.base_asset_decimals,
        LEFT(f.quote_asset_symbol, ${TOKEN_SYMBOL_MAX_LENGTH}) AS quote_asset_symbol,
        f.quote_asset_decimals,
        f.position_size_before,
        f.entry_quote_before,
        f.account_pnl,
        f.initial_margin_fraction_before,
        LEFT(f.fee_side, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeSide}) AS fee_side,
        f.integrator_fee_charged_raw,
        f.integrator_fee_estimated_raw,
        LEFT(f.integrator_fee_estimate_basis, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeBasis}) AS integrator_fee_estimate_basis,
        LEFT(f.integrator_fee_estimate_tick_source, ${AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeTickSource}) AS integrator_fee_estimate_tick_source,
        f.integrator_fee_estimated_usd,
        LEFT(f.integrator_fee_asset_symbol, ${TOKEN_SYMBOL_MAX_LENGTH}) AS integrator_fee_asset_symbol,
        f.integrator_fee_asset_decimals,
        f.integrator_fee_tick_observed,
        f.integrator_fee_tick_authorized,
        f.exchange_fee_charged_raw,
        f.exchange_fee_estimated_usd,
        f.exchange_fee_tick_observed,
        f.provider_trade_id,
        f.provider_order_id,
        f.execution_intent_id,
        pos.observed_at AS position_observed_at,
        pos.open        AS position_open,
        pos.position    AS position_now
      FROM lighter_fills f
      LEFT JOIN LATERAL (
        SELECT s.observed_at, s.open, s.position
          FROM lighter_position_market_state s
         WHERE s.environment  = f.environment
           AND s.account_index = f.account_index
           AND s.market_index  = f.market_index
      ) pos ON TRUE
      WHERE f.execution_intent_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM lighter_onboarding_workflows w
           WHERE w.environment = f.environment
             AND w.resolved_account_index = f.account_index
             AND w.wallet_address = ANY($${walletsParam}::text[])${projectClause}
        )
        ${predicates.join("\n        ")}
      ORDER BY f.traded_at DESC, f.id DESC
      LIMIT $${limitParam}`;

  return { sql, params };
}
