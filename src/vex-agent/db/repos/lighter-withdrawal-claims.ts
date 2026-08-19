import type { PoolClient } from "pg";

import type { LighterCoreClaimPreview } from "@tools/lighter/withdrawal/core-claim.js";
import { queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";

export type LighterWithdrawalClaimState =
  | "prepared" | "approved" | "staged" | "submitted" | "confirming" | "confirmed"
  | "reverted" | "rejected" | "expired" | "ambiguous";

export interface LighterWithdrawalClaimAttemptRow {
  readonly claimId: string;
  readonly withdrawalIntentId: string;
  readonly sessionId: string;
  readonly previewId: string;
  readonly approvalId: string | null;
  readonly matchHash: string;
  readonly operationClass: "manual_core_usdc_claim";
  readonly settlementChainId: 1;
  readonly settlementNetworkName: "Ethereum mainnet";
  readonly walletAddress: string;
  readonly ownerAddress: string;
  readonly gatewayAddress: string;
  readonly gatewayImplementation: string;
  readonly gatewayCodeHash: string;
  readonly settlementTokenAddress: string;
  readonly settlementTokenCodeHash: string;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDC";
  readonly assetDecimals: 6;
  readonly amountUnits: string;
  readonly calldata: string;
  readonly valueWei: "0";
  readonly preflightJson: LighterCoreClaimPreview["snapshot"];
  readonly preflightObservedAt: string;
  readonly preflightBlockNumber: string;
  readonly nativeBalanceWei: string;
  readonly gasEstimate: string;
  readonly gasLimit: string;
  readonly quotedMaxFeePerGasWei: string;
  readonly quotedPriorityFeePerGasWei: string;
  readonly feeCeilingPerGasWei: string;
  readonly priorityFeeCeilingWei: string;
  readonly networkFeeCeilingWei: string;
  readonly state: LighterWithdrawalClaimState;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly txHash: string | null;
  readonly replacementTxHash: string | null;
  readonly fromAddress: string | null;
  readonly nonce: number | null;
  readonly receiptJson: Record<string, unknown> | null;
  readonly ambiguousReason: string | null;
  readonly stagedAt: string | null;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

const COLUMNS = `
  claim_id, withdrawal_intent_id, session_id, preview_id, approval_id, match_hash,
  operation_class, settlement_chain_id, settlement_network_name, wallet_address,
  owner_address, gateway_address, gateway_implementation, gateway_code_hash,
  settlement_token_address, settlement_token_code_hash, asset_index, asset_symbol,
  asset_decimals, amount_units, calldata, value_wei, preflight_json,
  preflight_observed_at, preflight_block_number, native_balance_wei, gas_estimate,
  gas_limit, quoted_max_fee_per_gas_wei, quoted_priority_fee_per_gas_wei,
  fee_ceiling_per_gas_wei, priority_fee_ceiling_wei, network_fee_ceiling_wei,
  state, decision_reason, decided_at, tx_hash, replacement_tx_hash, from_address,
  nonce, receipt_json, ambiguous_reason, staged_at, submitted_at, confirmed_at,
  created_at, updated_at, expires_at`;

export async function createManualClaimAttemptWith(
  client: PoolClient,
  input: { readonly claimId: string; readonly preview: LighterCoreClaimPreview },
): Promise<LighterWithdrawalClaimAttemptRow> {
  const p = input.preview;
  const s = p.snapshot;
  const parent = await queryOneWith<{ intent_id: string }>(
    client,
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'manual_claim_prepared', claim_mode = 'manual', updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'claimable'
        AND pending_balance_units = amount_units AND destination_tx_hash IS NULL
      RETURNING intent_id`,
    [p.identity.withdrawalIntentId, p.identity.sessionId],
  );
  if (parent === null) throw new Error("Core withdrawal is no longer exactly claimable.");
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `INSERT INTO lighter_withdrawal_claim_attempts (
       claim_id, withdrawal_intent_id, session_id, preview_id, match_hash,
       operation_class, settlement_chain_id, settlement_network_name, wallet_address,
       owner_address, gateway_address, gateway_implementation, gateway_code_hash,
       settlement_token_address, settlement_token_code_hash, asset_index, asset_symbol,
       asset_decimals, amount_units, calldata, value_wei, preflight_json,
       preflight_observed_at, preflight_block_number, native_balance_wei, gas_estimate,
       gas_limit, quoted_max_fee_per_gas_wei, quoted_priority_fee_per_gas_wei,
       fee_ceiling_per_gas_wei, priority_fee_ceiling_wei, network_fee_ceiling_wei, expires_at
     ) VALUES (
       $1,$2,$3,$4,$5,'manual_core_usdc_claim',1,'Ethereum mainnet',$6,
       $7,$8,$9,$10,$11,$12,3,'USDC',6,$13,$14,'0',$15::jsonb,
       $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
     ) RETURNING ${COLUMNS}`,
    [
      input.claimId, p.identity.withdrawalIntentId, p.identity.sessionId, p.previewId, p.matchHash,
      s.walletAddress, s.ownerAddress, s.gatewayAddress, s.gatewayImplementation, s.gatewayCodeHash,
      s.settlementTokenAddress, s.settlementTokenCodeHash, s.amountUnits, s.calldata, jsonb(s),
      s.observedAt, s.blockNumber, s.nativeBalanceWei, s.gasEstimate, s.gasLimit,
      s.quotedMaxFeePerGasWei, s.quotedPriorityFeePerGasWei, s.feeCeilingPerGasWei,
      s.priorityFeeCeilingWei, s.networkFeeCeilingWei, s.expiresAt,
    ],
  );
  if (row === null) throw new Error("Manual Core claim attempt was not persisted.");
  return mapRow(row);
}

export async function findByClaimId(sessionId: string, claimId: string): Promise<LighterWithdrawalClaimAttemptRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_withdrawal_claim_attempts WHERE session_id = $1 AND claim_id = $2`,
    [sessionId, claimId],
  );
  return row === null ? null : mapRow(row);
}

export async function markDecisionWith(client: PoolClient, input: {
  readonly claimId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: "approved" | "rejected" | "expired";
  readonly reason: string;
}): Promise<LighterWithdrawalClaimAttemptRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_withdrawal_claim_attempts
        SET state = $4, approval_id = $3, decision_reason = $5, decided_at = NOW(), updated_at = NOW()
      WHERE claim_id = $1 AND session_id = $2 AND state = 'prepared'
      RETURNING ${COLUMNS}`,
    [input.claimId, input.sessionId, input.approvalId, input.decision, safeText(input.reason)],
  );
  if (row === null) return null;
  await queryOneWith(
    client,
    `UPDATE lighter_withdrawal_intents
        SET execution_state = $3, claim_approval_id = $4, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'manual_claim_prepared'
      RETURNING intent_id`,
    [String(row.withdrawal_intent_id), input.sessionId,
      input.decision === "approved" ? "manual_claim_approved" : input.decision,
      input.approvalId],
  );
  return mapRow(row);
}

export async function markStagedWith(client: PoolClient, input: {
  readonly claimId: string;
  readonly sessionId: string;
  readonly txHash: string;
  readonly fromAddress: string;
  readonly nonce: number;
}): Promise<LighterWithdrawalClaimAttemptRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_withdrawal_claim_attempts
        SET state = 'staged', tx_hash = $3, from_address = $4, nonce = $5,
            staged_at = NOW(), updated_at = NOW()
      WHERE claim_id = $1 AND session_id = $2 AND state = 'approved' AND tx_hash IS NULL
      RETURNING ${COLUMNS}`,
    [input.claimId, input.sessionId, hash(input.txHash), input.fromAddress, input.nonce],
  );
  if (row === null) return null;
  await queryOneWith(client,
    `UPDATE lighter_withdrawal_intents
        SET execution_state = 'manual_claim_staged', claim_tx_hash = $3,
            destination_tx_hash = $3, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'manual_claim_approved'
      RETURNING intent_id`,
    [String(row.withdrawal_intent_id), input.sessionId, input.txHash]);
  return mapRow(row);
}

export async function markSubmittedWith(client: PoolClient, claimId: string, sessionId: string): Promise<boolean> {
  const row = await queryOneWith<{ withdrawal_intent_id: string }>(client,
    `UPDATE lighter_withdrawal_claim_attempts
        SET state = 'submitted', submitted_at = NOW(), updated_at = NOW()
      WHERE claim_id = $1 AND session_id = $2 AND state = 'staged'
      RETURNING withdrawal_intent_id`, [claimId, sessionId]);
  if (row === null) return false;
  await queryOneWith(client,
    `UPDATE lighter_withdrawal_intents SET execution_state = 'manual_claim_submitted', updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'manual_claim_staged'
      RETURNING intent_id`, [row.withdrawal_intent_id, sessionId]);
  return true;
}

export async function recordReplacementWith(client: PoolClient, input: {
  readonly claimId: string; readonly sessionId: string; readonly replacementTxHash: string;
}): Promise<boolean> {
  const row = await queryOneWith<{ withdrawal_intent_id: string }>(client,
    `UPDATE lighter_withdrawal_claim_attempts SET replacement_tx_hash = $3, updated_at = NOW()
      WHERE claim_id = $1 AND session_id = $2 AND state IN ('submitted','confirming')
        AND tx_hash IS NOT NULL AND replacement_tx_hash IS NULL
      RETURNING withdrawal_intent_id`, [input.claimId, input.sessionId, hash(input.replacementTxHash)]);
  if (row === null) return false;
  await queryOneWith(client,
    `UPDATE lighter_withdrawal_intents SET claim_replacement_tx_hash = $3,
       destination_tx_hash = $3, updated_at = NOW()
     WHERE intent_id = $1 AND session_id = $2 RETURNING intent_id`,
    [row.withdrawal_intent_id, input.sessionId, input.replacementTxHash]);
  return true;
}

export async function markOutcomeWith(client: PoolClient, input: {
  readonly claimId: string;
  readonly sessionId: string;
  readonly outcome: "confirming" | "reverted" | "ambiguous";
  readonly receipt?: Record<string, unknown> | null;
  readonly reason?: string | null;
}): Promise<boolean> {
  const row = await queryOneWith<{ withdrawal_intent_id: string }>(client,
    `UPDATE lighter_withdrawal_claim_attempts
        SET state = $3, receipt_json = COALESCE($4::jsonb, receipt_json),
            ambiguous_reason = $5, updated_at = NOW()
      WHERE claim_id = $1 AND session_id = $2 AND state IN ('staged','submitted','confirming')
      RETURNING withdrawal_intent_id`,
    [input.claimId, input.sessionId, input.outcome,
      input.receipt === undefined || input.receipt === null ? null : jsonb(input.receipt),
      input.reason === undefined || input.reason === null ? null : safeText(input.reason)],
  );
  if (row === null) return false;
  const parentState = input.outcome === "reverted" ? "claimable"
    : input.outcome === "ambiguous" ? "ambiguous" : "manual_claim_submitted";
  await queryOneWith(client,
    `UPDATE lighter_withdrawal_intents SET execution_state = $3,
       ambiguous_reason = $4, updated_at = NOW()
     WHERE intent_id = $1 AND session_id = $2 RETURNING intent_id`,
    [row.withdrawal_intent_id, input.sessionId, parentState,
      input.outcome === "ambiguous" ? safeText(input.reason ?? "manual_claim_outcome_unknown") : null]);
  return true;
}

function mapRow(row: Record<string, unknown>): LighterWithdrawalClaimAttemptRow {
  return {
    claimId: String(row.claim_id), withdrawalIntentId: String(row.withdrawal_intent_id),
    sessionId: String(row.session_id), previewId: String(row.preview_id),
    approvalId: nullable(row.approval_id), matchHash: String(row.match_hash),
    operationClass: "manual_core_usdc_claim", settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet", walletAddress: String(row.wallet_address),
    ownerAddress: String(row.owner_address), gatewayAddress: String(row.gateway_address),
    gatewayImplementation: String(row.gateway_implementation), gatewayCodeHash: String(row.gateway_code_hash),
    settlementTokenAddress: String(row.settlement_token_address), settlementTokenCodeHash: String(row.settlement_token_code_hash),
    assetIndex: 3, assetSymbol: "USDC", assetDecimals: 6, amountUnits: String(row.amount_units),
    calldata: String(row.calldata), valueWei: "0", preflightJson: row.preflight_json as LighterCoreClaimPreview["snapshot"],
    preflightObservedAt: iso(row.preflight_observed_at), preflightBlockNumber: String(row.preflight_block_number),
    nativeBalanceWei: String(row.native_balance_wei), gasEstimate: String(row.gas_estimate), gasLimit: String(row.gas_limit),
    quotedMaxFeePerGasWei: String(row.quoted_max_fee_per_gas_wei), quotedPriorityFeePerGasWei: String(row.quoted_priority_fee_per_gas_wei),
    feeCeilingPerGasWei: String(row.fee_ceiling_per_gas_wei), priorityFeeCeilingWei: String(row.priority_fee_ceiling_wei),
    networkFeeCeilingWei: String(row.network_fee_ceiling_wei), state: row.state as LighterWithdrawalClaimState,
    decisionReason: nullable(row.decision_reason), decidedAt: nullableIso(row.decided_at), txHash: nullable(row.tx_hash),
    replacementTxHash: nullable(row.replacement_tx_hash), fromAddress: nullable(row.from_address),
    nonce: row.nonce === null || row.nonce === undefined ? null : Number(row.nonce),
    receiptJson: row.receipt_json === null || row.receipt_json === undefined ? null : row.receipt_json as Record<string, unknown>,
    ambiguousReason: nullable(row.ambiguous_reason), stagedAt: nullableIso(row.staged_at), submittedAt: nullableIso(row.submitted_at),
    confirmedAt: nullableIso(row.confirmed_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(row.expires_at),
  };
}

function hash(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Manual claim transaction hash is invalid.");
  return value;
}
function safeText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) throw new Error("Manual claim audit text is invalid.");
  return trimmed;
}
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function nullableIso(value: unknown): string | null { return value === null || value === undefined ? null : iso(value); }
