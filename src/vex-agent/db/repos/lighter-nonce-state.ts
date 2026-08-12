import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import type { LighterEnvironment } from "@tools/lighter/types.js";
import { execute, queryOne, queryOneWith } from "../client.js";

export const LIGHTER_NONCE_SOURCE = "live_lighter_public_api";

export type LighterNonceStatus = "observed" | "reserved" | "submitted" | "ambiguous";

export interface LighterNonceStateRow {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly providerNonce: string;
  readonly publicKey: string;
  readonly providerTransactionTime: string | null;
  readonly status: LighterNonceStatus;
  readonly reservedNonce: string | null;
  readonly reservationId: string | null;
  readonly source: string;
  readonly observedAt: string;
  readonly updatedAt: string;
}

export interface RecordObservedLighterNonceInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: number;
  readonly publicKey: string;
  readonly transactionTime?: number | null;
  readonly observedAt?: Date;
}

export interface ReserveObservedLighterNonceInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly reservationId?: string;
}

const SELECT_COLUMNS =
  "environment, account_index, api_key_index, provider_nonce, public_key, " +
  "provider_transaction_time, status, reserved_nonce, reservation_id, source, observed_at, updated_at";

export async function recordObserved(input: RecordObservedLighterNonceInput): Promise<void> {
  const providerNonce = exactSafeIntegerString(input.nonce, "nonce");
  const transactionTime = input.transactionTime === undefined || input.transactionTime === null
    ? null
    : exactSafeIntegerString(input.transactionTime, "transactionTime");
  if (input.publicKey.trim().length === 0) {
    throw new Error("lighter_nonce_state: publicKey is required");
  }

  await execute(
    `INSERT INTO lighter_nonce_state (
      environment, account_index, api_key_index, provider_nonce, public_key,
      provider_transaction_time, source, observed_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), NOW())
    ON CONFLICT (environment, account_index, api_key_index) DO UPDATE SET
      provider_nonce = EXCLUDED.provider_nonce,
      public_key = EXCLUDED.public_key,
      provider_transaction_time = EXCLUDED.provider_transaction_time,
      source = EXCLUDED.source,
      observed_at = EXCLUDED.observed_at,
      updated_at = NOW()
    WHERE lighter_nonce_state.status = 'observed'`,
    [
      input.environment,
      input.accountIndex,
      input.apiKeyIndex,
      providerNonce,
      input.publicKey,
      transactionTime,
      LIGHTER_NONCE_SOURCE,
      input.observedAt?.toISOString() ?? null,
    ],
  );
}

export async function reserveObserved(
  input: ReserveObservedLighterNonceInput,
): Promise<LighterNonceStateRow | null> {
  return reserveObservedWithQuery(
    (sql, params) => queryOne<Record<string, unknown>>(sql, params),
    input,
  );
}

export async function reserveObservedWith(
  client: PoolClient,
  input: ReserveObservedLighterNonceInput,
): Promise<LighterNonceStateRow | null> {
  return reserveObservedWithQuery(
    (sql, params) => queryOneWith<Record<string, unknown>>(client, sql, params),
    input,
  );
}

async function reserveObservedWithQuery(
  run: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>,
  input: ReserveObservedLighterNonceInput,
): Promise<LighterNonceStateRow | null> {
  const reservationId = input.reservationId ?? randomUUID();
  const row = await run(
    `UPDATE lighter_nonce_state
      SET status = 'reserved',
          reserved_nonce = provider_nonce,
          reservation_id = $4,
          updated_at = NOW()
      WHERE environment = $1
        AND account_index = $2
        AND api_key_index = $3
        AND status = 'observed'
      RETURNING ${SELECT_COLUMNS}`,
    [input.environment, input.accountIndex, input.apiKeyIndex, reservationId],
  );
  return row ? mapRow(row) : null;
}

export async function find(
  environment: LighterEnvironment,
  accountIndex: number,
  apiKeyIndex: number,
): Promise<LighterNonceStateRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_nonce_state
      WHERE environment = $1 AND account_index = $2 AND api_key_index = $3`,
    [environment, accountIndex, apiKeyIndex],
  );
  return row ? mapRow(row) : null;
}

export function exactSafeIntegerString(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`lighter_nonce_state: ${field} must be a safe non-negative integer`);
  }
  return String(value);
}

function mapRow(row: Record<string, unknown>): LighterNonceStateRow {
  return {
    environment: row.environment as LighterEnvironment,
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    providerNonce: row.provider_nonce as string,
    publicKey: row.public_key as string,
    providerTransactionTime: (row.provider_transaction_time as string | null) ?? null,
    status: row.status as LighterNonceStatus,
    reservedNonce: (row.reserved_nonce as string | null) ?? null,
    reservationId: (row.reservation_id as string | null) ?? null,
    source: row.source as string,
    observedAt: toIso(row.observed_at as string | Date),
    updatedAt: toIso(row.updated_at as string | Date),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
