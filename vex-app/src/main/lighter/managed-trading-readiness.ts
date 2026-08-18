import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import {
  createLighterRegisteredKeyCheckerBinary,
  type LighterRegisteredKeyChecker,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import * as keyIntentsRepo from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import * as nonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import type {
  LighterManagedTradingReadiness,
  LighterManagedTradingReadinessReason,
} from "@vex-agent/tools/protocols/lighter/managed-trading-readiness.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedManagedLighterTradingCredentialScopes,
  type UnlockedLighterTradingCredentialScope,
} from "../secrets/lighter-trading-credential.js";

export interface LighterManagedTradingReadinessDeps {
  readonly listManagedScopes: (
    environment: LighterEnvironment,
  ) => readonly UnlockedLighterTradingCredentialScope[];
  readonly findRegistrationIntent:
    typeof keyIntentsRepo.findLiveLighterKeyRegistrationIntentForAccount;
  readonly secretReader: LighterTradingSecretReader;
  readonly keyChecker: LighterRegisteredKeyChecker;
  readonly client: Pick<LighterClient, "getApiKeys" | "getNextNonce">;
  readonly findNonceState: typeof nonceStateRepo.find;
}

export async function resolveManagedLighterTradingReadiness(
  environment: LighterEnvironment,
  accountIndex: number,
  deps: LighterManagedTradingReadinessDeps = defaultDeps(),
): Promise<LighterManagedTradingReadiness> {
  if (environment !== "core") return notReady("verification_unavailable");
  const scope = deps.listManagedScopes(environment)
    .find((candidate) => candidate.accountIndex === accountIndex);
  if (scope === undefined) return notReady("active_managed_credential_missing");

  let intent: Awaited<ReturnType<LighterManagedTradingReadinessDeps["findRegistrationIntent"]>>;
  try {
    intent = await deps.findRegistrationIntent(environment, accountIndex);
  } catch {
    return notReady("verification_unavailable", { activeManagedCredential: true });
  }
  if (
    intent === null
    || intent.executionState !== "active"
    || intent.apiKeyIndex !== scope.apiKeyIndex
    || intent.publicKey === null
    || intent.registrationClientCheckedAt === null
    || intent.postRegistrationNonce === null
    || intent.registrationNonceSynchronizedAt === null
    || intent.registrationActivatedAt === null
  ) {
    return notReady("durable_activation_missing", { activeManagedCredential: true });
  }

  const reference: LighterTradingCredentialVaultReference = {
    kind: "encrypted_vault_reference",
    environment,
    accountIndex,
    apiKeyIndex: scope.apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
  };

  try {
    const [apiKeys, nextNonce, nonceState] = await Promise.all([
      deps.client.getApiKeys(environment, { accountIndex, apiKeyIndex: scope.apiKeyIndex }),
      deps.client.getNextNonce(environment, { accountIndex, apiKeyIndex: scope.apiKeyIndex }),
      deps.findNonceState(environment, accountIndex, scope.apiKeyIndex),
    ]);
    const expectedPublicKey = canonicalPublicKey(intent.publicKey);
    const exactRows = apiKeys.api_keys.filter(
      (row) => row.account_index === accountIndex && row.api_key_index === scope.apiKeyIndex,
    );
    if (apiKeys.code !== 200 || exactRows.length !== 1 || apiKeys.api_keys.length !== 1) {
      return notReady("live_key_mismatch", activationChecks());
    }
    const livePublicKey = canonicalPublicKey(exactRows[0]!.public_key);
    if (livePublicKey !== expectedPublicKey) {
      return notReady("live_key_mismatch", activationChecks());
    }

    // Public and durable identity must agree before the encrypted private key is
    // read. This keeps ordinary drift/failure checks outside the secret path.
    const secret = await loadLighterTradingSecretMaterial(reference, deps.secretReader);
    const checked = await deps.keyChecker.check({
      environment,
      accountIndex,
      apiKeyIndex: scope.apiKeyIndex,
      secret,
    });
    const clientPublicKey = canonicalPublicKey(checked.publicKey);
    if (clientPublicKey !== expectedPublicKey) {
      return notReady("client_check_failed", {
        ...activationChecks(),
        exactPublicKeyMatch: true,
      });
    }

    const liveNonce = canonicalNonce(nextNonce.nonce);
    const slotNonce = canonicalNonce(exactRows[0]!.nonce);
    const activationNonce = canonicalNonce(intent.postRegistrationNonce);
    const nonceSynchronized = nextNonce.code === 200
      && liveNonce === slotNonce
      && BigInt(liveNonce) >= BigInt(activationNonce);
    if (!nonceSynchronized) {
      return notReady("nonce_not_synchronized", {
        ...activationChecks(),
        exactPublicKeyMatch: true,
        clientCheckPassed: true,
      });
    }

    const nonceReservable = nonceState === null
      || (
        nonceState.status === "observed"
        && nonceState.providerNonce === liveNonce
        && canonicalPublicKey(nonceState.publicKey) === livePublicKey
      );
    if (!nonceReservable) {
      return notReady("nonce_not_reservable", {
        ...activationChecks(),
        exactPublicKeyMatch: true,
        clientCheckPassed: true,
        nonceSynchronized: true,
      });
    }

    return {
      ready: true,
      reason: "ready",
      ...activationChecks(),
      exactPublicKeyMatch: true,
      clientCheckPassed: true,
      nonceSynchronized: true,
      nonceReservable: true,
    };
  } catch {
    return notReady("verification_unavailable", activationChecks());
  }
}

function activationChecks(): Pick<
  LighterManagedTradingReadiness,
  "activeManagedCredential" | "durableActivation"
> {
  return {
    activeManagedCredential: true,
    durableActivation: true,
  };
}

function notReady(
  reason: Exclude<LighterManagedTradingReadinessReason, "ready">,
  checks: Partial<LighterManagedTradingReadiness> = {},
): LighterManagedTradingReadiness {
  return {
    ready: false,
    reason,
    activeManagedCredential: false,
    durableActivation: false,
    exactPublicKeyMatch: false,
    clientCheckPassed: false,
    nonceSynchronized: false,
    nonceReservable: false,
    ...checks,
  };
}

function canonicalPublicKey(value: string): string {
  const publicKey = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(publicKey)) {
    throw new Error("Lighter readiness received an invalid public key.");
  }
  return publicKey;
}

function canonicalNonce(value: string | number): string {
  const nonce = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(nonce)) {
    throw new Error("Lighter readiness received an invalid nonce.");
  }
  return BigInt(nonce).toString();
}

function defaultDeps(): LighterManagedTradingReadinessDeps {
  return {
    listManagedScopes: (environment) =>
      listUnlockedManagedLighterTradingCredentialScopes(environment),
    findRegistrationIntent: keyIntentsRepo.findLiveLighterKeyRegistrationIntentForAccount,
    secretReader: createUnlockedVaultLighterTradingSecretReader(),
    keyChecker: createLighterRegisteredKeyCheckerBinary(),
    client: getLighterClient(),
    findNonceState: nonceStateRepo.find,
  };
}
