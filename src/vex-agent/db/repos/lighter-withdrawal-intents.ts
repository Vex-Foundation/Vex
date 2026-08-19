import type { PoolClient } from "pg";

import type { LighterCoreWithdrawalPreview } from "@tools/lighter/withdrawal/core-preview.js";
import type {
  LighterTradingCredentialReadiness,
  LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";

export type LighterWithdrawalApprovalStatus =
  | "approval_pending"
  | "approved"
  | "rejected"
  | "expired";

export type LighterWithdrawalExecutionState =
  | "approval_pending"
  | "approved"
  | "nonce_reserved"
  | "signed"
  | "submission_staged"
  | "api_accepted"
  | "l2_pending"
  | "l2_executed"
  | "secure_waiting"
  | "claimable"
  | "auto_claim_observed"
  | "manual_claim_prepared"
  | "manual_claim_approved"
  | "manual_claim_staged"
  | "manual_claim_submitted"
  | "destination_confirmed"
  | "rejected"
  | "failed"
  | "refunded"
  | "expired"
  | "ambiguous";

export interface LighterWithdrawalIntentRow {
  readonly intentId: string;
  readonly previewId: string;
  readonly sessionId: string;
  readonly protocolExecutionId: number | null;
  readonly approvalId: string | null;
  readonly matchHash: string;
  readonly environment: "core";
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: 304;
  readonly settlementChainId: 1;
  readonly settlementNetworkName: "Ethereum mainnet";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly walletAddress: string;
  readonly destinationAddress: string;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDC";
  readonly assetDecimals: 6;
  readonly settlementTokenAddress: string;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly minimumWithdrawalUnits: string;
  readonly availableBalanceUnits: string;
  readonly collateralUnits: string;
  readonly initialMarginUnits: string;
  readonly maintenanceMarginUnits: string;
  readonly pendingOrderCount: number;
  readonly openPositionCount: number;
  readonly activeOrderCount: number;
  readonly gatewayAddress: string;
  readonly gatewayImplementation: string;
  readonly gatewayCodeHash: string;
  readonly settlementTokenCodeHash: string;
  readonly preflightJson: Record<string, unknown>;
  readonly preflightObservedAt: string;
  readonly preSubmitRevalidationJson: Record<string, unknown> | null;
  readonly preSubmitRevalidatedAt: string | null;
  readonly withdrawalDelaySeconds: number;
  readonly delayObservedAt: string;
  readonly approvalStatus: LighterWithdrawalApprovalStatus;
  readonly executionState: LighterWithdrawalExecutionState;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly nonceReservationId: string | null;
  readonly nonceValue: string | null;
  readonly signerTxHash: string | null;
  readonly submittedTxHash: string | null;
  readonly signerExpiryMs: number | null;
  readonly submitCode: number | null;
  readonly submitMessage: string | null;
  readonly predictedExecutionTimeMs: number | null;
  readonly volumeQuotaRemaining: string | null;
  readonly providerTxStatus: number | null;
  readonly providerTxEvidenceJson: Record<string, unknown> | null;
  readonly withdrawalHistoryId: string | null;
  readonly withdrawalHistoryStatus: string | null;
  readonly withdrawalHistoryJson: Record<string, unknown> | null;
  readonly pendingBalanceUnits: string | null;
  readonly ambiguousReason: string | null;
  readonly claimMode: "auto" | "manual" | "legacy" | null;
  readonly claimApprovalId: string | null;
  readonly claimTxHash: string | null;
  readonly claimReplacementTxHash: string | null;
  readonly destinationTxHash: string | null;
  readonly destinationBlockNumber: string | null;
  readonly destinationBlockHash: string | null;
  readonly destinationConfirmations: number | null;
  readonly destinationEvidenceJson: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface CreateLighterWithdrawalIntentInput {
  readonly intentId: string;
  readonly preview: LighterCoreWithdrawalPreview;
  readonly credentialReadiness: Extract<LighterTradingCredentialReadiness, { ready: true }>;
  readonly protocolExecutionId?: number | null;
}

export type CreateLighterWithdrawalIntentOutcome =
  | { readonly outcome: "created"; readonly intent: LighterWithdrawalIntentRow }
  | { readonly outcome: "existing"; readonly intent: LighterWithdrawalIntentRow }
  | { readonly outcome: "live_conflict"; readonly intent: LighterWithdrawalIntentRow };

const SELECT_COLUMNS = `
  intent_id, preview_id, session_id, protocol_execution_id, approval_id, match_hash,
  environment, operation_class, endpoint, signing_chain_id, settlement_chain_id,
  settlement_network_name, account_index, api_key_index, wallet_address,
  destination_address, credential_ref_json, asset_index, asset_symbol, asset_decimals,
  settlement_token_address, route_type, amount_units, minimum_withdrawal_units,
  available_balance_units, collateral_units, initial_margin_units,
  maintenance_margin_units, pending_order_count, open_position_count,
  active_order_count, gateway_address, gateway_implementation, gateway_code_hash,
  settlement_token_code_hash, preflight_json, preflight_observed_at,
  pre_submit_revalidation_json, pre_submit_revalidated_at, withdrawal_delay_seconds,
  delay_observed_at, approval_status, execution_state, decision_reason, decided_at,
  nonce_reservation_id, nonce_value, signer_tx_hash, submitted_tx_hash,
  signer_expiry_ms, submit_code, submit_message, predicted_execution_time_ms,
  volume_quota_remaining, provider_tx_status, provider_tx_evidence_json,
  withdrawal_history_id, withdrawal_history_status, withdrawal_history_json,
  pending_balance_units, ambiguous_reason, claim_mode, claim_approval_id,
  claim_tx_hash, claim_replacement_tx_hash, destination_tx_hash,
  destination_block_number, destination_block_hash, destination_confirmations,
  destination_evidence_json, created_at, updated_at, expires_at`;

const INSERT_SQL = `INSERT INTO lighter_withdrawal_intents (
  intent_id, preview_id, session_id, protocol_execution_id, match_hash,
  environment, operation_class, endpoint, signing_chain_id, settlement_chain_id,
  settlement_network_name, account_index, api_key_index, wallet_address,
  destination_address, credential_ref_json, asset_index, asset_symbol, asset_decimals,
  settlement_token_address, route_type, amount_units, minimum_withdrawal_units,
  available_balance_units, collateral_units, initial_margin_units,
  maintenance_margin_units, pending_order_count, open_position_count,
  active_order_count, gateway_address, gateway_implementation, gateway_code_hash,
  settlement_token_code_hash, preflight_json, preflight_observed_at,
  withdrawal_delay_seconds, delay_observed_at, pending_balance_units, expires_at
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10,
  $11, $12, $13, $14,
  $15, $16::jsonb, $17, $18, $19,
  $20, $21, $22, $23,
  $24, $25, $26,
  $27, $28, $29,
  $30, $31, $32, $33,
  $34, $35::jsonb, $36,
  $37, $38, $39, $40
) ON CONFLICT DO NOTHING
RETURNING ${SELECT_COLUMNS}`;

export async function createOrFindLiveApprovalPendingWith(
  client: PoolClient,
  input: CreateLighterWithdrawalIntentInput,
): Promise<CreateLighterWithdrawalIntentOutcome> {
  assertCredentialMatchesPreview(input.preview, input.credentialReadiness);
  const created = await queryOneWith<Record<string, unknown>>(client, INSERT_SQL, createParams(input));
  if (created !== null) return { outcome: "created", intent: mapRow(created) };

  const samePreview = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE session_id = $1 AND preview_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.preview.identity.sessionId, input.preview.previewId],
  );
  if (samePreview !== null) return { outcome: "existing", intent: mapRow(samePreview) };

  const snapshot = input.preview.snapshot;
  const conflict = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE environment = 'core'
        AND account_index = $1
        AND asset_index = 3
        AND route_type = 0
        AND execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ORDER BY created_at DESC
      LIMIT 1`,
    [snapshot.accountIndex],
  );
  if (conflict === null) {
    throw new Error("Core withdrawal intent insert was not persisted and no conflicting row was found.");
  }
  return { outcome: "live_conflict", intent: mapRow(conflict) };
}

export async function findByIntentId(
  sessionId: string,
  intentId: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE session_id = $1 AND intent_id = $2`,
    [sessionId, intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLatestForSession(
  sessionId: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId],
  );
  return row === null ? null : mapRow(row);
}

function createParams(input: CreateLighterWithdrawalIntentInput): unknown[] {
  const preview = input.preview;
  const snapshot = preview.snapshot;
  return [
    input.intentId,
    preview.previewId,
    preview.identity.sessionId,
    input.protocolExecutionId ?? null,
    preview.matchHash,
    snapshot.environment,
    snapshot.operationClass,
    snapshot.endpoint,
    snapshot.signingChainId,
    snapshot.settlementChainId,
    snapshot.settlementNetworkName,
    snapshot.accountIndex,
    snapshot.apiKeyIndex,
    snapshot.walletAddress,
    snapshot.destinationAddress,
    jsonb(input.credentialReadiness.reference),
    snapshot.assetIndex,
    snapshot.assetSymbol,
    snapshot.assetDecimals,
    snapshot.settlementTokenAddress,
    snapshot.routeType,
    snapshot.amountUnits,
    snapshot.minimumWithdrawalUnits,
    snapshot.availableBalanceUnits,
    snapshot.collateralUnits,
    snapshot.initialMarginRequirementUnits,
    snapshot.maintenanceMarginRequirementUnits,
    snapshot.pendingOrderCount,
    snapshot.openPositionCount,
    snapshot.activeOrderCount,
    snapshot.gatewayAddress,
    snapshot.gatewayImplementationAddress,
    snapshot.gatewayCodeHash,
    snapshot.settlementTokenCodeHash,
    jsonb(snapshot),
    snapshot.observedAt,
    snapshot.withdrawalDelaySeconds,
    snapshot.delayObservedAt,
    snapshot.pendingBalanceUnits,
    snapshot.expiresAt,
  ];
}

function assertCredentialMatchesPreview(
  preview: LighterCoreWithdrawalPreview,
  readiness: Extract<LighterTradingCredentialReadiness, { ready: true }>,
): void {
  const snapshot = preview.snapshot;
  if (
    readiness.nonceScope.environment !== "core"
    || readiness.nonceScope.accountIndex !== snapshot.accountIndex
    || readiness.nonceScope.apiKeyIndex !== snapshot.apiKeyIndex
  ) {
    throw new Error("Core withdrawal credential scope does not match the immutable preview.");
  }
}

function mapRow(row: Record<string, unknown>): LighterWithdrawalIntentRow {
  return {
    intentId: String(row.intent_id),
    previewId: String(row.preview_id),
    sessionId: String(row.session_id),
    protocolExecutionId: nullableNumber(row.protocol_execution_id),
    approvalId: nullableString(row.approval_id),
    matchHash: String(row.match_hash),
    environment: "core",
    operationClass: "secure_l2_withdrawal",
    endpoint: String(row.endpoint),
    signingChainId: 304,
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    walletAddress: String(row.wallet_address),
    destinationAddress: String(row.destination_address),
    credentialRefJson: row.credential_ref_json as LighterTradingCredentialVaultReference,
    assetIndex: 3,
    assetSymbol: "USDC",
    assetDecimals: 6,
    settlementTokenAddress: String(row.settlement_token_address),
    routeType: 0,
    amountUnits: String(row.amount_units),
    minimumWithdrawalUnits: String(row.minimum_withdrawal_units),
    availableBalanceUnits: String(row.available_balance_units),
    collateralUnits: String(row.collateral_units),
    initialMarginUnits: String(row.initial_margin_units),
    maintenanceMarginUnits: String(row.maintenance_margin_units),
    pendingOrderCount: Number(row.pending_order_count),
    openPositionCount: Number(row.open_position_count),
    activeOrderCount: Number(row.active_order_count),
    gatewayAddress: String(row.gateway_address),
    gatewayImplementation: String(row.gateway_implementation),
    gatewayCodeHash: String(row.gateway_code_hash),
    settlementTokenCodeHash: String(row.settlement_token_code_hash),
    preflightJson: row.preflight_json as Record<string, unknown>,
    preflightObservedAt: iso(row.preflight_observed_at),
    preSubmitRevalidationJson: nullableObject(row.pre_submit_revalidation_json),
    preSubmitRevalidatedAt: nullableIso(row.pre_submit_revalidated_at),
    withdrawalDelaySeconds: Number(row.withdrawal_delay_seconds),
    delayObservedAt: iso(row.delay_observed_at),
    approvalStatus: row.approval_status as LighterWithdrawalApprovalStatus,
    executionState: row.execution_state as LighterWithdrawalExecutionState,
    decisionReason: nullableString(row.decision_reason),
    decidedAt: nullableIso(row.decided_at),
    nonceReservationId: nullableString(row.nonce_reservation_id),
    nonceValue: nullableString(row.nonce_value),
    signerTxHash: nullableString(row.signer_tx_hash),
    submittedTxHash: nullableString(row.submitted_tx_hash),
    signerExpiryMs: nullableNumber(row.signer_expiry_ms),
    submitCode: nullableNumber(row.submit_code),
    submitMessage: nullableString(row.submit_message),
    predictedExecutionTimeMs: nullableNumber(row.predicted_execution_time_ms),
    volumeQuotaRemaining: nullableString(row.volume_quota_remaining),
    providerTxStatus: nullableNumber(row.provider_tx_status),
    providerTxEvidenceJson: nullableObject(row.provider_tx_evidence_json),
    withdrawalHistoryId: nullableString(row.withdrawal_history_id),
    withdrawalHistoryStatus: nullableString(row.withdrawal_history_status),
    withdrawalHistoryJson: nullableObject(row.withdrawal_history_json),
    pendingBalanceUnits: nullableString(row.pending_balance_units),
    ambiguousReason: nullableString(row.ambiguous_reason),
    claimMode: row.claim_mode as "auto" | "manual" | "legacy" | null,
    claimApprovalId: nullableString(row.claim_approval_id),
    claimTxHash: nullableString(row.claim_tx_hash),
    claimReplacementTxHash: nullableString(row.claim_replacement_tx_hash),
    destinationTxHash: nullableString(row.destination_tx_hash),
    destinationBlockNumber: nullableString(row.destination_block_number),
    destinationBlockHash: nullableString(row.destination_block_hash),
    destinationConfirmations: nullableNumber(row.destination_confirmations),
    destinationEvidenceJson: nullableObject(row.destination_evidence_json),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableObject(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : value as Record<string, unknown>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
