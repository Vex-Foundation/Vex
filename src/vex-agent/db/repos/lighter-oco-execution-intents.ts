import type { PoolClient } from "pg";

import type { LighterOcoPreview } from "@tools/lighter/oco-order.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import type {
  LighterTradingCredentialReadiness,
  LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { query, queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";

export type LighterOcoExecutionState =
  | "approval_pending"
  | "signed"
  | "submitted"
  | "api_accepted"
  | "sequencer_pending"
  | "active"
  | "resolved"
  | "rejected"
  | "ambiguous";

export interface LighterOcoExecutionIntentRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly approvalId: string | null;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
  readonly baseAmountInteger: string;
  readonly stopLossPreviewId: string;
  readonly stopLossMatchHash: string;
  readonly stopLossPriceInteger: string;
  readonly stopLossTriggerPriceInteger: string;
  readonly takeProfitPreviewId: string;
  readonly takeProfitMatchHash: string;
  readonly takeProfitPriceInteger: string;
  readonly takeProfitTriggerPriceInteger: string;
  readonly orderExpiryMs: number;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
  readonly previewJson: Record<string, unknown>;
  readonly liveSourceJson: Record<string, unknown>;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly approvalStatus: "approval_pending" | "approved" | "rejected" | "expired";
  readonly executionState: LighterOcoExecutionState;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly preSubmitRevalidationJson: Record<string, unknown> | null;
  readonly preSubmitRevalidatedAt: string | null;
  readonly nonceReservationId: string | null;
  readonly nonceValue: string | null;
  readonly stopLossClientOrderIndex: string | null;
  readonly takeProfitClientOrderIndex: string | null;
  readonly signerTxHash: string | null;
  readonly submittedTxHash: string | null;
  readonly submitCode: number | null;
  readonly submitMessage: string | null;
  readonly predictedExecutionTimeMs: number | null;
  readonly volumeQuotaRemaining: string | null;
  readonly providerOutcomeJson: Record<string, unknown> | null;
  readonly providerOutcomeCheckedAt: string | null;
  readonly ambiguousReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

const COLUMNS = `
  intent_id, session_id, approval_id, match_hash, environment, account_index,
  api_key_index, market_index, side, base_amount_integer,
  stop_loss_preview_id, stop_loss_match_hash, stop_loss_price_integer,
  stop_loss_trigger_price_integer, take_profit_preview_id, take_profit_match_hash,
  take_profit_price_integer, take_profit_trigger_price_integer, order_expiry_ms,
  client_order_index_policy, provider_version, preview_json, live_source_json,
  credential_ref_json, approval_status, execution_state, decision_reason, decided_at,
  pre_submit_revalidation_json, pre_submit_revalidated_at, nonce_reservation_id,
  nonce_value, stop_loss_client_order_index, take_profit_client_order_index,
  signer_tx_hash, submitted_tx_hash, submit_code, submit_message,
  predicted_execution_time_ms, volume_quota_remaining, provider_outcome_json,
  provider_outcome_checked_at, ambiguous_reason, created_at, updated_at, expires_at`;

export async function createApprovalPendingWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly preview: LighterOcoPreview;
    readonly liveSourceJson: Record<string, unknown>;
    readonly credentialReadiness: Extract<LighterTradingCredentialReadiness, { ready: true }>;
    readonly expiresAt: string;
  },
): Promise<LighterOcoExecutionIntentRow | null> {
  const p = input.preview;
  const trigger = (leg: LighterOcoPreview["stopLoss"], name: string): string => {
    const value = leg.preview.triggerPrice.integer;
    if (value === null) throw new Error(`${name} trigger price is missing`);
    return value;
  };
  const row = await queryOneWith<Record<string, unknown>>(client, `
    INSERT INTO lighter_oco_execution_intents (
      intent_id, session_id, match_hash, environment, account_index, api_key_index,
      market_index, side, base_amount_integer, stop_loss_preview_id,
      stop_loss_match_hash, stop_loss_price_integer, stop_loss_trigger_price_integer,
      take_profit_preview_id, take_profit_match_hash, take_profit_price_integer,
      take_profit_trigger_price_integer, order_expiry_ms, client_order_index_policy,
      provider_version, preview_json, live_source_json, credential_ref_json, expires_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21::jsonb,$22::jsonb,$23::jsonb,$24
    ) ON CONFLICT (intent_id) DO NOTHING RETURNING ${COLUMNS}`,
  [
    input.intentId, p.identity.sessionId, p.matchHash, p.identity.environment,
    Number(p.identity.accountIndex), Number(p.identity.apiKeyIndex),
    Number(p.identity.marketIndex), p.identity.side, p.identity.baseAmountInteger,
    p.stopLoss.previewId, p.stopLoss.matchHash, p.stopLoss.preview.price.integer,
    trigger(p.stopLoss, "stop-loss"), p.takeProfit.previewId, p.takeProfit.matchHash,
    p.takeProfit.preview.price.integer, trigger(p.takeProfit, "take-profit"),
    Number(p.identity.expiryMs), p.stopLoss.identity.clientOrderIndexPolicy,
    p.identity.providerVersion, jsonb(p.preview), jsonb(input.liveSourceJson),
    jsonb(input.credentialReadiness.reference), input.expiresAt,
  ]);
  return row === null ? null : mapRow(row);
}

export async function findByIntentId(
  sessionId: string,
  intentId: string,
): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_oco_execution_intents WHERE session_id=$1 AND intent_id=$2`,
    [sessionId, intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findByIntentIdAnySession(
  intentId: string,
): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_oco_execution_intents WHERE intent_id=$1`,
    [intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLiveByMatch(
  sessionId: string,
  matchHash: string,
): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_oco_execution_intents
      WHERE session_id=$1 AND match_hash=$2 AND approval_status IN ('approval_pending','approved')
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId, matchHash],
  );
  return row === null ? null : mapRow(row);
}

export async function markApprovalDecision(input: {
  readonly intentId: string;
  readonly decision: "approved" | "rejected" | "expired";
  readonly approvalId: string;
  readonly reason: string;
}): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_oco_execution_intents SET approval_status=$2, approval_id=$3,
      execution_state=CASE WHEN $2='approved' THEN execution_state ELSE 'rejected' END,
      decision_reason=$4, decided_at=NOW(), updated_at=NOW()
      WHERE intent_id=$1 AND approval_status='approval_pending' AND execution_state='approval_pending'
      RETURNING ${COLUMNS}`,
    [input.intentId, input.decision, input.approvalId, input.reason],
  );
  return row === null ? null : mapRow(row);
}

export async function markPreSubmitRevalidated(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly evidence: Record<string, unknown>;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents
      SET pre_submit_revalidation_json=$4::jsonb, pre_submit_revalidated_at=NOW(), updated_at=NOW()
      WHERE intent_id=$1 AND session_id=$2 AND environment=$3
        AND approval_status='approved' AND execution_state='approval_pending'
        AND pre_submit_revalidation_json IS NULL AND nonce_reservation_id IS NULL
      RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, jsonb(input.evidence)]);
}

export async function attachNonceReservationWith(client: PoolClient, input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly reservationId: string;
  readonly nonceValue: string;
}): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(client, `UPDATE lighter_oco_execution_intents
      SET nonce_reservation_id=$6, nonce_value=$7, updated_at=NOW()
      WHERE intent_id=$1 AND session_id=$2 AND environment=$3 AND account_index=$4 AND api_key_index=$5
        AND approval_status='approved' AND execution_state='approval_pending'
        AND pre_submit_revalidation_json IS NOT NULL AND nonce_reservation_id IS NULL
      RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.accountIndex, input.apiKeyIndex,
    input.reservationId, input.nonceValue]);
  return row === null ? null : mapRow(row);
}

export async function markSigned(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly reservationId: string;
  readonly nonceValue: string;
  readonly stopLossClientOrderIndex: string;
  readonly takeProfitClientOrderIndex: string;
  readonly signerTxHash: string;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state='signed',
      stop_loss_client_order_index=$6, take_profit_client_order_index=$7,
      signer_tx_hash=$8, updated_at=NOW()
      WHERE intent_id=$1 AND session_id=$2 AND environment=$3 AND approval_status='approved'
        AND execution_state='approval_pending' AND nonce_reservation_id=$4 AND nonce_value=$5
        AND stop_loss_client_order_index IS NULL AND take_profit_client_order_index IS NULL
        AND signer_tx_hash IS NULL RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.reservationId, input.nonceValue,
    input.stopLossClientOrderIndex, input.takeProfitClientOrderIndex, input.signerTxHash]);
}

export async function markSubmitted(input: {
  readonly intentId: string; readonly sessionId: string; readonly environment: LighterEnvironment;
  readonly signerTxHash: string;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state='submitted', updated_at=NOW()
    WHERE intent_id=$1 AND session_id=$2 AND environment=$3 AND execution_state='signed'
      AND signer_tx_hash=$4 RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.signerTxHash]);
}

export async function markApiAccepted(input: {
  readonly intentId: string; readonly sessionId: string; readonly environment: LighterEnvironment;
  readonly signerTxHash: string; readonly submittedTxHash: string; readonly submitCode: number;
  readonly submitMessage: string | null; readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining?: number | null;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state='api_accepted',
      submitted_tx_hash=$5, submit_code=$6, submit_message=$7,
      predicted_execution_time_ms=$8, volume_quota_remaining=$9, updated_at=NOW()
    WHERE intent_id=$1 AND session_id=$2 AND environment=$3 AND execution_state='submitted'
      AND signer_tx_hash=$4 AND submitted_tx_hash IS NULL RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.signerTxHash,
    input.submittedTxHash, input.submitCode, input.submitMessage,
    input.predictedExecutionTimeMs, input.volumeQuotaRemaining ?? null]);
}

export async function markSequencerPending(input: {
  readonly intentId: string; readonly sessionId: string; readonly environment: LighterEnvironment;
  readonly evidence?: Record<string, unknown>;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state='sequencer_pending',
      provider_outcome_json=COALESCE($4::jsonb, provider_outcome_json),
      provider_outcome_checked_at=CASE WHEN $4::jsonb IS NULL THEN provider_outcome_checked_at ELSE NOW() END,
      updated_at=NOW()
    WHERE intent_id=$1 AND session_id=$2 AND environment=$3
      AND execution_state IN ('api_accepted','sequencer_pending') RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment,
    input.evidence === undefined ? null : jsonb(input.evidence)]);
}

export async function markProviderOutcome(input: {
  readonly intentId: string; readonly sessionId: string; readonly environment: LighterEnvironment;
  readonly state: "active" | "resolved" | "rejected" | "sequencer_pending";
  readonly evidence: Record<string, unknown>;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state=$4,
      provider_outcome_json=$5::jsonb, provider_outcome_checked_at=NOW(), updated_at=NOW()
    WHERE intent_id=$1 AND session_id=$2 AND environment=$3
      AND execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous','active') RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.state, jsonb(input.evidence)]);
}

export async function markAmbiguous(input: {
  readonly intentId: string; readonly sessionId: string; readonly environment: LighterEnvironment;
  readonly reason: string;
}): Promise<LighterOcoExecutionIntentRow | null> {
  return transition(`UPDATE lighter_oco_execution_intents SET execution_state='ambiguous',
      ambiguous_reason=$4, updated_at=NOW()
    WHERE intent_id=$1 AND session_id=$2 AND environment=$3
      AND execution_state NOT IN ('active','resolved','rejected') RETURNING ${COLUMNS}`,
  [input.intentId, input.sessionId, input.environment, input.reason]);
}

export async function listUnresolved(
  environment?: LighterEnvironment,
  limit = 10,
): Promise<LighterOcoExecutionIntentRow[]> {
  const values = environment === undefined ? [limit] : [environment, limit];
  const where = environment === undefined ? "" : "AND environment=$1";
  const limitParam = environment === undefined ? "$1" : "$2";
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_oco_execution_intents
      WHERE execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous')
      ${where} ORDER BY updated_at ASC LIMIT ${limitParam}`,
    values,
  );
  return rows.map(mapRow);
}

async function transition(
  sql: string,
  values: readonly unknown[],
): Promise<LighterOcoExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(sql, [...values]);
  return row === null ? null : mapRow(row);
}

function mapRow(row: Record<string, unknown>): LighterOcoExecutionIntentRow {
  const nullableRecord = (value: unknown): Record<string, unknown> | null =>
    value === null || value === undefined ? null : value as Record<string, unknown>;
  const iso = (value: unknown): string | null => value === null || value === undefined
    ? null
    : value instanceof Date ? value.toISOString() : String(value);
  return {
    intentId: String(row.intent_id), sessionId: String(row.session_id),
    approvalId: row.approval_id == null ? null : String(row.approval_id),
    matchHash: String(row.match_hash), environment: row.environment as LighterEnvironment,
    accountIndex: Number(row.account_index), apiKeyIndex: Number(row.api_key_index),
    marketIndex: Number(row.market_index), side: row.side as "buy" | "sell",
    baseAmountInteger: String(row.base_amount_integer),
    stopLossPreviewId: String(row.stop_loss_preview_id), stopLossMatchHash: String(row.stop_loss_match_hash),
    stopLossPriceInteger: String(row.stop_loss_price_integer),
    stopLossTriggerPriceInteger: String(row.stop_loss_trigger_price_integer),
    takeProfitPreviewId: String(row.take_profit_preview_id), takeProfitMatchHash: String(row.take_profit_match_hash),
    takeProfitPriceInteger: String(row.take_profit_price_integer),
    takeProfitTriggerPriceInteger: String(row.take_profit_trigger_price_integer),
    orderExpiryMs: Number(row.order_expiry_ms), clientOrderIndexPolicy: String(row.client_order_index_policy),
    providerVersion: String(row.provider_version), previewJson: row.preview_json as Record<string, unknown>,
    liveSourceJson: row.live_source_json as Record<string, unknown>,
    credentialRefJson: row.credential_ref_json as LighterTradingCredentialVaultReference,
    approvalStatus: row.approval_status as LighterOcoExecutionIntentRow["approvalStatus"],
    executionState: row.execution_state as LighterOcoExecutionState,
    decisionReason: row.decision_reason == null ? null : String(row.decision_reason),
    decidedAt: iso(row.decided_at), preSubmitRevalidationJson: nullableRecord(row.pre_submit_revalidation_json),
    preSubmitRevalidatedAt: iso(row.pre_submit_revalidated_at),
    nonceReservationId: row.nonce_reservation_id == null ? null : String(row.nonce_reservation_id),
    nonceValue: row.nonce_value == null ? null : String(row.nonce_value),
    stopLossClientOrderIndex: row.stop_loss_client_order_index == null ? null : String(row.stop_loss_client_order_index),
    takeProfitClientOrderIndex: row.take_profit_client_order_index == null ? null : String(row.take_profit_client_order_index),
    signerTxHash: row.signer_tx_hash == null ? null : String(row.signer_tx_hash),
    submittedTxHash: row.submitted_tx_hash == null ? null : String(row.submitted_tx_hash),
    submitCode: row.submit_code == null ? null : Number(row.submit_code),
    submitMessage: row.submit_message == null ? null : String(row.submit_message),
    predictedExecutionTimeMs: row.predicted_execution_time_ms == null ? null : Number(row.predicted_execution_time_ms),
    volumeQuotaRemaining: row.volume_quota_remaining == null ? null : String(row.volume_quota_remaining),
    providerOutcomeJson: nullableRecord(row.provider_outcome_json), providerOutcomeCheckedAt: iso(row.provider_outcome_checked_at),
    ambiguousReason: row.ambiguous_reason == null ? null : String(row.ambiguous_reason),
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, expiresAt: iso(row.expires_at)!,
  };
}
