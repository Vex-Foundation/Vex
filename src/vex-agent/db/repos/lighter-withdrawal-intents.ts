import type { PoolClient } from "pg";

import type { LighterCoreWithdrawalPreview } from "@tools/lighter/withdrawal/core-preview.js";
import type { LighterRhcWithdrawalPreview } from "@tools/lighter/withdrawal/rhc-preview.js";
import { getLighterSecureWithdrawalProfile } from "@tools/lighter/withdrawal/profiles.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type {
  LighterTradingCredentialReadiness,
  LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { query, queryOne, queryOneWith } from "../client.js";
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
  readonly environment: LighterEnvironment;
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: 304 | 466324;
  readonly settlementChainId: 1 | 4663;
  readonly settlementNetworkName: "Ethereum mainnet" | "Robinhood Chain mainnet";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly walletAddress: string;
  readonly destinationAddress: string;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDC" | "USDG";
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
  readonly signedAt: string | null;
  readonly submissionStagedAt: string | null;
  readonly apiAcceptedAt: string | null;
  readonly l2ExecutedAt: string | null;
  readonly claimableAt: string | null;
  readonly destinationConfirmedAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly settlementScanFromBlock: string | null;
  readonly withdrawalHistoryTimestamp: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface CreateLighterWithdrawalIntentInput {
  readonly intentId: string;
  readonly preview: LighterCoreWithdrawalPreview | LighterRhcWithdrawalPreview;
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
  destination_evidence_json, signed_at, submission_staged_at, api_accepted_at,
  l2_executed_at, claimable_at, destination_confirmed_at, last_checked_at,
  settlement_scan_from_block, withdrawal_history_timestamp,
  created_at, updated_at, expires_at`;

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
      WHERE environment = $1
        AND account_index = $2
        AND asset_index = 3
        AND route_type = 0
        AND execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ORDER BY created_at DESC
      LIMIT 1`,
    [snapshot.environment, snapshot.accountIndex],
  );
  if (conflict === null) {
    throw new Error(`${snapshot.environment} withdrawal intent insert was not persisted and no conflicting row was found.`);
  }
  return { outcome: "live_conflict", intent: mapRow(conflict) };
}

export async function findNonterminalForScope(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE environment = $1
        AND account_index = $2
        AND asset_index = 3
        AND route_type = 0
        AND execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ORDER BY created_at DESC
      LIMIT 1`,
    [environment, safeNonNegativeInteger(accountIndex, "account index")],
  );
  return row === null ? null : mapRow(row);
}

export function isSafelyExpirableApprovalPending(
  intent: LighterWithdrawalIntentRow,
  nowMs = Date.now(),
): boolean {
  return intent.approvalStatus === "approval_pending"
    && intent.executionState === "approval_pending"
    && intent.protocolExecutionId === null
    && intent.approvalId === null
    && intent.decisionReason === null
    && intent.decidedAt === null
    && intent.preSubmitRevalidationJson === null
    && intent.preSubmitRevalidatedAt === null
    && intent.nonceReservationId === null
    && intent.nonceValue === null
    && intent.signerTxHash === null
    && intent.signerExpiryMs === null
    && intent.signedAt === null
    && intent.submissionStagedAt === null
    && intent.submittedTxHash === null
    && intent.submitCode === null
    && intent.submitMessage === null
    && intent.predictedExecutionTimeMs === null
    && intent.volumeQuotaRemaining === null
    && intent.apiAcceptedAt === null
    && intent.providerTxStatus === null
    && intent.providerTxEvidenceJson === null
    && intent.withdrawalHistoryId === null
    && intent.withdrawalHistoryStatus === null
    && intent.withdrawalHistoryJson === null
    && intent.ambiguousReason === null
    && intent.claimMode === null
    && intent.claimApprovalId === null
    && intent.claimTxHash === null
    && intent.claimReplacementTxHash === null
    && intent.destinationTxHash === null
    && intent.destinationBlockNumber === null
    && intent.destinationBlockHash === null
    && intent.destinationConfirmations === null
    && intent.destinationEvidenceJson === null
    && intent.l2ExecutedAt === null
    && intent.claimableAt === null
    && intent.destinationConfirmedAt === null
    && intent.lastCheckedAt === null
    && intent.settlementScanFromBlock === null
    && intent.withdrawalHistoryTimestamp === null
    && Number.isFinite(Date.parse(intent.expiresAt))
    && Date.parse(intent.expiresAt) <= nowMs;
}

export function isSafelyReemittableApprovalPending(
  intent: LighterWithdrawalIntentRow,
  preview: LighterCoreWithdrawalPreview | LighterRhcWithdrawalPreview,
  nowMs = Date.now(),
): boolean {
  const snapshot = preview.snapshot;
  return intent.sessionId === preview.identity.sessionId
    && intent.approvalStatus === "approval_pending"
    && intent.executionState === "approval_pending"
    && intent.protocolExecutionId === null
    && intent.approvalId === null
    && intent.decisionReason === null
    && intent.decidedAt === null
    && intent.preSubmitRevalidationJson === null
    && intent.preSubmitRevalidatedAt === null
    && intent.nonceReservationId === null
    && intent.nonceValue === null
    && intent.signerTxHash === null
    && intent.signerExpiryMs === null
    && intent.signedAt === null
    && intent.submissionStagedAt === null
    && intent.submittedTxHash === null
    && intent.submitCode === null
    && intent.submitMessage === null
    && intent.predictedExecutionTimeMs === null
    && intent.volumeQuotaRemaining === null
    && intent.apiAcceptedAt === null
    && intent.providerTxStatus === null
    && intent.providerTxEvidenceJson === null
    && intent.withdrawalHistoryId === null
    && intent.withdrawalHistoryStatus === null
    && intent.withdrawalHistoryJson === null
    && intent.ambiguousReason === null
    && intent.claimMode === null
    && intent.claimApprovalId === null
    && intent.claimTxHash === null
    && intent.claimReplacementTxHash === null
    && intent.destinationTxHash === null
    && intent.destinationBlockNumber === null
    && intent.destinationBlockHash === null
    && intent.destinationConfirmations === null
    && intent.destinationEvidenceJson === null
    && intent.l2ExecutedAt === null
    && intent.claimableAt === null
    && intent.destinationConfirmedAt === null
    && intent.lastCheckedAt === null
    && intent.settlementScanFromBlock === null
    && intent.withdrawalHistoryTimestamp === null
    && Number.isFinite(Date.parse(intent.expiresAt))
    && Date.parse(intent.expiresAt) > nowMs
    && intent.environment === snapshot.environment
    && intent.endpoint === snapshot.endpoint
    && intent.signingChainId === snapshot.signingChainId
    && intent.settlementChainId === snapshot.settlementChainId
    && intent.settlementNetworkName === snapshot.settlementNetworkName
    && intent.accountIndex === snapshot.accountIndex
    && intent.apiKeyIndex === snapshot.apiKeyIndex
    && intent.walletAddress.toLowerCase() === snapshot.walletAddress.toLowerCase()
    && intent.destinationAddress.toLowerCase() === snapshot.destinationAddress.toLowerCase()
    && intent.assetIndex === snapshot.assetIndex
    && intent.assetSymbol === snapshot.assetSymbol
    && intent.assetDecimals === snapshot.assetDecimals
    && intent.settlementTokenAddress.toLowerCase() === snapshot.settlementTokenAddress.toLowerCase()
    && intent.routeType === snapshot.routeType
    && intent.amountUnits === snapshot.amountUnits
    && intent.minimumWithdrawalUnits === snapshot.minimumWithdrawalUnits
    && intent.withdrawalDelaySeconds === snapshot.withdrawalDelaySeconds
    && intent.gatewayAddress.toLowerCase() === snapshot.gatewayAddress.toLowerCase()
    && intent.gatewayImplementation.toLowerCase()
      === snapshot.gatewayImplementationAddress.toLowerCase()
    && intent.gatewayCodeHash === snapshot.gatewayCodeHash
    && intent.settlementTokenCodeHash === snapshot.settlementTokenCodeHash;
}

export async function hasPendingApprovalForIntentWith(
  client: PoolClient,
  sessionId: string,
  intentId: string,
): Promise<boolean> {
  const row = await queryOneWith<{ present: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1
         FROM approval_queue q
         JOIN approval_intents i ON i.approval_id = q.id
        WHERE q.session_id = $1
          AND i.session_id = $1
          AND q.status = 'pending'
          AND COALESCE(q.tool_call->>'command', q.tool_call->>'name') = 'execute_tool'
          AND COALESCE(q.tool_call->'args', q.tool_call->'arguments')->>'toolId' = 'lighter.withdraw'
          AND COALESCE(q.tool_call->'args', q.tool_call->'arguments')->'params'->>'intentId' = $2
     ) AS present`,
    [safeText(sessionId, "session id"), safeText(intentId, "intent id")],
  );
  return row?.present === true;
}

export async function expireStaleApprovalPendingWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
  },
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_withdrawal_intents
        SET approval_status = 'expired',
            execution_state = 'expired',
            decision_reason = 'prepared withdrawal expired before approval dispatch',
            decided_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND environment = $3
        AND account_index = $4
        AND asset_index = 3
        AND route_type = 0
        AND approval_status = 'approval_pending'
        AND execution_state = 'approval_pending'
        AND expires_at <= NOW()
        AND protocol_execution_id IS NULL
        AND approval_id IS NULL
        AND decision_reason IS NULL
        AND decided_at IS NULL
        AND pre_submit_revalidation_json IS NULL
        AND pre_submit_revalidated_at IS NULL
        AND nonce_reservation_id IS NULL
        AND nonce_value IS NULL
        AND signer_tx_hash IS NULL
        AND signer_expiry_ms IS NULL
        AND signed_at IS NULL
        AND submission_staged_at IS NULL
        AND submitted_tx_hash IS NULL
        AND submit_code IS NULL
        AND submit_message IS NULL
        AND predicted_execution_time_ms IS NULL
        AND volume_quota_remaining IS NULL
        AND api_accepted_at IS NULL
        AND provider_tx_status IS NULL
        AND provider_tx_evidence_json IS NULL
        AND withdrawal_history_id IS NULL
        AND withdrawal_history_status IS NULL
        AND withdrawal_history_json IS NULL
        AND ambiguous_reason IS NULL
        AND claim_mode IS NULL
        AND claim_approval_id IS NULL
        AND claim_tx_hash IS NULL
        AND claim_replacement_tx_hash IS NULL
        AND destination_tx_hash IS NULL
        AND destination_block_number IS NULL
        AND destination_block_hash IS NULL
        AND destination_confirmations IS NULL
        AND destination_evidence_json IS NULL
        AND l2_executed_at IS NULL
        AND claimable_at IS NULL
        AND destination_confirmed_at IS NULL
        AND last_checked_at IS NULL
        AND settlement_scan_from_block IS NULL
        AND withdrawal_history_timestamp IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [
      safeText(input.intentId, "intent id"),
      safeText(input.sessionId, "session id"),
      input.environment,
      safeNonNegativeInteger(input.accountIndex, "account index"),
    ],
  );
  return row === null ? null : mapRow(row);
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

export async function findByIntentIdWith(
  client: PoolClient,
  sessionId: string,
  intentId: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE session_id = $1 AND intent_id = $2
      FOR UPDATE`,
    [safeText(sessionId, "session id"), safeText(intentId, "intent id")],
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

export async function findByIntentIdForWallet(
  intentId: string,
  walletAddress: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE intent_id = $1
        AND LOWER(wallet_address) = LOWER($2)
        AND LOWER(destination_address) = LOWER($2)
      LIMIT 1`,
    [safeText(intentId, "intent id"), safeText(walletAddress, "wallet address")],
  );
  return row === null ? null : mapRow(row);
}

export async function findByIntentIdForWalletWith(
  client: PoolClient,
  intentId: string,
  walletAddress: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE intent_id = $1
        AND LOWER(wallet_address) = LOWER($2)
        AND LOWER(destination_address) = LOWER($2)
      LIMIT 1`,
    [safeText(intentId, "intent id"), safeText(walletAddress, "wallet address")],
  );
  return row === null ? null : mapRow(row);
}

export async function findLatestForWallet(
  walletAddress: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE LOWER(wallet_address) = LOWER($1)
        AND LOWER(destination_address) = LOWER($1)
      ORDER BY (
        execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ) DESC, created_at DESC
      LIMIT 1`,
    [safeText(walletAddress, "wallet address")],
  );
  return row === null ? null : mapRow(row);
}

export async function findLatestForWalletWith(
  client: PoolClient,
  walletAddress: string,
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE LOWER(wallet_address) = LOWER($1)
        AND LOWER(destination_address) = LOWER($1)
      ORDER BY (
        execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ) DESC, created_at DESC
      LIMIT 1`,
    [safeText(walletAddress, "wallet address")],
  );
  return row === null ? null : mapRow(row);
}

export async function listReconciliationCandidates(limit = 5): Promise<LighterWithdrawalIntentRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Lighter withdrawal reconciliation limit must be between 1 and 25.");
  }
  const result = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM lighter_withdrawal_intents
      WHERE signer_tx_hash IS NOT NULL
        AND submission_staged_at IS NOT NULL
        AND execution_state NOT IN ('destination_confirmed','rejected','failed','refunded','expired')
      ORDER BY COALESCE(last_checked_at, updated_at) ASC, created_at ASC
      LIMIT $1`, [limit]);
  return result.map(mapRow);
}

export async function markApprovalDecision(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: "approved" | "rejected" | "expired";
  readonly reason: string;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET approval_status = $4,
            execution_state = $4,
            approval_id = $3,
            decision_reason = $5,
            decided_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND approval_status = 'approval_pending'
        AND execution_state = 'approval_pending'
      RETURNING ${SELECT_COLUMNS}`,
    [input.intentId, input.sessionId, input.approvalId, input.decision, safeText(input.reason, "decision reason")],
  );
  return row === null ? null : mapRow(row);
}

export async function markPreSubmitRevalidated(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly evidence: Record<string, unknown>;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET pre_submit_revalidation_json = $3::jsonb,
            pre_submit_revalidated_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND approval_status = 'approved'
        AND execution_state = 'approved'
        AND nonce_reservation_id IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [input.intentId, input.sessionId, jsonb(assertPublicEvidence(input.evidence))],
  );
  return row === null ? null : mapRow(row);
}

export async function attachNonceReservationWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
    readonly reservationId: string;
    readonly nonceValue: string;
  },
): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'nonce_reserved',
            nonce_reservation_id = $5,
            nonce_value = $6,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND account_index = $3
        AND api_key_index = $4
        AND approval_status = 'approved'
        AND execution_state = 'approved'
        AND pre_submit_revalidated_at IS NOT NULL
        AND nonce_reservation_id IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [
      input.intentId,
      input.sessionId,
      input.accountIndex,
      input.apiKeyIndex,
      safeText(input.reservationId, "reservation id"),
      decimal(input.nonceValue, true, "nonce"),
    ],
  );
  return row === null ? null : mapRow(row);
}

export async function markSigned(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly reservationId: string;
  readonly nonceValue: string;
  readonly signerTxHash: string;
  readonly signerExpiryMs: number;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'signed',
            signer_tx_hash = $5,
            signer_expiry_ms = $6,
            signed_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND execution_state = 'nonce_reserved'
        AND nonce_reservation_id = $3
        AND nonce_value = $4
        AND signer_tx_hash IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [
      input.intentId,
      input.sessionId,
      safeText(input.reservationId, "reservation id"),
      decimal(input.nonceValue, true, "nonce"),
      safeText(input.signerTxHash, "signer transaction hash"),
      safeNonNegativeInteger(input.signerExpiryMs, "signer expiry"),
    ],
  );
  return row === null ? null : mapRow(row);
}

export async function markSubmissionStaged(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly signerTxHash: string;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'submission_staged',
            submission_staged_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND execution_state = 'signed'
        AND signer_tx_hash = $3
      RETURNING ${SELECT_COLUMNS}`,
    [input.intentId, input.sessionId, safeText(input.signerTxHash, "signer transaction hash")],
  );
  return row === null ? null : mapRow(row);
}

export async function markApiAccepted(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly submitCode: number;
  readonly submitMessage?: string | null;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining?: number | null;
  readonly settlementScanFromBlock: string;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'api_accepted',
            submitted_tx_hash = $4,
            submit_code = $5,
            submit_message = $6,
            predicted_execution_time_ms = $7,
            volume_quota_remaining = $8,
            settlement_scan_from_block = $9,
            api_accepted_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND execution_state = 'submission_staged'
        AND signer_tx_hash = $3
        AND submitted_tx_hash IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [
      input.intentId,
      input.sessionId,
      safeText(input.signerTxHash, "signer transaction hash"),
      safeText(input.submittedTxHash, "submitted transaction hash"),
      safeNonNegativeInteger(input.submitCode, "submit code"),
      input.submitMessage === null || input.submitMessage === undefined
        ? null
        : safeText(input.submitMessage, "submit message"),
      safeNonNegativeInteger(input.predictedExecutionTimeMs, "predicted execution time"),
      input.volumeQuotaRemaining === null || input.volumeQuotaRemaining === undefined
        ? null
        : String(safeNonNegativeInteger(input.volumeQuotaRemaining, "volume quota")),
      decimal(input.settlementScanFromBlock, true, "settlement scan block"),
    ],
  );
  return row === null ? null : mapRow(row);
}

export async function markAmbiguous(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly reason: string;
}): Promise<LighterWithdrawalIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'ambiguous',
            ambiguous_reason = $3,
            last_checked_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND execution_state IN ('nonce_reserved','signed','submission_staged','api_accepted','l2_pending')
      RETURNING ${SELECT_COLUMNS}`,
    [input.intentId, input.sessionId, safeText(input.reason, "ambiguity reason")],
  );
  return row === null ? null : mapRow(row);
}

export async function recordReconciliation(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly state:
    | "l2_pending"
    | "l2_executed"
    | "secure_waiting"
    | "claimable"
    | "auto_claim_observed"
    | "manual_claim_prepared"
    | "manual_claim_approved"
    | "manual_claim_submitted"
    | "destination_confirmed"
    | "failed"
    | "refunded"
    | "ambiguous";
  readonly providerTxStatus: number | null;
  readonly providerTxEvidence: Record<string, unknown> | null;
  readonly historyId?: string | null;
  readonly historyStatus?: string | null;
  readonly historyTimestamp?: number | null;
  readonly historyEvidence?: Record<string, unknown> | null;
  readonly pendingBalanceUnits?: string | null;
  readonly ambiguousReason?: string | null;
  readonly claimMode?: "auto" | "manual" | "legacy" | null;
  readonly destinationTxHash?: string | null;
  readonly destinationBlockNumber?: string | null;
  readonly destinationBlockHash?: string | null;
  readonly destinationConfirmations?: number | null;
  readonly destinationEvidence?: Record<string, unknown> | null;
  readonly settlementScanFromBlock?: string | null;
}): Promise<LighterWithdrawalIntentRow | null> {
  const historyId = input.historyId === undefined || input.historyId === null
    ? null
    : safeText(input.historyId, "history id");
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_withdrawal_intents
        SET execution_state = $3,
            provider_tx_status = $4,
            provider_tx_evidence_json = $5::jsonb,
            withdrawal_history_id = COALESCE(withdrawal_history_id, $6::text),
            withdrawal_history_status = COALESCE($7, withdrawal_history_status),
            withdrawal_history_timestamp = COALESCE($8, withdrawal_history_timestamp),
            withdrawal_history_json = COALESCE($9::jsonb, withdrawal_history_json),
            pending_balance_units = COALESCE($10, pending_balance_units),
            ambiguous_reason = $11,
            claim_mode = COALESCE($12, claim_mode),
            destination_tx_hash = COALESCE($13, destination_tx_hash),
            destination_block_number = COALESCE($14, destination_block_number),
            destination_block_hash = COALESCE($15, destination_block_hash),
            destination_confirmations = COALESCE($16, destination_confirmations),
            destination_evidence_json = COALESCE($17::jsonb, destination_evidence_json),
            settlement_scan_from_block = COALESCE($18, settlement_scan_from_block),
            l2_executed_at = CASE WHEN $3 IN ('l2_executed','secure_waiting','claimable','auto_claim_observed','destination_confirmed')
                                  THEN COALESCE(l2_executed_at, NOW()) ELSE l2_executed_at END,
            claimable_at = CASE WHEN $3 = 'claimable' THEN COALESCE(claimable_at, NOW()) ELSE claimable_at END,
            destination_confirmed_at = CASE WHEN $3 = 'destination_confirmed' THEN COALESCE(destination_confirmed_at, NOW()) ELSE destination_confirmed_at END,
            last_checked_at = NOW(),
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND execution_state IN (
          'submission_staged','api_accepted','l2_pending','l2_executed','secure_waiting',
          'claimable','auto_claim_observed','manual_claim_prepared','manual_claim_approved',
          'manual_claim_staged','manual_claim_submitted','ambiguous'
        )
        AND (
          $3 = 'ambiguous'
          OR $3 = 'destination_confirmed'
          OR ($3 = 'manual_claim_prepared' AND execution_state = 'manual_claim_prepared')
          OR ($3 = 'manual_claim_approved' AND execution_state = 'manual_claim_approved')
          OR ($3 = 'manual_claim_submitted' AND execution_state IN (
            'manual_claim_staged','manual_claim_submitted','ambiguous'
          ))
          OR ($3 = 'auto_claim_observed' AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','l2_executed','secure_waiting',
            'claimable','auto_claim_observed','ambiguous'
          ))
          OR ($3 = 'claimable' AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','l2_executed','secure_waiting',
            'claimable','manual_claim_staged','manual_claim_submitted','ambiguous'
          ))
          OR ($3 = 'secure_waiting' AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','l2_executed','secure_waiting','ambiguous'
          ))
          OR ($3 = 'l2_executed' AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','l2_executed','ambiguous'
          ))
          OR ($3 = 'l2_pending' AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','ambiguous'
          ))
          OR ($3 IN ('failed','refunded') AND execution_state IN (
            'submission_staged','api_accepted','l2_pending','l2_executed','secure_waiting','ambiguous'
          ))
        )
        AND (
          withdrawal_history_id IS NULL
          OR $6::text IS NULL
          OR withdrawal_history_id = $6::text
        )
      RETURNING ${SELECT_COLUMNS}`,
    [
      input.intentId,
      input.sessionId,
      input.state,
      input.providerTxStatus === null ? null : safeNonNegativeInteger(input.providerTxStatus, "provider tx status"),
      input.providerTxEvidence === null ? null : jsonb(assertPublicEvidence(input.providerTxEvidence)),
      historyId,
      input.historyStatus ?? null,
      input.historyTimestamp === null || input.historyTimestamp === undefined
        ? null
        : safeNonNegativeInteger(input.historyTimestamp, "history timestamp"),
      input.historyEvidence === null || input.historyEvidence === undefined
        ? null
        : jsonb(assertPublicEvidence(input.historyEvidence)),
      input.pendingBalanceUnits === null || input.pendingBalanceUnits === undefined
        ? null
        : decimal(input.pendingBalanceUnits, true, "pending balance"),
      input.ambiguousReason === null || input.ambiguousReason === undefined
        ? null
        : safeText(input.ambiguousReason, "ambiguity reason"),
      input.claimMode ?? null,
      input.destinationTxHash === null || input.destinationTxHash === undefined
        ? null
        : safeText(input.destinationTxHash, "destination transaction hash"),
      input.destinationBlockNumber === null || input.destinationBlockNumber === undefined
        ? null
        : decimal(input.destinationBlockNumber, true, "destination block"),
      input.destinationBlockHash === null || input.destinationBlockHash === undefined
        ? null
        : safeText(input.destinationBlockHash, "destination block hash"),
      input.destinationConfirmations === null || input.destinationConfirmations === undefined
        ? null
        : safeNonNegativeInteger(input.destinationConfirmations, "destination confirmations"),
      input.destinationEvidence === null || input.destinationEvidence === undefined
        ? null
        : jsonb(assertPublicEvidence(input.destinationEvidence)),
      input.settlementScanFromBlock === null || input.settlementScanFromBlock === undefined
        ? null
        : decimal(input.settlementScanFromBlock, true, "settlement scan block"),
    ],
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
  preview: LighterCoreWithdrawalPreview | LighterRhcWithdrawalPreview,
  readiness: Extract<LighterTradingCredentialReadiness, { ready: true }>,
): void {
  const snapshot = preview.snapshot;
  if (
    readiness.nonceScope.environment !== snapshot.environment
    || readiness.nonceScope.accountIndex !== snapshot.accountIndex
    || readiness.nonceScope.apiKeyIndex !== snapshot.apiKeyIndex
  ) {
    throw new Error(`${snapshot.environment} withdrawal credential scope does not match the immutable preview.`);
  }
}

function mapRow(row: Record<string, unknown>): LighterWithdrawalIntentRow {
  const environment = String(row.environment);
  if (environment !== "core" && environment !== "rhc") {
    throw new Error("Lighter withdrawal row has an unsupported environment.");
  }
  const profile = getLighterSecureWithdrawalProfile(environment);
  if (
    Number(row.signing_chain_id) !== profile.signingChainId
    || Number(row.settlement_chain_id) !== profile.settlementChainId
    || String(row.settlement_network_name) !== profile.settlementNetworkName
    || Number(row.asset_index) !== profile.assetIndex
    || String(row.asset_symbol) !== profile.assetSymbol
    || Number(row.asset_decimals) !== profile.assetDecimals
    || Number(row.route_type) !== profile.routeType
  ) {
    throw new Error(`Lighter ${environment} withdrawal row crossed an environment identity boundary.`);
  }
  return {
    intentId: String(row.intent_id),
    previewId: String(row.preview_id),
    sessionId: String(row.session_id),
    protocolExecutionId: nullableNumber(row.protocol_execution_id),
    approvalId: nullableString(row.approval_id),
    matchHash: String(row.match_hash),
    environment,
    operationClass: "secure_l2_withdrawal",
    endpoint: String(row.endpoint),
    signingChainId: profile.signingChainId,
    settlementChainId: profile.settlementChainId,
    settlementNetworkName: profile.settlementNetworkName,
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    walletAddress: String(row.wallet_address),
    destinationAddress: String(row.destination_address),
    credentialRefJson: row.credential_ref_json as LighterTradingCredentialVaultReference,
    assetIndex: 3,
    assetSymbol: profile.assetSymbol,
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
    signedAt: nullableIso(row.signed_at),
    submissionStagedAt: nullableIso(row.submission_staged_at),
    apiAcceptedAt: nullableIso(row.api_accepted_at),
    l2ExecutedAt: nullableIso(row.l2_executed_at),
    claimableAt: nullableIso(row.claimable_at),
    destinationConfirmedAt: nullableIso(row.destination_confirmed_at),
    lastCheckedAt: nullableIso(row.last_checked_at),
    settlementScanFromBlock: nullableString(row.settlement_scan_from_block),
    withdrawalHistoryTimestamp: nullableNumber(row.withdrawal_history_timestamp),
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

function safeText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 1_000 || /(?:private|secret|signature|tx_info|auth.?token)/i.test(trimmed)) {
    throw new Error(`Lighter withdrawal ${field} is unsafe or invalid.`);
  }
  return trimmed;
}

function safeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Lighter withdrawal ${field} is invalid.`);
  return value;
}

function decimal(value: string, allowZero: boolean, field: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || (!allowZero && BigInt(trimmed) === 0n)) {
    throw new Error(`Lighter withdrawal ${field} is invalid.`);
  }
  return BigInt(trimmed).toString(10);
}

function assertPublicEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = jsonb(value);
  if (
    encoded.length > 12_000
    || /(?:private.?key|secret|signature|tx_info|auth.?token)/i.test(encoded)
  ) {
    throw new Error("Lighter withdrawal revalidation evidence is unsafe or too large.");
  }
  return value;
}
