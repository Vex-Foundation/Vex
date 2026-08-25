/**
 * Repository for `lighter_onboarding_intents` — the durable state of each
 * fund-moving onboarding leg (Phase 7). It records addresses, amounts, tx
 * hashes, and lifecycle only; never keys, signatures, or signed payloads.
 * Marks persist tx hashes BEFORE broadcast (staged-broadcast doctrine) and
 * advance execution state through explicit CAS transitions.
 */

import { randomUUID } from "node:crypto";
import { query, queryOne } from "../client.js";
import { jsonb } from "../params.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import type {
  LighterDepositCreditEvidence,
  LighterDepositL1Evidence,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";
import type { LighterDepositPreflightSnapshot } from "@tools/lighter/wallet-funding/deposit-preflight.js";
import {
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingQueryClient,
  type LighterOnboardingWorkflowState,
} from "./lighter-onboarding-workflows.js";

export type LighterOnboardingCapability = "deposit" | "key_registration" | "swap" | "withdrawal";

export type LighterOnboardingApprovalStatus =
  | "approval_pending"
  | "approved"
  | "rejected"
  | "expired";

export type LighterOnboardingExecutionState =
  | "prepared"
  | "slot_reserved"
  | "key_generated_encrypted"
  | "approval_pending"
  | "approved"
  | "allowance_verified"
  | "approve_submitted"
  | "approve_confirmed"
  | "deposit_submitted"
  | "deposit_confirmed"
  | "credited"
  | "ambiguous"
  | "failed";

export interface LighterStagedEvmTransaction {
  readonly txHash: string;
  readonly fromAddress: string;
  readonly nonce: number;
}

export interface LighterReplacementTransaction {
  readonly originalTxHash: string;
  readonly replacementTxHash: string;
  readonly reason: "repriced";
  readonly observedAt: Date;
}

export interface LighterOnboardingIntentRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly protocolExecutionId: number | null;
  readonly approvalId: string | null;
  readonly environment: LighterEnvironment;
  readonly capability: LighterOnboardingCapability;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly depositContract: string | null;
  readonly depositTo: string | null;
  readonly assetIndex: number | null;
  readonly routeType: number | null;
  readonly amountUnits: string | null;
  readonly settlementTokenAddress: string | null;
  readonly settlementTokenSymbol: string | null;
  readonly settlementTokenDecimals: number | null;
  readonly preflightMinimumTransferUnits: string | null;
  readonly preflightWalletBalanceUnits: string | null;
  readonly preflightWalletAllowanceUnits: string | null;
  readonly preflightWalletNativeBalanceWei: string | null;
  readonly preflightEthereumBlockNumber: string | null;
  readonly preflightLighterBlockNumber: string | null;
  readonly preflightObservedAt: Date | null;
  readonly preflightApproveGasLimit: string | null;
  readonly preflightDepositGasLimit: string | null;
  readonly preflightMaxFeePerGasWei: string | null;
  readonly preflightMaxPriorityFeePerGasWei: string | null;
  readonly preflightApproveMaxFeeWei: string | null;
  readonly preflightDepositMaxFeeWei: string | null;
  readonly preflightTotalMaxFeeWei: string | null;
  readonly preflightNativeReserveWei: string | null;
  readonly preflightRequiredNativeBalanceWei: string | null;
  /** Complete public preparation evidence. Optional only for legacy Core rows. */
  readonly preflightPublicSnapshot?: LighterDepositPublicSnapshot | null;
  readonly approvalStatus: LighterOnboardingApprovalStatus;
  readonly executionState: LighterOnboardingExecutionState;
  readonly approveTxHash: string | null;
  readonly approveTxFrom: string | null;
  readonly approveTxNonce: string | null;
  readonly approveReplacementTxHash: string | null;
  readonly approveReplacementReason: "repriced" | null;
  readonly approveReplacementObservedAt: Date | null;
  readonly depositTxHash: string | null;
  readonly depositTxFrom: string | null;
  readonly depositTxNonce: string | null;
  readonly depositReplacementTxHash: string | null;
  readonly depositReplacementReason: "repriced" | null;
  readonly depositReplacementObservedAt: Date | null;
  readonly depositL1BlockHash: string | null;
  readonly depositL1BlockNumber: string | null;
  readonly depositEventAccountIndex: number | null;
  readonly lighterTxHash: string | null;
  readonly lighterTxStatus: number | null;
  readonly lighterBlockHeight: number | null;
  readonly lighterExecutedAt: number | null;
  readonly lighterEvidenceObservedAt: Date | null;
  readonly resolvedAccountIndex: number | null;
  readonly decisionReason: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

export type LighterDepositPublicSnapshot = Omit<
  LighterDepositPreflightSnapshot,
  "observedAt"
> & { readonly observedAt: string };

export interface CreateDepositIntentInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly depositContract: string;
  readonly depositTo: string;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: string;
  readonly preflight: LighterDepositPreflightSnapshot;
  readonly expiresAt: Date;
}

export type CreateDepositIntentOutcome =
  | { readonly outcome: "created"; readonly intent: LighterOnboardingIntentRow }
  | { readonly outcome: "live_conflict"; readonly intent: LighterOnboardingIntentRow | null };

export function generateOnboardingIntentId(): string {
  return `lighter-onboard-${randomUUID()}`;
}

const RETURNING = `
  intent_id, session_id, protocol_execution_id, approval_id, environment, capability,
  wallet_address, chain_id, deposit_contract, deposit_to, asset_index, route_type, amount_units,
  settlement_token_address, settlement_token_symbol, settlement_token_decimals,
  preflight_min_transfer_units, preflight_wallet_balance_units,
  preflight_wallet_allowance_units, preflight_wallet_native_balance_wei,
  preflight_ethereum_block_number, preflight_lighter_block_number, preflight_observed_at,
  preflight_approve_gas_limit, preflight_deposit_gas_limit,
  preflight_max_fee_per_gas_wei, preflight_max_priority_fee_per_gas_wei,
  preflight_approve_max_fee_wei, preflight_deposit_max_fee_wei,
  preflight_total_max_fee_wei, preflight_native_reserve_wei,
  preflight_required_native_balance_wei, preflight_public_snapshot,
  approval_status, execution_state,
  approve_tx_hash, approve_tx_from, approve_tx_nonce,
  approve_replacement_tx_hash, approve_replacement_reason, approve_replacement_observed_at,
  deposit_tx_hash, deposit_tx_from, deposit_tx_nonce,
  deposit_replacement_tx_hash, deposit_replacement_reason, deposit_replacement_observed_at,
  resolved_account_index,
  deposit_l1_block_hash, deposit_l1_block_number, deposit_event_account_index,
  lighter_tx_hash, lighter_tx_status, lighter_block_height, lighter_executed_at,
  lighter_evidence_observed_at,
  decision_reason, failure_reason, created_at, updated_at, expires_at
`;

const INSERT_DEPOSIT_SQL = `
  INSERT INTO lighter_onboarding_intents (
    intent_id, session_id, environment, capability, wallet_address, chain_id,
    deposit_contract, deposit_to, asset_index, route_type, amount_units,
    settlement_token_address, settlement_token_symbol, settlement_token_decimals,
    preflight_min_transfer_units, preflight_wallet_balance_units,
    preflight_wallet_allowance_units, preflight_wallet_native_balance_wei,
    preflight_ethereum_block_number, preflight_lighter_block_number, preflight_observed_at,
    preflight_approve_gas_limit, preflight_deposit_gas_limit,
    preflight_max_fee_per_gas_wei, preflight_max_priority_fee_per_gas_wei,
    preflight_approve_max_fee_wei, preflight_deposit_max_fee_wei,
    preflight_total_max_fee_wei, preflight_native_reserve_wei,
    preflight_required_native_balance_wei, preflight_public_snapshot,
    approval_status, execution_state, expires_at
  ) VALUES (
    $1, $2, $3, 'deposit', $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, $22, $23, $24, $25, $26, $27, $28, $29,
    $30::jsonb, 'approval_pending', 'approval_pending', $31
  )
  ON CONFLICT DO NOTHING
  RETURNING ${RETURNING}
`;

/**
 * Create the row under the caller's session-control-locked transaction.
 * `ON CONFLICT DO NOTHING` converts the partial unique-index race into a
 * deterministic result; a second statement returns the authoritative live row.
 */
export async function createOrFindLiveDepositApprovalPendingWith(
  client: LighterOnboardingQueryClient,
  input: CreateDepositIntentInput,
): Promise<CreateDepositIntentOutcome> {
  assertPreflightMatchesInput(input);
  const inserted = await client.query<Record<string, unknown>>(INSERT_DEPOSIT_SQL, [
    generateOnboardingIntentId(),
    input.sessionId,
    input.environment,
    input.walletAddress,
    input.chainId,
    input.depositContract,
    input.depositTo,
    input.assetIndex,
    input.routeType,
    input.amountUnits,
    input.preflight.settlementTokenAddress,
    input.preflight.settlementTokenSymbol,
    input.preflight.settlementTokenDecimals,
    input.preflight.minimumTransferUnits,
    input.preflight.walletBalanceUnits,
    input.preflight.walletAllowanceUnits,
    input.preflight.walletNativeBalanceWei,
    input.preflight.ethereumBlockNumber,
    input.preflight.lighterBlockNumber,
    input.preflight.observedAt,
    input.preflight.approveGasLimit,
    input.preflight.depositGasLimit,
    input.preflight.maxFeePerGasWei,
    input.preflight.maxPriorityFeePerGasWei,
    input.preflight.approveMaxFeeWei,
    input.preflight.depositMaxFeeWei,
    input.preflight.totalMaxFeeWei,
    input.preflight.nativeReserveWei,
    input.preflight.requiredNativeBalanceWei,
    jsonb(toPublicSnapshot(input.preflight)),
    input.expiresAt,
  ]);
  const created = inserted.rows[0];
  if (created !== undefined) {
    const intent = mapRow(created);
    await requireDepositWorkflowTransition(client, intent, {
      expectedStates: [
        "integration_enabled",
        "account_resolved",
        "ready_to_trade",
        "failed",
      ],
      nextState: "deposit_approval_pending",
    });
    return { outcome: "created", intent };
  }

  const conflict = await findLiveDepositConflictWith(client, input.environment, input.walletAddress);
  return {
    outcome: "live_conflict",
    intent: conflict,
  };
}

async function findLiveDepositConflictWith(
  client: LighterOnboardingQueryClient,
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingIntentRow | null> {
  const existing = await client.query<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents
      WHERE environment = $1
        AND LOWER(wallet_address) = LOWER($2)
        AND capability = 'deposit'
        AND approval_status IN ('approval_pending', 'approved')
        AND execution_state NOT IN ('credited', 'failed')
      ORDER BY created_at ASC
      LIMIT 1`,
    [environment, walletAddress],
  );
  const conflict = existing.rows[0];
  return conflict === undefined ? null : mapRow(conflict);
}

/**
 * True only for an expired deposit preparation that never reached approval,
 * signing, staging, submission, replacement, or settlement observation.
 *
 * This predicate is an in-memory fast path only. The writer below repeats every
 * condition in its SQL compare-and-set, which remains the cross-process
 * authority if the row changes after this read.
 */
export function isSafelyExpirableDepositApprovalPending(
  intent: LighterOnboardingIntentRow,
  nowMs = Date.now(),
): boolean {
  return intent.capability === "deposit"
    && intent.approvalStatus === "approval_pending"
    && intent.executionState === "approval_pending"
    && intent.approvalId === null
    && intent.protocolExecutionId === null
    && intent.decisionReason === null
    && intent.failureReason === null
    && intent.approveTxHash === null
    && intent.approveTxFrom === null
    && intent.approveTxNonce === null
    && intent.approveReplacementTxHash === null
    && intent.approveReplacementReason === null
    && intent.approveReplacementObservedAt === null
    && intent.depositTxHash === null
    && intent.depositTxFrom === null
    && intent.depositTxNonce === null
    && intent.depositReplacementTxHash === null
    && intent.depositReplacementReason === null
    && intent.depositReplacementObservedAt === null
    && intent.depositL1BlockHash === null
    && intent.depositL1BlockNumber === null
    && intent.depositEventAccountIndex === null
    && intent.lighterTxHash === null
    && intent.lighterTxStatus === null
    && intent.lighterBlockHeight === null
    && intent.lighterExecutedAt === null
    && intent.lighterEvidenceObservedAt === null
    && intent.resolvedAccountIndex === null
    && Number.isFinite(intent.expiresAt.getTime())
    && intent.expiresAt.getTime() <= nowMs;
}

/**
 * Retire an expired approval preparation only when the database still proves
 * that no approval or execution evidence exists. The full environment, wallet,
 * chain, contract, beneficiary, asset, route, and amount identity is included
 * in the CAS so a stale caller cannot retire a different deposit scope.
 */
export async function expireStaleDepositApprovalPendingWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly environment: LighterEnvironment;
    readonly walletAddress: string;
    readonly chainId: number;
    readonly depositContract: string;
    readonly depositTo: string;
    readonly assetIndex: number;
    readonly routeType: number;
    readonly amountUnits: string;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const reason =
    "Prepared Lighter deposit expired before an approval was dispatched; no transaction was signed or submitted.";
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET approval_status = 'expired',
            execution_state = 'failed',
            decision_reason = $11,
            decided_at = NOW(),
            failure_reason = $11,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND environment = $3
        AND LOWER(wallet_address) = LOWER($4)
        AND chain_id = $5
        AND LOWER(deposit_contract) = LOWER($6)
        AND LOWER(deposit_to) = LOWER($7)
        AND asset_index = $8
        AND route_type = $9
        AND amount_units = $10
        AND capability = 'deposit'
        AND approval_status = 'approval_pending'
        AND execution_state = 'approval_pending'
        AND expires_at <= NOW()
        AND approval_id IS NULL
        AND protocol_execution_id IS NULL
        AND decision_reason IS NULL
        AND failure_reason IS NULL
        AND approve_tx_hash IS NULL
        AND approve_tx_from IS NULL
        AND approve_tx_nonce IS NULL
        AND approve_replacement_tx_hash IS NULL
        AND approve_replacement_reason IS NULL
        AND approve_replacement_observed_at IS NULL
        AND deposit_tx_hash IS NULL
        AND deposit_tx_from IS NULL
        AND deposit_tx_nonce IS NULL
        AND deposit_replacement_tx_hash IS NULL
        AND deposit_replacement_reason IS NULL
        AND deposit_replacement_observed_at IS NULL
        AND deposit_l1_block_hash IS NULL
        AND deposit_l1_block_number IS NULL
        AND deposit_event_account_index IS NULL
        AND lighter_tx_hash IS NULL
        AND lighter_tx_status IS NULL
        AND lighter_block_height IS NULL
        AND lighter_executed_at IS NULL
        AND lighter_evidence_observed_at IS NULL
        AND resolved_account_index IS NULL
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.sessionId,
      input.environment,
      input.walletAddress,
      input.chainId,
      input.depositContract,
      input.depositTo,
      input.assetIndex,
      input.routeType,
      input.amountUnits,
      reason,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
    nextState: "failed",
    failureCode: "deposit_expired_before_approval_dispatch",
  });
  return intent;
}

export async function markApprovalDecisionWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly decision: "approved" | "rejected" | "expired";
    readonly approvalId?: string | null;
    readonly protocolExecutionId?: number | null;
    readonly reason?: string | null;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET approval_status = $2,
           execution_state = CASE WHEN $2 = 'approved' THEN 'approved' ELSE execution_state END,
           approval_id = COALESCE($3, approval_id),
           protocol_execution_id = COALESCE($4, protocol_execution_id),
           decision_reason = $5,
           decided_at = NOW(),
           updated_at = NOW()
     WHERE intent_id = $1
       AND capability = 'deposit'
       AND approval_status = 'approval_pending'
       AND execution_state = 'approval_pending'
     RETURNING ${RETURNING}`,
    [input.intentId, input.decision, input.approvalId ?? null, input.protocolExecutionId ?? null, input.reason ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  if (input.decision !== "approved") {
    await requireDepositWorkflowTransition(client, intent, {
      expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
      nextState: "failed",
      failureCode: input.decision === "rejected"
        ? "deposit_approval_rejected"
        : "deposit_approval_expired",
    });
  }
  return intent;
}

/**
 * Resolve a fresh approval card for a deposit whose allowance transaction was
 * already confirmed, while leaving that confirmed leg immutable. A rejection
 * or expiry terminalizes the recovery; only an approval may resume at the
 * deposit leg.
 */
export async function markConfirmedApprovalRecoveryDecisionWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly decision: "approved" | "rejected" | "expired";
    readonly approvalId?: string | null;
    readonly protocolExecutionId?: number | null;
    readonly reason?: string | null;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET approval_status = $2,
            execution_state = CASE WHEN $2 = 'approved' THEN execution_state ELSE 'failed' END,
            approval_id = $3,
            protocol_execution_id = $4,
            decision_reason = $5,
            decided_at = NOW(),
            failure_reason = CASE WHEN $2 = 'approved' THEN NULL ELSE $5 END,
            updated_at = NOW()
      WHERE intent_id = $1
        AND capability = 'deposit'
        AND approval_status = 'approval_pending'
        AND execution_state = 'approve_confirmed'
        AND approve_tx_hash IS NOT NULL
        AND approve_tx_from IS NOT NULL
        AND approve_tx_nonce IS NOT NULL
        AND deposit_tx_hash IS NULL
        AND deposit_tx_from IS NULL
        AND deposit_tx_nonce IS NULL
        AND deposit_replacement_tx_hash IS NULL
        AND deposit_l1_block_hash IS NULL
        AND lighter_tx_hash IS NULL
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.decision,
      input.approvalId ?? null,
      input.protocolExecutionId ?? null,
      input.reason ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  if (input.decision !== "approved") {
    await requireDepositWorkflowTransition(client, intent, {
      expectedStates: ["approve_confirmed"],
      nextState: "failed",
      failureCode: input.decision === "rejected"
        ? "deposit_recovery_approval_rejected"
        : "deposit_recovery_approval_expired",
    });
  }
  return intent;
}

/**
 * Retire an old-session deposit only when durable state proves that signing,
 * staging, submission, and settlement observation never began. The old row is
 * retained for audit; callers may atomically create a brand-new intent for the
 * current session after this transition succeeds.
 */
export async function supersedePristineDepositIntentWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly environment: LighterEnvironment;
    readonly walletAddress: string;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const reason =
    "Superseded by a fresh Lighter onboarding session before any transaction was signed or submitted.";
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET approval_status = CASE
              WHEN approval_status = 'approval_pending' THEN 'expired'
              ELSE approval_status
            END,
            execution_state = 'failed',
            decision_reason = CASE
              WHEN approval_status = 'approval_pending' THEN $5
              ELSE decision_reason
            END,
            decided_at = CASE
              WHEN approval_status = 'approval_pending' THEN NOW()
              ELSE decided_at
            END,
            failure_reason = $5,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND environment = $3
        AND LOWER(wallet_address) = LOWER($4)
        AND capability = 'deposit'
        AND failure_reason IS NULL
        AND (
          (
            approval_status = 'approval_pending'
            AND execution_state = 'approval_pending'
            AND approval_id IS NULL
            AND protocol_execution_id IS NULL
            AND decision_reason IS NULL
          )
          OR (
            approval_status = 'approved'
            AND execution_state = 'approved'
          )
        )
        AND approve_tx_hash IS NULL
        AND approve_tx_from IS NULL
        AND approve_tx_nonce IS NULL
        AND approve_replacement_tx_hash IS NULL
        AND approve_replacement_reason IS NULL
        AND approve_replacement_observed_at IS NULL
        AND deposit_tx_hash IS NULL
        AND deposit_tx_from IS NULL
        AND deposit_tx_nonce IS NULL
        AND deposit_replacement_tx_hash IS NULL
        AND deposit_replacement_reason IS NULL
        AND deposit_replacement_observed_at IS NULL
        AND deposit_l1_block_hash IS NULL
        AND deposit_l1_block_number IS NULL
        AND deposit_event_account_index IS NULL
        AND lighter_tx_hash IS NULL
        AND lighter_tx_status IS NULL
        AND lighter_block_height IS NULL
        AND lighter_executed_at IS NULL
        AND lighter_evidence_observed_at IS NULL
        AND resolved_account_index IS NULL
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.sessionId,
      input.environment,
      input.walletAddress,
      reason,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
    nextState: "failed",
    failureCode: "deposit_superseded_pristine",
  });
  return intent;
}

/**
 * Extend only an approved deposit intent that provably never reached signing,
 * staging, submission, or settlement evidence. The original approval remains
 * in the audit trail; the fresh public preflight replaces stale balance and fee
 * evidence before the caller issues and binds a fresh approval card.
 */
export async function renewPristineApprovedDepositIntentWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly preflight: LighterDepositPreflightSnapshot;
    readonly expiresAt: Date;
  },
): Promise<LighterOnboardingIntentRow | null> {
  if (
    !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt.getTime() <= Date.now()
  ) {
    throw new Error("Lighter deposit approval retry expiry must be in the future.");
  }
  const snapshot = input.preflight;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET settlement_token_address = $4,
            settlement_token_symbol = $5,
            settlement_token_decimals = $6,
            preflight_min_transfer_units = $7,
            preflight_wallet_balance_units = $8,
            preflight_wallet_allowance_units = $9,
            preflight_wallet_native_balance_wei = $10,
            preflight_ethereum_block_number = $11,
            preflight_lighter_block_number = $12,
            preflight_observed_at = $13,
            preflight_approve_gas_limit = $14,
            preflight_deposit_gas_limit = $15,
            preflight_max_fee_per_gas_wei = $16,
            preflight_max_priority_fee_per_gas_wei = $17,
            preflight_approve_max_fee_wei = $18,
            preflight_deposit_max_fee_wei = $19,
            preflight_total_max_fee_wei = $20,
            preflight_native_reserve_wei = $21,
            preflight_required_native_balance_wei = $22,
            preflight_public_snapshot = $23::jsonb,
            expires_at = $24,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'deposit'
        AND approval_status = 'approved'
        AND execution_state = 'approved'
        AND LOWER(wallet_address) = LOWER($3)
        AND chain_id = $25
        AND LOWER(deposit_contract) = LOWER($26)
        AND LOWER(deposit_to) = LOWER($3)
        AND asset_index = $27
        AND route_type = $28
        AND amount_units = $29
        AND approve_tx_hash IS NULL
        AND approve_tx_from IS NULL
        AND approve_tx_nonce IS NULL
        AND approve_replacement_tx_hash IS NULL
        AND approve_replacement_reason IS NULL
        AND approve_replacement_observed_at IS NULL
        AND deposit_tx_hash IS NULL
        AND deposit_tx_from IS NULL
        AND deposit_tx_nonce IS NULL
        AND deposit_replacement_tx_hash IS NULL
        AND deposit_replacement_reason IS NULL
        AND deposit_replacement_observed_at IS NULL
        AND deposit_l1_block_hash IS NULL
        AND deposit_l1_block_number IS NULL
        AND deposit_event_account_index IS NULL
        AND lighter_tx_hash IS NULL
        AND lighter_tx_status IS NULL
        AND lighter_block_height IS NULL
        AND lighter_executed_at IS NULL
        AND lighter_evidence_observed_at IS NULL
        AND resolved_account_index IS NULL
        AND failure_reason IS NULL
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.sessionId,
      snapshot.walletAddress,
      snapshot.settlementTokenAddress,
      snapshot.settlementTokenSymbol,
      snapshot.settlementTokenDecimals,
      snapshot.minimumTransferUnits,
      snapshot.walletBalanceUnits,
      snapshot.walletAllowanceUnits,
      snapshot.walletNativeBalanceWei,
      snapshot.ethereumBlockNumber,
      snapshot.lighterBlockNumber,
      snapshot.observedAt,
      snapshot.approveGasLimit,
      snapshot.depositGasLimit,
      snapshot.maxFeePerGasWei,
      snapshot.maxPriorityFeePerGasWei,
      snapshot.approveMaxFeeWei,
      snapshot.depositMaxFeeWei,
      snapshot.totalMaxFeeWei,
      snapshot.nativeReserveWei,
      snapshot.requiredNativeBalanceWei,
      jsonb(toPublicSnapshot(snapshot)),
      input.expiresAt,
      snapshot.chainId,
      snapshot.gatewayAddress,
      snapshot.assetIndex,
      snapshot.routeType,
      snapshot.amountUnits,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/**
 * Prepare a new approval card after the allowance leg is durably confirmed but
 * before any deposit transaction identity exists. The live snapshot replaces
 * the old approval-era preflight so the new card discloses only the remaining
 * deposit leg. The confirmed approval hash/sender/nonce are never cleared.
 */
export async function renewConfirmedApprovalDepositIntentWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly preflight: LighterDepositPreflightSnapshot;
    readonly expiresAt: Date;
  },
): Promise<LighterOnboardingIntentRow | null> {
  if (
    !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt.getTime() <= Date.now()
  ) {
    throw new Error("Lighter confirmed-approval recovery expiry must be in the future.");
  }
  if (input.preflight.approvalRequired) {
    throw new Error("Lighter confirmed-approval recovery requires sufficient live allowance.");
  }
  const snapshot = input.preflight;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET approval_status = 'approval_pending',
            approval_id = NULL,
            protocol_execution_id = NULL,
            decision_reason = NULL,
            decided_at = NULL,
            settlement_token_address = $4,
            settlement_token_symbol = $5,
            settlement_token_decimals = $6,
            preflight_min_transfer_units = $7,
            preflight_wallet_balance_units = $8,
            preflight_wallet_allowance_units = $9,
            preflight_wallet_native_balance_wei = $10,
            preflight_ethereum_block_number = $11,
            preflight_lighter_block_number = $12,
            preflight_observed_at = $13,
            preflight_approve_gas_limit = $14,
            preflight_deposit_gas_limit = $15,
            preflight_max_fee_per_gas_wei = $16,
            preflight_max_priority_fee_per_gas_wei = $17,
            preflight_approve_max_fee_wei = $18,
            preflight_deposit_max_fee_wei = $19,
            preflight_total_max_fee_wei = $20,
            preflight_native_reserve_wei = $21,
            preflight_required_native_balance_wei = $22,
            preflight_public_snapshot = $23::jsonb,
            expires_at = $24,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'deposit'
        AND approval_status = 'approved'
        AND execution_state = 'approve_confirmed'
        AND LOWER(wallet_address) = LOWER($3)
        AND chain_id = $25
        AND LOWER(deposit_contract) = LOWER($26)
        AND LOWER(deposit_to) = LOWER($3)
        AND asset_index = $27
        AND route_type = $28
        AND amount_units = $29
        AND approve_tx_hash IS NOT NULL
        AND approve_tx_from IS NOT NULL
        AND approve_tx_nonce IS NOT NULL
        AND deposit_tx_hash IS NULL
        AND deposit_tx_from IS NULL
        AND deposit_tx_nonce IS NULL
        AND deposit_replacement_tx_hash IS NULL
        AND deposit_replacement_reason IS NULL
        AND deposit_replacement_observed_at IS NULL
        AND deposit_l1_block_hash IS NULL
        AND deposit_l1_block_number IS NULL
        AND deposit_event_account_index IS NULL
        AND lighter_tx_hash IS NULL
        AND lighter_tx_status IS NULL
        AND lighter_block_height IS NULL
        AND lighter_executed_at IS NULL
        AND lighter_evidence_observed_at IS NULL
        AND resolved_account_index IS NULL
        AND failure_reason IS NULL
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.sessionId,
      snapshot.walletAddress,
      snapshot.settlementTokenAddress,
      snapshot.settlementTokenSymbol,
      snapshot.settlementTokenDecimals,
      snapshot.minimumTransferUnits,
      snapshot.walletBalanceUnits,
      snapshot.walletAllowanceUnits,
      snapshot.walletNativeBalanceWei,
      snapshot.ethereumBlockNumber,
      snapshot.lighterBlockNumber,
      snapshot.observedAt,
      snapshot.approveGasLimit,
      snapshot.depositGasLimit,
      snapshot.maxFeePerGasWei,
      snapshot.maxPriorityFeePerGasWei,
      snapshot.approveMaxFeeWei,
      snapshot.depositMaxFeeWei,
      snapshot.totalMaxFeeWei,
      snapshot.nativeReserveWei,
      snapshot.requiredNativeBalanceWei,
      jsonb(toPublicSnapshot(snapshot)),
      input.expiresAt,
      snapshot.chainId,
      snapshot.gatewayAddress,
      snapshot.assetIndex,
      snapshot.routeType,
      snapshot.amountUnits,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Persist an approve tx hash before broadcast; only from the approved state. */
export async function markApproveSubmittedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  transaction: LighterStagedEvmTransaction,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(client, intentId, "approve_submitted", ["approved"], {
    approve_tx_hash: transaction.txHash,
    approve_tx_from: transaction.fromAddress,
    approve_tx_nonce: transaction.nonce,
  }, {
    expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
    nextState: "approve_staged",
  });
}

export async function markApproveConfirmedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  txHash: string,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'approve_confirmed', updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state = 'approve_submitted'
        AND LOWER(COALESCE(approve_replacement_tx_hash, approve_tx_hash)) = LOWER($2)
      RETURNING ${RETURNING}`,
    [intentId, txHash],
  );
  const advancedRow = result.rows[0];
  if (advancedRow !== undefined) {
    const advanced = mapRow(advancedRow);
    await requireDepositWorkflowTransition(client, advanced, {
      expectedStates: ["approve_staged", "ambiguous"],
      nextState: "approve_confirmed",
    });
    return advanced;
  }

  // The evidence-only repair sweep may win the same confirmation transition
  // while the live executor is awaiting the receipt. Treat that exact durable
  // end state as idempotent instead of downgrading it to ambiguity.
  const existing = await client.query<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents i
      WHERE i.intent_id = $1
        AND i.capability = 'deposit'
        AND i.execution_state = 'approve_confirmed'
        AND LOWER(COALESCE(i.approve_replacement_tx_hash, i.approve_tx_hash)) = LOWER($2)
        AND i.approve_tx_from IS NOT NULL
        AND i.approve_tx_nonce IS NOT NULL
        AND i.deposit_tx_hash IS NULL
        AND i.deposit_replacement_tx_hash IS NULL
        AND EXISTS (
          SELECT 1
            FROM lighter_onboarding_workflows w
           WHERE w.environment = i.environment
             AND w.wallet_address = LOWER(i.wallet_address)
             AND w.workflow_state = 'approve_confirmed'
             AND w.active_deposit_intent_id = i.intent_id
        )`,
    [intentId, txHash],
  );
  const row = existing.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Record that the live on-chain allowance already covered this exact amount. */
export async function markAllowanceVerifiedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "allowance_verified",
    ["approved"],
    {},
    {
      expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
      nextState: "allowance_verified",
    },
  );
}

/** Persist a deposit tx hash before broadcast; only after allowance is proven. */
export async function markDepositSubmittedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  transaction: LighterStagedEvmTransaction,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "deposit_submitted",
    ["approve_confirmed", "allowance_verified"],
    {
      deposit_tx_hash: transaction.txHash,
      deposit_tx_from: transaction.fromAddress,
      deposit_tx_nonce: transaction.nonce,
    },
    {
      expectedStates: ["approve_confirmed", "allowance_verified"],
      nextState: "deposit_staged",
    },
  );
}

export async function recordApproveReplacementWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  replacement: LighterReplacementTransaction,
): Promise<LighterOnboardingIntentRow | null> {
  return recordReplacementWith(client, "approve", intentId, replacement);
}

export async function recordDepositReplacementWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  replacement: LighterReplacementTransaction,
): Promise<LighterOnboardingIntentRow | null> {
  return recordReplacementWith(client, "deposit", intentId, replacement);
}

export async function markDepositConfirmedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  evidence: LighterDepositL1Evidence,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'deposit_confirmed',
            deposit_l1_block_hash = $3,
            deposit_l1_block_number = $4,
            deposit_event_account_index = $5,
            failure_reason = NULL,
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)
        AND LOWER(wallet_address) = LOWER($6)
        AND asset_index = $7
        AND route_type = $8
        AND amount_units = $9
        AND execution_state IN ('deposit_submitted', 'ambiguous')
      RETURNING ${RETURNING}`,
    [
      intentId,
      evidence.txHash,
      evidence.blockHash,
      evidence.blockNumber,
      evidence.accountIndex,
      evidence.walletAddress,
      evidence.assetIndex,
      evidence.routeType,
      evidence.amountUnits,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_staged", "ambiguous"],
    nextState: "deposit_l1_confirmed",
  });
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_l1_confirmed"],
    nextState: "deposit_l2_pending",
  });
  return intent;
}

export async function markDepositCreditedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  evidence: LighterDepositCreditEvidence,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'credited',
            resolved_account_index = $3,
            lighter_tx_hash = $4,
            lighter_tx_status = $5,
            lighter_block_height = $6,
            lighter_executed_at = $7,
            lighter_evidence_observed_at = NOW(),
            failure_reason = NULL,
            updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state = 'deposit_confirmed'
        AND LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)
        AND LOWER(deposit_l1_block_hash) = LOWER($8)
        AND deposit_l1_block_number = $9
        AND deposit_event_account_index = $3
        AND LOWER(wallet_address) = LOWER($10)
        AND asset_index = $11
        AND route_type = $12
        AND amount_units = $13
      RETURNING ${RETURNING}`,
    [
      intentId,
      evidence.txHash,
      evidence.accountIndex,
      evidence.lighterTxHash,
      evidence.lighterStatus,
      evidence.lighterBlockHeight,
      evidence.lighterExecutedAt,
      evidence.blockHash,
      evidence.blockNumber,
      evidence.walletAddress,
      evidence.assetIndex,
      evidence.routeType,
      evidence.amountUnits,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_l2_pending"],
    nextState: "account_resolved",
    resolvedAccountIndex: evidence.accountIndex,
  });
  return intent;
}

/** Attach exact L1 evidence to a pre-Phase-2 confirmed row without replaying its workflow. */
export async function recordConfirmedDepositL1EvidenceWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  evidence: LighterDepositL1Evidence,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET deposit_l1_block_hash = $3,
            deposit_l1_block_number = $4,
            deposit_event_account_index = $5,
            updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state = 'deposit_confirmed'
        AND deposit_l1_block_hash IS NULL
        AND deposit_l1_block_number IS NULL
        AND deposit_event_account_index IS NULL
        AND LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)
        AND LOWER(wallet_address) = LOWER($6)
        AND asset_index = $7
        AND route_type = $8
        AND amount_units = $9
      RETURNING ${RETURNING}`,
    [
      intentId,
      evidence.txHash,
      evidence.blockHash,
      evidence.blockNumber,
      evidence.accountIndex,
      evidence.walletAddress,
      evidence.assetIndex,
      evidence.routeType,
      evidence.amountUnits,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Rebind a still-uncredited confirmed deposit to its latest canonical block evidence. */
export async function reconcileConfirmedDepositL1EvidenceWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  evidence: LighterDepositL1Evidence,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET deposit_l1_block_hash = $3,
            deposit_l1_block_number = $4,
            deposit_event_account_index = $5,
            failure_reason = NULL,
            updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state = 'deposit_confirmed'
        AND LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)
        AND LOWER(wallet_address) = LOWER($6)
        AND asset_index = $7
        AND route_type = $8
        AND amount_units = $9
      RETURNING ${RETURNING}`,
    [
      intentId,
      evidence.txHash,
      evidence.blockHash,
      evidence.blockNumber,
      evidence.accountIndex,
      evidence.walletAddress,
      evidence.assetIndex,
      evidence.routeType,
      evidence.amountUnits,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function markAmbiguousWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  reason: string,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = 'ambiguous', failure_reason = $2, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state NOT IN ('credited','failed')
     RETURNING ${RETURNING}`,
    [intentId, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: [
      "deposit_approval_pending",
      "deposit_preflight_validated",
      "allowance_verified",
      "approve_staged",
      "approve_confirmed",
      "deposit_staged",
      "deposit_l1_confirmed",
      "deposit_l2_pending",
    ],
    nextState: "ambiguous",
    failureCode: "deposit_outcome_ambiguous",
  });
  return intent;
}

export async function markFailedWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  reason: string,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = 'failed', failure_reason = $2, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state NOT IN ('credited')
     RETURNING ${RETURNING}`,
    [intentId, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: [
      "deposit_approval_pending",
      "deposit_preflight_validated",
      "allowance_verified",
      "approve_staged",
      "approve_confirmed",
      "deposit_staged",
      "deposit_l1_confirmed",
      "deposit_l2_pending",
      "ambiguous",
    ],
    nextState: "failed",
    failureCode: "deposit_failed",
  });
  return intent;
}

export async function findByIntentId(intentId: string): Promise<LighterOnboardingIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents WHERE intent_id = $1`,
    [intentId],
  );
  return row ? mapRow(row) : null;
}

export async function listUnresolved(
  environment: LighterEnvironment,
): Promise<LighterOnboardingIntentRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents
      WHERE environment = $1
        AND execution_state NOT IN ('credited','failed')
        AND approval_status <> 'rejected'
      ORDER BY updated_at DESC`,
    [environment],
  );
  return rows.map(mapRow);
}

export async function listUnresolvedDepositsForWallet(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingIntentRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents
      WHERE environment = $1
        AND capability = 'deposit'
        AND LOWER(wallet_address) = LOWER($2)
        AND execution_state NOT IN ('credited','failed')
        AND approval_status <> 'rejected'
      ORDER BY updated_at DESC`,
    [environment, walletAddress],
  );
  return rows.map(mapRow);
}

export async function reconcileApproveReceiptWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly txHash: string;
    readonly outcome: "confirmed" | "reverted";
  },
): Promise<LighterOnboardingIntentRow | null> {
  const next = input.outcome === "confirmed" ? "approve_confirmed" : "failed";
  const reason = input.outcome === "reverted"
    ? "Ethereum receipt proves the Lighter USDC approval transaction reverted."
    : null;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = $3,
            failure_reason = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(COALESCE(approve_replacement_tx_hash, approve_tx_hash)) = LOWER($2)
        AND deposit_tx_hash IS NULL
        AND execution_state IN ('approve_submitted', 'ambiguous')
      RETURNING ${RETURNING}`,
    [input.intentId, input.txHash, next, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, input.outcome === "confirmed"
    ? {
        expectedStates: ["approve_staged", "ambiguous"],
        nextState: "approve_confirmed",
      }
    : {
        expectedStates: ["approve_staged", "ambiguous"],
        nextState: "failed",
        failureCode: "approve_transaction_reverted",
      });
  return intent;
}

export async function reconcileDepositReceiptWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly txHash: string;
    readonly outcome: "confirmed" | "reverted";
    readonly evidence?: LighterDepositL1Evidence;
  },
): Promise<LighterOnboardingIntentRow | null> {
  if (input.outcome === "confirmed") {
    if (input.evidence === undefined) {
      throw new Error("Confirmed Lighter deposit reconciliation requires exact L1 event evidence.");
    }
    if (input.evidence.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new Error("Lighter deposit reconciliation evidence hash does not match the staged hash.");
    }
    return markDepositConfirmedWith(client, input.intentId, input.evidence);
  }

  const next = "failed";
  const reason = "Ethereum receipt proves the Lighter deposit transaction reverted.";
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = $3,
            failure_reason = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)
        AND execution_state IN ('deposit_submitted', 'ambiguous')
      RETURNING ${RETURNING}`,
    [input.intentId, input.txHash, next, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: ["deposit_staged", "ambiguous"],
    nextState: "failed",
    failureCode: "deposit_transaction_reverted",
  });
  return intent;
}

async function recordReplacementWith(
  client: LighterOnboardingQueryClient,
  stage: "approve" | "deposit",
  intentId: string,
  replacement: LighterReplacementTransaction,
): Promise<LighterOnboardingIntentRow | null> {
  const prefix = stage === "approve" ? "approve" : "deposit";
  const allowedStates = stage === "approve"
    ? ["approve_submitted", "ambiguous"]
    : ["deposit_submitted", "ambiguous"];
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET ${prefix}_replacement_tx_hash = $3,
            ${prefix}_replacement_reason = $4,
            ${prefix}_replacement_observed_at = COALESCE(
              ${prefix}_replacement_observed_at,
              $5
            ),
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(${prefix}_tx_hash) = LOWER($2)
        AND ${prefix}_tx_from IS NOT NULL
        AND ${prefix}_tx_nonce IS NOT NULL
        AND execution_state = ANY($6)
        AND (
          ${prefix}_replacement_tx_hash IS NULL
          OR LOWER(${prefix}_replacement_tx_hash) = LOWER($3)
        )
      RETURNING ${RETURNING}`,
    [
      intentId,
      replacement.originalTxHash,
      replacement.replacementTxHash,
      replacement.reason,
      replacement.observedAt,
      allowedStates,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

async function advanceDepositWith(
  client: LighterOnboardingQueryClient,
  intentId: string,
  next: LighterOnboardingExecutionState,
  from: LighterOnboardingExecutionState[],
  set: Record<string, unknown> = {},
  workflow: {
    readonly expectedStates: readonly LighterOnboardingWorkflowState[];
    readonly nextState: LighterOnboardingWorkflowState;
    readonly resolvedAccountIndex?: number | null;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const columns = Object.keys(set);
  const setClauses = columns.map((col, i) => `${col} = $${i + 3}`);
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = $2${setClauses.length ? ", " + setClauses.join(", ") : ""}, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state = ANY($${columns.length + 3})
     RETURNING ${RETURNING}`,
    [intentId, next, ...columns.map((c) => set[c]), from],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, workflow);
  return intent;
}

async function requireDepositWorkflowTransition(
  client: LighterOnboardingQueryClient,
  intent: LighterOnboardingIntentRow,
  input: {
    readonly expectedStates: readonly LighterOnboardingWorkflowState[];
    readonly nextState: LighterOnboardingWorkflowState;
    readonly resolvedAccountIndex?: number | null;
    readonly failureCode?: string | null;
  },
): Promise<void> {
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: input.expectedStates,
    nextState: input.nextState,
    activeDepositIntentId: intent.intentId,
    resolvedAccountIndex: input.resolvedAccountIndex,
    failureCode: input.failureCode,
  });
  if (workflow === null) {
    throw new Error(
      `Lighter onboarding workflow rejected ${input.nextState} for intent ${intent.intentId}.`,
    );
  }
}

function mapRow(row: Record<string, unknown>): LighterOnboardingIntentRow {
  return {
    intentId: String(row.intent_id),
    sessionId: String(row.session_id),
    protocolExecutionId: row.protocol_execution_id === null ? null : Number(row.protocol_execution_id),
    approvalId: row.approval_id === null ? null : String(row.approval_id),
    environment: row.environment as LighterEnvironment,
    capability: row.capability as LighterOnboardingCapability,
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    depositContract: row.deposit_contract === null ? null : String(row.deposit_contract),
    depositTo: row.deposit_to === null ? null : String(row.deposit_to),
    assetIndex: row.asset_index === null ? null : Number(row.asset_index),
    routeType: row.route_type === null ? null : Number(row.route_type),
    amountUnits: row.amount_units === null ? null : String(row.amount_units),
    settlementTokenAddress: row.settlement_token_address === null
      ? null
      : String(row.settlement_token_address),
    settlementTokenSymbol: row.settlement_token_symbol === null
      ? null
      : String(row.settlement_token_symbol),
    settlementTokenDecimals: row.settlement_token_decimals === null
      ? null
      : Number(row.settlement_token_decimals),
    preflightMinimumTransferUnits: row.preflight_min_transfer_units === null
      ? null
      : String(row.preflight_min_transfer_units),
    preflightWalletBalanceUnits: row.preflight_wallet_balance_units === null
      ? null
      : String(row.preflight_wallet_balance_units),
    preflightWalletAllowanceUnits: row.preflight_wallet_allowance_units === null
      ? null
      : String(row.preflight_wallet_allowance_units),
    preflightWalletNativeBalanceWei: row.preflight_wallet_native_balance_wei === null
      ? null
      : String(row.preflight_wallet_native_balance_wei),
    preflightEthereumBlockNumber: row.preflight_ethereum_block_number === null
      ? null
      : String(row.preflight_ethereum_block_number),
    preflightLighterBlockNumber: row.preflight_lighter_block_number === null
      ? null
      : String(row.preflight_lighter_block_number),
    preflightObservedAt: row.preflight_observed_at === null
      ? null
      : row.preflight_observed_at as Date,
    preflightApproveGasLimit: nullableString(row.preflight_approve_gas_limit),
    preflightDepositGasLimit: nullableString(row.preflight_deposit_gas_limit),
    preflightMaxFeePerGasWei: nullableString(row.preflight_max_fee_per_gas_wei),
    preflightMaxPriorityFeePerGasWei: nullableString(row.preflight_max_priority_fee_per_gas_wei),
    preflightApproveMaxFeeWei: nullableString(row.preflight_approve_max_fee_wei),
    preflightDepositMaxFeeWei: nullableString(row.preflight_deposit_max_fee_wei),
    preflightTotalMaxFeeWei: nullableString(row.preflight_total_max_fee_wei),
    preflightNativeReserveWei: nullableString(row.preflight_native_reserve_wei),
    preflightRequiredNativeBalanceWei: nullableString(
      row.preflight_required_native_balance_wei,
    ),
    preflightPublicSnapshot: parsePublicSnapshot(row.preflight_public_snapshot),
    approvalStatus: row.approval_status as LighterOnboardingApprovalStatus,
    executionState: row.execution_state as LighterOnboardingExecutionState,
    approveTxHash: row.approve_tx_hash === null ? null : String(row.approve_tx_hash),
    approveTxFrom: nullableString(row.approve_tx_from),
    approveTxNonce: nullableString(row.approve_tx_nonce),
    approveReplacementTxHash: nullableString(row.approve_replacement_tx_hash),
    approveReplacementReason: row.approve_replacement_reason === null
      || row.approve_replacement_reason === undefined
      ? null
      : "repriced",
    approveReplacementObservedAt: row.approve_replacement_observed_at === null
      || row.approve_replacement_observed_at === undefined
      ? null
      : row.approve_replacement_observed_at as Date,
    depositTxHash: row.deposit_tx_hash === null ? null : String(row.deposit_tx_hash),
    depositTxFrom: nullableString(row.deposit_tx_from),
    depositTxNonce: nullableString(row.deposit_tx_nonce),
    depositReplacementTxHash: nullableString(row.deposit_replacement_tx_hash),
    depositReplacementReason: row.deposit_replacement_reason === null
      || row.deposit_replacement_reason === undefined
      ? null
      : "repriced",
    depositReplacementObservedAt: row.deposit_replacement_observed_at === null
      || row.deposit_replacement_observed_at === undefined
      ? null
      : row.deposit_replacement_observed_at as Date,
    depositL1BlockHash: row.deposit_l1_block_hash === null ? null : String(row.deposit_l1_block_hash),
    depositL1BlockNumber: row.deposit_l1_block_number === null ? null : String(row.deposit_l1_block_number),
    depositEventAccountIndex: row.deposit_event_account_index === null
      ? null
      : Number(row.deposit_event_account_index),
    lighterTxHash: row.lighter_tx_hash === null ? null : String(row.lighter_tx_hash),
    lighterTxStatus: row.lighter_tx_status === null ? null : Number(row.lighter_tx_status),
    lighterBlockHeight: row.lighter_block_height === null ? null : Number(row.lighter_block_height),
    lighterExecutedAt: row.lighter_executed_at === null ? null : Number(row.lighter_executed_at),
    lighterEvidenceObservedAt: row.lighter_evidence_observed_at === null
      ? null
      : row.lighter_evidence_observed_at as Date,
    resolvedAccountIndex: row.resolved_account_index === null ? null : Number(row.resolved_account_index),
    decisionReason: row.decision_reason === null ? null : String(row.decision_reason),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

function assertPreflightMatchesInput(input: CreateDepositIntentInput): void {
  const snapshot = input.preflight;
  if (
    snapshot.environment !== input.environment
    || snapshot.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()
    || snapshot.beneficiaryAddress.toLowerCase() !== input.depositTo.toLowerCase()
    || snapshot.chainId !== input.chainId
    || snapshot.gatewayAddress.toLowerCase() !== input.depositContract.toLowerCase()
    || snapshot.assetIndex !== input.assetIndex
    || snapshot.routeType !== input.routeType
    || snapshot.amountUnits !== input.amountUnits
  ) {
    throw new Error("Lighter deposit preflight does not match the durable intent fields.");
  }
}

function toPublicSnapshot(
  snapshot: LighterDepositPreflightSnapshot,
): LighterDepositPublicSnapshot {
  return {
    ...snapshot,
    observedAt: snapshot.observedAt.toISOString(),
  };
}

function parsePublicSnapshot(value: unknown): LighterDepositPublicSnapshot | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  const snapshot = value as Record<string, unknown>;
  const observedAt = requiredSnapshotString(snapshot.observedAt);
  if (!Number.isFinite(Date.parse(observedAt)) || snapshot.depositValueWei !== "0") {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return {
    observedAt,
    environment: requiredSnapshotEnvironment(snapshot.environment),
    lighterRestBaseUrl: requiredSnapshotString(snapshot.lighterRestBaseUrl),
    settlementNetworkName: requiredSnapshotString(snapshot.settlementNetworkName),
    walletAddress: requiredSnapshotString(snapshot.walletAddress),
    beneficiaryAddress: requiredSnapshotString(snapshot.beneficiaryAddress),
    chainId: requiredSnapshotInteger(snapshot.chainId),
    settlementBlockNumber: requiredSnapshotString(snapshot.settlementBlockNumber),
    ethereumBlockNumber: requiredSnapshotString(snapshot.ethereumBlockNumber),
    lighterBlockNumber: requiredSnapshotString(snapshot.lighterBlockNumber),
    gatewayAddress: requiredSnapshotString(snapshot.gatewayAddress),
    gatewayImplementationAddress: nullableSnapshotString(snapshot.gatewayImplementationAddress),
    gatewayCodeHash: requiredSnapshotString(snapshot.gatewayCodeHash),
    settlementTokenAddress: requiredSnapshotString(snapshot.settlementTokenAddress),
    settlementTokenImplementationAddress: nullableSnapshotString(
      snapshot.settlementTokenImplementationAddress,
    ),
    settlementTokenCodeHash: requiredSnapshotString(snapshot.settlementTokenCodeHash),
    settlementTokenSymbol: requiredSnapshotSettlementSymbol(snapshot.settlementTokenSymbol),
    settlementTokenDecimals: requiredSnapshotInteger(snapshot.settlementTokenDecimals),
    assetIndex: requiredSnapshotInteger(snapshot.assetIndex),
    routeType: requiredSnapshotInteger(snapshot.routeType),
    amountUnits: requiredSnapshotString(snapshot.amountUnits),
    minimumTransferUnits: requiredSnapshotString(snapshot.minimumTransferUnits),
    depositCalldata: requiredSnapshotHex(snapshot.depositCalldata),
    depositValueWei: "0",
    walletBalanceUnits: requiredSnapshotString(snapshot.walletBalanceUnits),
    walletAllowanceUnits: requiredSnapshotString(snapshot.walletAllowanceUnits),
    walletNativeBalanceWei: requiredSnapshotString(snapshot.walletNativeBalanceWei),
    approvalRequired: requiredSnapshotBoolean(snapshot.approvalRequired),
    approveGasLimit: requiredSnapshotString(snapshot.approveGasLimit),
    depositGasLimit: requiredSnapshotString(snapshot.depositGasLimit),
    maxFeePerGasWei: requiredSnapshotString(snapshot.maxFeePerGasWei),
    maxPriorityFeePerGasWei: requiredSnapshotString(snapshot.maxPriorityFeePerGasWei),
    approveMaxFeeWei: requiredSnapshotString(snapshot.approveMaxFeeWei),
    depositMaxFeeWei: requiredSnapshotString(snapshot.depositMaxFeeWei),
    totalMaxFeeWei: requiredSnapshotString(snapshot.totalMaxFeeWei),
    nativeReserveWei: requiredSnapshotString(snapshot.nativeReserveWei),
    requiredNativeBalanceWei: requiredSnapshotString(snapshot.requiredNativeBalanceWei),
  };
}

function requiredSnapshotString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value;
}

function nullableSnapshotString(value: unknown): string | null {
  return value === null ? null : requiredSnapshotString(value);
}

function requiredSnapshotInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value;
}

function requiredSnapshotBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value;
}

function requiredSnapshotEnvironment(value: unknown): LighterEnvironment {
  if (value !== "core" && value !== "rhc") {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value;
}

function requiredSnapshotSettlementSymbol(
  value: unknown,
): LighterDepositPublicSnapshot["settlementTokenSymbol"] {
  if (value !== "USDC" && value !== "USDG") {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value;
}

function requiredSnapshotHex(
  value: unknown,
): LighterDepositPublicSnapshot["depositCalldata"] {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("Stored Lighter deposit public preflight snapshot is invalid.");
  }
  return value as LighterDepositPublicSnapshot["depositCalldata"];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function effectiveApproveTxHash(intent: LighterOnboardingIntentRow): string | null {
  return intent.approveReplacementTxHash ?? intent.approveTxHash;
}

export function effectiveDepositTxHash(intent: LighterOnboardingIntentRow): string | null {
  return intent.depositReplacementTxHash ?? intent.depositTxHash;
}
