import { execute, queryOne } from "../client.js";
import { jsonb } from "../params.js";
import type {
  LighterOrderPreview,
  LighterOrderSide,
  LighterOrderTimeInForce,
  LighterOrderType,
} from "@tools/lighter/order-preview.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";

export interface LighterOrderPreviewRow {
  readonly previewId: string;
  readonly sessionId: string;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number | null;
  readonly marketIndex: number;
  readonly side: LighterOrderSide;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly orderType: LighterOrderType;
  readonly timeInForce: LighterOrderTimeInForce;
  readonly reduceOnly: boolean;
  readonly triggerPriceInteger: string | null;
  readonly orderExpiryMs: number;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
  readonly previewJson: Record<string, unknown>;
  readonly liveSourceJson: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateLighterOrderPreviewInput {
  readonly preview: LighterOrderPreview;
  readonly liveSourceJson: Record<string, unknown>;
}

const SELECT_COLUMNS =
  "preview_id, session_id, match_hash, environment, account_index, api_key_index, " +
  "market_index, side, base_amount_integer, price_integer, order_type, time_in_force, " +
  "reduce_only, trigger_price_integer, order_expiry_ms, client_order_index_policy, " +
  "provider_version, preview_json, live_source_json, created_at, expires_at";

const INSERT_SQL = `INSERT INTO lighter_order_previews (
  preview_id, session_id, match_hash, environment, account_index, api_key_index,
  market_index, side, base_amount_integer, price_integer, order_type, time_in_force,
  reduce_only, trigger_price_integer, order_expiry_ms, client_order_index_policy,
  provider_version, preview_json, live_source_json, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20)
ON CONFLICT (preview_id) DO NOTHING`;

export async function create(input: CreateLighterOrderPreviewInput): Promise<void> {
  const { preview } = input;
  await execute(INSERT_SQL, [
    preview.previewId,
    preview.identity.sessionId,
    preview.matchHash,
    preview.identity.environment,
    Number(preview.identity.accountIndex),
    preview.identity.apiKeyIndex.length === 0 ? null : Number(preview.identity.apiKeyIndex),
    Number(preview.identity.marketIndex),
    preview.identity.side,
    preview.identity.baseAmountInteger,
    preview.identity.priceInteger,
    preview.identity.orderType,
    preview.identity.timeInForce,
    preview.identity.reduceOnly === "1",
    preview.identity.triggerPriceInteger.length === 0 ? null : preview.identity.triggerPriceInteger,
    Number(preview.identity.expiryMs),
    preview.identity.clientOrderIndexPolicy,
    preview.identity.providerVersion,
    jsonb(preview.preview),
    jsonb(input.liveSourceJson),
    preview.expiresAt,
  ]);
}

export async function findLatestFreshByMatch(
  sessionId: string,
  environment: LighterEnvironment,
  matchHash: string,
): Promise<LighterOrderPreviewRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_previews
      WHERE session_id = $1
        AND environment = $2
        AND match_hash = $3
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, environment, matchHash],
  );
  return row ? mapRow(row) : null;
}

export async function findFreshById(
  sessionId: string,
  environment: LighterEnvironment,
  previewId: string,
): Promise<LighterOrderPreviewRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_previews
      WHERE session_id = $1
        AND environment = $2
        AND preview_id = $3
        AND expires_at > NOW()
      LIMIT 1`,
    [sessionId, environment, previewId],
  );
  return row ? mapRow(row) : null;
}

export async function findById(
  sessionId: string,
  environment: LighterEnvironment,
  previewId: string,
): Promise<LighterOrderPreviewRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_previews
      WHERE session_id = $1 AND environment = $2 AND preview_id = $3
      LIMIT 1`,
    [sessionId, environment, previewId],
  );
  return row ? mapRow(row) : null;
}

export async function findLatestFresh(
  sessionId: string,
  environment: LighterEnvironment,
): Promise<LighterOrderPreviewRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_previews
      WHERE session_id = $1
        AND environment = $2
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, environment],
  );
  return row ? mapRow(row) : null;
}

function mapRow(row: Record<string, unknown>): LighterOrderPreviewRow {
  return {
    previewId: row.preview_id as string,
    sessionId: row.session_id as string,
    matchHash: row.match_hash as string,
    environment: row.environment as LighterEnvironment,
    accountIndex: Number(row.account_index),
    apiKeyIndex: row.api_key_index === null || row.api_key_index === undefined
      ? null
      : Number(row.api_key_index),
    marketIndex: Number(row.market_index),
    side: row.side as LighterOrderSide,
    baseAmountInteger: row.base_amount_integer as string,
    priceInteger: row.price_integer as string,
    orderType: row.order_type as LighterOrderType,
    timeInForce: row.time_in_force as LighterOrderTimeInForce,
    reduceOnly: row.reduce_only as boolean,
    triggerPriceInteger: (row.trigger_price_integer as string | null) ?? null,
    orderExpiryMs: Number(row.order_expiry_ms),
    clientOrderIndexPolicy: row.client_order_index_policy as string,
    providerVersion: row.provider_version as string,
    previewJson: (row.preview_json as Record<string, unknown>) ?? {},
    liveSourceJson: (row.live_source_json as Record<string, unknown>) ?? {},
    createdAt: toIso(row.created_at as string | Date),
    expiresAt: toIso(row.expires_at as string | Date),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
