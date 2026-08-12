import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import type { LighterTradingSecretReader } from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import { unlockSecretVault } from "@vex-lib/local-secret-vault.js";
import { SECRETS_VAULT_FILE } from "../paths/config-dir.js";
import { requireUnlockedMasterPassword } from "./session.js";

export function createUnlockedVaultLighterTradingSecretReader(): LighterTradingSecretReader {
  return {
    readTradingApiPrivateKey: async (reference) =>
      readUnlockedLighterTradingApiPrivateKey(reference),
  };
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
