/** Durable public lifecycle for Phase 3 key registration. */

import { createHash } from "node:crypto";

import type { LighterEnvironment } from "@tools/lighter/types.js";
import type { LighterApiKeySlotObservation } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { selectAvailableLighterApiKeyIndex } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
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
    | "approved"
    | "key_registration_tx_staged"
    | "change_pub_key_submitted"
    | "ambiguous"
    | "key_verified"
    | "nonce_synchronized"
    | "active";
  readonly vaultCredentialId: string | null;
  readonly publicKey: string | null;
  readonly publicKeyFingerprint: string | null;
  readonly keyGeneratedAt: Date | null;
  readonly registrationNonce: string | null;
  readonly registrationNonceObservedAt: Date | null;
  readonly registrationTxType: number | null;
  readonly registrationTxHash: string | null;
  readonly registrationTxExpiredAt: string | null;
  readonly registrationTxStagedAt: Date | null;
  readonly registrationSubmittedTxHash: string | null;
  readonly registrationSubmitCode: number | null;
  readonly registrationPredictedExecutionTimeMs: string | null;
  readonly registrationSubmitAcceptedAt: Date | null;
  readonly registrationAmbiguityReason: string | null;
  readonly registrationKeyVerifiedAt: Date | null;
  readonly registrationClientCheckedAt: Date | null;
  readonly postRegistrationNonce: string | null;
  readonly registrationNonceSynchronizedAt: Date | null;
  readonly registrationActivatedAt: Date | null;
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
  registration_tx_type, registration_tx_hash, registration_tx_expired_at,
  registration_tx_staged_at, registration_submitted_tx_hash,
  registration_submit_code, registration_predicted_execution_time_ms,
  registration_submit_accepted_at, registration_ambiguity_reason,
  registration_key_verified_at, registration_client_checked_at,
  post_registration_nonce, registration_nonce_synchronized_at,
  registration_activated_at,
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

/** Record the exact host approval before any signer access. */
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

/** Renew only an approved intent that has never reached signing or submission. */
export async function renewPristineApprovedLighterKeyRegistrationIntentWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly expiresAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  assertTimestamp(input.expiresAt, "approval retry expiry");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET expires_at = $3,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state = 'approved'
        AND registration_tx_type IS NULL
        AND registration_tx_hash IS NULL
        AND registration_tx_expired_at IS NULL
        AND registration_tx_staged_at IS NULL
        AND registration_submitted_tx_hash IS NULL
        AND registration_submit_code IS NULL
        AND registration_predicted_execution_time_ms IS NULL
        AND registration_submit_accepted_at IS NULL
        AND registration_ambiguity_reason IS NULL
        AND registration_key_verified_at IS NULL
        AND registration_client_checked_at IS NULL
        AND post_registration_nonce IS NULL
        AND registration_nonce_synchronized_at IS NULL
        AND registration_activated_at IS NULL
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, input.expiresAt],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Persist public TxType/hash/expiry identity before sendTx can be called. */
export async function markLighterKeyRegistrationTxStagedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly txType: number;
    readonly txHash: string;
    readonly expiredAt: string;
    readonly stagedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  if (input.txType !== 8) throw new Error("Lighter key registration requires TxType 8.");
  const txHash = normalizeRegistrationTxHash(input.txHash);
  const expiredAt = normalizePositiveInt64(input.expiredAt, "transaction expiry");
  assertTimestamp(input.stagedAt, "transaction staging");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'key_registration_tx_staged',
            registration_tx_type = $3,
            registration_tx_hash = $4,
            registration_tx_expired_at = $5,
            registration_tx_staged_at = $6,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state = 'approved'
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, input.txType, txHash, expiredAt, input.stagedAt],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Record only the public sendTx acknowledgement after the network call. */
export async function markLighterKeyRegistrationSubmittedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly txHash: string;
    readonly submittedTxHash: string;
    readonly submitCode: number;
    readonly predictedExecutionTimeMs: number;
    readonly acceptedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const txHash = normalizeRegistrationTxHash(input.txHash);
  const submittedTxHash = normalizeRegistrationTxHash(input.submittedTxHash);
  if (submittedTxHash !== txHash || input.submitCode !== 200) {
    throw new Error("Lighter key registration sendTx response does not match staged identity.");
  }
  if (!Number.isSafeInteger(input.predictedExecutionTimeMs) || input.predictedExecutionTimeMs < 0) {
    throw new Error("Lighter key registration predicted execution time is invalid.");
  }
  assertTimestamp(input.acceptedAt, "sendTx acceptance");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'change_pub_key_submitted',
            registration_submitted_tx_hash = $4,
            registration_submit_code = $5,
            registration_predicted_execution_time_ms = $6,
            registration_submit_accepted_at = $7,
            registration_ambiguity_reason = NULL,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state = 'key_registration_tx_staged'
        AND registration_tx_hash = $3
      RETURNING ${RETURNING}`,
    [
      input.intentId,
      input.sessionId,
      txHash,
      submittedTxHash,
      input.submitCode,
      input.predictedExecutionTimeMs,
      input.acceptedAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["key_registration_approval_pending"],
    nextState: "change_pub_key_submitted",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter workflow rejected submitted key-registration identity.");
  }
  return intent;
}

export async function markLighterKeyRegistrationAmbiguousWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly txHash: string;
    readonly reason: string;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const txHash = normalizeRegistrationTxHash(input.txHash);
  const reason = normalizeAmbiguityReason(input.reason);
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'ambiguous',
            registration_ambiguity_reason = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state IN ('key_registration_tx_staged', 'change_pub_key_submitted')
        AND registration_tx_hash = $3
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, txHash, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["key_registration_approval_pending", "change_pub_key_submitted"],
    nextState: "ambiguous",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
    failureCode: reason,
  });
  if (workflow === null) {
    throw new Error("Lighter workflow rejected ambiguous key-registration state.");
  }
  return intent;
}

export async function markLighterKeyRegistrationKeyVerifiedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly publicKey: string;
    readonly verifiedAt: Date;
    readonly clientCheckedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const publicKey = normalizePublicKey(input.publicKey);
  assertTimestamp(input.verifiedAt, "public-key verification");
  assertTimestamp(input.clientCheckedAt, "official client check");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'key_verified',
            registration_key_verified_at = $4,
            registration_client_checked_at = $5,
            registration_ambiguity_reason = NULL,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state IN ('change_pub_key_submitted', 'ambiguous')
        AND public_key = $3
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, publicKey, input.verifiedAt, input.clientCheckedAt],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["change_pub_key_submitted", "ambiguous"],
    nextState: "key_verified",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter workflow rejected verified key-registration state.");
  }
  return intent;
}

export async function markLighterKeyRegistrationNonceSynchronizedWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly nextNonce: string;
    readonly synchronizedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  const nextNonce = normalizeRegistrationNonce(input.nextNonce);
  assertTimestamp(input.synchronizedAt, "nonce synchronization");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'nonce_synchronized',
            post_registration_nonce = $3,
            registration_nonce_synchronized_at = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state = 'key_verified'
        AND $3::BIGINT = registration_nonce + 1
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, nextNonce, input.synchronizedAt],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["key_verified"],
    nextState: "nonce_synchronized",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter workflow rejected synchronized key-registration nonce.");
  }
  return intent;
}

export async function markLighterKeyRegistrationActiveWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly activatedAt: Date;
  },
): Promise<LighterKeyRegistrationReservationRow | null> {
  assertTimestamp(input.activatedAt, "key activation");
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = 'active',
            registration_activated_at = $3,
            updated_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND capability = 'key_registration'
        AND approval_status = 'approved'
        AND execution_state = 'nonce_synchronized'
      RETURNING ${RETURNING}`,
    [input.intentId, input.sessionId, input.activatedAt],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: ["nonce_synchronized"],
    nextState: "ready_to_trade",
    apiKeyIndex: intent.apiKeyIndex,
    publicKeyFingerprint: intent.publicKeyFingerprint,
  });
  if (workflow === null) {
    throw new Error("Lighter workflow rejected active key-registration state.");
  }
  return intent;
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
  const deployment = getLighterFundingDeployment(input.environment);
  if (input.chainId !== deployment.settlementChainId) {
    throw new Error(
      `Lighter ${input.environment} key registration requires settlement chain ${deployment.settlementChainId}.`,
    );
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
    && row.execution_state !== "key_registration_tx_staged"
    && row.execution_state !== "change_pub_key_submitted"
    && row.execution_state !== "ambiguous"
    && row.execution_state !== "key_verified"
    && row.execution_state !== "nonce_synchronized"
    && row.execution_state !== "active"
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
    registrationTxType: nullableNumber(row.registration_tx_type),
    registrationTxHash: nullableString(row.registration_tx_hash),
    registrationTxExpiredAt: nullableString(row.registration_tx_expired_at),
    registrationTxStagedAt: nullableDate(row.registration_tx_staged_at),
    registrationSubmittedTxHash: nullableString(row.registration_submitted_tx_hash),
    registrationSubmitCode: nullableNumber(row.registration_submit_code),
    registrationPredictedExecutionTimeMs: nullableString(
      row.registration_predicted_execution_time_ms,
    ),
    registrationSubmitAcceptedAt: nullableDate(row.registration_submit_accepted_at),
    registrationAmbiguityReason: nullableString(row.registration_ambiguity_reason),
    registrationKeyVerifiedAt: nullableDate(row.registration_key_verified_at),
    registrationClientCheckedAt: nullableDate(row.registration_client_checked_at),
    postRegistrationNonce: nullableString(row.post_registration_nonce),
    registrationNonceSynchronizedAt: nullableDate(row.registration_nonce_synchronized_at),
    registrationActivatedAt: nullableDate(row.registration_activated_at),
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

function normalizeRegistrationTxHash(value: string): string {
  const txHash = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(txHash)) {
    throw new Error("Lighter key registration requires a canonical 40-byte transaction hash.");
  }
  return txHash;
}

function normalizePositiveInt64(value: string, field: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Lighter key registration ${field} must be a positive canonical integer.`);
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 63n) - 1n) {
    throw new Error(`Lighter key registration ${field} exceeds the int64 range.`);
  }
  return parsed.toString();
}

function normalizeAmbiguityReason(value: string): string {
  const reason = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,80}$/.test(reason)) {
    throw new Error("Lighter key registration ambiguity reason is invalid.");
  }
  return reason;
}

function assertTimestamp(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Lighter key registration ${field} timestamp is invalid.`);
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : value as Date;
}
