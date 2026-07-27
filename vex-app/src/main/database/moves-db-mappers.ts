/**
 * `moves-db.ts` row → DTO mapping — split out (Card C5, move-only) once the
 * parent file crossed the repo's 500-line cap. See `moves-db.ts`'s own module
 * doc (AMOUNT HONESTY section) for the full per-source amount-resolution
 * contract this mapper implements.
 */

import type { MoveItem } from "@shared/schemas/portfolio-moves.js";
import { coerceBridgeLegs } from "@shared/schemas/bridge-legs.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import {
  resolveAgentActivityAmount,
  resolveAmountWithEstimateBasis,
} from "./agent-activity-amount.js";
import type { MoveRow } from "./moves-db-types.js";

/**
 * `value_usd` (`NUMERIC`) comes back from `pg` as a string or number. Coerce
 * to a finite JS number, preserving the "absent" distinction as `null` (no
 * fabricated 0 — the column is genuinely nullable when the engine could not
 * price the trade).
 */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** TIMESTAMPTZ comes back as a Date (node-postgres) or string; normalise to ISO. */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const MOVE_STATUSES = ["pending", "confirmed", "failed"] as const;
type MoveStatus = (typeof MOVE_STATUSES)[number];

/**
 * Narrow the SQL-collapsed `agent_activity` status string to the DTO's closed
 * vocabulary. `null` (the legacy `proj_activity` half, which has no status
 * concept) stays `null`; an unrecognized value fails closed to `null` rather
 * than risking an output-schema parse failure on a future enum drift.
 */
function toMoveStatus(value: string | null): MoveStatus | null {
  // Tolerate the raw DB value too — the SQL CASE collapses
  // `definitively_failed` → `failed`, but the mapper must not depend on it
  // (defense in depth against a future half added without the CASE).
  if (value === "definitively_failed") return "failed";
  return value !== null && (MOVE_STATUSES as readonly string[]).includes(value)
    ? (value as MoveStatus)
    : null;
}

/** Map one UNION-ALL row (`MoveRow`) to the renderer-facing `MoveItem` DTO. */
export function mapMoveRow(row: MoveRow): MoveItem {
  const isAgentActivity = row.source === "agent_activity";
  // `product_type` is computed in SQL ('bridge'/'lend'/'prediction' per
  // `kind`, else 'spot'); the legacy half echoes proj_activity's own
  // product_type, which for a legacy bridge is also 'bridge' — so the
  // BRIDGE/lend/prediction amount rule below applies ONLY to the
  // agent_activity half.
  const isBridge = isAgentActivity && row.product_type === "bridge";
  // W5 (migration 049) — lend/prediction rows share the bridge amount
  // rule (see `resolveAmountWithEstimateBasis`'s doc): a confirmed row
  // is not guaranteed decoder-proven, so it falls back to the quoted
  // amount labelled "estimated" instead of going blank.
  const isLendOrPrediction =
    isAgentActivity &&
    (row.product_type === "lend" || row.product_type === "prediction");
  const moveStatus = toMoveStatus(row.status);

  // Amount honesty by source:
  //  - agent_activity plain SWAP (C20): status-driven — never a blind
  //    COALESCE; a confirmed-without-decode row is unreachable (the
  //    sweep's both-legs-required invariant — R3) so it never needs an
  //    "estimated" fallback and `amountBasis` stays null;
  //  - agent_activity BRIDGE (Q2) / lend / prediction (W5 R3/R5):
  //    executed when independently verified, else the quoted amount
  //    shown explicitly as an estimate;
  //  - legacy `success`: its own column IS the fill (unambiguous).
  let inputAmount: string | null;
  let outputAmount: string | null;
  let amountBasis: MoveItem["amountBasis"] = null;
  if (isBridge || isLendOrPrediction) {
    const inRes = resolveAmountWithEstimateBasis(
      moveStatus,
      row.input_amount,
      row.executed_amount_in_raw,
      row.token_in_decimals,
    );
    const outRes = resolveAmountWithEstimateBasis(
      moveStatus,
      row.output_amount,
      row.executed_amount_out_raw,
      row.token_out_decimals,
    );
    inputAmount = inRes.value;
    outputAmount = outRes.value;
    // executed_* are populated together, so the two bases agree in
    // practice; prefer the output (destination-fill / receive) basis,
    // then input.
    amountBasis = outRes.basis ?? inRes.basis;
  } else if (isAgentActivity) {
    inputAmount = resolveAgentActivityAmount(
      moveStatus,
      row.input_amount,
      row.executed_amount_in_raw,
      row.token_in_decimals,
    );
    outputAmount = resolveAgentActivityAmount(
      moveStatus,
      row.output_amount,
      row.executed_amount_out_raw,
      row.token_out_decimals,
    );
  } else {
    inputAmount = row.input_amount;
    outputAmount = row.output_amount;
  }

  return {
    id: `${row.source}:${row.id}`,
    source: isAgentActivity ? "agent_activity" : "success",
    tradeSide: row.trade_side,
    productType: row.product_type,
    venue: row.venue,
    inputToken: row.input_token,
    inputTokenSymbol: sanitizeTokenSymbol(row.input_token_symbol),
    inputTokenLocalSymbol: sanitizeTokenSymbol(row.input_token_local_symbol),
    inputAmount,
    outputToken: row.output_token,
    outputTokenSymbol: sanitizeTokenSymbol(row.output_token_symbol),
    outputTokenLocalSymbol: sanitizeTokenSymbol(row.output_token_local_symbol),
    outputAmount,
    valueUsd: toNumberOrNull(row.value_usd),
    captureStatus: row.capture_status,
    status: moveStatus,
    failureCode: row.failure_code ?? null,
    instrumentKey: row.instrument_key,
    chain: row.chain,
    txRef: row.tx_ref,
    walletAddress: row.wallet_address,
    fromChain: row.from_chain ?? null,
    toChain: row.to_chain ?? null,
    providerOrderId: row.provider_order_id ?? null,
    amountBasis,
    legs: isBridge ? coerceBridgeLegs(row.legs) : [],
    // R12: surface the last successful sweep check for bridge logical
    // rows only — the renderer flags a stale pending bridge "tracking
    // delayed". Swap/legacy rows leave it null.
    lastCheckedAt: isBridge && row.last_checked_at != null ? toIso(row.last_checked_at) : null,
    // Canonical vocabulary (see `legacy-activity-kind.ts`): derived server-side
    // for the legacy arm, the real columns for the agent_activity arm. Both are
    // pass-through — the SQL owns the derivation and the clamping, so there is
    // no second place for the two arms to disagree.
    activityKind: row.activity_kind ?? null,
    eventRole: row.event_role ?? null,
    createdAt: toIso(row.created_at),
  };
}
