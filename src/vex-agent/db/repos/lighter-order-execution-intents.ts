import type { PoolClient } from "pg";

import { query, queryOne, queryOneWith } from "../client.js";
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
  readonly clientOrderIndex: string | null;
  readonly signerTxHash: string | null;
  readonly submittedTxHash: string | null;
  readonly submitCode: number | null;
  readonly submitMessage: string | null;
  readonly predictedExecutionTimeMs: number | null;
  readonly volumeQuotaRemaining: string | null;
  readonly ambiguousReason: string | null;
  readonly signedAt: string | null;
  readonly submittedAt: string | null;
  readonly apiAcceptedAt: string | null;
  readonly ambiguousAt: string | null;
  readonly providerOrderId: string | null;
  readonly providerOrderStatus: string | null;
  readonly providerOutcomeSource: LighterProviderOutcomeSource | null;
  readonly providerOutcomeJson: Record<string, unknown> | null;
  readonly providerOutcomeCheckedAt: string | null;
  readonly preSubmitRevalidationJson: Record<string, unknown> | null;
  readonly preSubmitRevalidatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export type LighterProviderOutcomeSource =
  | "active_order"
  | "inactive_order"
  | "account_trade"
  | "not_found";

export type LighterProviderOutcomeExecutionState =
  | "sequencer_pending"
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected";

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

export interface MarkLighterOrderSignedInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly nonceReservationId: string;
  readonly nonceValue: string;
  readonly clientOrderIndex: string;
  readonly signerTxHash: string;
}

export interface MarkLighterOrderSubmittedInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly signerTxHash: string;
}

export interface MarkLighterOrderApiAcceptedInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly submitCode: number;
  readonly submitMessage?: string | null;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining?: number | null;
}

export interface MarkLighterOrderAmbiguousInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly reason: string;
}

export interface MarkLighterOrderSequencerPendingInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
}

export interface MarkLighterOrderPreSubmitRevalidatedInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly evidence: Record<string, unknown>;
}

export interface MarkLighterOrderProviderOutcomeInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly state: LighterProviderOutcomeExecutionState;
  readonly source: LighterProviderOutcomeSource;
  readonly providerOrderId?: string | null;
  readonly providerOrderStatus?: string | null;
  readonly providerOutcomeJson: Record<string, unknown>;
}

export interface MarkLighterOrderStreamOutcomeInput {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly state: LighterProviderOutcomeExecutionState;
  readonly source: Extract<LighterProviderOutcomeSource, "active_order" | "inactive_order">;
  readonly providerOrderId: string;
  readonly providerOrderStatus: string;
  readonly providerOutcomeJson: Record<string, unknown>;
}

const SELECT_COLUMNS =
  "intent_id, session_id, preview_id, protocol_execution_id, approval_id, match_hash, environment, " +
  "account_index, api_key_index, market_index, side, base_amount_integer, price_integer, " +
  "order_type, time_in_force, reduce_only, trigger_price_integer, order_expiry_ms, " +
  "client_order_index_policy, provider_version, credential_ref_json, approval_status, " +
  "execution_state, decision_reason, decided_at, nonce_reservation_id, nonce_value, " +
  "client_order_index, signer_tx_hash, submitted_tx_hash, submit_code, submit_message, predicted_execution_time_ms, " +
  "volume_quota_remaining, ambiguous_reason, signed_at, submitted_at, api_accepted_at, ambiguous_at, " +
  "provider_order_id, provider_order_status, provider_outcome_source, provider_outcome_json, provider_outcome_checked_at, " +
  "pre_submit_revalidation_json, pre_submit_revalidated_at, " +
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

const MARK_PRE_SUBMIT_REVALIDATED_SQL = `UPDATE lighter_order_execution_intents
   SET pre_submit_revalidation_json = $4::jsonb,
       pre_submit_revalidated_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state = 'approval_pending'
   AND nonce_reservation_id IS NULL
   AND nonce_value IS NULL
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

const MARK_SIGNED_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = 'signed',
       client_order_index = $6,
       signer_tx_hash = $7,
       signed_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state = 'approval_pending'
   AND nonce_reservation_id = $4
   AND nonce_value = $5
   AND client_order_index IS NULL
   AND signer_tx_hash IS NULL
 RETURNING ${SELECT_COLUMNS}`;

const MARK_SUBMITTED_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = 'submitted',
       submitted_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state = 'signed'
   AND signer_tx_hash = $4
   AND submitted_at IS NULL
 RETURNING ${SELECT_COLUMNS}`;

const MARK_API_ACCEPTED_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = 'api_accepted',
       submitted_tx_hash = $5,
       submit_code = $6,
       submit_message = $7,
       predicted_execution_time_ms = $8,
       volume_quota_remaining = $9,
       api_accepted_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state = 'submitted'
   AND signer_tx_hash = $4
   AND api_accepted_at IS NULL
 RETURNING ${SELECT_COLUMNS}`;

const MARK_SEQUENCER_PENDING_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = 'sequencer_pending',
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state = 'api_accepted'
   AND signer_tx_hash = $4
   AND submitted_tx_hash = $5
   AND client_order_index IS NOT NULL
 RETURNING ${SELECT_COLUMNS}`;

const MARK_PROVIDER_OUTCOME_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = $4,
       provider_outcome_source = $5,
       provider_order_id = $6,
       provider_order_status = $7,
       provider_outcome_json = $8::jsonb,
       provider_outcome_checked_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND execution_state IN ('api_accepted','sequencer_pending')
   AND client_order_index IS NOT NULL
 RETURNING ${SELECT_COLUMNS}`;

/**
 * Stream evidence may advance an order after the initial REST classification
 * moved it to open/partially_filled. The guarded transition matrix prevents a
 * delayed frame from downgrading durable progress or rewriting a terminal row.
 */
const MARK_STREAM_OUTCOME_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = $3,
       provider_outcome_source = $4,
       provider_order_id = $5,
       provider_order_status = $6,
       provider_outcome_json = $7::jsonb,
       provider_outcome_checked_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND environment = $2
   AND approval_status = 'approved'
   AND client_order_index IS NOT NULL
   AND (
     (
       execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous')
       AND $3 IN ('sequencer_pending','open','partially_filled','filled','canceled','rejected')
     )
     OR (
       execution_state = 'open'
       AND $3 IN ('open','partially_filled','filled','canceled','rejected')
     )
     OR (
       execution_state = 'partially_filled'
       AND $3 IN ('partially_filled','filled','canceled','rejected')
     )
   )
 RETURNING ${SELECT_COLUMNS}`;

const MARK_AMBIGUOUS_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = 'ambiguous',
       ambiguous_reason = $4,
       ambiguous_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND session_id = $2
   AND environment = $3
   AND approval_status = 'approved'
   AND (
     execution_state IN ('signed','submitted','api_accepted','sequencer_pending')
     OR (
       execution_state = 'approval_pending'
       AND nonce_reservation_id IS NOT NULL
       AND nonce_value IS NOT NULL
     )
   )
   AND ambiguous_at IS NULL
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

export async function markPreSubmitRevalidated(
  input: MarkLighterOrderPreSubmitRevalidatedInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_PRE_SUBMIT_REVALIDATED_SQL,
    [
      input.intentId,
      input.sessionId,
      input.environment,
      jsonb(assertPreSubmitRevalidationEvidence(input.evidence)),
    ],
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

export async function markSigned(
  input: MarkLighterOrderSignedInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_SIGNED_SQL,
    toMarkSignedParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markSubmitted(
  input: MarkLighterOrderSubmittedInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_SUBMITTED_SQL,
    toMarkSubmittedParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markApiAccepted(
  input: MarkLighterOrderApiAcceptedInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_API_ACCEPTED_SQL,
    toMarkApiAcceptedParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markAmbiguous(
  input: MarkLighterOrderAmbiguousInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_AMBIGUOUS_SQL,
    toMarkAmbiguousParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markSequencerPending(
  input: MarkLighterOrderSequencerPendingInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_SEQUENCER_PENDING_SQL,
    toMarkSequencerPendingParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markProviderOutcome(
  input: MarkLighterOrderProviderOutcomeInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    MARK_PROVIDER_OUTCOME_SQL,
    toMarkProviderOutcomeParams(input),
  );
  return row ? mapRow(row) : null;
}

export async function markStreamOutcome(
  input: MarkLighterOrderStreamOutcomeInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(MARK_STREAM_OUTCOME_SQL, [
    input.intentId,
    input.environment,
    providerOutcomeState(input.state),
    providerOutcomeSource(input.source),
    requiredSafeId(input.providerOrderId, "providerOrderId"),
    requiredSafeText(input.providerOrderStatus, "providerOrderStatus"),
    jsonb(assertProviderOutcomeJson(input.providerOutcomeJson)),
  ]);
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

/**
 * Execution states a signed/submitted order can be stranded in when the app
 * crashed, the provider response was lost, or the sequencer outcome was never
 * read. Repair owns moving these to a provider-evidence-backed state.
 */
export const LIGHTER_ORDER_UNRESOLVED_EXECUTION_STATES = [
  "signed",
  "submitted",
  "api_accepted",
  "sequencer_pending",
  "ambiguous",
] as const;

/** Orders that still need positive provider updates until they are terminal. */
export const LIGHTER_ORDER_STREAM_WATCHABLE_STATES = [
  ...LIGHTER_ORDER_UNRESOLVED_EXECUTION_STATES,
  "open",
  "partially_filled",
] as const;

/**
 * Deliberately session-independent: unresolved intents from an earlier app run
 * belong to a session that no longer exists, and repair must still see them.
 */
export async function listUnresolved(
  environment?: LighterEnvironment,
  limit = 20,
): Promise<LighterOrderExecutionIntentRow[]> {
  const bounded = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_execution_intents
      WHERE execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous')
        AND ($1::text IS NULL OR environment = $1)
      ORDER BY created_at ASC
      LIMIT ${bounded}`,
    [environment ?? null],
  );
  return rows.map(mapRow);
}

/**
 * Session-independent stream watch set. Open and partially-filled orders stay
 * subscribed until a positive terminal provider event arrives.
 */
export async function listStreamWatchable(
  environment?: LighterEnvironment,
  accountIndex?: number,
  limit = 100,
): Promise<LighterOrderExecutionIntentRow[]> {
  const bounded = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
  const exactAccountIndex = accountIndex === undefined
    ? null
    : requiredNonNegativeInt(accountIndex, "accountIndex");
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_execution_intents
      WHERE execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous','open','partially_filled')
        AND approval_status = 'approved'
        AND client_order_index IS NOT NULL
        AND NOT (
          execution_state = 'partially_filled'
          AND provider_outcome_source = 'inactive_order'
          AND (
            LOWER(COALESCE(provider_order_status, '')) LIKE '%cancel%'
            OR LOWER(COALESCE(provider_order_status, '')) LIKE '%expire%'
          )
        )
        AND ($1::text IS NULL OR environment = $1)
        AND ($2::bigint IS NULL OR account_index = $2)
      ORDER BY created_at ASC
      LIMIT ${bounded}`,
    [environment ?? null, exactAccountIndex],
  );
  return rows.map(mapRow);
}

export async function findByIntentIdAnySession(
  intentId: string,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM lighter_order_execution_intents
      WHERE intent_id = $1`,
    [intentId],
  );
  return row ? mapRow(row) : null;
}

export interface MarkLighterOrderRepairResolvedInput {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly state: LighterProviderOutcomeExecutionState;
  /** Nonce-inference resolutions use "not_found" with the inference detail in providerOutcomeJson. */
  readonly source: LighterProviderOutcomeSource;
  readonly providerOrderId?: string | null;
  readonly providerOrderStatus?: string | null;
  readonly providerOutcomeJson: Record<string, unknown>;
}

const MARK_REPAIR_RESOLVED_SQL = `UPDATE lighter_order_execution_intents
   SET execution_state = $3,
       provider_outcome_source = $4,
       provider_order_id = $5,
       provider_order_status = $6,
       provider_outcome_json = $7::jsonb,
       provider_outcome_checked_at = NOW(),
       updated_at = NOW()
 WHERE intent_id = $1
   AND environment = $2
   AND execution_state IN ('signed','submitted','api_accepted','sequencer_pending','ambiguous')
 RETURNING ${SELECT_COLUMNS}`;

/**
 * Repair-only transition from an unresolved state to an evidence-backed one.
 * Unlike markProviderOutcome it may start from signed/submitted/ambiguous —
 * exactly the states a crash or lost response strands an intent in — and it
 * never touches a terminal or pre-signing row.
 */
export async function markRepairResolved(
  input: MarkLighterOrderRepairResolvedInput,
): Promise<LighterOrderExecutionIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(MARK_REPAIR_RESOLVED_SQL, [
    input.intentId,
    input.environment,
    input.state,
    input.source,
    input.providerOrderId ?? null,
    input.providerOrderStatus ?? null,
    jsonb(input.providerOutcomeJson),
  ]);
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

function toMarkSignedParams(input: MarkLighterOrderSignedInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    requiredSafeId(input.nonceReservationId, "nonceReservationId"),
    requiredNonNegativeDecimal(input.nonceValue, "nonceValue"),
    requiredUint48Decimal(input.clientOrderIndex, "clientOrderIndex"),
    requiredSafeId(input.signerTxHash, "signerTxHash"),
  ];
}

function toMarkSubmittedParams(input: MarkLighterOrderSubmittedInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    requiredSafeId(input.signerTxHash, "signerTxHash"),
  ];
}

function toMarkApiAcceptedParams(input: MarkLighterOrderApiAcceptedInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    requiredSafeId(input.signerTxHash, "signerTxHash"),
    requiredSafeId(input.submittedTxHash, "submittedTxHash"),
    requiredNonNegativeInt(input.submitCode, "submitCode"),
    optionalSafeText(input.submitMessage, "submitMessage"),
    requiredNonNegativeInt(input.predictedExecutionTimeMs, "predictedExecutionTimeMs"),
    input.volumeQuotaRemaining === null || input.volumeQuotaRemaining === undefined
      ? null
      : requiredNonNegativeInt(input.volumeQuotaRemaining, "volumeQuotaRemaining"),
  ];
}

function toMarkAmbiguousParams(input: MarkLighterOrderAmbiguousInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    requiredSafeText(input.reason, "reason"),
  ];
}

function toMarkSequencerPendingParams(input: MarkLighterOrderSequencerPendingInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    requiredSafeId(input.signerTxHash, "signerTxHash"),
    requiredSafeId(input.submittedTxHash, "submittedTxHash"),
  ];
}

function toMarkProviderOutcomeParams(input: MarkLighterOrderProviderOutcomeInput): unknown[] {
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    providerOutcomeState(input.state),
    providerOutcomeSource(input.source),
    optionalSafeId(input.providerOrderId, "providerOrderId"),
    optionalSafeText(input.providerOrderStatus, "providerOrderStatus"),
    jsonb(assertProviderOutcomeJson(input.providerOutcomeJson)),
  ];
}

function toAttachNonceReservationParams(input: AttachLighterOrderNonceReservationInput): unknown[] {
  if (input.reservationId.trim().length === 0) {
    throw new Error("lighter_order_execution_intents: reservationId is required");
  }
  const nonceValue = requiredNonNegativeDecimal(input.nonceValue, "nonceValue");
  return [
    input.intentId,
    input.sessionId,
    input.environment,
    input.accountIndex,
    input.apiKeyIndex,
    input.reservationId,
    nonceValue,
  ];
}

function requiredNonNegativeDecimal(value: string, field: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`lighter_order_execution_intents: ${field} must be a non-negative decimal integer`);
  }
  return BigInt(value).toString();
}

const UINT48_MAX = (1n << 48n) - 1n;

function requiredUint48Decimal(value: string, field: string): string {
  const decimal = requiredNonNegativeDecimal(value, field);
  if (BigInt(decimal) > UINT48_MAX) {
    throw new Error(`lighter_order_execution_intents: ${field} must fit uint48`);
  }
  return decimal;
}

function requiredNonNegativeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`lighter_order_execution_intents: ${field} must be a safe non-negative integer`);
  }
  return value;
}

function requiredSafeId(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 160 || /[\s{}"]/.test(trimmed)) {
    throw new Error(`lighter_order_execution_intents: ${field} must be a safe structural id`);
  }
  return trimmed;
}

function optionalSafeId(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : requiredSafeId(trimmed, field);
}

function optionalSafeText(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return safeText(trimmed, field);
}

function requiredSafeText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`lighter_order_execution_intents: ${field} is required`);
  }
  return safeText(trimmed, field);
}

function safeText(value: string, field: string): string {
  if (value.length > 240 || /[{}"]/.test(value)) {
    throw new Error(`lighter_order_execution_intents: ${field} must be bounded structural text`);
  }
  assertNoSignedPayloadShape(value, field);
  return value;
}

function assertNoSignedPayloadShape(value: string, field: string): void {
  if (
    /\b(?:tx_info|sig|signature|private|secret|payload)\b/i.test(value)
    || /(?:0x)?[a-fA-F0-9]{64}/.test(value)
  ) {
    throw new Error(`lighter_order_execution_intents: ${field} must not contain signed payload material`);
  }
}

function providerOutcomeSource(source: LighterProviderOutcomeSource): LighterProviderOutcomeSource {
  if (
    source !== "active_order"
    && source !== "inactive_order"
    && source !== "account_trade"
    && source !== "not_found"
  ) {
    throw new Error("lighter_order_execution_intents: provider outcome source is invalid");
  }
  return source;
}

function providerOutcomeState(state: LighterProviderOutcomeExecutionState): LighterProviderOutcomeExecutionState {
  if (
    state !== "sequencer_pending"
    && state !== "open"
    && state !== "partially_filled"
    && state !== "filled"
    && state !== "canceled"
    && state !== "rejected"
  ) {
    throw new Error("lighter_order_execution_intents: provider outcome state is invalid");
  }
  return state;
}

function assertProviderOutcomeJson(value: Record<string, unknown>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lighter_order_execution_intents: providerOutcomeJson must be an object");
  }
  const encoded = jsonb(value);
  if (encoded.length > 2_000 || /\b(?:tx_info|private|secret|signature|payload)\b/i.test(encoded)) {
    throw new Error("lighter_order_execution_intents: providerOutcomeJson must be bounded non-secret evidence");
  }
  return value;
}

function assertPreSubmitRevalidationEvidence(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lighter_order_execution_intents: pre-submit revalidation evidence must be an object");
  }
  const encoded = jsonb(value);
  if (
    encoded.length > 2_000
    || /(?:auth|token|tx_info|private|secret|signature|payload)/i.test(encoded)
  ) {
    throw new Error(
      "lighter_order_execution_intents: pre-submit revalidation evidence must be bounded and non-secret",
    );
  }
  return value;
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
    clientOrderIndex: (row.client_order_index as string | null) ?? null,
    signerTxHash: (row.signer_tx_hash as string | null) ?? null,
    submittedTxHash: (row.submitted_tx_hash as string | null) ?? null,
    submitCode: row.submit_code === null || row.submit_code === undefined
      ? null
      : Number(row.submit_code),
    submitMessage: (row.submit_message as string | null) ?? null,
    predictedExecutionTimeMs:
      row.predicted_execution_time_ms === null || row.predicted_execution_time_ms === undefined
        ? null
        : Number(row.predicted_execution_time_ms),
    volumeQuotaRemaining:
      row.volume_quota_remaining === null || row.volume_quota_remaining === undefined
        ? null
        : String(row.volume_quota_remaining),
    ambiguousReason: (row.ambiguous_reason as string | null) ?? null,
    signedAt: toIsoOrNull(row.signed_at as string | Date | null | undefined),
    submittedAt: toIsoOrNull(row.submitted_at as string | Date | null | undefined),
    apiAcceptedAt: toIsoOrNull(row.api_accepted_at as string | Date | null | undefined),
    ambiguousAt: toIsoOrNull(row.ambiguous_at as string | Date | null | undefined),
    providerOrderId: (row.provider_order_id as string | null) ?? null,
    providerOrderStatus: (row.provider_order_status as string | null) ?? null,
    providerOutcomeSource: (row.provider_outcome_source as LighterProviderOutcomeSource | null) ?? null,
    providerOutcomeJson: (row.provider_outcome_json as Record<string, unknown> | null) ?? null,
    providerOutcomeCheckedAt: toIsoOrNull(row.provider_outcome_checked_at as string | Date | null | undefined),
    preSubmitRevalidationJson:
      (row.pre_submit_revalidation_json as Record<string, unknown> | null) ?? null,
    preSubmitRevalidatedAt:
      toIsoOrNull(row.pre_submit_revalidated_at as string | Date | null | undefined),
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
