/**
 * Activity repo — proj_activity CRUD.
 *
 * Unified cross-protocol activity feed.
 * One execution can have N activity rows (batch captures like predict.closeAll).
 */

import { query, queryOne, execute } from "../client.js";
import { jsonb } from "../params.js";

export interface ActivityRow {
  namespace: string;
  activityType: string;
  productType: string;
  tradeSide: string | null;
  chain: string;
  executionId: number;
  captureItemId: number | null;
  walletAddress: string | null;
  inputToken: string | null;
  inputAmount: string | null;
  outputToken: string | null;
  outputAmount: string | null;
  valueUsd: number | null;
  inputValueUsd: string | null;
  outputValueUsd: string | null;
  feeValueUsd: string | null;
  unitPriceUsd: string | null;
  valuationSource: string | null;
  benchmarkAssetKey: string | null;
  settlementAssetKey: string | null;
  inputValueNative: string | null;
  outputValueNative: string | null;
  captureStatus: string | null;
  positionKey: string | null;
  instrumentKey: string | null;
  externalRefs: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface Activity extends ActivityRow {
  id: number;
  createdAt: string;
}

/** Insert activity row. Returns 0 if insert failed. */
export async function insertActivity(row: ActivityRow): Promise<number> {
  const result = await queryOne<{ id: number }>(
    `INSERT INTO proj_activity
     (namespace, activity_type, product_type, trade_side, chain, execution_id, capture_item_id,
      wallet_address, input_token, input_amount, output_token, output_amount,
      value_usd, input_value_usd, output_value_usd, fee_value_usd, unit_price_usd, valuation_source,
      benchmark_asset_key, settlement_asset_key, input_value_native, output_value_native,
      capture_status, position_key, instrument_key, external_refs, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb, $27::jsonb)
     RETURNING id`,
    [
      row.namespace, row.activityType, row.productType, row.tradeSide, row.chain,
      row.executionId, row.captureItemId, row.walletAddress, row.inputToken, row.inputAmount,
      row.outputToken, row.outputAmount, row.valueUsd,
      row.inputValueUsd, row.outputValueUsd, row.feeValueUsd, row.unitPriceUsd, row.valuationSource,
      row.benchmarkAssetKey, row.settlementAssetKey, row.inputValueNative, row.outputValueNative,
      row.captureStatus, row.positionKey,
      row.instrumentKey, jsonb(row.externalRefs), jsonb(row.meta),
    ],
  );
  return result?.id ?? 0;
}

/**
 * Get activities with optional filters. `addresses` undefined → all wallets
 * (legacy/global); a set → only those (wallet_address = ANY); EMPTY set → []
 * (never global — Codex 5E-2).
 */
export async function getActivities(opts?: {
  addresses?: string[];
  namespace?: string;
  productType?: string;
  limit?: number;
}): Promise<Activity[]> {
  if (opts?.addresses !== undefined && opts.addresses.length === 0) return [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts?.addresses !== undefined) { conditions.push(`wallet_address = ANY($${idx++}::text[])`); params.push(opts.addresses); }
  if (opts?.namespace) { conditions.push(`namespace = $${idx++}`); params.push(opts.namespace); }
  if (opts?.productType) { conditions.push(`product_type = $${idx++}`); params.push(opts.productType); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;
  params.push(limit);

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM proj_activity ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    params,
  );
  return rows.map(mapRow);
}

/** Get activities by execution_id (batch captures produce multiple rows). */
export async function getByExecution(executionId: number): Promise<Activity[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM proj_activity WHERE execution_id = $1 ORDER BY id ASC",
    [executionId],
  );
  return rows.map(mapRow);
}

/** Get activities by position_key (for lifecycle tracking). */
export async function getByPositionKey(positionKey: string): Promise<Activity[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM proj_activity WHERE position_key = $1 ORDER BY created_at ASC",
    [positionKey],
  );
  return rows.map(mapRow);
}

/** Get activities by instrument_key (for lot tracking). */
export async function getByInstrumentKey(instrumentKey: string): Promise<Activity[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM proj_activity WHERE instrument_key = $1 ORDER BY created_at ASC",
    [instrumentKey],
  );
  return rows.map(mapRow);
}

export interface HyperliquidPerpTarget {
  readonly walletAddress: string;
  readonly positionKey: string;
  readonly instrumentKey: string | null;
  readonly captureStatus: string;
}

/** Latest tracked HL positions/resting entries that may still be live. */
export async function getActiveHyperliquidPerpTargets(): Promise<HyperliquidPerpTarget[]> {
  const rows = await query<{
    wallet_address: string;
    position_key: string;
    instrument_key: string | null;
    capture_status: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (position_key) position_key, wallet_address, instrument_key, capture_status
       FROM proj_activity
       WHERE namespace = 'hyperliquid'
         AND product_type = 'perps'
         AND position_key IS NOT NULL
         AND wallet_address IS NOT NULL
       ORDER BY position_key, created_at DESC, id DESC
     )
     SELECT wallet_address, position_key, instrument_key, capture_status
     FROM latest
     WHERE capture_status IN ('open', 'pending', 'executed')`,
  );
  return rows.map((row) => ({
    walletAddress: row.wallet_address,
    positionKey: row.position_key,
    instrumentKey: row.instrument_key,
    captureStatus: row.capture_status,
  }));
}

/** Wallet-only projection used by the websocket lifecycle. */
export async function getActiveHyperliquidPerpWallets(): Promise<string[]> {
  return [...new Set((await getActiveHyperliquidPerpTargets()).map((target) => target.walletAddress))];
}

/** Last session that established a tracked position, used only for a safe wake/notice. */
export async function getLatestSessionIdForPosition(positionKey: string): Promise<string | null> {
  const row = await queryOne<{ session_id: string | null }>(
    `SELECT execution.session_id
     FROM proj_activity AS activity
     JOIN protocol_executions AS execution ON execution.id = activity.execution_id
     WHERE activity.position_key = $1
       AND execution.session_id IS NOT NULL
     ORDER BY activity.created_at DESC, activity.id DESC
     LIMIT 1`,
    [positionKey],
  );
  return row?.session_id ?? null;
}

/**
 * Distinct hex EVM token addresses this wallet has traded on a given chain —
 * the "tracked tokens" the direct-RPC balance sync scans in addition to the
 * seed set (LOCKED Wave-2 correction #1). Derived from SUCCESSFUL `proj_activity`
 * rows only: the activity populator writes rows exclusively from successful
 * captures (a failed swap never emits `_tradeCapture`), and this deliberately
 * does NOT touch `protocol_executions` (which includes failures) or parse
 * `instrument_key`.
 *
 * Filters (exactly the locked query spec): product_type='spot' + wallet scope +
 * chain match (against the chain's `activityChainKeys`, case-insensitive) + a
 * hex-address shape guard on input_token/output_token (drops symbol-only legs).
 */
export async function getTrackedEvmTokensForChain(opts: {
  walletAddress: string;
  /** Lowercased `_tradeCapture.chain` candidates for the target chain. */
  chainKeys: string[];
}): Promise<string[]> {
  if (opts.chainKeys.length === 0) return [];
  const rows = await query<{ token: string }>(
    `SELECT DISTINCT token FROM (
       SELECT input_token AS token FROM proj_activity
        WHERE product_type = 'spot'
          AND wallet_address = $1
          AND LOWER(chain) = ANY($2::text[])
          AND input_token ~* '^0x[0-9a-f]{40}$'
       UNION
       SELECT output_token AS token FROM proj_activity
        WHERE product_type = 'spot'
          AND wallet_address = $1
          AND LOWER(chain) = ANY($2::text[])
          AND output_token ~* '^0x[0-9a-f]{40}$'
     ) t
     WHERE token IS NOT NULL`,
    [opts.walletAddress, opts.chainKeys],
  );
  return rows.map((r) => r.token);
}

function mapRow(r: Record<string, unknown>): Activity {
  const inputValueUsd = r.input_value_usd != null ? String(r.input_value_usd) : null;
  const outputValueUsd = r.output_value_usd != null ? String(r.output_value_usd) : null;
  // Backwards compat: valueUsd computed from new fields
  const legacyValueUsd = r.value_usd != null ? Number(r.value_usd)
    : outputValueUsd != null ? Number(outputValueUsd)
    : inputValueUsd != null ? Number(inputValueUsd)
    : null;

  return {
    id: r.id as number,
    namespace: r.namespace as string,
    activityType: r.activity_type as string,
    productType: r.product_type as string,
    tradeSide: r.trade_side as string | null,
    chain: r.chain as string,
    executionId: r.execution_id as number,
    captureItemId: r.capture_item_id as number | null,
    walletAddress: r.wallet_address as string | null,
    inputToken: r.input_token as string | null,
    inputAmount: r.input_amount as string | null,
    outputToken: r.output_token as string | null,
    outputAmount: r.output_amount as string | null,
    valueUsd: legacyValueUsd,
    inputValueUsd,
    outputValueUsd,
    feeValueUsd: r.fee_value_usd != null ? String(r.fee_value_usd) : null,
    unitPriceUsd: r.unit_price_usd != null ? String(r.unit_price_usd) : null,
    valuationSource: r.valuation_source as string | null,
    benchmarkAssetKey: r.benchmark_asset_key as string | null,
    settlementAssetKey: r.settlement_asset_key as string | null,
    inputValueNative: r.input_value_native != null ? String(r.input_value_native) : null,
    outputValueNative: r.output_value_native != null ? String(r.output_value_native) : null,
    captureStatus: r.capture_status as string | null,
    positionKey: r.position_key as string | null,
    instrumentKey: r.instrument_key as string | null,
    externalRefs: (r.external_refs as Record<string, unknown>) ?? {},
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}
