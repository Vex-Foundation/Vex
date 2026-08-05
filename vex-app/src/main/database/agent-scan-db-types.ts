/**
 * `agent-scan-db.ts` row shape — the single `agent_activity` arm the Agent
 * Scan feed reads. See `agent-scan-db.ts`'s module doc for the source /
 * scope / amount-honesty contract this row feeds.
 *
 * NODE-POSTGRES TYPE NOTES, which the mapper depends on:
 *  - `BIGINT` columns (`chain_id`, `from_chain_id`, `to_chain_id`) arrive as
 *    STRINGS, not numbers — node-postgres refuses to silently lose precision
 *    past 2^53. They are typed `number | string` and narrowed in the mapper.
 *  - `NUMERIC` columns (`usd_*`) arrive as strings for the same reason, and
 *    stay strings all the way to the DTO — a USD figure is never a JS float
 *    here.
 *  - `SMALLINT` (`token_*_decimals`) fits a number and arrives as one.
 *  - `TIMESTAMPTZ` arrives as a `Date` (or a string, depending on parser
 *    configuration); `cursor_ts` is deliberately a pre-rendered STRING built by
 *    SQL `to_char(...)` so the keyset cursor never passes through `Date`.
 */

export interface AgentScanRow {
  /** `agent_activity.id::text` — the DTO id AND the keyset cursor's `sourceId`. */
  readonly source_id: string;
  readonly created_at: string | Date;
  /** SQL-rendered microsecond UTC timestamp — the keyset cursor's `createdAt`. */
  readonly cursor_ts: string;

  /** Canonical vocabulary, SQL-clamped to the DTO bounds. */
  readonly activity_kind: string | null;
  readonly event_role: string | null;
  /** Already collapsed `definitively_failed` → `failed` in SQL. */
  readonly status: string | null;
  readonly protocol: string | null;

  /** The row's OWN execution chain (for a bridge fill: the destination). */
  readonly chain_id: number | string | null;
  readonly chain_family: string | null;
  readonly chain_slug: string | null;
  /** Bridge route endpoints; `null` on a same-chain activity. */
  readonly from_chain_id: number | string | null;
  readonly from_chain_slug: string | null;
  readonly to_chain_id: number | string | null;
  readonly to_chain_slug: string | null;

  /** Requested (quote-time) IN leg + its receipt-derived executed counterpart. */
  readonly token_in_address: string | null;
  readonly token_in_symbol: string | null;
  readonly token_in_decimals: number | null;
  readonly amount_in_human: string | null;
  readonly amount_in_raw: string | null;
  readonly executed_amount_in_human: string | null;
  readonly executed_amount_in_raw: string | null;
  readonly usd_in_est: number | string | null;

  readonly token_out_address: string | null;
  readonly token_out_symbol: string | null;
  readonly token_out_decimals: number | null;
  readonly amount_out_human: string | null;
  readonly amount_out_raw: string | null;
  readonly executed_amount_out_human: string | null;
  readonly executed_amount_out_raw: string | null;
  readonly usd_out_est: number | string | null;

  /**
   * Migration 050's DEPRECATED mixed-meaning column — network gas on a Kyber
   * row, the VENUE's own fee on a Jupiter one. Still selected; NO LONGER what
   * feeds the "Vex fee" label (see `vex_fee_usd_est`).
   */
  readonly usd_fee_est: number | string | null;
  /**
   * The Vex integrator fee in USD, from the SAME whole source as the two
   * token-denominated fields below. This — not `usd_fee_est` — is what the
   * "Vex fee" label may be fed from.
   */
  readonly vex_fee_usd_est: number | string | null;
  /** Vex integrator fee (migration 050), token-denominated, from ONE whole source. */
  readonly vex_fee_token_symbol: string | null;
  readonly vex_fee_amount_human: string | null;
  /**
   * Which whole source won: `in_transaction` (taken inside the transaction this
   * row records), `separate_leg` (a sibling fee transfer), or `null` (no fee
   * claimed — none charged, none collected yet, or the projection failed closed
   * on contradictory evidence). Mapper-internal; never an IPC DTO field.
   */
  readonly vex_fee_source: string | null;

  readonly failure_code: string | null;
  /** Redacted engine text, SQL-clamped to the DTO's 500-char bound. */
  readonly failure_reason: string | null;
  readonly tx_hash: string | null;
  readonly provider_order_id: string | null;
  readonly last_checked_at: string | Date | null;
  /**
   * Migration 065. Consecutive INCONCLUSIVE verification attempts; the DTO's
   * `stalledVerification` is DERIVED from this and is never a stored status.
   */
  readonly verification_attempts: number | string | null;
  /** Why the last attempt could not conclude, e.g. `no_safe_rpc`. Bounded open string. */
  readonly last_verification_reason: string | null;
  readonly pending_reason: string | null;

  /**
   * BRIDGE rows only — `jsonb_agg(...)` of every sibling leg of the execution
   * (already parsed to a JS array by node-postgres), or `null`. Mapped WITHOUT
   * dropping anything: unlike `coerceBridgeLegs`, an unrecognized role is
   * carried through as a tolerant string (OWNER RULE — an audit feed never
   * silently discards evidence).
   */
  readonly legs: unknown;
}
