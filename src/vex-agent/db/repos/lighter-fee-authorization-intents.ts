import type { ClientBase, PoolClient } from "pg";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";

export interface LighterFeeAuthorizationTerms {
  readonly collectorAccountIndex: number;
  readonly collectorL1Address: string;
  readonly maxPerpsMakerFee: number;
  readonly maxPerpsTakerFee: number;
  readonly maxSpotMakerFee: number;
  readonly maxSpotTakerFee: number;
  readonly authorizationExpiryMs: number;
  readonly revoke: boolean;
  readonly publicKey: string;
  readonly currentTier: string;
  readonly targetTier: "plus" | "premium" | null;
  readonly exchangeMakerFeeTick: number;
  readonly exchangeTakerFeeTick: number;
}

export type LighterFeeAuthorizationState =
  | "approval_pending"
  | "approved"
  | "tier_change_staged"
  | "tier_ready"
  | "signing"
  | "submission_staged"
  | "submitted"
  | "active"
  | "ambiguous"
  | "failed"
  | "rejected"
  | "expired";

export interface LighterFeeAuthorizationIntentRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly terms: LighterFeeAuthorizationTerms;
  readonly approvalId: string | null;
  readonly approvalStatus:
    | "approval_pending"
    | "approved"
    | "rejected"
    | "expired";
  readonly executionState: LighterFeeAuthorizationState;
  readonly nonceValue: string | null;
  readonly txHash: string | null;
  readonly txExpiryMs: number | null;
  readonly failureReason: string | null;
  readonly expiresAt: Date;
  readonly verifiedAt: Date | null;
}

function map(row: Record<string, unknown>): LighterFeeAuthorizationIntentRow {
  return {
    intentId: String(row.intent_id),
    sessionId: String(row.session_id),
    environment: row.environment as LighterEnvironment,
    walletAddress: String(row.wallet_address),
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    terms: row.terms_json as LighterFeeAuthorizationTerms,
    approvalId: row.approval_id as string | null,
    approvalStatus:
      row.approval_status as LighterFeeAuthorizationIntentRow["approvalStatus"],
    executionState: row.execution_state as LighterFeeAuthorizationState,
    nonceValue: row.nonce_value as string | null,
    txHash: row.tx_hash as string | null,
    txExpiryMs: row.tx_expiry_ms === null ? null : Number(row.tx_expiry_ms),
    failureReason: row.failure_reason as string | null,
    expiresAt: new Date(row.expires_at as string | Date),
    verifiedAt:
      row.verified_at === null
        ? null
        : new Date(row.verified_at as string | Date),
  };
}

export async function findLighterFeeAuthorizationIntent(
  intentId: string,
): Promise<LighterFeeAuthorizationIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM lighter_fee_authorization_intents WHERE intent_id=$1",
    [intentId],
  );
  return row ? map(row) : null;
}

export async function findLiveLighterFeeAuthorizationIntent(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterFeeAuthorizationIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM lighter_fee_authorization_intents WHERE environment=$1 AND account_index=$2
     AND execution_state NOT IN ('active','failed','rejected','expired')`,
    [environment, accountIndex],
  );
  return row ? map(row) : null;
}

export async function findLatestApprovedLighterFeeAuthorization(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterFeeAuthorizationIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM lighter_fee_authorization_intents
    WHERE environment=$1 AND account_index=$2 AND approval_status='approved'
    AND terms_json->>'revoke'='false' ORDER BY created_at DESC LIMIT 1`,
    [environment, accountIndex],
  );
  return row ? map(row) : null;
}

export async function expirePendingLighterFeeAuthorizationWith(
  client: PoolClient,
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<void> {
  await client.query(
    `UPDATE lighter_fee_authorization_intents SET execution_state='expired',
    approval_status='expired',updated_at=NOW() WHERE environment=$1 AND account_index=$2
    AND execution_state='approval_pending' AND expires_at<=NOW()`,
    [environment, accountIndex],
  );
}

export async function retireUnsignedLighterFeeAuthorizationWith(
  client: PoolClient,
  intent: LighterFeeAuthorizationIntentRow,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE lighter_fee_authorization_intents SET execution_state='failed',
    failure_reason='fresh_approval_required',updated_at=NOW() WHERE intent_id=$1 AND session_id=$2
    AND execution_state=$3 AND approval_status='approved' AND nonce_value IS NULL AND tx_hash IS NULL`,
    [intent.intentId, intent.sessionId, intent.executionState],
  );
  return result.rowCount === 1;
}

export async function createLighterFeeAuthorizationIntentWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly environment: LighterEnvironment;
    readonly walletAddress: string;
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
    readonly terms: LighterFeeAuthorizationTerms;
    readonly expiresAt: Date;
  },
): Promise<LighterFeeAuthorizationIntentRow> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `INSERT INTO lighter_fee_authorization_intents
     (intent_id,session_id,environment,wallet_address,account_index,api_key_index,terms_json,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.intentId,
      input.sessionId,
      input.environment,
      input.walletAddress,
      input.accountIndex,
      input.apiKeyIndex,
      jsonb(input.terms),
      input.expiresAt,
    ],
  );
  if (!row) throw new Error("Fee authorization could not be persisted.");
  return map(row);
}

export async function markLighterFeeAuthorizationDecisionWith(
  client: ClientBase,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly approvalId: string;
    readonly status: "approved" | "rejected" | "expired";
  },
): Promise<LighterFeeAuthorizationIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_fee_authorization_intents SET approval_id=$3,approval_status=$4,
     execution_state=$4,updated_at=NOW() WHERE intent_id=$1 AND session_id=$2
     AND approval_status='approval_pending' AND execution_state='approval_pending'
     AND ($4 <> 'approved' OR expires_at>NOW()) RETURNING *`,
    [input.intentId, input.sessionId, input.approvalId, input.status],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

export async function transitionLighterFeeAuthorizationWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly expectedStates: readonly LighterFeeAuthorizationState[];
    readonly nextState: LighterFeeAuthorizationState;
    readonly nonceValue?: string;
    readonly txHash?: string;
    readonly txExpiryMs?: number;
    readonly failureReason?: string;
  },
): Promise<LighterFeeAuthorizationIntentRow | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE lighter_fee_authorization_intents SET execution_state=$4,
     nonce_value=COALESCE($5,nonce_value),tx_hash=COALESCE($6,tx_hash),
     tx_expiry_ms=COALESCE($7,tx_expiry_ms),failure_reason=COALESCE($8,failure_reason),
     verified_at=CASE WHEN $4='active' THEN NOW() ELSE verified_at END,updated_at=NOW()
     WHERE intent_id=$1 AND session_id=$2 AND execution_state=ANY($3::text[])
     AND approval_status='approved' RETURNING *`,
    [
      input.intentId,
      input.sessionId,
      input.expectedStates,
      input.nextState,
      input.nonceValue ?? null,
      input.txHash ?? null,
      input.txExpiryMs ?? null,
      input.failureReason ?? null,
    ],
  );
  return row ? map(row) : null;
}
