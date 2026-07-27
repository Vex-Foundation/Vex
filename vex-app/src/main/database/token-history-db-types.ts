/**
 * `token-history-db.ts` row shape — split out (Card C5, move-only) once the
 * parent file crossed the repo's 500-line cap. See `token-history-db.ts`'s
 * own module doc for the full source/dedupe/amount-honesty/USD-honesty
 * contract this row feeds.
 */

// ── Row shape (wide UNION — NULL placeholders where an arm doesn't apply) ─

export interface PageRow {
  readonly source_kind: "activity" | "intent" | "agent_activity";
  readonly source_rank: number;
  readonly source_id: string;
  readonly created_at: string | Date;
  readonly cursor_ts: string;
  readonly namespace: string | null;
  readonly product_type: string | null;
  readonly trade_side: string | null;
  readonly chain: string | null;
  readonly dest_chain: string | null;
  readonly input_token_address: string | null;
  readonly input_amount: string | null;
  readonly output_token_address: string | null;
  readonly output_amount: string | null;
  readonly input_value_usd: number | string | null;
  readonly output_value_usd: number | string | null;
  readonly unit_price_usd: number | string | null;
  readonly capture_status: string | null;
  readonly tx_ref: string | null;
  readonly input_token_symbol: string | null;
  readonly input_token_local_symbol: string | null;
  readonly output_token_symbol: string | null;
  readonly output_token_local_symbol: string | null;
  readonly to_address: string | null;
  /** `agent_activity` only — already collapsed to the DTO's 3-value vocabulary in SQL. */
  readonly status: string | null;
  /** `agent_activity` only — the closed failure_code enum. */
  readonly failure_code: string | null;
  /** `agent_activity` only — receipt-derived EXECUTED leg, raw base-unit integer text (C20). */
  readonly executed_amount_in_raw: string | null;
  readonly executed_amount_out_raw: string | null;
  /** `agent_activity` only — token decimals, needed to format the raw executed amount. */
  readonly token_in_decimals: number | null;
  readonly token_out_decimals: number | null;
  /** `agent_activity` BRIDGE logical row only — provider order id; `null` otherwise. */
  readonly provider_order_id: string | null;
  /**
   * `agent_activity` BRIDGE logical row only — `jsonb_agg(...)` of every
   * sibling leg (parsed to a JS array by node-postgres), or `null`. Coerced
   * via `coerceBridgeLegs`; carries the per-leg chain + hash the renderer turns
   * into explorer links (NEVER truncated — OWNER RULE).
   */
  readonly legs: unknown;
  /**
   * `agent_activity` only — last SUCCESSFUL sweep check (`last_checked_at`),
   * surfaced on the DTO for BRIDGE logical rows only (R12 tracking-delay);
   * `null`/absent on the legacy arms. `Date`/string per node-postgres.
   */
  readonly last_checked_at?: string | Date | null;
  /**
   * Canonical `activityKind`: the real `agent_activity.kind` on the
   * agent_activity arm, DERIVED from `product_type` on the legacy
   * `proj_activity` arm (see `legacy-activity-kind.ts`), NULL on the
   * `wallet_intents` arm (whose `transfer` entry carries no vocabulary field).
   * Optional so a row shape constructed before the column existed still
   * type-checks.
   */
  readonly activity_kind?: string | null;
  /** `agent_activity.event_role`; NULL on both legacy arms. */
  readonly event_role?: string | null;
}
