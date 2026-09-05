import { readLighterOrderFeeTerms } from "@tools/lighter/order-fee-terms.js";
import type { LighterIntegratorFees } from "@tools/lighter/fee-policy.js";
import type { PoolClient } from "pg";

import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import { query, queryOne, queryOneWith, type Executor } from "../client.js";
import { jsonb, jsonbByteLength } from "../params.js";

export type LighterOrderLifecycleAction =
  | "cancel_one"
  | "modify"
  | "cancel_all"
  | "close_position";

export type LighterOrderLifecycleState =
  | "approval_pending"
  | "approved"
  | "pre_submit_revalidated"
  | "nonce_reserved"
  | "signed"
  | "submission_staged"
  | "api_accepted"
  | "sequencer_pending"
  | "completed"
  | "rejected"
  | "expired"
  | "ambiguous";

export interface LighterOrderLifecycleIntentRow {
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly intentId: string;
  readonly sessionId: string;
  readonly protocolExecutionId: number | null;
  readonly approvalId: string | null;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly actionType: LighterOrderLifecycleAction;
  readonly marketIndex: number | null;
  readonly providerOrderId: string | null;
  readonly requestedBaseAmountInteger: string | null;
  readonly requestedPriceInteger: string | null;
  readonly requestedSide: "buy" | "sell" | null;
  readonly reduceOnly: boolean;
  readonly providerSnapshotJson: Record<string, unknown>;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly approvalStatus: "approval_pending" | "approved" | "rejected" | "expired";
  readonly executionState: LighterOrderLifecycleState;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly preSubmitRevalidationJson: Record<string, unknown> | null;
  readonly preSubmitRevalidatedAt: string | null;
  readonly nonceReservationId: string | null;
  readonly nonceValue: string | null;
  readonly signerExpiryMs: number | null;
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

export interface CreateLighterOrderLifecycleIntentInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly protocolExecutionId?: number | null;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly actionType: LighterOrderLifecycleAction;
  readonly marketIndex: number | null;
  readonly providerOrderId: string | null;
  readonly requestedBaseAmountInteger?: string | null;
  readonly requestedPriceInteger?: string | null;
  readonly requestedSide?: "buy" | "sell" | null;
  readonly reduceOnly?: boolean;
  readonly providerSnapshotJson: Record<string, unknown>;
  readonly credentialRefJson: LighterTradingCredentialVaultReference;
  readonly expiresAt: string;
}

const COLUMNS = `
  intent_id, session_id, protocol_execution_id, approval_id, match_hash,
  environment, account_index, api_key_index, action_type, market_index,
  provider_order_id, requested_base_amount_integer, requested_price_integer,
  requested_side, reduce_only, provider_snapshot_json, credential_ref_json,
  approval_status, execution_state, decision_reason, decided_at,
  pre_submit_revalidation_json, pre_submit_revalidated_at,
  nonce_reservation_id, nonce_value, signer_expiry_ms, signer_tx_hash,
  submitted_tx_hash, submit_code, submit_message, predicted_execution_time_ms,
  volume_quota_remaining, provider_outcome_json, provider_outcome_checked_at,
  ambiguous_reason, created_at, updated_at, expires_at`;

const INSERT_SQL = `INSERT INTO lighter_order_lifecycle_intents (
  intent_id, session_id, protocol_execution_id, match_hash, environment,
  account_index, api_key_index, action_type, market_index, provider_order_id,
  requested_base_amount_integer, requested_price_integer, requested_side,
  reduce_only, provider_snapshot_json, credential_ref_json, expires_at
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10,
  $11, $12, $13,
  $14, $15::jsonb, $16::jsonb, $17
) ON CONFLICT (intent_id) DO NOTHING
RETURNING ${COLUMNS}`;

export async function createApprovalPendingWith(
  client: PoolClient,
  input: CreateLighterOrderLifecycleIntentInput,
): Promise<LighterOrderLifecycleIntentRow | null> {
  validateCreate(input);
  const row = await queryOneWith<Record<string, unknown>>(client, INSERT_SQL, [
    input.intentId,
    input.sessionId,
    input.protocolExecutionId ?? null,
    input.matchHash,
    input.environment,
    input.accountIndex,
    input.apiKeyIndex,
    input.actionType,
    input.marketIndex,
    input.providerOrderId,
    input.requestedBaseAmountInteger ?? null,
    input.requestedPriceInteger ?? null,
    input.requestedSide ?? null,
    input.reduceOnly ?? false,
    jsonb(input.providerSnapshotJson),
    jsonb(input.credentialRefJson),
    input.expiresAt,
  ]);
  return row === null ? null : mapRow(row);
}

export async function findByIntentId(
  sessionId: string,
  intentId: string,
): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE session_id = $1 AND intent_id = $2`,
    [sessionId, intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findByIntentIdAnySession(
  intentId: string,
): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents WHERE intent_id = $1`,
    [intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLiveTarget(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly actionType: LighterOrderLifecycleAction;
  readonly marketIndex: number | null;
  readonly providerOrderId: string | null;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE environment = $1 AND account_index = $2 AND action_type = $3
        AND market_index IS NOT DISTINCT FROM $4
        AND provider_order_id IS NOT DISTINCT FROM $5
        AND execution_state NOT IN ('completed','rejected','expired')
      ORDER BY created_at DESC LIMIT 1`,
    [input.environment, input.accountIndex, input.actionType, input.marketIndex, input.providerOrderId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLiveOrderTarget(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly providerOrderId: string;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  requireProviderOrderId(input.providerOrderId);
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE environment = $1 AND account_index = $2
        AND action_type IN ('cancel_one','modify')
        AND market_index = $3 AND provider_order_id = $4
        AND execution_state NOT IN ('completed','rejected','expired')
      ORDER BY created_at DESC LIMIT 1`,
    [input.environment, input.accountIndex, input.marketIndex, input.providerOrderId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLiveAccountWideCancel(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE environment = $1 AND account_index = $2 AND action_type = 'cancel_all'
        AND execution_state NOT IN ('completed','rejected','expired')
      ORDER BY created_at DESC LIMIT 1`,
    [input.environment, input.accountIndex],
  );
  return row === null ? null : mapRow(row);
}

export async function findAnyLiveOrderMutation(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE environment = $1 AND account_index = $2
        AND action_type IN ('cancel_one','modify','cancel_all','close_position')
        AND execution_state NOT IN ('completed','rejected','expired')
      ORDER BY created_at ASC LIMIT 1`,
    [input.environment, input.accountIndex],
  );
  return row === null ? null : mapRow(row);
}

/**
 * An expired lifecycle preparation may be replaced only before any nonce,
 * signature, submission, or provider-outcome evidence exists. Approved rows
 * keep their historical approval status; retiring them changes only the
 * execution state so the old approval can never be replayed.
 */
export function isSafelyExpirablePreSubmit(
  intent: LighterOrderLifecycleIntentRow,
  nowMs = Date.now(),
): boolean {
  const pending = intent.approvalStatus === "approval_pending"
    && intent.executionState === "approval_pending"
    && intent.approvalId === null
    && intent.decidedAt === null
    && intent.preSubmitRevalidationJson === null
    && intent.preSubmitRevalidatedAt === null;
  const approved = intent.approvalStatus === "approved"
    && intent.approvalId !== null
    && intent.decidedAt !== null
    && (
      (intent.executionState === "approved"
        && intent.preSubmitRevalidationJson === null
        && intent.preSubmitRevalidatedAt === null)
      || (intent.executionState === "pre_submit_revalidated"
        && intent.preSubmitRevalidationJson !== null
        && intent.preSubmitRevalidatedAt !== null)
    );
  return (pending || approved)
    && intent.nonceReservationId === null
    && intent.nonceValue === null
    && intent.signerExpiryMs === null
    && intent.signerTxHash === null
    && intent.submittedTxHash === null
    && intent.submitCode === null
    && intent.submitMessage === null
    && intent.predictedExecutionTimeMs === null
    && intent.volumeQuotaRemaining === null
    && intent.providerOutcomeJson === null
    && intent.providerOutcomeCheckedAt === null
    && intent.ambiguousReason === null
    && Number.isFinite(Date.parse(intent.expiresAt))
    && Date.parse(intent.expiresAt) <= nowMs;
}

export async function expireStalePreSubmitWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly matchHash: string;
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
    readonly actionType: LighterOrderLifecycleAction;
    readonly marketIndex: number | null;
    readonly providerOrderId: string | null;
  },
): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_order_lifecycle_intents
        SET approval_status = CASE
              WHEN approval_status = 'approval_pending' THEN 'expired'
              ELSE approval_status
            END,
            execution_state = 'expired',
            decision_reason = CASE
              WHEN approval_status = 'approval_pending'
                THEN 'Prepared Lighter lifecycle action expired before approval or submission.'
              ELSE decision_reason
            END,
            decided_at = COALESCE(decided_at, NOW()),
            updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND match_hash = $3
        AND environment = $4 AND account_index = $5 AND action_type = $6
        AND market_index IS NOT DISTINCT FROM $7
        AND provider_order_id IS NOT DISTINCT FROM $8
        AND expires_at <= NOW()
        AND (
          (approval_status = 'approval_pending' AND execution_state = 'approval_pending'
            AND approval_id IS NULL AND decided_at IS NULL
            AND pre_submit_revalidation_json IS NULL AND pre_submit_revalidated_at IS NULL)
          OR
          (approval_status = 'approved' AND approval_id IS NOT NULL AND decided_at IS NOT NULL
            AND (
              (execution_state = 'approved'
                AND pre_submit_revalidation_json IS NULL AND pre_submit_revalidated_at IS NULL)
              OR
              (execution_state = 'pre_submit_revalidated'
                AND pre_submit_revalidation_json IS NOT NULL AND pre_submit_revalidated_at IS NOT NULL)
            ))
        )
        AND nonce_reservation_id IS NULL AND nonce_value IS NULL
        AND signer_expiry_ms IS NULL AND signer_tx_hash IS NULL
        AND submitted_tx_hash IS NULL AND submit_code IS NULL AND submit_message IS NULL
        AND predicted_execution_time_ms IS NULL AND volume_quota_remaining IS NULL
        AND provider_outcome_json IS NULL AND provider_outcome_checked_at IS NULL
        AND ambiguous_reason IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.matchHash, input.environment, input.accountIndex,
      input.actionType, input.marketIndex, input.providerOrderId],
  );
  return row === null ? null : mapRow(row);
}

/** Terminalize a true live-position drift before any close transaction exists. */
export async function markClosePositionChangedBeforeSubmissionWith(
  client: Executor,
  input: {
  readonly intentId: string;
  readonly sessionId: string;
  },
): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
        SET execution_state = 'rejected',
            provider_outcome_json = jsonb_build_object(
              'kind', 'lighter_close_position_changed_before_submission',
              'transactionSubmitted', false
            ),
            provider_outcome_checked_at = NOW(), updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2
        AND action_type = 'close_position'
        AND approval_status = 'approved' AND execution_state = 'approved'
        AND pre_submit_revalidation_json IS NULL AND pre_submit_revalidated_at IS NULL
        AND nonce_reservation_id IS NULL AND nonce_value IS NULL
        AND signer_expiry_ms IS NULL AND signer_tx_hash IS NULL
        AND submitted_tx_hash IS NULL AND submit_code IS NULL AND submit_message IS NULL
        AND predicted_execution_time_ms IS NULL AND volume_quota_remaining IS NULL
        AND provider_outcome_json IS NULL AND provider_outcome_checked_at IS NULL
        AND ambiguous_reason IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId],
    client,
  );
}

/**
 * User-driven status includes expired pre-submit rows so they cannot disappear
 * behind a signed/submitted-only repair filter.
 */
export async function listStatusCandidates(
  environment?: LighterEnvironment,
  limit = 100,
): Promise<LighterOrderLifecycleIntentRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("lighter_order_lifecycle_intents: limit must be from 1 through 500");
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE (
        execution_state IN ('nonce_reserved','signed','submission_staged','api_accepted','sequencer_pending','ambiguous')
        OR (execution_state IN ('approval_pending','approved','pre_submit_revalidated') AND expires_at <= NOW())
      )
        AND ($1::text IS NULL OR environment = $1)
      ORDER BY updated_at ASC LIMIT $2`,
    [environment ?? null, limit],
  );
  return rows.map(mapRow);
}

export async function markApprovalDecision(input: {
  readonly intentId: string;
  readonly decision: "approved" | "rejected" | "expired";
  readonly approvalId: string;
  readonly reason: string;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_order_lifecycle_intents
      SET approval_status = $2, approval_id = $3, decision_reason = $4,
          decided_at = NOW(), execution_state = $2, updated_at = NOW()
      WHERE intent_id = $1 AND approval_status = 'approval_pending'
        AND execution_state = 'approval_pending'
      RETURNING ${COLUMNS}`,
    [input.intentId, input.decision, input.approvalId, input.reason],
  );
  return row === null ? null : mapRow(row);
}

export async function markPreSubmitRevalidated(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly evidence: Record<string, unknown>;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'pre_submit_revalidated',
          pre_submit_revalidation_json = $3::jsonb,
          pre_submit_revalidated_at = NOW(), updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND approval_status = 'approved'
        AND execution_state = 'approved' AND nonce_reservation_id IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, jsonb(input.evidence)],
  );
}

export async function attachNonceReservation(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly reservationId: string;
  readonly nonceValue: string;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return attachNonceReservationUsing(undefined, input);
}

export async function attachNonceReservationWith(
  client: Executor,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly reservationId: string;
    readonly nonceValue: string;
  },
): Promise<LighterOrderLifecycleIntentRow | null> {
  return attachNonceReservationUsing(client, input);
}

async function attachNonceReservationUsing(
  client: Executor | undefined,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly reservationId: string;
    readonly nonceValue: string;
  },
): Promise<LighterOrderLifecycleIntentRow | null> {
  requireDecimal("nonceValue", input.nonceValue, true);
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'nonce_reserved', nonce_reservation_id = $3,
          nonce_value = $4, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2
        AND approval_status = 'approved' AND execution_state = 'pre_submit_revalidated'
        AND nonce_reservation_id IS NULL AND nonce_value IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.reservationId, input.nonceValue],
    client,
  );
}

export async function markSigned(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly reservationId: string;
  readonly signerTxHash: string;
  readonly signerExpiryMs: number | null;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'signed', signer_tx_hash = $4,
          signer_expiry_ms = $5, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'nonce_reserved'
        AND nonce_reservation_id = $3 AND signer_tx_hash IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.reservationId, input.signerTxHash, input.signerExpiryMs],
  );
}

export async function markSubmissionStaged(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly signerTxHash: string;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'submission_staged', updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'signed'
        AND signer_tx_hash = $3
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.signerTxHash],
  );
}

export async function markApiAccepted(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly submitCode: number;
  readonly submitMessage: string | null;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining: string | null;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'api_accepted', submitted_tx_hash = $4,
          submit_code = $5, submit_message = $6,
          predicted_execution_time_ms = $7, volume_quota_remaining = $8,
          updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND execution_state = 'submission_staged'
        AND signer_tx_hash = $3 AND submitted_tx_hash IS NULL
      RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.signerTxHash, input.submittedTxHash,
      input.submitCode, input.submitMessage, input.predictedExecutionTimeMs, input.volumeQuotaRemaining],
  );
}

export async function markProviderOutcome(input: {
  readonly intentId: string;
  readonly state: "sequencer_pending" | "completed" | "rejected";
  readonly evidence: Record<string, unknown>;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = $2, provider_outcome_json = $3::jsonb,
          provider_outcome_checked_at = NOW(), updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state IN ('api_accepted','sequencer_pending','ambiguous')
      RETURNING ${COLUMNS}`,
    [input.intentId, input.state, jsonb(input.evidence)],
  );
}

export async function markAmbiguous(input: {
  readonly intentId: string;
  readonly reason: string;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  return transition(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = 'ambiguous', ambiguous_reason = $2, updated_at = NOW()
      WHERE intent_id = $1
        AND execution_state IN ('nonce_reserved','signed','submission_staged','api_accepted','sequencer_pending')
      RETURNING ${COLUMNS}`,
    [input.intentId, input.reason],
  );
}

export async function listRepairable(limit = 100): Promise<LighterOrderLifecycleIntentRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("lighter_order_lifecycle_intents: limit must be from 1 through 500");
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE execution_state IN ('nonce_reserved','signed','submission_staged','api_accepted','sequencer_pending','ambiguous')
      ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

/** Session-independent lifecycle intents that still need positive provider evidence. */
export async function listStreamWatchable(
  environment?: LighterEnvironment,
  accountIndex?: number,
  limit = 100,
): Promise<LighterOrderLifecycleIntentRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("lighter_order_lifecycle_intents: limit must be from 1 through 500");
  }
  if (accountIndex !== undefined && (!Number.isSafeInteger(accountIndex) || accountIndex < 0)) {
    throw new Error("lighter_order_lifecycle_intents: invalid accountIndex");
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_order_lifecycle_intents
      WHERE approval_status = 'approved'
        AND execution_state IN ('signed','submission_staged','api_accepted','sequencer_pending','ambiguous')
        AND ($1::text IS NULL OR environment = $1)
        AND ($2::bigint IS NULL OR account_index = $2)
      ORDER BY updated_at ASC LIMIT $3`,
    [environment ?? null, accountIndex ?? null, limit],
  );
  return rows.map(mapRow);
}

/** Merge-safe stream transition. Callers provide only validated, account-scoped provider evidence. */
export async function markStreamEvidence(input: {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly state: "sequencer_pending" | "completed" | "rejected";
  readonly evidence: Record<string, unknown>;
}): Promise<LighterOrderLifecycleIntentRow | null> {
  if (jsonbByteLength(input.evidence) > 64 * 1024) {
    throw new Error("lighter_order_lifecycle_intents: stream evidence is too large");
  }
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE lighter_order_lifecycle_intents
      SET execution_state = $4, provider_outcome_json = $5::jsonb,
          provider_outcome_checked_at = NOW(), updated_at = NOW()
      WHERE intent_id = $1 AND environment = $2 AND account_index = $3
        AND approval_status = 'approved'
        AND execution_state IN ('signed','submission_staged','api_accepted','sequencer_pending','ambiguous')
      RETURNING ${COLUMNS}`,
    [input.intentId, input.environment, input.accountIndex, input.state, jsonb(input.evidence)],
  );
  return row === null ? null : mapRow(row);
}

async function transition(
  sql: string,
  params: unknown[],
  client?: Executor,
): Promise<LighterOrderLifecycleIntentRow | null> {
  const row = client === undefined
    ? await queryOne<Record<string, unknown>>(sql, params)
    : await queryOneWith<Record<string, unknown>>(client, sql, params);
  return row === null ? null : mapRow(row);
}

function validateCreate(input: CreateLighterOrderLifecycleIntentInput): void {
  if (!/^lighter-lifecycle-[0-9a-f-]{16,80}$/.test(input.intentId)) {
    throw new Error("lighter_order_lifecycle_intents: invalid intentId");
  }
  if (!/^[0-9a-f]{64}$/.test(input.matchHash)) {
    throw new Error("lighter_order_lifecycle_intents: invalid matchHash");
  }
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) {
    throw new Error("lighter_order_lifecycle_intents: invalid accountIndex");
  }
  if (!Number.isInteger(input.apiKeyIndex) || input.apiKeyIndex < 4 || input.apiKeyIndex > 254) {
    throw new Error("lighter_order_lifecycle_intents: invalid apiKeyIndex");
  }
  if (input.marketIndex !== null && (!Number.isInteger(input.marketIndex) || input.marketIndex < 0 || input.marketIndex > 65_535)) {
    throw new Error("lighter_order_lifecycle_intents: invalid marketIndex");
  }
  if (
    input.credentialRefJson.kind !== "encrypted_vault_reference"
    || input.credentialRefJson.environment !== input.environment
    || input.credentialRefJson.accountIndex !== input.accountIndex
    || input.credentialRefJson.apiKeyIndex !== input.apiKeyIndex
  ) {
    throw new Error("lighter_order_lifecycle_intents: credential scope mismatch");
  }
  assertBoundedNonSecretEvidence(input.providerSnapshotJson);
  if (input.providerOrderId !== null) requireProviderOrderId(input.providerOrderId);
  if (input.requestedBaseAmountInteger != null) requireDecimal("requestedBaseAmountInteger", input.requestedBaseAmountInteger, false);
  if (input.requestedPriceInteger != null) requireDecimal("requestedPriceInteger", input.requestedPriceInteger, false);
  const hasOrder = input.marketIndex !== null && input.providerOrderId !== null;
  if ((input.actionType === "cancel_one" || input.actionType === "modify") !== hasOrder) {
    throw new Error("lighter_order_lifecycle_intents: action target shape mismatch");
  }
  if (input.actionType === "cancel_all" && (input.marketIndex !== null || input.providerOrderId !== null)) {
    throw new Error("lighter_order_lifecycle_intents: cancel_all must be account-wide");
  }
  if (input.actionType === "modify" && (input.requestedBaseAmountInteger == null || input.requestedPriceInteger == null)) {
    throw new Error("lighter_order_lifecycle_intents: modify values are required");
  }
  if (input.actionType === "close_position" && (
    input.marketIndex === null || input.providerOrderId !== null || input.requestedSide == null
    || input.requestedBaseAmountInteger == null || input.requestedPriceInteger == null || input.reduceOnly !== true
  )) {
    throw new Error("lighter_order_lifecycle_intents: close_position shape mismatch");
  }
  if (input.actionType !== "close_position" && input.reduceOnly === true) {
    throw new Error("lighter_order_lifecycle_intents: reduceOnly is reserved for position close");
  }
  if (!Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("lighter_order_lifecycle_intents: invalid expiry");
  }
}

function assertBoundedNonSecretEvidence(value: Record<string, unknown>): void {
  if (jsonbByteLength(value) > 64 * 1024) {
    throw new Error("lighter_order_lifecycle_intents: provider snapshot is too large");
  }
  const encoded = jsonb(value).toLowerCase();
  if (/(private.?key|seed.?phrase|mnemonic|auth.?token|txinfo|signature)/.test(encoded)) {
    throw new Error("lighter_order_lifecycle_intents: provider snapshot contains forbidden signed or secret material");
  }
}

function requireProviderOrderId(value: string): void {
  requireDecimal("providerOrderId", value, false);
  if (BigInt(value) > (1n << 60n) - 1n) {
    throw new Error("lighter_order_lifecycle_intents: providerOrderId is outside the official range");
  }
}

function requireDecimal(field: string, value: string, allowZero: boolean): void {
  if (!/^(0|[1-9]\d*)$/.test(value) || (!allowZero && value === "0")) {
    throw new Error(`lighter_order_lifecycle_intents: invalid ${field}`);
  }
}

function mapRow(row: Record<string, unknown>): LighterOrderLifecycleIntentRow {
  return {
    integratorFees: readLighterOrderFeeTerms((row.provider_snapshot_json as Record<string, unknown> | undefined)?.integratorFees),
    intentId: String(row.intent_id), sessionId: String(row.session_id),
    protocolExecutionId: nullableNumber(row.protocol_execution_id), approvalId: nullableString(row.approval_id),
    matchHash: String(row.match_hash), environment: row.environment as LighterEnvironment,
    accountIndex: Number(row.account_index), apiKeyIndex: Number(row.api_key_index),
    actionType: row.action_type as LighterOrderLifecycleAction,
    marketIndex: nullableNumber(row.market_index), providerOrderId: nullableString(row.provider_order_id),
    requestedBaseAmountInteger: nullableString(row.requested_base_amount_integer),
    requestedPriceInteger: nullableString(row.requested_price_integer),
    requestedSide: nullableString(row.requested_side) as "buy" | "sell" | null, reduceOnly: Boolean(row.reduce_only),
    providerSnapshotJson: row.provider_snapshot_json as Record<string, unknown>,
    credentialRefJson: row.credential_ref_json as LighterTradingCredentialVaultReference,
    approvalStatus: row.approval_status as LighterOrderLifecycleIntentRow["approvalStatus"],
    executionState: row.execution_state as LighterOrderLifecycleState,
    decisionReason: nullableString(row.decision_reason), decidedAt: iso(row.decided_at),
    preSubmitRevalidationJson: row.pre_submit_revalidation_json as Record<string, unknown> | null,
    preSubmitRevalidatedAt: iso(row.pre_submit_revalidated_at),
    nonceReservationId: nullableString(row.nonce_reservation_id), nonceValue: nullableString(row.nonce_value),
    signerExpiryMs: nullableNumber(row.signer_expiry_ms), signerTxHash: nullableString(row.signer_tx_hash),
    submittedTxHash: nullableString(row.submitted_tx_hash), submitCode: nullableNumber(row.submit_code),
    submitMessage: nullableString(row.submit_message), predictedExecutionTimeMs: nullableNumber(row.predicted_execution_time_ms),
    volumeQuotaRemaining: nullableString(row.volume_quota_remaining),
    providerOutcomeJson: row.provider_outcome_json as Record<string, unknown> | null,
    providerOutcomeCheckedAt: iso(row.provider_outcome_checked_at), ambiguousReason: nullableString(row.ambiguous_reason),
    createdAt: iso(row.created_at) ?? "", updatedAt: iso(row.updated_at) ?? "", expiresAt: iso(row.expires_at) ?? "",
  };
}

function nullableString(value: unknown): string | null { return value == null ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value == null ? null : Number(value); }
function iso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
