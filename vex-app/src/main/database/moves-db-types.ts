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
  /**
   * Canonical `activityKind`: the real `agent_activity.kind` on the new-format
   * arm, DERIVED from `product_type` on the legacy arm (see
   * `legacy-activity-kind.ts`). Optional so a caller constructing this row
   * shape before the column existed still type-checks.
   */
  readonly activity_kind?: string | null;
  /** `agent_activity.event_role`; always NULL on the legacy arm. */
  readonly event_role?: string | null;
  /**
   * agent_activity YIELD rows only — migration 053's Option-C SECOND-LEG
   * column family (`agent_activity_second_leg_roles_only` binds it to
   * `yield_py`/`yield_lp`, so every other row leaves it NULL). A `py.mint` is
   * 1→2 (one token in, PT **and** YT out) and a pre-expiry `py.redeem` is 2→1;
   * without these the feed renders half the action. Optional so a caller
   * constructing this row shape before the columns existed still type-checks.
   *
   * Raw amounts travel WITH their decimals (rules/90) — `*_in2_raw` alone is
   * the canonical thousandfold-error shape.
   */
  readonly token_in2_address?: string | null;
  readonly token_in2_symbol?: string | null;
  readonly token_in2_decimals?: number | null;
  readonly amount_in2_human?: string | null;
  readonly executed_amount_in2_raw?: string | null;
  readonly token_out2_address?: string | null;
  readonly token_out2_symbol?: string | null;
  readonly token_out2_decimals?: number | null;
  readonly amount_out2_human?: string | null;
  readonly executed_amount_out2_raw?: string | null;
}
