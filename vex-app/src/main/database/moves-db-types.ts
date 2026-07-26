/**
 * `moves-db.ts` row shape — split out (Card C5, move-only) once the parent
 * file crossed the repo's 500-line cap. See `moves-db.ts`'s own module doc
 * for the full source/dedupe/amount-honesty contract this row feeds.
 */

export interface MoveRow {
  readonly id: number | string;
  readonly trade_side: string | null;
  readonly product_type: string | null;
  readonly venue: string | null;
  readonly input_token: string | null;
  readonly input_token_symbol: string | null;
  readonly input_token_local_symbol: string | null;
  readonly input_amount: string | null;
  readonly output_token: string | null;
  readonly output_token_symbol: string | null;
  readonly output_token_local_symbol: string | null;
  readonly output_amount: string | null;
  readonly value_usd: number | string | null;
  readonly capture_status: string | null;
  readonly instrument_key: string | null;
  readonly chain: string;
  readonly tx_ref: string | null;
  readonly wallet_address: string | null;
  readonly created_at: string | Date;
  /** 'success' (legacy proj_activity) | 'agent_activity' (new-format truth). */
  readonly source: string;
  /** agent_activity only — already collapsed to the DTO's 3-value vocabulary in SQL. */
  readonly status: string | null;
  /** agent_activity only — the closed failure_code enum. */
  readonly failure_code: string | null;
  /** agent_activity only — receipt-derived EXECUTED leg, raw base-unit integer text (C20). */
  readonly executed_amount_in_raw: string | null;
  readonly executed_amount_out_raw: string | null;
  /** agent_activity only — token decimals, needed to format the raw executed amount. */
  readonly token_in_decimals: number | null;
  readonly token_out_decimals: number | null;
  /**
   * agent_activity BRIDGE logical row only (`kind = 'bridge'`) — the route
   * endpoints for from→to display; `chain` (above) stays the leg's own
   * execution chain (the destination, where the fill hash lives). `null` on a
   * swap / legacy row.
   */
  readonly from_chain: string | null;
  readonly to_chain: string | null;
  /** agent_activity BRIDGE logical row only — provider order id; `null` otherwise. */
  readonly provider_order_id: string | null;
  /**
   * agent_activity BRIDGE logical row only — `jsonb_agg(...)` of every sibling
   * leg (already parsed to a JS array by node-postgres), or `null` for a
   * swap/legacy row. Coerced via `coerceBridgeLegs`.
   */
  readonly legs: unknown;
  /**
   * agent_activity only — last SUCCESSFUL sweep check (`last_checked_at`),
   * surfaced on the DTO for BRIDGE logical rows only (R12 tracking-delay);
   * `null`/absent on legacy rows. `Date`/string per node-postgres.
   */
  readonly last_checked_at: string | Date | null;
}
