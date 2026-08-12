import type { PoolClient } from "pg";

import { queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";
import type { LighterOrderPreviewRow } from "./lighter-order-previews.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import type {
  LighterTradingCredentialReadiness,
  LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";

export type LighterOrderApprovalStatus =
  | "approval_pending"
  | "approved"
  | "rejected"
  | "expired";

export type LighterOrderExecutionIntentState =
  | "previewed"
  | "approval_pending"
  | "signed"
  | "submitted"
  | "api_accepted"
  | "sequencer_pending"
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "ambiguous";

export interface LighterOrderExecutionIntentRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly previewId: string;
  readonly protocolExecutionId: number | null;
  readonly approvalId: string | null;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly orderType: "limit" | "market";
  readonly timeInForce: "good-till-time" | "immediate-or-cancel" | "post-only";
  readonly reduceOnly: boolean;
  readonly triggerPriceInteger: string | null;
  readonly orderExpiryMs: number;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly approvalStatus: LighterOrderApprovalStatus;
  readonly executionState: LighterOrderExecutionIntentState;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly nonceReservationId: string | null;
  readonly nonceValue: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface CreateLighterOrderExecutionIntentInput {
  readonly intentId: string;
  readonly preview: LighterOrderPreviewRow;
  readonly credentialReadiness: Extract<LighterTradingCredentialReadiness, { ready: true }>;
  readonly expiresAt: string;
  readonly protocolExecutionId?: number | null;
  readonly approvalId?: string | null;
}

export interface MarkLighterOrderApprovalDecisionInput {
  readonly intentId: string;
  readonly decision: "approved" | "rejected" | "expired";
  readonly approvalId?: string | null;
  readonly reason?: string | null;
}

export interface AttachLighterOrderNonceReservationInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly reservationId: string;
  readonly nonceValue: string;
}

const SELECT_COLUMNS =
  "intent_id, session_id, preview_id, protocol_execution_id, approval_id, match_hash, environment, " +
  "account_index, api_key_index, market_index, side, base_amount_integer, price_integer, " +
  "order_type, time_in_force, reduce_only, trigger_price_integer, order_expiry_ms, " +
  "client_order_index_policy, provider_version, credential_ref_json, approval_status, " +
  "execution_state, decision_reason, decided_at, nonce_reservation_id, nonce_value, " +
  "created_at, updated_at, expires_at";

const INSERT_SQL = `INSERT INTO lighter_order_execution_intents (
  intent_id, session_id, preview_id, protocol_execution_id, approval_id, match_hash, environment,
  account_index, api_key_index, market_index, side, base_amount_integer, price_integer,
  order_type, time_in_force, reduce_only, trigger_price_integer, order_expiry_ms,
  client_order_index_policy, provider_version, credential_ref_json, expires_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12, $13,
  $14, $15, $16, $17, $18,
  $19, $20, $21::jsonb, $22
) ON CONFLICT (intent_id) DO NOTHING
RETURNING ${SELECT_COLUMNS}`;

const MARK_APPROVAL_DECISION_SQL = `UPDATE lighter_order_execution_intents
   SET approval_status = $2,
       approval_id = COALESCE($3, approval_id),
       decision_reason = $4,
       decided_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND approval_status = 'approval_pending'
 RETURNING ${SELECT_COLUMNS}`;

const ATTACH_NONCE_RESERVATION_SQL = `UPDATE lighter_order_execution_intents
   SET nonce_reservation_id = $6,
       nonce_value = $7,
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND account_index = $4
   AND api_key_index = $5
   AND approval_status = 'approved'
   AND execution_state = 'approval_pending'
   AND nonce_reservation_id IS NULL
   AND nonce_value IS NULL
 RETURNING ${SELECT_COLUMNS}`;

export async function createApprovalPending(
  input: CreateLighterOrderExecutionIntentInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(INSERT_SQL, toCreateParams(input));
  return row ? mapRow(row) : null;
}

export async function createApprovalPendingWith(
  client: PoolClient,
  input: CreateLighterOrderExecutionIntentInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(client, INSERT_SQL, toCreateParams(input));
  return row ? mapRow(row) : null;
}

export async function markApprovalDecision(
  input: MarkLighterOrderApprovalDecisionInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_APPROVAL_DECISION_SQL,
    [
      input.intentId,
      input.decision,
      input.approvalId ?? null,
      input.reason ?? null,
    ],
  );
  return row ? mapRow(row) : null;
}

export async function attachNonceReservation(
  input: AttachLighterOrderNonceReservationInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    ATTACH_NONCE_RESERVATION_SQL,
    toAttachNonceReservationParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function attachNonceReservationWith(
  client: PoolClient,
  input: AttachLighterOrderNonceReservationInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    ATTACH_NONCE_RESERVATION_SQL,
    toAttachNonceReservationParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function findByIntentId(
  sessionId: string,
  intentId: string,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_execution_intents
      WHERE session_id = $1 AND intent_id = $2`,
    [sessionId, intentId],
  );
  return row ? mapRow(row) : null;
}

export async function findLiveByPreview(
  sessionId: string,
  previewId: string,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_execution_intents
      WHERE session_id = $1
        AND preview_id = $2
        AND approval_status IN ('approval_pending','approved')
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, previewId],
  );
  return row ? mapRow(row) : null;
}

function toCreateParams(input: CreateLighterOrderExecutionIntentInput): unknown[] {
  const { preview, credentialReadiness } = input;
  assertCredentialMatchesPreview(preview, credentialReadiness);
  return [
    input.intentId,
    preview.sessionId,
    preview.previewId,
    input.protocolExecutionId ?? null,
    input.approvalId ?? null,
    preview.matchHash,
    preview.environment,
    preview.accountIndex,
    preview.apiKeyIndex,
    preview.marketIndex,
    preview.side,
    preview.baseAmountInteger,
    preview.priceInteger,
    preview.orderType,
    preview.timeInForce,
    preview.reduceOnly,
    preview.triggerPriceInteger,
    preview.orderExpiryMs,
    preview.clientOrderIndexPolicy,
    preview.providerVersion,
    jsonb(credentialReadiness.reference),
    input.expiresAt,
  ];
}

function toAttachNonceReservationParams(input: AttachLighterOrderNonceReservationInput): unknown[] {
  if (input.reservationId.trim().length === 0) {
    throw new Error("lighter_order_execution_intents: reservationId is required");
  }
  if (!/^\d+$/.test(input.nonceValue) || BigInt(input.nonceValue) === 0n) {
    throw new Error("lighter_order_execution_intents: nonceValue must be a positive decimal integer");
  }
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    input.accountIndex,
    input.apiKeyIndex,
    input.reservationId,
    BigInt(input.nonceValue).toString(),
  ];
}

function assertCredentialMatchesPreview(
  preview: LighterOrderPreviewRow,
  credentialReadiness: Extract<LighterTradingCredentialReadiness, { ready: true }>,
): void {
  const { nonceScope } = credentialReadiness;
  if (preview.apiKeyIndex === null) {
    throw new Error("lighter_order_execution_intents: preview must include a trading apiKeyIndex");
  }
  if (
    preview.environment !== nonceScope.environment
    || preview.accountIndex !== nonceScope.accountIndex
    || preview.apiKeyIndex !== nonceScope.apiKeyIndex
  ) {
    throw new Error(
      "lighter_order_execution_intents: credential readiness must match preview environment/account/api-key",
    );
  }
}

function mapRow(row: Record<string, unknown>): LighterOrderExecutionIntentRow {
  return {
    intentId: row.intent_id as string,
    sessionId: row.session_id as string,
    previewId: row.preview_id as string,
    protocolExecutionId: row.protocol_execution_id === null || row.protocol_execution_id === undefined
      ? null
      : Number(row.protocol_execution_id),
    approvalId: (row.approval_id as string | null) ?? null,
    matchHash: row.match_hash as string,
    environment: row.environment as LighterEnvironment,
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    marketIndex: Number(row.market_index),
    side: row.side as "buy" | "sell",
    baseAmountInteger: row.base_amount_integer as string,
    priceInteger: row.price_integer as string,
    orderType: row.order_type as "limit" | "market",
    timeInForce: row.time_in_force as "good-till-time" | "immediate-or-cancel" | "post-only",
    reduceOnly: row.reduce_only as boolean,
    triggerPriceInteger: (row.trigger_price_integer as string | null) ?? null,
    orderExpiryMs: Number(row.order_expiry_ms),
    clientOrderIndexPolicy: row.client_order_index_policy as string,
    providerVersion: row.provider_version as string,
    credentialRefJson: row.credential_ref_json as LighterTradingCredentialVaultReference,
    approvalStatus: row.approval_status as LighterOrderApprovalStatus,
    executionState: row.execution_state as LighterOrderExecutionIntentState,
    decisionReason: (row.decision_reason as string | null) ?? null,
    decidedAt: toIsoOrNull(row.decided_at as string | Date | null | undefined),
    nonceReservationId: (row.nonce_reservation_id as string | null) ?? null,
    nonceValue: (row.nonce_value as string | null) ?? null,
    createdAt: toIso(row.created_at as string | Date),
    updatedAt: toIso(row.updated_at as string | Date),
    expiresAt: toIso(row.expires_at as string | Date),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
