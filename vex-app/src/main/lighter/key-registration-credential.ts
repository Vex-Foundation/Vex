import {
  createLighterApiKeyGeneratorBinary,
  type LighterApiKeyGenerator,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import {
  findLighterKeyRegistrationIntent,
  markLighterKeyGeneratedEncryptedWith,
  type LighterKeyRegistrationReservationRow,
} from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import type { LighterOnboardingQueryClient } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  getUnlockedLighterTradingCredentialRegistrationState,
  LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE,
  readUnlockedLighterTradingApiPrivateKey,
  writeUnlockedPendingLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";
import { configureLighterKeyRegistrationCredentialPreparer } from "@vex-agent/tools/protocols/lighter/key-registration-preparation.js";

export interface PreparedLighterRegistrationCredential {
  readonly intentId: string;
  readonly environment: "core" | "rhc";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly vaultCredentialId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly outcome: "generated" | "recovered_pending" | "already_persisted";
}

export interface PrepareLighterRegistrationCredentialDeps {
  readonly readIntent: (
    intentId: string,
  ) => Promise<LighterKeyRegistrationReservationRow | null>;
  readonly generator: LighterApiKeyGenerator;
  readonly readVaultPrivateKey: (
    reference: LighterTradingCredentialVaultReference,
  ) => string | null;
  readonly readVaultRegistrationState: (
    reference: LighterTradingCredentialVaultReference,
  ) => string | null;
  readonly writePendingVaultPrivateKey: (
    reference: LighterTradingCredentialVaultReference,
    privateKey: string,
  ) => unknown;
  readonly persistGeneratedMetadata: (
    sessionId: string,
    input: {
      readonly intentId: string;
      readonly reference: LighterTradingCredentialVaultReference;
      readonly publicKey: string;
      readonly generatedAt: Date;
    },
  ) => Promise<LighterKeyRegistrationReservationRow | null>;
  readonly now: () => Date;
}

/**
 * Generate or recover the pending key outside the session lock, encrypt it,
 * then use one short DB-only locked transaction for the lifecycle CAS.
 */
export async function prepareLighterRegistrationCredential(
  input: { readonly sessionId: string; readonly intentId: string },
  deps: PrepareLighterRegistrationCredentialDeps = defaultDeps(),
): Promise<PreparedLighterRegistrationCredential> {
  const now = deps.now();
  const intent = await deps.readIntent(input.intentId);
  if (intent === null || intent.sessionId !== input.sessionId) {
    throw preparationError("reservation is missing or belongs to another session");
  }
  if (
    intent.executionState !== "slot_reserved"
    && intent.executionState !== "key_generated_encrypted"
  ) {
    throw preparationError("reservation is not ready for local key preparation");
  }
  if (intent.executionState === "slot_reserved" && intent.expiresAt <= now) {
    throw preparationError("reservation has expired");
  }
  if (deps.generator.source !== "official_lighter_signer") {
    throw preparationError("requires the packaged official signer helper");
  }

  const reference = credentialReference(intent);
  let privateKey: string | null;
  let registrationState: string | null;
  try {
    privateKey = deps.readVaultPrivateKey(reference);
    registrationState = deps.readVaultRegistrationState(reference);
  } catch {
    throw preparationError("could not inspect the encrypted local vault");
  }

  let publicKey: string;
  let outcome: PreparedLighterRegistrationCredential["outcome"];
  if (privateKey === null && registrationState === null) {
    if (intent.executionState !== "slot_reserved") {
      throw preparationError("persisted metadata has no recoverable encrypted key");
    }
    try {
      const generated = await deps.generator.generate();
      publicKey = generated.publicKey;
      deps.writePendingVaultPrivateKey(reference, generated.secret.privateKey);
    } catch {
      throw preparationError("could not generate and encrypt the local key");
    }
    outcome = "generated";
  } else if (
    privateKey !== null
    && registrationState === LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE
  ) {
    try {
      publicKey = await deps.generator.derivePublicKey(materialFromSecret(privateKey));
    } catch {
      throw preparationError("could not recover the pending local key");
    }
    outcome = intent.executionState === "key_generated_encrypted"
      ? "already_persisted"
      : "recovered_pending";
  } else {
    throw preparationError("encrypted key and registration marker are inconsistent");
  }

  if (intent.executionState === "key_generated_encrypted") {
    if (
      intent.vaultCredentialId !== reference.vaultCredentialId
      || intent.publicKey !== publicKey
      || intent.publicKeyFingerprint === null
    ) {
      throw preparationError("persisted public metadata does not match the encrypted key");
    }
    return resultFromIntent(intent, outcome);
  }

  let persisted: LighterKeyRegistrationReservationRow | null;
  try {
    persisted = await deps.persistGeneratedMetadata(input.sessionId, {
      intentId: input.intentId,
      reference,
      publicKey,
      generatedAt: now,
    });
  } catch {
    throw preparationError("encrypted key metadata could not be persisted");
  }
  if (persisted === null) {
    throw preparationError("encrypted key metadata lost its lifecycle compare-and-swap");
  }
  if (
    persisted.vaultCredentialId !== reference.vaultCredentialId
    || persisted.publicKey !== publicKey
    || persisted.publicKeyFingerprint === null
  ) {
    throw preparationError("persisted key metadata does not match the prepared credential");
  }
  return resultFromIntent(persisted, outcome);
}

export function installLighterKeyRegistrationCredentialPreparer(): () => void {
  return configureLighterKeyRegistrationCredentialPreparer({
    prepare: (input) => prepareLighterRegistrationCredential(input),
  });
}

function defaultDeps(): PrepareLighterRegistrationCredentialDeps {
  return {
    readIntent: findLighterKeyRegistrationIntent,
    generator: createLighterApiKeyGeneratorBinary(),
    readVaultPrivateKey: readUnlockedLighterTradingApiPrivateKey,
    readVaultRegistrationState: getUnlockedLighterTradingCredentialRegistrationState,
    writePendingVaultPrivateKey: writeUnlockedPendingLighterTradingApiPrivateKey,
    persistGeneratedMetadata: (sessionId, input) =>
      withSessionControlLock(sessionId, (client: LighterOnboardingQueryClient) =>
        markLighterKeyGeneratedEncryptedWith(client, input)),
    now: () => new Date(),
  };
}

function credentialReference(
  intent: LighterKeyRegistrationReservationRow,
): LighterTradingCredentialVaultReference {
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

function resultFromIntent(
  intent: LighterKeyRegistrationReservationRow,
  outcome: PreparedLighterRegistrationCredential["outcome"],
): PreparedLighterRegistrationCredential {
  if (
    intent.vaultCredentialId === null
    || intent.publicKey === null
    || intent.publicKeyFingerprint === null
  ) {
    throw preparationError("durable key metadata is incomplete");
  }
  return {
    intentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    vaultCredentialId: intent.vaultCredentialId,
    publicKey: intent.publicKey,
    publicKeyFingerprint: intent.publicKeyFingerprint,
    outcome,
  };
}

function preparationError(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter key registration credential preparation failed: ${reason}.`,
    "Do not register or replace the key until the durable reservation and encrypted vault state are reconciled.",
  );
}
