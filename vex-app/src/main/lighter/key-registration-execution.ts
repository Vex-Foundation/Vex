import { persistLighterSigningEvidence } from "@vex-agent/tools/protocols/lighter/execution-boundary.js";
import { app } from "electron";
import { assertIntentAuthority, LighterIntentRefusal, lighterSignerExited } from "@vex-agent/tools/protocols/lighter/intent-expiry.js";
import { getAddress } from "viem";

import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import { readUniqueLighterMasterAccount } from "@tools/lighter/wallet-funding/account-ownership.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import {
  createLighterApiKeyGeneratorBinary,
  createLighterRegisteredKeyCheckerBinary,
  type LighterApiKeyGenerator,
  type LighterRegisteredKeyChecker,
} from "@tools/lighter/signer-binary-adapter.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import {
  assertLighterTradingApiKeyIndexAllowed,
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import type { LighterApiKey } from "@tools/lighter/types.js";
import * as keyIntentsRepo from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { isLighterIntegrationEnabled } from "@vex-agent/db/repos/lighter-integration-settings.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import type {
  LighterKeyRegistrationExecutionResult,
  LighterKeyRegistrationExecutor,
} from "@vex-agent/tools/protocols/lighter/key-registration-execution.js";
import { configureLighterKeyRegistrationExecutor } from "@vex-agent/tools/protocols/lighter/key-registration-execution.js";
import { resolveSigningWallet } from "@vex-agent/tools/internal/wallet/resolve.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import {
  activateUnlockedLighterTradingCredential,
  getUnlockedLighterTradingCredentialRegistrationState,
  LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE,
  LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE,
  readUnlockedLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";
import { signApprovedLighterKeyRegistration } from "./key-registration-signing.js";

const RECONCILIATION_ATTEMPTS = 8;
const RECONCILIATION_INTERVAL_MS = 750;
type RegistrationIntent = keyIntentsRepo.LighterKeyRegistrationReservationRow;

export interface LighterKeyRegistrationExecutionDeps {
  readonly client: Pick<
    LighterClient,
    "getAccountsByL1Address" | "getApiKeys" | "getNextNonce" | "sendTx"
  >;
  readonly readIntent: typeof keyIntentsRepo.findLighterKeyRegistrationIntent;
  readonly integrationEnabled: typeof isLighterIntegrationEnabled;
  readonly resolveWallet: typeof resolveSigningWallet;
  readonly sign: typeof signApprovedLighterKeyRegistration;
  readonly keyGenerator: LighterApiKeyGenerator;
  readonly keyChecker: LighterRegisteredKeyChecker;
  readonly readVaultPrivateKey: typeof readUnlockedLighterTradingApiPrivateKey;
  readonly readVaultRegistrationState:
    typeof getUnlockedLighterTradingCredentialRegistrationState;
  readonly activateVaultCredential: typeof activateUnlockedLighterTradingCredential;
  readonly claimSigning: typeof keyIntentsRepo.claimRegistrationSigning;
  readonly admitSend: typeof keyIntentsRepo.markRegistrationSendAttemptStarted;
  readonly refuseUnsubmitted: typeof keyIntentsRepo.markRegistrationUnsubmitted;
  readonly markStaged: typeof markStaged;
  readonly markSubmitted: typeof markSubmitted;
  readonly markAmbiguous: typeof markAmbiguous;
  readonly markKeyVerified: typeof markKeyVerified;
  readonly markNonceSynchronized: typeof markNonceSynchronized;
  readonly markActive: typeof markActive;
  readonly now: () => Date;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly reconciliationAttempts: number;
}

export async function executeApprovedLighterKeyRegistration(
  input: Parameters<LighterKeyRegistrationExecutor["execute"]>[0],
  deps: LighterKeyRegistrationExecutionDeps = defaultDeps(),
): Promise<LighterKeyRegistrationExecutionResult> {
  return runLighterKeyRegistration(input, deps, true);
}

export async function reconcileLighterKeyRegistration(
  input: Parameters<LighterKeyRegistrationExecutor["reconcile"]>[0],
  deps: LighterKeyRegistrationExecutionDeps = defaultDeps(),
): Promise<LighterKeyRegistrationExecutionResult> {
  return runLighterKeyRegistration(input, deps, false);
}

async function runLighterKeyRegistration(
  input: Parameters<LighterKeyRegistrationExecutor["execute"]>[0],
  deps: LighterKeyRegistrationExecutionDeps,
  allowSubmission: boolean,
): Promise<LighterKeyRegistrationExecutionResult> {
  let intent = await deps.readIntent(input.intentId);
  if (intent === null || intent.sessionId !== input.sessionId) {
    throw executionError("the approved registration intent is unavailable in this session");
  }
  const assertAuthority = (phase: Parameters<typeof assertIntentAuthority>[2]): void =>
    assertIntentAuthority(intent!.expiresAt, deps.now().getTime(), phase, input.abortSignal);
  if (allowSubmission && intent.executionState === "approved") assertAuthority("before_reservation");
  if (intent.executionState === "failed" && !(intent.approvalStatus === "approved"
    && intent.registrationAmbiguityReason !== null
    && /^(consent_expired_|cancelled_|submission_admission_refused$)/.test(intent.registrationAmbiguityReason))) {
    throw executionError("the registration failed without an unsubmitted consent refusal");
  }
  if (intent.executionState === "failed") return {
    source: "vex_lighter_key_registration", status: "expired_unsubmitted", intentId: intent.intentId,
    executionState: intent.executionState, accountIndex: intent.accountIndex, apiKeyIndex: intent.apiKeyIndex,
    txHash: intent.registrationTxHash, postRegistrationNonce: intent.postRegistrationNonce,
    message: "The registration was refused before submission. Any signing evidence was retained. Request fresh approval.",
  };
  assertLighterTradingApiKeyIndexAllowed(intent.environment, intent.apiKeyIndex);
  assertIntentShape(intent);
  if (intent.approvalStatus !== "approved") {
    throw executionError("the registration intent does not have durable approval");
  }
  if (allowSubmission) {
    if (!(await deps.integrationEnabled(intent.environment, intent.walletAddress))) {
      throw executionError("the Lighter integration was disabled before execution");
    }
  } else if (
    intent.executionState === "slot_reserved"
    || intent.executionState === "key_generated_encrypted"
    || intent.executionState === "approval_pending"
    || intent.executionState === "approved"
  ) {
    throw executionError("the registration has no staged transaction to reconcile");
  }

  await assertOwnedMasterAccount(deps.client, intent);

  if (intent.executionState === "approved") {
    const slot = await readExactApiKeySlot(deps.client, intent);
    if (slot !== null) {
      throw executionError("the approved API-key slot is no longer empty");
    }
    const nonce = await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
    if (nonce.code !== 200 || String(nonce.nonce) !== intent.registrationNonce) {
      throw executionError("the live API-key nonce changed after approval");
    }

    const wallet = deps.resolveWallet(input.walletResolution, input.walletPolicy, "eip155");
    if (wallet.family !== "eip155") {
      throw executionError("the selected wallet is not an EVM signing wallet");
    }
    assertAuthority("before_reservation");
    if (!await deps.claimSigning({ intentId: intent.intentId, sessionId: intent.sessionId })) {
      throw executionError("the registration signing attempt is already claimed or expired");
    }
    let signingStarted = false;
    let signerExited = false;
    let sendAdmissionStarted = false;
    try {
    assertAuthority("after_reservation");
    assertAuthority("before_signing");
    signingStarted = true;
    const signed = await deps.sign({
      sessionId: input.sessionId,
      intent,
      wallet,
      revalidatedNonce: String(nonce.nonce),
    });
    signerExited = lighterSignerExited(signed);
    const signingIntentId = intent.intentId;
    const staged = await persistLighterSigningEvidence(() => deps.markStaged(input.sessionId, signingIntentId, {
      txType: signed.txType,
      txHash: signed.txHash,
      expiredAt: signed.expiredAt,
      stagedAt: deps.now(),
    }));
    if (staged === null) {
      throw executionError("the signed registration lost its pre-submission lifecycle transition");
    }
    intent = staged;

    assertAuthority("after_signing");
    assertAuthority("before_submission");
    sendAdmissionStarted = true;
    if (!await deps.admitSend({ intentId: intent.intentId, sessionId: intent.sessionId, txHash: signed.txHash })) {
      sendAdmissionStarted = false;
      throw new LighterIntentRefusal("submission_admission_refused");
    }
    assertAuthority("before_submission");
    if (BigInt(signed.expiredAt) <= BigInt(deps.now().getTime())) throw executionError("the signed registration wire expiry elapsed");

    let response: Awaited<ReturnType<LighterClient["sendTx"]>>;
    try {
      response = await deps.client.sendTx(intent.environment, {
        txType: signed.txType,
        txInfo: signed.txInfo,
      });
    } catch {
      intent = await recordAmbiguous(deps, intent, "send_tx_outcome_unknown");
      return reconcileRegistration(input, intent, deps);
    }

    const submittedHash = normalizeTxHash(response.tx_hash);
    if (
      response.code !== 200
      || submittedHash === null
      || submittedHash !== intent.registrationTxHash
      || !Number.isSafeInteger(response.predicted_execution_time_ms)
      || response.predicted_execution_time_ms < 0
    ) {
      intent = await recordAmbiguous(deps, intent, "send_tx_response_mismatch");
      return reconcileRegistration(input, intent, deps);
    }
    try {
      const submitted = await deps.markSubmitted(input.sessionId, intent.intentId, {
        txHash: submittedHash,
        submittedTxHash: submittedHash,
        submitCode: response.code,
        predictedExecutionTimeMs: response.predicted_execution_time_ms,
        acceptedAt: deps.now(),
      });
      if (submitted === null) throw executionError("submission acknowledgement was not persisted");
      intent = submitted;
    } catch {
      intent = await recordAmbiguous(deps, intent, "submit_acceptance_persistence_failed");
    }
    } catch (error) {
      signerExited ||= lighterSignerExited(error);
      if (error instanceof LighterIntentRefusal && !sendAdmissionStarted && (!signingStarted || signerExited)) {
        await deps.refuseUnsubmitted({ intentId: intent.intentId, sessionId: intent.sessionId, reason: error.reason });
      } else if (intent.registrationTxHash !== null) {
        await recordAmbiguous(deps, intent, error instanceof LighterIntentRefusal ? error.reason : "signing_or_admission_interrupted");
      }
      throw error;
    }
  } else if (intent.executionState === "key_registration_tx_staged") {
    intent = await recordAmbiguous(deps, intent, "staged_tx_requires_reconciliation");
  }

  return reconcileRegistration(input, intent, deps);
}

async function reconcileRegistration(
  input: Parameters<LighterKeyRegistrationExecutor["execute"]>[0],
  initialIntent: RegistrationIntent,
  deps: LighterKeyRegistrationExecutionDeps,
): Promise<LighterKeyRegistrationExecutionResult> {
  let intent = initialIntent;
  const slot = await waitForExactApiKeySlot(deps, intent);
  if (slot === null) {
    return result(intent, intent.executionState === "ambiguous"
      ? "ambiguity_unresolved"
      : "submitted_pending_verification");
  }
  const registeredPublicKey = normalizePublicKey(slot.public_key);
  if (registeredPublicKey !== intent.publicKey) {
    if (intent.executionState === "change_pub_key_submitted") {
      intent = await recordAmbiguous(deps, intent, "registered_public_key_conflict");
    }
    return result(intent, "registered_key_conflict");
  }

  const reference = credentialReference(intent);
  const registrationState = deps.readVaultRegistrationState(reference);
  if (
    registrationState !== LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE
    && registrationState !== LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE
  ) {
    throw executionError("the encrypted trading credential has an invalid activation marker");
  }
  const privateKey = deps.readVaultPrivateKey(reference);
  if (privateKey === null) {
    throw executionError("the encrypted trading credential is unavailable");
  }
  const secret = materialFromSecret(privateKey);
  const derivedPublicKey = await deps.keyGenerator.derivePublicKey(secret);
  if (derivedPublicKey !== intent.publicKey) {
    throw executionError("the encrypted trading credential no longer matches the approved key");
  }
  const checked = await deps.keyChecker.check({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    secret,
  });
  if (checked.publicKey !== intent.publicKey) {
    throw executionError("the official client check returned a different public key");
  }

  if (
    intent.executionState === "change_pub_key_submitted"
    || intent.executionState === "ambiguous"
  ) {
    const checkedAt = deps.now();
    const verified = await deps.markKeyVerified(input.sessionId, intent.intentId, {
      publicKey: intent.publicKey!,
      verifiedAt: checkedAt,
      clientCheckedAt: checkedAt,
    });
    if (verified === null) {
      throw executionError("the verified key lost its lifecycle transition");
    }
    intent = verified;
  }

  if (intent.executionState === "key_verified") {
    const nonce = await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
    const expectedNonce = (BigInt(intent.registrationNonce!) + 1n).toString();
    if (nonce.code !== 200 || String(nonce.nonce) !== expectedNonce) {
      return result(intent, "key_verified_pending_nonce");
    }
    const synchronized = await deps.markNonceSynchronized(
      input.sessionId,
      intent.intentId,
      { nextNonce: expectedNonce, synchronizedAt: deps.now() },
    );
    if (synchronized === null) {
      throw executionError("the verified registration nonce lost its lifecycle transition");
    }
    intent = synchronized;
  }

  if (intent.executionState === "nonce_synchronized") {
    const active = await deps.markActive(input.sessionId, intent.intentId, {
      activatedAt: deps.now(),
    });
    if (active === null) {
      throw executionError("the verified credential lost its activation transition");
    }
    intent = active;
  }
  if (intent.executionState !== "active") {
    throw executionError("the registration lifecycle cannot be activated from its current state");
  }
  const activated = deps.activateVaultCredential(reference);
  if (activated.registrationState !== LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE) {
    throw executionError("the encrypted trading credential was not activated");
  }
  return result(intent, "active");
}

async function assertOwnedMasterAccount(
  client: LighterKeyRegistrationExecutionDeps["client"],
  intent: RegistrationIntent,
): Promise<void> {
  let accountIndex: number;
  try {
    accountIndex = await readUniqueLighterMasterAccount(
      client,
      intent.environment,
      intent.walletAddress,
    );
  } catch {
    throw executionError("the approved Lighter master account is not uniquely owned by the wallet");
  }
  if (accountIndex !== intent.accountIndex) {
    throw executionError("the approved Lighter master account is not uniquely owned by the wallet");
  }
}

async function readExactApiKeySlot(
  client: LighterKeyRegistrationExecutionDeps["client"],
  intent: RegistrationIntent,
): Promise<LighterApiKey | null> {
  let response: Awaited<ReturnType<LighterClient["getApiKeys"]>>;
  try {
    response = await client.getApiKeys(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
  } catch (error) {
    if (isMissingExactApiKeySlot(error)) return null;
    throw error;
  }
  if (response.code !== 200) throw executionError("the live API-key slot could not be verified");
  if (response.api_keys.some((row) => row.account_index !== intent.accountIndex)) {
    throw executionError("the live API-key slot response included another account");
  }
  const exact = response.api_keys.filter((row) => row.api_key_index === intent.apiKeyIndex);
  if (exact.length > 1 || response.api_keys.length !== exact.length) {
    throw executionError("the live API-key slot response was contradictory");
  }
  if (exact.length === 0) return null;
  normalizePublicKey(exact[0]!.public_key);
  return exact[0]!;
}

function isMissingExactApiKeySlot(error: unknown): boolean {
  return error instanceof VexError
    && error.code === ErrorCodes.LIGHTER_INVALID_REQUEST
    && error.httpStatus === 400
    && /^Lighter (?:Core|RHC) rejected the request \(HTTP 400\)\. Upstream said: api key not found$/i
      .test(error.message);
}

async function waitForExactApiKeySlot(
  deps: LighterKeyRegistrationExecutionDeps,
  intent: RegistrationIntent,
  abortSignal?: AbortSignal,
): Promise<LighterApiKey | null> {
  for (let attempt = 0; attempt < deps.reconciliationAttempts; attempt += 1) {
    try {
      const slot = await readExactApiKeySlot(deps.client, intent);
      if (slot !== null) return slot;
    } catch {
      // Provider-read uncertainty after submit is public reconciliation state,
      // never permission to resend the signed transaction.
    }
    if (abortSignal?.aborted) return null;
    if (attempt + 1 < deps.reconciliationAttempts) {
      await deps.sleep(RECONCILIATION_INTERVAL_MS);
    }
  }
  return null;
}

function assertIntentShape(intent: RegistrationIntent): void {
  if (
    intent.publicKey === null
    || normalizePublicKey(intent.publicKey) !== intent.publicKey
    || intent.registrationNonce === null
    || !/^(?:0|[1-9][0-9]*)$/.test(intent.registrationNonce)
    || intent.vaultCredentialId !== credentialReference(intent).vaultCredentialId
    || intent.chainId !== getLighterFundingDeployment(intent.environment).settlementChainId
  ) {
    throw executionError("the durable registration intent is incomplete or malformed");
  }
}

function credentialReference(intent: RegistrationIntent): LighterTradingCredentialVaultReference {
  const scope = {
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  };
  return {
    kind: "encrypted_vault_reference",
    ...scope,
    vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
  };
}

function normalizePublicKey(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(normalized)) {
    throw executionError("the live Lighter public key is malformed");
  }
  return normalized;
}

function normalizeTxHash(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{80}$/.test(normalized) ? normalized : null;
}

async function recordAmbiguous(
  deps: LighterKeyRegistrationExecutionDeps,
  intent: RegistrationIntent,
  reason: string,
): Promise<RegistrationIntent> {
  if (intent.registrationTxHash === null) {
    throw executionError("the staged registration transaction identity is missing");
  }
  const ambiguous = await deps.markAmbiguous(intent.sessionId, intent.intentId, {
    txHash: intent.registrationTxHash,
    reason,
  });
  if (ambiguous !== null) return ambiguous;
  return await deps.readIntent(intent.intentId) ?? intent;
}

function result(
  intent: RegistrationIntent,
  status: LighterKeyRegistrationExecutionResult["status"],
): LighterKeyRegistrationExecutionResult {
  const messages: Record<LighterKeyRegistrationExecutionResult["status"], string> = {
    active:
      "Lighter registered the exact vault-derived public key, the official client check passed, and the nonce and local active marker are synchronized.",
    submitted_pending_verification:
      "Lighter accepted the registration transaction, but the exact public key is not visible yet. Vex will not resubmit without reconciliation.",
    ambiguity_unresolved:
      "The registration submission outcome is ambiguous and the exact public key is not visible. Vex did not resubmit.",
    registered_key_conflict:
      "The reserved slot contains a different public key. The local credential remains inactive and Vex will not resubmit.",
    key_verified_pending_nonce:
      "The exact public key and official client check passed, but the next nonce is not the approved nonce plus one. The local credential remains inactive.",
    expired_unsubmitted:
      "The registration consent expired or the dispatch was cancelled before Vex attempted the submission. Nothing was sent to Lighter; the signing evidence is retained and the local credential remains inactive.",
  };
  return {
    source: "vex_lighter_key_registration",
    status,
    intentId: intent.intentId,
    executionState: intent.executionState,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    txHash: intent.registrationTxHash,
    postRegistrationNonce: intent.postRegistrationNonce,
    message: messages[status],
  };
}

async function markStaged(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationTxStagedWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationTxStagedWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

async function markSubmitted(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationSubmittedWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationSubmittedWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

async function markAmbiguous(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationAmbiguousWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationAmbiguousWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

async function markKeyVerified(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationKeyVerifiedWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationKeyVerifiedWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

async function markNonceSynchronized(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationNonceSynchronizedWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationNonceSynchronizedWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

async function markActive(
  sessionId: string,
  intentId: string,
  input: Omit<Parameters<typeof keyIntentsRepo.markLighterKeyRegistrationActiveWith>[1],
    "sessionId" | "intentId">,
): Promise<RegistrationIntent | null> {
  return withSessionControlLock(sessionId, (client) =>
    keyIntentsRepo.markLighterKeyRegistrationActiveWith(client, {
      sessionId,
      intentId,
      ...input,
    }));
}

function defaultDeps(): LighterKeyRegistrationExecutionDeps {
  return {
    client: getLighterClient(),
    readIntent: keyIntentsRepo.findLighterKeyRegistrationIntent,
    integrationEnabled: isLighterIntegrationEnabled,
    resolveWallet: resolveSigningWallet,
    sign: signApprovedLighterKeyRegistration,
    keyGenerator: createLighterApiKeyGeneratorBinary({ allowBinaryPathOverride: !app.isPackaged }),
    keyChecker: createLighterRegisteredKeyCheckerBinary({ allowBinaryPathOverride: !app.isPackaged }),
    readVaultPrivateKey: readUnlockedLighterTradingApiPrivateKey,
    readVaultRegistrationState: getUnlockedLighterTradingCredentialRegistrationState,
    activateVaultCredential: activateUnlockedLighterTradingCredential,
    claimSigning: keyIntentsRepo.claimRegistrationSigning,
    admitSend: keyIntentsRepo.markRegistrationSendAttemptStarted,
    refuseUnsubmitted: keyIntentsRepo.markRegistrationUnsubmitted,
    markStaged,
    markSubmitted,
    markAmbiguous,
    markKeyVerified,
    markNonceSynchronized,
    markActive,
    now: () => new Date(),
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    reconciliationAttempts: RECONCILIATION_ATTEMPTS,
  };
}

export function installLighterKeyRegistrationExecutor(): () => void {
  return configureLighterKeyRegistrationExecutor({
    execute: (input) => executeApprovedLighterKeyRegistration(input),
    reconcile: (input) => reconcileLighterKeyRegistration(input),
  });
}

function executionError(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter key registration refused: ${reason}.`,
    "Do not submit another registration until the durable intent and exact API-key slot are reconciled.",
  );
}
