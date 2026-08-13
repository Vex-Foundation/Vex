import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import {
  materialFromSecret,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import {
  unlockSecretVault,
  writeSecretVaultExtraSecrets,
} from "@vex-lib/local-secret-vault.js";
import { SECRETS_VAULT_FILE } from "../paths/config-dir.js";
import { requireUnlockedMasterPassword } from "./session.js";

export interface UnlockedLighterTradingCredentialStatus {
  readonly present: boolean;
  readonly reference: LighterTradingCredentialVaultReference;
}

export interface UnlockedLighterTradingCredentialScope {
  readonly environment: LighterTradingCredentialVaultReference["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

export function createUnlockedVaultLighterTradingSecretReader(): LighterTradingSecretReader {
  return {
    readTradingApiPrivateKey: async (reference) =>
      readUnlockedLighterTradingApiPrivateKey(reference),
  };
}

export function writeUnlockedLighterTradingApiPrivateKey(
  reference: LighterTradingCredentialVaultReference,
  privateKey: string,
): UnlockedLighterTradingCredentialStatus {
  assertReference(reference);
  const material = materialFromSecret(privateKey);
  const password = requireUnlockedMasterPassword();
  if (!password.ok) {
    throw lockedCredentialError("saved");
  }

  try {
    writeSecretVaultExtraSecrets(
      password.data,
      { [reference.vaultCredentialId]: material.privateKey },
      { filePath: SECRETS_VAULT_FILE },
    );
    return { present: true, reference };
  } catch {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential could not be saved through the privileged vault boundary.",
      "Unlock Vex and retry importing the Lighter trading credential.",
    );
  }
}

export function deleteUnlockedLighterTradingApiPrivateKey(
  reference: LighterTradingCredentialVaultReference,
): UnlockedLighterTradingCredentialStatus {
  assertReference(reference);
  const password = requireUnlockedMasterPassword();
  if (!password.ok) {
    throw lockedCredentialError("removed");
  }

  try {
    writeSecretVaultExtraSecrets(
      password.data,
      { [reference.vaultCredentialId]: null },
      { filePath: SECRETS_VAULT_FILE },
    );
    return { present: false, reference };
  } catch {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential could not be removed through the privileged vault boundary.",
      "Unlock Vex and retry removing the Lighter trading credential.",
    );
  }
}

export function getUnlockedLighterTradingCredentialStatus(
  reference: LighterTradingCredentialVaultReference,
): UnlockedLighterTradingCredentialStatus {
  assertReference(reference);
  const password = requireUnlockedMasterPassword();
  if (!password.ok) {
    throw lockedCredentialError("checked");
  }

  try {
    const contents = unlockSecretVault(password.data, {
      filePath: SECRETS_VAULT_FILE,
    });
    const value = contents.extraSecrets?.[reference.vaultCredentialId];
    return {
      present: typeof value === "string" && value.trim().length > 0,
      reference,
    };
  } catch {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential status is not readable through the privileged vault boundary.",
      "Unlock Vex and retry after the Lighter trading credential is imported.",
    );
  }
}

export function hasUnlockedLighterTradingCredential(
  environment: LighterTradingCredentialVaultReference["environment"],
): boolean {
  return listUnlockedLighterTradingCredentialScopes(environment).length > 0;
}

export function listUnlockedLighterTradingCredentialScopes(
  environment?: LighterTradingCredentialVaultReference["environment"],
): readonly UnlockedLighterTradingCredentialScope[] {
  const password = requireUnlockedMasterPassword();
  if (!password.ok) return [];

  try {
    const contents = unlockSecretVault(password.data, {
      filePath: SECRETS_VAULT_FILE,
    });
    const extraSecrets = contents.extraSecrets ?? {};
    const scopes: UnlockedLighterTradingCredentialScope[] = [];
    for (const [key, value] of Object.entries(extraSecrets)) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const match = /^lighter\/(core|rhc)\/account-(\d+)\/api-key-(\d+)$/.exec(key);
      if (!match) continue;
      const [, env, accountIndexRaw, apiKeyIndexRaw] = match;
      if (environment !== undefined && env !== environment) continue;
      const accountIndex = Number(accountIndexRaw);
      const apiKeyIndex = Number(apiKeyIndexRaw);
      if (
        !Number.isSafeInteger(accountIndex)
        || accountIndex < 0
        || !Number.isInteger(apiKeyIndex)
        || apiKeyIndex < 4
        || apiKeyIndex > 254
      ) {
        continue;
      }
      scopes.push({
        environment: env as LighterTradingCredentialVaultReference["environment"],
        accountIndex,
        apiKeyIndex,
      });
    }
    return scopes.sort((left, right) =>
      left.environment.localeCompare(right.environment)
      || left.accountIndex - right.accountIndex
      || left.apiKeyIndex - right.apiKeyIndex);
  } catch {
    return [];
  }
}

export function readUnlockedLighterTradingApiPrivateKey(
  reference: LighterTradingCredentialVaultReference,
): string | null {
  assertReference(reference);
  const password = requireUnlockedMasterPassword();
  if (!password.ok) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential is not readable because the local vault is locked.",
      "Unlock Vex before approving a live Lighter order.",
    );
  }

  try {
    const contents = unlockSecretVault(password.data, {
      filePath: SECRETS_VAULT_FILE,
    });
    const value = contents.extraSecrets?.[reference.vaultCredentialId];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential is not readable through the privileged vault boundary.",
      "Unlock Vex and retry after the Lighter trading credential is imported.",
    );
  }
}

function lockedCredentialError(action: "saved" | "removed" | "checked"): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter trading credential cannot be ${action} because the local vault is locked.`,
    "Unlock Vex before changing Lighter trading credentials.",
  );
}

function assertReference(reference: LighterTradingCredentialVaultReference): void {
  const expected = defaultLighterTradingVaultCredentialId({
    environment: reference.environment,
    accountIndex: reference.accountIndex,
    apiKeyIndex: reference.apiKeyIndex,
  });
  if (
    reference.kind !== "encrypted_vault_reference" ||
    reference.vaultCredentialId !== expected
  ) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential reference does not match the approved Lighter account scope.",
      "Run a fresh Lighter order preview and approval preparation before trying again.",
    );
  }
}
