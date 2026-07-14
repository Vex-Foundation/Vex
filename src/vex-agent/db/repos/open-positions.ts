/**
 * Open positions repo — proj_open_positions.
 *
 * Tracks lifecycle of perps, predictions, DCA/limit orders, LP positions.
 * Upsert by (namespace, position_type, external_id).
 */

import { query, queryOne, execute } from "../client.js";
import { jsonb } from "../params.js";

export interface Position {
  id: number;
  namespace: string;
  positionType: string;
  chain: string;
  externalId: string | null;
  walletAddress: string;
  instrumentKey: string | null;
  positionKey: string | null;
  entryPriceUsd: string | null;
  currentValueUsd: string | null;
  unrealizedPnlUsd: string | null;
  notionalUsd: string | null;
  feeUsd: string | null;
  contracts: string | null;
  settlementAssetKey: string | null;
  data: Record<string, unknown>;
  status: string;
  openedAt: string | null;
  closedAt: string | null;
}

export interface UpsertPositionRow {
  namespace: string;
  positionType: string;
  chain: string;
  externalId: string;
  walletAddress: string;
  instrumentKey?: string;
  positionKey?: string;
  entryPriceUsd?: string;
  currentValueUsd?: string;
  unrealizedPnlUsd?: string;
  notionalUsd?: string;
  feeUsd?: string;
  contracts?: string;
  settlementAssetKey?: string;
  data?: Record<string, unknown>;
  status?: string;
}

/**
 * Upsert position — ON CONFLICT updates status, capture-derived MTM, and data.
 *
 * $9/$10 (current_value_usd / unrealized_pnl_usd, both NUMERIC) are cast to
 * ::numeric inside every `CASE WHEN $n IS NULL` use. Without the cast Postgres
 * cannot infer the parameter type from an `IS NULL` test alone, so PREPARE
 * failed with `could not determine data type of parameter $9` and NO perps
 * projection row was ever written — the empty POSITIONS panel in the live app
 * (incident 2026-07-13). The cast pins the type to the real column type.
 */
export async function upsertPosition(row: UpsertPositionRow): Promise<void> {
  await execute(
    `INSERT INTO proj_open_positions (namespace, position_type, chain, external_id, wallet_address, instrument_key, position_key, entry_price_usd, current_value_usd, unrealized_pnl_usd, notional_usd, fee_usd, contracts, settlement_asset_key, data, status, opened_at, last_refresh_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, NOW(), CASE WHEN $9::numeric IS NULL AND $10::numeric IS NULL THEN NULL ELSE NOW() END)
     ON CONFLICT (namespace, position_type, chain, wallet_address, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET status = COALESCE($16, proj_open_positions.status),
       data = COALESCE($15::jsonb, proj_open_positions.data),
       instrument_key = COALESCE($6, proj_open_positions.instrument_key),
       position_key = COALESCE($7, proj_open_positions.position_key),
       entry_price_usd = COALESCE($8, proj_open_positions.entry_price_usd),
       current_value_usd = COALESCE($9, proj_open_positions.current_value_usd),
       unrealized_pnl_usd = COALESCE($10, proj_open_positions.unrealized_pnl_usd),
       notional_usd = COALESCE($11, proj_open_positions.notional_usd),
       fee_usd = COALESCE($12, proj_open_positions.fee_usd),
       contracts = COALESCE($13, proj_open_positions.contracts),
       settlement_asset_key = COALESCE($14, proj_open_positions.settlement_asset_key),
       last_refresh_at = CASE WHEN $9::numeric IS NULL AND $10::numeric IS NULL THEN proj_open_positions.last_refresh_at ELSE NOW() END,
       synced_at = NOW()`,
    [row.namespace, row.positionType, row.chain, row.externalId, row.walletAddress,
     row.instrumentKey ?? null, row.positionKey ?? null, row.entryPriceUsd ?? null,
     row.currentValueUsd ?? null, row.unrealizedPnlUsd ?? null,
     row.notionalUsd ?? null, row.feeUsd ?? null,
     row.contracts ?? null, row.settlementAssetKey ?? null,
     jsonb(row.data ?? {}), row.status ?? "open"],
  );
}

/**
 * Close a position by marking status and closed_at. Nulls out MTM fields.
 * Keyed on the full position identity (namespace, type, chain, wallet,
 * external_id) — matching the unique index — so one wallet's close never
 * touches another wallet's same-external_id position (puzzle 5 phase 5E-1).
 */
export async function closePosition(
  namespace: string,
  positionType: string,
  chain: string,
  walletAddress: string,
  externalId: string,
  status = "closed",
): Promise<boolean> {
  const n = await execute(
    "UPDATE proj_open_positions SET status = $6, closed_at = NOW(), current_value_usd = NULL, unrealized_pnl_usd = NULL, last_refresh_at = NULL, synced_at = NOW() WHERE namespace = $1 AND position_type = $2 AND chain = $3 AND wallet_address = $4 AND external_id = $5 AND status = 'open'",
    [namespace, positionType, chain, walletAddress, externalId, status],
  );
  return n > 0;
}

/**
 * Get open positions, optionally scoped to a wallet set. `addresses` undefined →
 * all wallets (legacy/global); a set → only those; EMPTY set → [] (never
 * global — Codex 5E-2).
 */
export async function getOpen(addresses?: string[], namespace?: string): Promise<Position[]> {
  if (addresses !== undefined && addresses.length === 0) return [];
  const conditions: string[] = ["status = 'open'"];
  const params: unknown[] = [];
  let idx = 1;

  if (addresses !== undefined) { conditions.push(`wallet_address = ANY($${idx++}::text[])`); params.push(addresses); }
  if (namespace) { conditions.push(`namespace = $${idx++}`); params.push(namespace); }

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM proj_open_positions WHERE ${conditions.join(" AND ")} ORDER BY opened_at DESC`,
    params,
  );
  return rows.map(mapRow);
}

/** Get position by position_key. */
export async function getByPositionKey(positionKey: string): Promise<Position | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM proj_open_positions WHERE position_key = $1 AND status = 'open' LIMIT 1",
    [positionKey],
  );
  return row ? mapRow(row) : null;
}

/**
 * Get a position by position_key REGARDLESS of status (open OR closed). The S5
 * outcome resolver needs the CLOSED state too (a closed position is the resolved
 * outcome of a perps/prediction/order anchor), which `getByPositionKey`
 * deliberately hides. Returns the most-recently-opened matching row, or null.
 */
export async function getByPositionKeyAnyStatus(positionKey: string): Promise<Position | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM proj_open_positions WHERE position_key = $1 ORDER BY opened_at DESC NULLS LAST, id DESC LIMIT 1",
    [positionKey],
  );
  return row ? mapRow(row) : null;
}

function mapRow(r: Record<string, unknown>): Position {
  return {
    id: r.id as number,
    namespace: r.namespace as string,
    positionType: r.position_type as string,
    chain: r.chain as string,
    externalId: r.external_id as string | null,
    walletAddress: r.wallet_address as string,
    instrumentKey: r.instrument_key as string | null,
    positionKey: r.position_key as string | null,
    entryPriceUsd: r.entry_price_usd != null ? String(r.entry_price_usd) : null,
    currentValueUsd: r.current_value_usd != null ? String(r.current_value_usd) : null,
    unrealizedPnlUsd: r.unrealized_pnl_usd != null ? String(r.unrealized_pnl_usd) : null,
    notionalUsd: r.notional_usd != null ? String(r.notional_usd) : null,
    feeUsd: r.fee_usd != null ? String(r.fee_usd) : null,
    contracts: r.contracts != null ? String(r.contracts) : null,
    settlementAssetKey: r.settlement_asset_key as string | null,
    data: (r.data as Record<string, unknown>) ?? {},
    status: r.status as string,
    openedAt: r.opened_at as string | null,
    closedAt: r.closed_at as string | null,
  };
}
