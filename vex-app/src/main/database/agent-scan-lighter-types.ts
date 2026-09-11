/**
 * The Agent Scan feed's LIGHTER arm row shape - one row of `lighter_fills`
 * (migration 152) plus the market's newest observed position state, as
 * `agent-scan-lighter-query.ts` selects it.
 *
 * A sibling of `agent-scan-db-types.ts` rather than a section of it, for the
 * same reason the DTO splits: the two arms read different tables, carry
 * different vocabularies and change for different reasons.
 *
 * NODE-POSTGRES TYPE NOTES, which `agent-scan-lighter-mappers.ts` depends on:
 *  - `BIGINT` arrives as a STRING (node-postgres refuses to lose precision past
 *    2^53). `id` is therefore selected as `::text` and stays a string all the
 *    way into the cursor, and `account_index` is never selected at all.
 *  - `INTEGER` and `SMALLINT` fit a number and arrive as one; they are still
 *    typed `number | string` where a parser configuration could widen them, and
 *    narrowed in the mapper.
 *  - Every AMOUNT in this ledger is already a TEXT decimal string with its own
 *    `CHECK` (migration 152), so amounts arrive as strings and are never
 *    converted to a JS number anywhere on this path.
 *  - `TIMESTAMPTZ` arrives as a `Date` (or a string, depending on parser
 *    configuration); `cursor_ts` is deliberately a pre-rendered STRING built by
 *    SQL `to_char(...)` so the keyset cursor never passes through `Date`.
 *  - `JSONB` (`position_now`) arrives already parsed as `unknown`. It is the
 *    ONE value on this row with no database CHECK behind it, so the mapper
 *    validates it by shape and degrades a field it cannot read to null.
 */

/** The arm discriminator, selected as a SQL literal. 1 = `lighter_fills`. */
export const AGENT_SCAN_LIGHTER_SOURCE_RANK = 1;

export interface AgentScanLighterRow {
  /** Literal `1` from SQL: the arm this row belongs to, for the merge and the cursor. */
  readonly source_rank: number | string;
  /** `lighter_fills.id::text` - the DTO id AND the keyset cursor's `sourceId`. */
  readonly source_id: string;
  /** SQL-rendered microsecond UTC render of `traded_at` - the cursor's `createdAt`. */
  readonly cursor_ts: string;
  /** When the VENUE matched the fill. The feed time of this row. */
  readonly traded_at: string | Date;
  /** When VEX saw the fill. A different fact from `traded_at`. */
  readonly observed_at: string | Date;

  /** `core` or `rhc`, SQL-clamped to the DTO bound. */
  readonly environment: string | null;
  readonly market_index: number | string;
  readonly market_symbol: string | null;
  readonly side: string | null;
  readonly trade_type: string | null;
  /** NULL on a public row whose account half was never supplied. */
  readonly position_effect: string | null;

  readonly base_size: string;
  readonly price: string;
  readonly quote_notional: string;
  /** Lighter's OWN usd notional for the fill - settled, not an estimate. */
  readonly usd_amount: string;
  readonly block_height: string;

  readonly base_asset_symbol: string | null;
  readonly base_asset_decimals: number | string;
  readonly quote_asset_symbol: string | null;
  readonly quote_asset_decimals: number | string;

  /** The account's own half: whole or nothing (`entry_quote_before` may be null alone). */
  readonly position_size_before: string | null;
  readonly entry_quote_before: string | null;
  readonly account_pnl: string | null;

  /**
   * Migration 162. The trade record's own initial margin fraction BEFORE the
   * fill, on the provider's 10000 scale. NULL on a public row and on a row
   * written before the column existed and not yet re-observed.
   */
  readonly initial_margin_fraction_before: number | string | null;

  readonly fee_side: string | null;
  /** EXACT integrator fee. NULL is UNPROVEN, never zero (migration 152). */
  readonly integrator_fee_charged_raw: string | null;
  readonly integrator_fee_estimated_raw: string | null;
  readonly integrator_fee_estimate_basis: string | null;
  readonly integrator_fee_estimate_tick_source: string | null;
  readonly integrator_fee_estimated_usd: string | null;
  readonly integrator_fee_asset_symbol: string | null;
  readonly integrator_fee_asset_decimals: number | string | null;
  readonly integrator_fee_tick_observed: number | string | null;
  readonly integrator_fee_tick_authorized: number | string | null;

  /** Signed: the exchange reports a rebate as a negative charged amount. */
  readonly exchange_fee_charged_raw: string | null;
  readonly exchange_fee_estimated_usd: string | null;
  readonly exchange_fee_tick_observed: number | string | null;

  readonly provider_trade_id: string;
  readonly provider_order_id: string | null;
  /** Mandatory on this arm: a fill without an intent is HELD and never read. */
  readonly execution_intent_id: string;

  /**
   * `lighter_position_market_state` for this fill's (environment, account,
   * market), or all null when no observation has ever covered the market.
   * `position_observed_at` is VEX'S OWN observation time from the sweep.
   */
  readonly position_observed_at: string | Date | null;
  readonly position_open: boolean | null;
  /** The stored position JSONB, already parsed by node-postgres. Validated in the mapper. */
  readonly position_now: unknown;
}
