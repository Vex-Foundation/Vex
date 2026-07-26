/**
 * Transactions repo — per-half SQL builders + keyset-cursor plumbing.
 *
 * `getTransactions` (transactions.ts) assembles its UNION ALL feed query from
 * the three half-builders below (agent_activity / success / failure), each
 * sharing the same `push`/`params` binder and the same keyset boundary
 * (`tsParam`/`rankParam`/`idParam`) so the cursor comparison is identical
 * across halves. See transactions.ts's module doc for the full three-half
 * feed semantics, filters, and pagination contract these builders implement.
 */

import type { DecodedCursor } from "./transactions-cursor.js";
import { failureToolsForProduct } from "./transactions-failure-tools.js";

// Microsecond-precision UTC render of created_at, used BOTH as the keyset
// boundary value (compared via ::timestamptz) and as the minted cursor's
// cursorTs. Round-trips losslessly through ::timestamptz.
const CURSOR_TS_EXPR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Build the per-half keyset predicate for DESC ordering on
 * (created_at, sourceRank, id). `sourceRank` is a constant per half so the
 * comparison is specialised (index-friendly) rather than a row-value compare.
 * Returns "" when no cursor (first page).
 */
function keysetPredicate(
  sourceRank: 0 | 1 | 2,
  cursor: DecodedCursor | null | undefined,
  tsParam: number,
  rankParam: number,
  idParam: number,
): string {
  if (!cursor) return "";
  return (
    `AND (created_at < $${tsParam}::timestamptz` +
    ` OR (created_at = $${tsParam}::timestamptz AND ${sourceRank} < $${rankParam}::int)` +
    ` OR (created_at = $${tsParam}::timestamptz AND ${sourceRank} = $${rankParam}::int AND id < $${idParam}::int))`
  );
}

/** Shared keyset-bind params every half's builder needs. */
interface HalfKeysetParams {
  cursor: DecodedCursor | null | undefined;
  tsParam: number;
  rankParam: number;
  idParam: number;
  push: (value: unknown) => number;
}

export function buildActivityHalf(
  params: HalfKeysetParams & {
    addresses: string[];
    namespace?: string;
    txHash?: string;
    productType?: string;
  },
): string {
  const { addresses, namespace, txHash, productType, cursor, tsParam, rankParam, idParam, push } = params;

  // ── AGENT_ACTIVITY half (agent_activity) ──────────────────────────────
  const activityConds: string[] = [`wallet_address = ANY($${push(addresses)}::text[])`];
  if (namespace !== undefined) activityConds.push(`protocol = $${push(namespace)}`);
  if (txHash !== undefined) {
    // A bridge's logical row (`bridge_fill_expected`) carries the FILL hash; its
    // deposit / refund / extra-fill hashes live on sibling legs. Match the row
    // when its OWN tx_hash matches (this alone covers swaps — each swap leg is
    // its own feed row) OR — for a bridge logical row only — when ANY sibling
    // leg of the same execution carries the hash, so `agent_scan txHash=` finds
    // a bridge by a deposit / refund / extra-fill hash and returns the logical
    // row with its legs (Codex FIX-ROUND-1 m7). The EXISTS is gated on the
    // logical role so it never widens a swap leg's own-hash match.
    const txHashParam = push(txHash);
    activityConds.push(
      `(tx_hash = $${txHashParam}` +
        ` OR (event_role = 'bridge_fill_expected' AND EXISTS (` +
        `SELECT 1 FROM agent_activity sib` +
        ` WHERE sib.protocol_execution_id = agent_activity.protocol_execution_id` +
        ` AND sib.tx_hash = $${txHashParam})))`,
    );
  }
  // A bridge (migration 045) fans out into per-leg rows; only its LOGICAL row
  // (`event_role = 'bridge_fill_expected'`) is a feed row — its allowance/
  // deposit/observed-fill/refund siblings ride the row's `legs[]` array, never
  // as their own feed rows. Swaps keep emitting every leg row (allowance +
  // swap) exactly as before (behavior preserved). `lend`/`prediction`
  // (migration 049, W5) are ONE-role-per-on-chain-tx like swaps — no logical/
  // leg split — so every row of those kinds is its own feed row, including
  // closeAll's N independent `predict_close`/`predict_claim` rows (R5: each is
  // an independent user-facing outcome, never aggregated into one row's legs).
  activityConds.push("(kind = 'swap' OR kind = 'lend' OR kind = 'prediction' OR event_role = 'bridge_fill_expected')");
  // productType now maps to `kind`: 'spot' → swap rows (derive to the same
  // "spot" product the success half stores), 'bridge' → bridge logical rows,
  // 'lend' → lend rows, 'prediction' → prediction rows. Any OTHER productType
  // (perps/order) has no agent_activity representation → exclude the half
  // entirely (no param bind needed).
  if (productType === "spot") activityConds.push("kind = 'swap'");
  else if (productType === "bridge") activityConds.push("kind = 'bridge'");
  else if (productType === "lend") activityConds.push("kind = 'lend'");
  else if (productType === "prediction") activityConds.push("kind = 'prediction'");
  else if (productType !== undefined) activityConds.push("FALSE");
  const activityKeyset = keysetPredicate(0, cursor, tsParam, rankParam, idParam);

  return `
    SELECT
      'agent_activity'::text AS source,
      0 AS source_rank,
      id,
      protocol AS namespace,
      CASE
        WHEN kind = 'bridge' THEN 'bridge'
        WHEN kind = 'lend' THEN 'lend'
        WHEN kind = 'prediction' THEN 'prediction'
        ELSE 'spot'
      END AS product_type,
      NULL::text AS trade_side,
      COALESCE(chain_slug, chain_id::text) AS chain,
      COALESCE(token_in_symbol, token_in_address) AS input_token,
      -- FIX2-SPINE C20 (finding 5): no human-amount COALESCE here — the TS
      -- mapper derives inputAmount from raw + decimals per the row's status
      -- (see module doc). This column stays a placeholder so the UNION ALL's
      -- column count/order matches the success half exactly.
      NULL::text AS input_amount,
      COALESCE(token_out_symbol, token_out_address) AS output_token,
      NULL::text AS output_amount,
      COALESCE(usd_out_est, usd_in_est) AS value_usd,
      NULL::text AS capture_status,
      status AS status,
      failure_code,
      failure_reason,
      chain_id,
      protocol,
      NULL::text AS tool_id,
      NULL::int AS duration_ms,
      protocol_execution_id,
      event_index,
      event_role,
      token_in_address,
      token_in_symbol,
      token_in_decimals,
      token_out_address,
      token_out_symbol,
      token_out_decimals,
      amount_in_human,
      amount_in_raw,
      amount_out_human,
      amount_out_raw,
      executed_amount_in_human,
      executed_amount_in_raw,
      executed_amount_out_human,
      executed_amount_out_raw,
      usd_in_est,
      usd_out_est,
      usd_fee_est,
      usd_network_gas_est,
      usd_venue_fee_est,
      usd_destination_prepay_est,
      usd_vex_fee_est,
      -- The Vex fee in TOKEN units (050 Part 2) — the exact fact behind the
      -- nullable USD estimate above. Projected because the transactions
      -- inspect view spreads this row straight into agent-visible output:
      -- without it the agent still sees only a null usd_vex_fee_est and
      -- cannot tell "no fee" from "no price".
      vex_fee_token_address,
      vex_fee_token_symbol,
      vex_fee_token_decimals,
      vex_fee_amount_raw,
      vex_fee_amount_human,
      usd_source,
      from_chain_id,
      from_chain_slug,
      to_chain_id,
      to_chain_slug,
      chain_family,
      provider_order_id,
      provider_status,
      -- Bridge legs (B8): every leg of the execution, the canonical expected
      -- fill INCLUDED (REVISION 4), aggregated with NO LIMIT (OWNER RULE — never
      -- truncated). NULL on swap rows.
      CASE WHEN kind = 'bridge' THEN (
        SELECT jsonb_agg(jsonb_build_object(
          'eventIndex', leg.event_index,
          'role', leg.event_role,
          'chainId', leg.chain_id,
          'chainSlug', leg.chain_slug,
          'chainFamily', leg.chain_family,
          'txHash', leg.tx_hash,
          'status', leg.status,
          'failureCode', leg.failure_code
        ) ORDER BY leg.event_index)
        FROM agent_activity leg
        WHERE leg.protocol_execution_id = agent_activity.protocol_execution_id
      ) END AS legs,
      tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM agent_activity
    WHERE ${activityConds.join(" AND ")} ${activityKeyset}`;
}

export function buildSuccessHalf(
  params: HalfKeysetParams & {
    addresses: string[];
    productType?: string;
    namespace?: string;
    txHash?: string;
  },
): string {
  const { addresses, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push } = params;

  // ── SUCCESS half (proj_activity) ──────────────────────────────────────
  const successConds: string[] = [`wallet_address = ANY($${push(addresses)}::text[])`];
  if (productType !== undefined) successConds.push(`product_type = $${push(productType)}`);
  if (namespace !== undefined) successConds.push(`namespace = $${push(namespace)}`);
  if (txHash !== undefined) successConds.push(`external_refs->>'txHash' = $${push(txHash)}`);
  const successKeyset = keysetPredicate(1, cursor, tsParam, rankParam, idParam);

  return `
    SELECT
      'success'::text AS source,
      1 AS source_rank,
      id,
      namespace,
      product_type AS product_type,
      trade_side,
      chain,
      input_token,
      input_amount,
      output_token,
      output_amount,
      value_usd,
      capture_status,
      NULL::text AS status,
      NULL::text AS failure_code,
      NULL::text AS failure_reason,
      NULL::bigint AS chain_id,
      NULL::text AS protocol,
      NULL::text AS tool_id,
      NULL::int AS duration_ms,
      execution_id AS protocol_execution_id,
      NULL::smallint AS event_index,
      NULL::text AS event_role,
      NULL::text AS token_in_address,
      NULL::text AS token_in_symbol,
      NULL::smallint AS token_in_decimals,
      NULL::text AS token_out_address,
      NULL::text AS token_out_symbol,
      NULL::smallint AS token_out_decimals,
      NULL::text AS amount_in_human,
      NULL::text AS amount_in_raw,
      NULL::text AS amount_out_human,
      NULL::text AS amount_out_raw,
      NULL::text AS executed_amount_in_human,
      NULL::text AS executed_amount_in_raw,
      NULL::text AS executed_amount_out_human,
      NULL::text AS executed_amount_out_raw,
      NULL::numeric AS usd_in_est,
      NULL::numeric AS usd_out_est,
      NULL::numeric AS usd_fee_est,
      NULL::numeric AS usd_network_gas_est,
      NULL::numeric AS usd_venue_fee_est,
      NULL::numeric AS usd_destination_prepay_est,
      NULL::numeric AS usd_vex_fee_est,
      NULL::text AS vex_fee_token_address,
      NULL::text AS vex_fee_token_symbol,
      NULL::smallint AS vex_fee_token_decimals,
      NULL::text AS vex_fee_amount_raw,
      NULL::text AS vex_fee_amount_human,
      NULL::text AS usd_source,
      NULL::bigint AS from_chain_id,
      NULL::text AS from_chain_slug,
      NULL::bigint AS to_chain_id,
      NULL::text AS to_chain_slug,
      NULL::text AS chain_family,
      NULL::text AS provider_order_id,
      NULL::text AS provider_status,
      NULL::jsonb AS legs,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM proj_activity
    WHERE ${successConds.join(" AND ")} ${successKeyset}`;
}

export function buildFailureHalf(
  params: HalfKeysetParams & {
    sessionId: string | null;
    productType?: string;
    namespace?: string;
    txHash?: string;
  },
): string {
  const { sessionId, productType, namespace, txHash, cursor, tsParam, rankParam, idParam, push } = params;

  const failTools = failureToolsForProduct(productType);
  // An empty allowlist (unknown productType) means the failure half matches
  // nothing; ANY('{}') achieves that without a special case.
  const failConds: string[] = [
    // FIX-SPINE C9 (finding 1) — NOT `success = false` alone: a freshly
    // created intent row (execution_status='intent') ALSO has
    // success=false until it completes, so filtering on success alone
    // would show every in-flight intent as an already-failed transaction.
    "execution_status = 'failed'",
    `session_id = $${push(sessionId)}`,
    `tool_id = ANY($${push(failTools)}::text[])`,
    // FIX-SPINE C9 (finding 2) — this toolId's failure-tool-allowlist
    // membership exists precisely so a PRE-agent_activity failure (before
    // any row could be created) still surfaces; once an agent_activity row
    // exists for this SAME execution, IT is the source of truth — never
    // show the same attempt twice under two different sources.
    "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)",
  ];
  if (namespace !== undefined) failConds.push(`namespace = $${push(namespace)}`);
  if (txHash !== undefined) failConds.push(`external_refs->>'txHash' = $${push(txHash)}`);
  const failureKeyset = keysetPredicate(2, cursor, tsParam, rankParam, idParam);

  // NOTE: select ONLY bounded columns — NEVER params, result, or trade_capture.
  return `
    SELECT
      'failure'::text AS source,
      2 AS source_rank,
      id,
      namespace,
      NULL::text AS product_type,
      NULL::text AS trade_side,
      NULL::text AS chain,
      NULL::text AS input_token,
      NULL::text AS input_amount,
      NULL::text AS output_token,
      NULL::text AS output_amount,
      NULL::numeric AS value_usd,
      NULL::text AS capture_status,
      'failed'::text AS status,
      NULL::text AS failure_code,
      NULL::text AS failure_reason,
      NULL::bigint AS chain_id,
      NULL::text AS protocol,
      tool_id,
      duration_ms,
      id AS protocol_execution_id,
      NULL::smallint AS event_index,
      NULL::text AS event_role,
      NULL::text AS token_in_address,
      NULL::text AS token_in_symbol,
      NULL::smallint AS token_in_decimals,
      NULL::text AS token_out_address,
      NULL::text AS token_out_symbol,
      NULL::smallint AS token_out_decimals,
      NULL::text AS amount_in_human,
      NULL::text AS amount_in_raw,
      NULL::text AS amount_out_human,
      NULL::text AS amount_out_raw,
      NULL::text AS executed_amount_in_human,
      NULL::text AS executed_amount_in_raw,
      NULL::text AS executed_amount_out_human,
      NULL::text AS executed_amount_out_raw,
      NULL::numeric AS usd_in_est,
      NULL::numeric AS usd_out_est,
      NULL::numeric AS usd_fee_est,
      NULL::numeric AS usd_network_gas_est,
      NULL::numeric AS usd_venue_fee_est,
      NULL::numeric AS usd_destination_prepay_est,
      NULL::numeric AS usd_vex_fee_est,
      NULL::text AS vex_fee_token_address,
      NULL::text AS vex_fee_token_symbol,
      NULL::smallint AS vex_fee_token_decimals,
      NULL::text AS vex_fee_amount_raw,
      NULL::text AS vex_fee_amount_human,
      NULL::text AS usd_source,
      NULL::bigint AS from_chain_id,
      NULL::text AS from_chain_slug,
      NULL::bigint AS to_chain_id,
      NULL::text AS to_chain_slug,
      NULL::text AS chain_family,
      NULL::text AS provider_order_id,
      NULL::text AS provider_status,
      NULL::jsonb AS legs,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM protocol_executions
    WHERE ${failConds.join(" AND ")} ${failureKeyset}`;
}

export function normalizeSourceRank(value: unknown): 0 | 1 | 2 {
  const n = Number(value);
  return n === 1 ? 1 : n === 2 ? 2 : 0;
}
