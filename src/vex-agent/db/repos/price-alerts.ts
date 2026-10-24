/**
 * Watchlist items and price alerts (migration 184, F01).
 *
 * Plain async functions over the engine DB client. The rules (which chain,
 * which value, which limit) live in `@vex-agent/alerts/service`; this module
 * only reads and writes rows, with two guarantees of its own:
 *
 *   - LIMITS UNDER ONE LOCK. Every count-then-insert runs in one transaction
 *     behind `pg_advisory_xact_lock` on {@link PRICE_ALERTS_LOCK_KEY}, so the
 *     chat tool and the Watchlist page cannot both pass a limit at once.
 *   - REPLAYS FIND THE ROW. Adding a followed token again returns the row that
 *     exists; setting an active alert again (same asset, condition and value)
 *     returns the alert that already waits instead of a second one.
 *
 * NUMERIC columns come back from `pg` as strings, which is what the decimal
 * code wants; nothing here turns a price into a `Number`.
 */

import type pg from "pg";

import { execute, query, queryOne, withTransaction } from "../client.js";

/** One advisory lock for both tables: the limits are checked under it. */
export const PRICE_ALERTS_LOCK_KEY = "vex.f01.price_alerts";

export type PriceAlertStatus = "active" | "triggered" | "cancelled";
export type PriceAlertOrigin = "chat" | "app";

export interface WatchlistItemRow {
  readonly id: string;
  readonly chain: string;
  readonly address: string;
  readonly assetKey: string;
  readonly label: string;
  readonly createdAt: string;
}

export interface PriceAlertRow {
  readonly id: string;
  readonly chain: string;
  readonly address: string;
  readonly assetKey: string;
  readonly label: string;
  readonly condition: "above" | "below" | "rises_pct" | "falls_pct";
  /** What the user said: a USD price or a percent, plain decimal text. */
  readonly value: string;
  readonly referencePrice: string;
  readonly triggerPrice: string;
  readonly direction: "above" | "below";
  readonly note: string | null;
  readonly origin: PriceAlertOrigin;
  readonly sessionId: string | null;
  readonly status: PriceAlertStatus;
  readonly triggeredAt: string | null;
  readonly triggeredPrice: string | null;
  readonly acknowledgedAt: string | null;
  readonly createdAt: string;
}

interface WatchlistDbRow extends pg.QueryResultRow {
  id: string;
  chain: string;
  address: string;
  asset_key: string;
  label: string;
  created_at: Date;
}

interface AlertDbRow extends pg.QueryResultRow {
  id: string;
  chain: string;
  address: string;
  asset_key: string;
  label: string;
  condition: PriceAlertRow["condition"];
  value: string;
  reference_price: string;
  trigger_price: string;
  direction: PriceAlertRow["direction"];
  note: string | null;
  origin: PriceAlertOrigin;
  session_id: string | null;
  status: PriceAlertStatus;
  triggered_at: Date | null;
  triggered_price: string | null;
  acknowledged_at: Date | null;
  created_at: Date;
}

const ALERT_COLUMNS = `id, chain, address, asset_key, label, condition,
  value::text AS value, reference_price::text AS reference_price,
  trigger_price::text AS trigger_price, direction, note, origin, session_id,
  status, triggered_at, triggered_price::text AS triggered_price,
  acknowledged_at, created_at`;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toWatchlistItem(row: WatchlistDbRow): WatchlistItemRow {
  return {
    id: row.id,
    chain: row.chain,
    address: row.address,
    assetKey: row.asset_key,
    label: row.label,
    createdAt: row.created_at.toISOString(),
  };
}

function toAlert(row: AlertDbRow): PriceAlertRow {
  return {
    id: row.id,
    chain: row.chain,
    address: row.address,
    assetKey: row.asset_key,
    label: row.label,
    condition: row.condition,
    value: row.value,
    referencePrice: row.reference_price,
    triggerPrice: row.trigger_price,
    direction: row.direction,
    note: row.note,
    origin: row.origin,
    sessionId: row.session_id,
    status: row.status,
    triggeredAt: iso(row.triggered_at),
    triggeredPrice: row.triggered_price,
    acknowledgedAt: iso(row.acknowledged_at),
    createdAt: row.created_at.toISOString(),
  };
}

async function lockPriceAlerts(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [PRICE_ALERTS_LOCK_KEY]);
}

// ── Watchlist ───────────────────────────────────────────────────────

export async function listWatchlist(): Promise<WatchlistItemRow[]> {
  const rows = await query<WatchlistDbRow>(
    "SELECT id, chain, address, asset_key, label, created_at FROM watchlist_items ORDER BY created_at, id",
  );
  return rows.map(toWatchlistItem);
}

export interface NewWatchlistItem {
  readonly chain: string;
  readonly address: string;
  readonly assetKey: string;
  readonly label: string;
}

export type AddWatchlistItemResult =
  | { readonly ok: true; readonly item: WatchlistItemRow; readonly created: boolean }
  | { readonly ok: false; readonly reason: "watchlist_full" };

/** Follow a token; an asset already followed returns its row (`created: false`). */
export async function addWatchlistItem(input: NewWatchlistItem, limit: number): Promise<AddWatchlistItemResult> {
  return withTransaction(async (client) => {
    await lockPriceAlerts(client);
    const existing = await client.query<WatchlistDbRow>(
      "SELECT id, chain, address, asset_key, label, created_at FROM watchlist_items WHERE asset_key = $1",
      [input.assetKey],
    );
    const found = existing.rows[0];
    if (found !== undefined) return { ok: true, item: toWatchlistItem(found), created: false };
    const counted = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM watchlist_items");
    if (Number(counted.rows[0]?.n ?? "0") >= limit) return { ok: false, reason: "watchlist_full" };
    const inserted = await client.query<WatchlistDbRow>(
      `INSERT INTO watchlist_items (asset_kind, chain, address, asset_key, label)
       VALUES ('token', $1, $2, $3, $4)
       RETURNING id, chain, address, asset_key, label, created_at`,
      [input.chain, input.address, input.assetKey, input.label],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("watchlist insert returned no row");
    return { ok: true, item: toWatchlistItem(row), created: true };
  });
}

/** Stop following a token. `false` when it was not followed. */
export async function removeWatchlistItem(assetKey: string): Promise<boolean> {
  return (await execute("DELETE FROM watchlist_items WHERE asset_key = $1", [assetKey])) > 0;
}

// ── Alerts ──────────────────────────────────────────────────────────

export interface ListAlertsOptions {
  readonly status: PriceAlertStatus;
  readonly limit?: number;
}

/** Active alerts oldest first; done alerts newest first (by fire time, then creation). */
export async function listAlerts(options: ListAlertsOptions): Promise<PriceAlertRow[]> {
  const order = options.status === "active"
    ? "created_at, id"
    : "triggered_at DESC NULLS LAST, created_at DESC, id";
  const rows = await query<AlertDbRow>(
    `SELECT ${ALERT_COLUMNS} FROM price_alerts WHERE status = $1 ORDER BY ${order} LIMIT $2`,
    [options.status, options.limit ?? 100],
  );
  return rows.map(toAlert);
}

export async function getAlert(id: string): Promise<PriceAlertRow | null> {
  const row = await queryOne<AlertDbRow>(`SELECT ${ALERT_COLUMNS} FROM price_alerts WHERE id = $1`, [id]);
  return row === null ? null : toAlert(row);
}

export interface NewPriceAlert {
  readonly chain: string;
  readonly address: string;
  readonly assetKey: string;
  readonly label: string;
  readonly condition: PriceAlertRow["condition"];
  readonly value: string;
  readonly referencePrice: string;
  readonly triggerPrice: string;
  readonly direction: PriceAlertRow["direction"];
  readonly note: string | null;
  readonly origin: PriceAlertOrigin;
  readonly sessionId: string | null;
}

export type CreateAlertResult =
  | { readonly ok: true; readonly alert: PriceAlertRow; readonly created: boolean }
  | { readonly ok: false; readonly reason: "too_many_alerts" };

/**
 * Store a new active alert, or return the active alert that already waits on
 * the same asset, condition and value (`created: false`). Counts and inserts
 * under the feature lock.
 */
export async function createAlert(input: NewPriceAlert, limit: number): Promise<CreateAlertResult> {
  return withTransaction(async (client) => {
    await lockPriceAlerts(client);
    const existing = await client.query<AlertDbRow>(
      `SELECT ${ALERT_COLUMNS} FROM price_alerts
        WHERE status = 'active' AND asset_key = $1 AND condition = $2 AND value = $3::numeric`,
      [input.assetKey, input.condition, input.value],
    );
    const found = existing.rows[0];
    if (found !== undefined) return { ok: true, alert: toAlert(found), created: false };
    const counted = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM price_alerts WHERE status = 'active'",
    );
    if (Number(counted.rows[0]?.n ?? "0") >= limit) return { ok: false, reason: "too_many_alerts" };
    // The session may have been deleted between the tool call and this write;
    // a dangling id is stored as NULL rather than failing the alert.
    const inserted = await client.query<AlertDbRow>(
      `INSERT INTO price_alerts (
         asset_kind, chain, address, asset_key, label, condition, value,
         reference_price, trigger_price, direction, note, origin, session_id)
       VALUES ('token', $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11,
               (SELECT id FROM sessions WHERE id = $12))
       RETURNING ${ALERT_COLUMNS}`,
      [
        input.chain,
        input.address,
        input.assetKey,
        input.label,
        input.condition,
        input.value,
        input.referencePrice,
        input.triggerPrice,
        input.direction,
        input.note,
        input.origin,
        input.sessionId,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("price alert insert returned no row");
    return { ok: true, alert: toAlert(row), created: true };
  });
}

/** Cancel an ACTIVE alert. `null` when there was none to cancel. */
export async function cancelAlert(id: string): Promise<PriceAlertRow | null> {
  const row = await queryOne<AlertDbRow>(
    `UPDATE price_alerts SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING ${ALERT_COLUMNS}`,
    [id],
  );
  return row === null ? null : toAlert(row);
}

/** The poller's read: active alerts, oldest first, bounded. */
export async function listActiveForPoll(limit: number): Promise<PriceAlertRow[]> {
  return listAlerts({ status: "active", limit });
}

/**
 * The claim: mark one alert fired at `price`, only if it is still active.
 * `null` means it was cancelled or already fired, and the caller must not
 * announce it.
 */
export async function claimTriggered(id: string, price: string, at: Date): Promise<PriceAlertRow | null> {
  const row = await queryOne<AlertDbRow>(
    `UPDATE price_alerts
        SET status = 'triggered', triggered_at = $3, triggered_price = $2::numeric, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING ${ALERT_COLUMNS}`,
    [id, price, at],
  );
  return row === null ? null : toAlert(row);
}

/** Fired alerts the user has not closed yet, newest first. */
export async function listUnacknowledgedFired(limit: number): Promise<PriceAlertRow[]> {
  const rows = await query<AlertDbRow>(
    `SELECT ${ALERT_COLUMNS} FROM price_alerts
      WHERE status = 'triggered' AND acknowledged_at IS NULL
      ORDER BY triggered_at DESC, id LIMIT $1`,
    [limit],
  );
  return rows.map(toAlert);
}

/** Mark fired alerts seen. Returns how many changed. */
export async function acknowledgeFired(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return execute(
    `UPDATE price_alerts SET acknowledged_at = now(), updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'triggered' AND acknowledged_at IS NULL`,
    [ids],
  );
}

/** Remove fired alerts from the Fired list. Returns how many were removed. */
export async function clearFired(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return execute("DELETE FROM price_alerts WHERE id = ANY($1::uuid[]) AND status = 'triggered'", [ids]);
}
