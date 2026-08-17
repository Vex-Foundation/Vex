/** Durable public lifecycle for Phase 3 key registration. */

import { createHash } from "node:crypto";

import type { LighterEnvironment } from "@tools/lighter/types.js";
import type { LighterApiKeySlotObservation } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { selectAvailableLighterApiKeyIndex } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { LIGHTER_DEPOSIT_CHAIN_ID } from "@tools/lighter/wallet-funding/constants.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { queryOne } from "../client.js";
import {
  generateOnboardingIntentId,
  type LighterOnboardingApprovalStatus,
} from "./lighter-onboarding-intents.js";
import {
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingQueryClient,
} from "./lighter-onboarding-workflows.js";

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
  readonly executionState:
    | "slot_reserved"
    | "key_generated_encrypted"
    | "approval_pending"
    | "approved";
  readonly vaultCredentialId: string | null;
  readonly publicKey: string | null;
  readonly publicKeyFingerprint: string | null;
  readonly keyGeneratedAt: Date | null;
  readonly registrationNonce: string | null;
  readonly registrationNonceObservedAt: Date | null;
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
  vault_credential_id, public_key, public_key_fingerprint, key_generated_at,
  registration_nonce, registration_nonce_observed_at,
  created_at, updated_at, expires_at
`;

export async function findLighterKeyRegistrationIntent(
  intentId: string,
): Promise<LighterKeyRegistrationReservationRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents
      WHERE intent_id = $1 AND capability = 'key_registration'`,
    [intentId],
  );
  return row === null ? null : mapRow(row);
}

export async function findLiveLighterKeyRegistrationIntentForAccount(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterKeyRegistrationReservationRow | null> {
  if (!Number.isSafeInteger(accountIndex) || accountIndex <= 0) {
    throw new Error("Lighter key registration lookup requires a positive safe account index.");
  }
  const row = await queryOne<Record<string, unknown>>(
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
  return row === null ? null : mapRow(row);
}

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

/**
 * Persist only after the private key is encrypted in the local vault. A failed
 * DB write leaves a recoverable pending key at the deterministic reference.
 */
export async function markLighterKeyGeneratedEncryptedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly reference: LighterTradingCredentialVaultReference;
    readonly publicKey: string;
    readonly generatedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const expectedReference = defaultLighterTradingVaultCredentialId(input.reference);
  if (
    input.reference.kind !== "encrypted_vault_reference"
    || input.reference.vaultCredentialId !== expectedReference
  ) {
    throw new Error("Lighter key registration vault reference does not match its account scope.");
  }
  const publicKey = normalizePublicKey(input.publicKey);
  if (!Number.isFinite(input.generatedAt.getTime())) {
    throw new Error("Lighter key registration requires a valid key-generation timestamp.");
  }
  const publicKeyFingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "hex"))
    .digest("hex");

  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'key_generated_encrypted',
            vault_credential_id = $2,
            public_key = $3,
            public_key_fingerprint = $4,
            key_generated_at = $5,
            updated_at = NOW()
      WHERE intent_id = $1
        AND capability = 'key_registration'
        AND execution_state = 'slot_reserved'
        AND environment = $6
        AND resolved_account_index = $7
        AND api_key_index = $8
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.reference.vaultCredentialId,
      publicKey,
      publicKeyFingerprint,
      input.generatedAt,
      input.reference.environment,
      input.reference.accountIndex,
      input.reference.apiKeyIndex,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["account_resolved"],
    nextState: "key_generated_encrypted",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter onboarding workflow rejected encrypted key metadata.");
  }
  return intent;
}

/**
 * Bind a freshly observed public nextNonce into the approval contract before
 * the host creates an approval card. Signing must later re-read and match it.
 */
export async function markLighterKeyRegistrationApprovalPendingWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly registrationNonce: string;
    readonly observedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const registrationNonce = normalizeRegistrationNonce(input.registrationNonce);
  if (!Number.isFinite(input.observedAt.getTime())) {
    throw new Error("Lighter key registration nonce observation requires a valid timestamp.");
  }
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'approval_pending',
            registration_nonce = $3,
            registration_nonce_observed_at = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approval_pending'
        AND execution_state = 'key_generated_encrypted'
        AND expires_at > NOW()
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, registrationNonce, input.observedAt],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["key_generated_encrypted"],
    nextState: "key_registration_approval_pending",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter onboarding workflow rejected key-registration approval preparation.");
  }
  return intent;
}

/** Record the exact host approval before any release-gate or signer access. */
export async function markLighterKeyRegistrationApprovedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly approvalId: string;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  if (input.approvalId.trim().length === 0) {
    throw new Error("Lighter key registration approval id is required.");
  }
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET approval_status = 'approved',
            approval_id = $3,
            decided_at = NOW(),
            decision_reason = 'user approved exact Lighter key registration intent',
            execution_state = 'approved',
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approval_pending'
        AND execution_state = 'approval_pending'
        AND expires_at > NOW()
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, input.approvalId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
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
  if (
    row.execution_state !== "slot_reserved"
    && row.execution_state !== "key_generated_encrypted"
    && row.execution_state !== "approval_pending"
    && row.execution_state !== "approved"
  ) {
    throw new Error("Lighter key registration row has an unexpected execution state.");
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
    executionState: row.execution_state,
    vaultCredentialId: nullableString(row.vault_credential_id),
    publicKey: nullableString(row.public_key),
    publicKeyFingerprint: nullableString(row.public_key_fingerprint),
    keyGeneratedAt: row.key_generated_at === null || row.key_generated_at === undefined
      ? null
      : row.key_generated_at as Date,
    registrationNonce: nullableString(row.registration_nonce),
    registrationNonceObservedAt:
      row.registration_nonce_observed_at === null
        || row.registration_nonce_observed_at === undefined
        ? null
        : row.registration_nonce_observed_at as Date,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

function normalizeRegistrationNonce(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Lighter key registration nonce must be a canonical non-negative integer.");
  }
  const nonce = BigInt(value);
  if (nonce > (1n << 48n) - 1n) {
    throw new Error("Lighter key registration nonce exceeds the official signer range.");
  }
  return nonce.toString();
}

function normalizePublicKey(value: string): string {
  const publicKey = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(publicKey)) {
    throw new Error("Lighter key registration requires a canonical 40-byte public key.");
  }
  return publicKey;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
