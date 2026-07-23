/**
 * Transactions repo (Stage 9; Agent Scan plan §4.1/§11.1 added the
 * `agent_activity` half; FIX-SPINE round 1 fixed feed correctness per Codex
 * findings 1/2/16, C9; FIX2-SPINE round 2 fixed a quote-vs-settlement leak
 * per Codex final-review finding 5/C20) — the unified, keyset-paginated tx
 * feed behind the agent-facing history view.
 *
 * It FUSES three halves into ONE bounded row shape, then keyset-paginates the
 * union:
 *   - AGENT_ACTIVITY half — `agent_activity` rows (source='agent_activity',
 *     sourceRank=0) for the session's selected wallet set. New-format swap
 *     attempts: pending/confirmed/definitively_failed, wallet-scoped like the
 *     success half (agent_activity carries `wallet_address` directly, unlike
 *     `protocol_executions`). Carries the FULL per-leg detail additively (see
 *     `TransactionRow`) — requested vs executed amounts, token addr/symbol/
 *     decimals, failure_reason, protocol_execution_id/event_index/event_role,
 *     usd in/out/fee/source.
 *   - SUCCESS half — proj_activity rows for the session's selected wallet set
 *     (source='success', sourceRank=1). Carries the trade economics (legacy
 *     shape — no per-leg token/amount granularity).
 *   - FAILURE half — protocol_executions for the CURRENT session, restricted
 *     to the trade-impacting failure-tool allowlist (source='failure',
 *     sourceRank=2). Carries NO economics — failures never produced a fill —
 *     and is selected with ONLY bounded columns: `params`, `result`, and
 *     `trade_capture` are NEVER selected (they may hold raw provider/error
 *     payloads — data-exposure invariant).
 *
 *     TWO conditions (FIX-SPINE C9, findings 1/2) keep this half correct:
 *       1. `execution_status = 'failed'` — NOT just `success = false`. Every
 *          freshly-created intent row (Hyperliquid; Agent Scan's own
 *          `createAgentActivityIntent`) starts `success = false` (the column
 *          DEFAULT) with `execution_status = 'intent'` until it completes —
 *          filtering on `success = false` alone would show every IN-FLIGHT
 *          intent as an already-failed transaction.
 *       2. `NOT EXISTS (... agent_activity WHERE protocol_execution_id = …)`
 *          — a Kyber/Uniswap swap execute's toolId IS in the failure-tool
 *          allowlist (its matrix `expectedType` derives to "spot" like any
 *          other spot tool) precisely so a failure that happened BEFORE any
 *          `agent_activity` row could be created still surfaces here. But
 *          once that row exists, `agent_activity` is the source of truth for
 *          THAT SAME execution — this half must not ALSO show it a second
 *          time under a different `source`.
 *
 *   FIX2-SPINE C20 (Codex final-review finding 5) — a `confirmed` row must
 *   NEVER display a quote-time human amount as if it were the settled truth.
 *   The SQL no longer COALESCEs executed/requested human amounts into a
 *   convenience column for the agent_activity half; it selects the raw
 *   executed/requested legs + token decimals (already needed for the
 *   granular fields below) and the TS mapper (`rawToHuman`, BigInt-safe via
 *   viem's `formatUnits`) derives `inputAmount`/`outputAmount` FROM the
 *   status: `confirmed` → executed raw only; `pending` → requested raw only
 *   (labelled via `amountBasis:"requested"` — nothing has settled yet, so
 *   showing the quote is honest, not settlement); any other status (i.e.
 *   `definitively_failed`) → no convenience amount at all, matching "quotes
 *   never masquerade as settlement" (there is no settlement AND the attempt
 *   is no longer in progress, so no display amount claims to represent
 *   truth).
 *
 * Filters: productType filters proj_activity.product_type on the success half
 * and the DERIVED PRODUCT (via the failure-tool allowlist, current + legacy)
 * on the failure half — NEVER trade_side. The agent_activity half has no
 * productType concept yet (kind is always 'swap' in phase 1, which derives to
 * "spot") and is excluded entirely for any other requested productType.
 * namespace + txHash filter all three halves where applicable. A null/empty
 * sessionId OMITS the failure half entirely (successes + agent_activity only)
 * — a failure feed is meaningless without a session to scope it to, and must
 * never leak another session's failures.
 *
 * Pagination: keyset over the tuple (created_at, sourceRank, id), DESC. The
 * cursor timestamp is the DB-side microsecond rendering of created_at (see
 * `transactions-cursor.ts`) so sub-millisecond ties paginate correctly. Fetches
 * limit+1 to detect `hasMore`; `nextCursor` is minted from the last KEPT row.
 *
 * Migrations: `030_transactions_indexes.sql`, `044_agent_activity.sql`.
 */

import { formatUnits } from "viem";

import { query } from "../client.js";
import {
  encodeCursor,
  type DecodedCursor,
} from "./transactions-cursor.js";
import {
  FAILURE_TOOL_PRODUCTS,
  failureToolsForProduct,
} from "./transactions-failure-tools.js";

export type TransactionSource = "agent_activity" | "success" | "failure";

/**
 * One bounded, camelCase row in the unified feed. Failure rows carry no
 * economics. Every field below `toolId` is additive over the original
 * (Stage 9) shape — populated on the `agent_activity` half only, `undefined`/
 * `null` elsewhere, so an existing reader that only knew the original fields
 * is unaffected.
 */
export interface TransactionRow {
  source: TransactionSource;
  id: number;
  namespace: string;
  productType: string;
  tradeSide?: string | null;
  chain?: string | null;
  /** Convenience: symbol-or-address (prefer the granular fields below for anything precise). */
  inputToken?: string | null;
  /**
   * agent_activity only (FIX2-SPINE C20) — derived from raw + decimals per
   * `amountBasis`: `confirmed` → executed truth; `pending` → the requested
   * quote (never settlement); any other status → `null` (no display value).
   */
  inputAmount?: string | null;
  outputToken?: string | null;
  outputAmount?: string | null;
  /** agent_activity only — which raw amount `inputAmount`/`outputAmount` was derived from, or `null` when neither applies (FIX2-SPINE C20). */
  amountBasis?: "executed" | "requested" | null;
  valueUsd?: number | null;
  captureStatus?: string | null;
  /** agent_activity: 'pending' | 'confirmed' | 'definitively_failed'. failure half: always 'failed'. */
  status?: string | null;
  /** agent_activity only — the closed failure_code enum (plan §4.1). */
  failureCode?: string | null;
  /** agent_activity only — sanitized (redact()+capped) failure detail. */
  failureReason?: string | null;
  /** agent_activity only — numeric chain id (explorer-link derivation). */
  chainId?: number | null;
  /** agent_activity only — provider slug (e.g. "kyberswap" | "uniswap"). */
  protocol?: string | null;
  toolId?: string | null;
  durationMs?: number | null;
  /** agent_activity: its own protocol_execution_id. success: proj_activity.execution_id. failure: its own id. */
  protocolExecutionId?: number | null;
  /** agent_activity only — position within the execution's event group. */
  eventIndex?: number | null;
  /** agent_activity only — 'allowance_reset' | 'allowance' | 'swap'. */
  eventRole?: string | null;
  tokenInAddress?: string | null;
  tokenInSymbol?: string | null;
  tokenInDecimals?: number | null;
  tokenOutAddress?: string | null;
  tokenOutSymbol?: string | null;
  tokenOutDecimals?: number | null;
  /** agent_activity only — quote-time REQUESTED legs (may be present even on a pre-broadcast failure). */
  amountInHuman?: string | null;
  amountInRaw?: string | null;
  amountOutHuman?: string | null;
  amountOutRaw?: string | null;
  /** agent_activity only — receipt-derived EXECUTED legs (confirmed rows only). */
  executedAmountInHuman?: string | null;
  executedAmountInRaw?: string | null;
  executedAmountOutHuman?: string | null;
  executedAmountOutRaw?: string | null;
  usdInEst?: string | null;
  usdOutEst?: string | null;
  usdFeeEst?: string | null;
  usdSource?: string | null;
  txHash: string | null;
  createdAt: string;
}

export interface GetTransactionsOptions {
  addresses: string[];
  sessionId: string | null;
  productType?: string;
  namespace?: string;
  txHash?: string;
  cursor?: DecodedCursor | null;
  limit: number;
}

export interface GetTransactionsResult {
  items: TransactionRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Always 'session' — failures are scoped to the current session only. */
  failuresScope: "session";
}

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

/**
 * Fetch the unified transaction feed for the session's wallet set. See module
 * doc for the half semantics, filters, and pagination contract.
 */
export async function getTransactions(opts: GetTransactionsOptions): Promise<GetTransactionsResult> {
  const { addresses, sessionId, productType, namespace, txHash, cursor, limit } = opts;
  const hasSession = typeof sessionId === "string" && sessionId.length > 0;

  // Empty wallet set → the agent_activity/success halves match nothing. The
  // failure half is session-scoped, not wallet-scoped, so it can still
  // surface rows; but with no wallets there is no portfolio context to report
  // against, so we keep the same fail-closed posture as the other
  // wallet-scoped views and return [].
  if (addresses.length === 0) {
    return { items: [], nextCursor: null, hasMore: false, failuresScope: "session" };
  }

  const params: unknown[] = [];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };

  // Cursor binds — shared across all halves so the keyset boundary is identical.
  const tsParam = cursor ? push(cursor.cursorTs) : 0;
  const rankParam = cursor ? push(cursor.sourceRank) : 0;
  const idParam = cursor ? push(cursor.id) : 0;

  // ── AGENT_ACTIVITY half (agent_activity) ──────────────────────────────
  const activityConds: string[] = [`wallet_address = ANY($${push(addresses)}::text[])`];
  if (namespace !== undefined) activityConds.push(`protocol = $${push(namespace)}`);
  if (txHash !== undefined) activityConds.push(`tx_hash = $${push(txHash)}`);
  // agent_activity.kind is always 'swap' this phase, which derives to the SAME
  // "spot" product the success half stores (TYPE_TO_PRODUCT convention) — a
  // productType filter for anything else must exclude this half entirely (no
  // param bind needed).
  if (productType !== undefined && productType !== "spot") activityConds.push("FALSE");
  const activityKeyset = keysetPredicate(0, cursor, tsParam, rankParam, idParam);

  const activityHalf = `
    SELECT
      'agent_activity'::text AS source,
      0 AS source_rank,
      id,
      protocol AS namespace,
      'spot'::text AS product_type,
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
      usd_source,
      tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM agent_activity
    WHERE ${activityConds.join(" AND ")} ${activityKeyset}`;

  const halves: string[] = [activityHalf];

  // ── SUCCESS half (proj_activity) ──────────────────────────────────────
  const successConds: string[] = [`wallet_address = ANY($${push(addresses)}::text[])`];
  if (productType !== undefined) successConds.push(`product_type = $${push(productType)}`);
  if (namespace !== undefined) successConds.push(`namespace = $${push(namespace)}`);
  if (txHash !== undefined) successConds.push(`external_refs->>'txHash' = $${push(txHash)}`);
  const successKeyset = keysetPredicate(1, cursor, tsParam, rankParam, idParam);

  halves.push(`
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
      NULL::text AS usd_source,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM proj_activity
    WHERE ${successConds.join(" AND ")} ${successKeyset}`);

  // ── FAILURE half (protocol_executions) ─────────────────────────────────
  // Omitted entirely without a session — never leak another session's failures.
  if (hasSession) {
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
    halves.push(`
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
      NULL::text AS usd_source,
      external_refs->>'txHash' AS tx_hash,
      created_at,
      ${CURSOR_TS_EXPR} AS cursor_ts
    FROM protocol_executions
    WHERE ${failConds.join(" AND ")} ${failureKeyset}`);
  }

  const limitParam = push(limit + 1);
  const sql = `${halves.join("\n    UNION ALL\n")}
    ORDER BY created_at DESC, source_rank DESC, id DESC
    LIMIT $${limitParam}`;

  const rows = await query<Record<string, unknown>>(sql, params);

  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const items = kept.map(mapRow);

  const lastKept = kept[kept.length - 1];
  const nextCursor = hasMore && lastKept !== undefined
    ? encodeCursor({
        cursorTs: lastKept.cursor_ts as string,
        sourceRank: normalizeSourceRank(lastKept.source_rank),
        id: Number(lastKept.id),
      })
    : null;

  return { items, nextCursor, hasMore, failuresScope: "session" };
}

function normalizeSourceRank(value: unknown): 0 | 1 | 2 {
  const n = Number(value);
  return n === 1 ? 1 : n === 2 ? 2 : 0;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string | null {
  return (value as string | null) ?? null;
}

/**
 * BigInt-safe raw→human conversion (FIX2-SPINE C20) — the ONLY place the
 * agent_activity half's display amount is computed; the SQL never does this
 * arithmetic (see module doc). Returns `null` when either input is
 * missing/malformed — a missing display amount is safer than a wrong one.
 */
function rawToHuman(raw: string | null, decimals: number | null): string | null {
  if (raw === null || decimals === null) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/**
 * Derive the agent_activity half's convenience amount fields from raw +
 * decimals per the row's status (FIX2-SPINE C20): `confirmed` → executed
 * truth only; `pending` → the requested quote only (labelled, never
 * settlement); anything else (`definitively_failed`) → no display amount —
 * the attempt is over and nothing settled, so no value here would be honest.
 */
function deriveDisplayAmounts(
  status: string | null,
  requestedInRaw: string | null,
  requestedOutRaw: string | null,
  executedInRaw: string | null,
  executedOutRaw: string | null,
  tokenInDecimals: number | null,
  tokenOutDecimals: number | null,
): { inputAmount: string | null; outputAmount: string | null; amountBasis: "executed" | "requested" | null } {
  if (status === "confirmed") {
    return {
      inputAmount: rawToHuman(executedInRaw, tokenInDecimals),
      outputAmount: rawToHuman(executedOutRaw, tokenOutDecimals),
      amountBasis: "executed",
    };
  }
  if (status === "pending") {
    return {
      inputAmount: rawToHuman(requestedInRaw, tokenInDecimals),
      outputAmount: rawToHuman(requestedOutRaw, tokenOutDecimals),
      amountBasis: "requested",
    };
  }
  return { inputAmount: null, outputAmount: null, amountBasis: null };
}

function mapRow(r: Record<string, unknown>): TransactionRow {
  const toolId = r.tool_id as string | null;

  if (r.source === "failure") {
    // Failure rows carry no per-leg economics. Derive the product from the
    // allowlist (current + legacy — matches what the success half stores /
    // what the tool used to store before deletion) so the model can group
    // both halves by the same productType. Unknown tools fall back to "unknown".
    const product = (toolId !== null && FAILURE_TOOL_PRODUCTS.get(toolId)) || "unknown";
    return {
      source: "failure",
      id: Number(r.id),
      namespace: r.namespace as string,
      productType: product,
      status: str(r.status) ?? "failed",
      toolId,
      durationMs: num(r.duration_ms),
      protocolExecutionId: num(r.protocol_execution_id),
      txHash: str(r.tx_hash),
      createdAt: toIso(r.created_at),
    };
  }

  if (r.source === "agent_activity") {
    const status = r.status as string | null;
    const { inputAmount, outputAmount, amountBasis } = deriveDisplayAmounts(
      status,
      str(r.amount_in_raw),
      str(r.amount_out_raw),
      str(r.executed_amount_in_raw),
      str(r.executed_amount_out_raw),
      num(r.token_in_decimals),
      num(r.token_out_decimals),
    );
    return {
      source: "agent_activity",
      id: Number(r.id),
      namespace: r.namespace as string,
      productType: r.product_type as string,
      chain: str(r.chain),
      inputToken: str(r.input_token),
      inputAmount,
      outputToken: str(r.output_token),
      outputAmount,
      amountBasis,
      valueUsd: num(r.value_usd),
      status,
      failureCode: str(r.failure_code),
      failureReason: str(r.failure_reason),
      chainId: num(r.chain_id),
      protocol: str(r.protocol),
      protocolExecutionId: num(r.protocol_execution_id),
      eventIndex: num(r.event_index),
      eventRole: str(r.event_role),
      tokenInAddress: str(r.token_in_address),
      tokenInSymbol: str(r.token_in_symbol),
      tokenInDecimals: num(r.token_in_decimals),
      tokenOutAddress: str(r.token_out_address),
      tokenOutSymbol: str(r.token_out_symbol),
      tokenOutDecimals: num(r.token_out_decimals),
      amountInHuman: str(r.amount_in_human),
      amountInRaw: str(r.amount_in_raw),
      amountOutHuman: str(r.amount_out_human),
      amountOutRaw: str(r.amount_out_raw),
      executedAmountInHuman: str(r.executed_amount_in_human),
      executedAmountInRaw: str(r.executed_amount_in_raw),
      executedAmountOutHuman: str(r.executed_amount_out_human),
      executedAmountOutRaw: str(r.executed_amount_out_raw),
      usdInEst: str(r.usd_in_est),
      usdOutEst: str(r.usd_out_est),
      usdFeeEst: str(r.usd_fee_est),
      usdSource: str(r.usd_source),
      txHash: str(r.tx_hash),
      createdAt: toIso(r.created_at),
    };
  }

  return {
    source: "success",
    id: Number(r.id),
    namespace: r.namespace as string,
    productType: r.product_type as string,
    tradeSide: str(r.trade_side),
    chain: str(r.chain),
    inputToken: str(r.input_token),
    inputAmount: str(r.input_amount),
    outputToken: str(r.output_token),
    outputAmount: str(r.output_amount),
    valueUsd: num(r.value_usd),
    captureStatus: str(r.capture_status),
    protocolExecutionId: num(r.protocol_execution_id),
    txHash: str(r.tx_hash),
    createdAt: toIso(r.created_at),
  };
}

// TIMESTAMPTZ comes back as a Date (node-postgres) or a string; normalise to ISO.
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
