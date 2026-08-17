/** Durable public slot reservations for Phase 3 key registration. */

import type { LighterEnvironment } from "@tools/lighter/types.js";
import type { LighterApiKeySlotObservation } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { selectAvailableLighterApiKeyIndex } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { LIGHTER_DEPOSIT_CHAIN_ID } from "@tools/lighter/wallet-funding/constants.js";
import {
  generateOnboardingIntentId,
  type LighterOnboardingApprovalStatus,
} from "./lighter-onboarding-intents.js";
import type { LighterOnboardingQueryClient } from "./lighter-onboarding-workflows.js";

export const LIGHTER_KEY_SLOT_OBSERVATION_MAX_AGE_MS = 60_000;
const LIGHTER_KEY_SLOT_OBSERVATION_FUTURE_TOLERANCE_MS = 5_000;

export interface LighterKeyRegistrationReservationRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly slotObservedAt: Date;
  readonly slotObservationHash: string;
  readonly approvalStatus: LighterOnboardingApprovalStatus;
  readonly executionState: "slot_reserved";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

export interface ReserveLighterApiKeySlotInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly observation: LighterApiKeySlotObservation;
  readonly expiresAt: Date;
  readonly now?: Date;
}

export type ReserveLighterApiKeySlotOutcome =
  | { readonly outcome: "created"; readonly reservation: LighterKeyRegistrationReservationRow }
  | { readonly outcome: "live_conflict"; readonly reservation: LighterKeyRegistrationReservationRow };

interface WorkflowLockRow {
  readonly workflow_state: string;
  readonly resolved_account_index: string | number | null;
  readonly api_key_index: number | null;
}

const RETURNING = `
  intent_id, session_id, environment, wallet_address, chain_id,
  resolved_account_index, api_key_index, slot_observed_at,
  slot_observation_hash, approval_status, execution_state,
  created_at, updated_at, expires_at
`;

/**
 * Reserve under a caller-owned transaction. The workflow row lock serializes
 * sessions using the same wallet; the partial unique indexes are the
 * cross-process authority for account/index conflicts.
 */
export async function reserveLighterApiKeySlotWith(
  client: LighterOnboardingQueryClient,
  input: ReserveLighterApiKeySlotInput,
): Promise<ReserveLighterApiKeySlotOutcome> {
  const now = input.now ?? new Date();
  assertReservationInput(input, now);

  const locked = await client.query<WorkflowLockRow>(
    `SELECT workflow_state, resolved_account_index, api_key_index
       FROM lighter_onboarding_workflows
      WHERE environment = $1 AND wallet_address = LOWER($2)
      FOR UPDATE`,
    [input.environment, input.walletAddress],
  );
  const workflow = locked.rows[0];
  if (workflow === undefined) {
    throw new Error("Lighter key registration requires a durable onboarding workflow.");
  }
  if (Number(workflow.resolved_account_index) !== input.accountIndex) {
    throw new Error("Lighter key registration account does not match the resolved workflow account.");
  }

  if (workflow.api_key_index !== null) {
    const existing = await findHeldReservationWith(
      client,
      input.environment,
      input.accountIndex,
      workflow.api_key_index,
    );
    if (existing === null) {
      throw new Error("Lighter workflow names an API-key slot without a durable reservation.");
    }
    return { outcome: "live_conflict", reservation: existing };
  }
  if (workflow.workflow_state !== "account_resolved") {
    throw new Error("Lighter API-key slot reservation requires the account_resolved workflow state.");
  }

  const held = await client.query<{ api_key_index: number }>(
    `SELECT api_key_index
       FROM lighter_onboarding_intents
      WHERE environment = $1
        AND resolved_account_index = $2
        AND capability = 'key_registration'
        AND execution_state <> 'failed'
        AND api_key_index IS NOT NULL
      ORDER BY api_key_index ASC`,
    [input.environment, input.accountIndex],
  );
  const apiKeyIndex = selectAvailableLighterApiKeyIndex(
    input.observation,
    held.rows.map((row) => row.api_key_index),
  );

  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO lighter_onboarding_intents (
       intent_id, session_id, environment, capability, wallet_address, chain_id,
       resolved_account_index, api_key_index, slot_observed_at,
       slot_observation_hash, approval_status, execution_state, expires_at
     ) VALUES (
       $1, $2, $3, 'key_registration', $4, $5,
       $6, $7, $8, $9, 'approval_pending', 'slot_reserved', $10
     )
     ON CONFLICT DO NOTHING
     RETURNING ${RETURNING}`,
    [
      generateOnboardingIntentId(),
      input.sessionId,
      input.environment,
      input.walletAddress,
      input.chainId,
      input.accountIndex,
      apiKeyIndex,
      input.observation.observedAt,
      input.observation.observationHash,
      input.expiresAt,
    ],
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    const conflict = await findAnyHeldReservationWith(
      client,
      input.environment,
      input.accountIndex,
    );
    if (conflict === null) {
      throw new Error("Lighter API-key slot reservation lost a conflict without an authoritative row.");
    }
    if (conflict.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
      throw new Error("Lighter account index is already reserved by a different wallet workflow.");
    }
    return { outcome: "live_conflict", reservation: conflict };
  }

  const reservation = mapRow(created);
  const updated = await client.query(
    `UPDATE lighter_onboarding_workflows
        SET api_key_index = $3,
            revision = revision + 1,
            updated_at = NOW()
      WHERE environment = $1
        AND wallet_address = LOWER($2)
        AND workflow_state = 'account_resolved'
        AND resolved_account_index = $4
        AND api_key_index IS NULL`,
    [input.environment, input.walletAddress, apiKeyIndex, input.accountIndex],
  );
  if (updated.rowCount !== 1) {
    throw new Error("Lighter workflow rejected the API-key slot reservation.");
  }

  return { outcome: "created", reservation };
}

async function findHeldReservationWith(
  client: LighterOnboardingQueryClient,
  environment: LighterEnvironment,
  accountIndex: number,
  apiKeyIndex: number,
): Promise<LighterKeyRegistrationReservationRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents
      WHERE environment = $1
        AND resolved_account_index = $2
        AND api_key_index = $3
        AND capability = 'key_registration'
        AND execution_state <> 'failed'
      ORDER BY created_at ASC
      LIMIT 1`,
    [environment, accountIndex, apiKeyIndex],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

async function findAnyHeldReservationWith(
  client: LighterOnboardingQueryClient,
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterKeyRegistrationReservationRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents
      WHERE environment = $1
        AND resolved_account_index = $2
        AND capability = 'key_registration'
        AND execution_state <> 'failed'
      ORDER BY created_at ASC
      LIMIT 1`,
    [environment, accountIndex],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

function assertReservationInput(input: ReserveLighterApiKeySlotInput, now: Date): void {
  if (input.environment !== "core" || input.chainId !== LIGHTER_DEPOSIT_CHAIN_ID) {
    throw new Error("Phase 3 key registration currently supports Lighter Core on Ethereum mainnet only.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) {
    throw new Error("Lighter API-key slot reservation requires a valid EVM wallet address.");
  }
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex <= 0) {
    throw new Error("Lighter API-key slot reservation requires a positive safe account index.");
  }
  if (input.observation.accountIndex !== input.accountIndex) {
    throw new Error("Lighter API-key slot observation does not match the requested account.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.observation.observationHash)) {
    throw new Error("Lighter API-key slot observation hash is invalid.");
  }
  const nowMs = now.getTime();
  const observedAtMs = input.observation.observedAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedAtMs)) {
    throw new Error("Lighter API-key slot reservation requires valid timestamps.");
  }
  if (
    observedAtMs < nowMs - LIGHTER_KEY_SLOT_OBSERVATION_MAX_AGE_MS
    || observedAtMs > nowMs + LIGHTER_KEY_SLOT_OBSERVATION_FUTURE_TOLERANCE_MS
  ) {
    throw new Error("Lighter API-key slot observation is stale or from the future.");
  }
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now) {
    throw new Error("Lighter API-key slot reservation expiry must be in the future.");
  }
}

function mapRow(row: Record<string, unknown>): LighterKeyRegistrationReservationRow {
  if (row.execution_state !== "slot_reserved") {
    throw new Error("Lighter key reservation row has an unexpected execution state.");
  }
  return {
    intentId: String(row.intent_id),
    sessionId: String(row.session_id),
    environment: row.environment as LighterEnvironment,
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    accountIndex: Number(row.resolved_account_index),
    apiKeyIndex: Number(row.api_key_index),
    slotObservedAt: row.slot_observed_at as Date,
    slotObservationHash: String(row.slot_observation_hash),
    approvalStatus: row.approval_status as LighterOnboardingApprovalStatus,
    executionState: "slot_reserved",
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}
