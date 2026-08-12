import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterTradingCredentialVaultReference } from "./trading-credentials.js";

const LIGHTER_TRADING_SECRET_BRAND: unique symbol = Symbol("lighter.trading.secret");

export interface LighterTradingSecretMaterial {
  readonly kind: "lighter_api_private_key_secret";
  readonly privateKey: string;
  readonly [LIGHTER_TRADING_SECRET_BRAND]: true;
  readonly toJSON: () => { readonly kind: "lighter_api_private_key_secret"; readonly privateKey: "[redacted]" };
}

export interface LighterTradingSecretReader {
  readonly readTradingApiPrivateKey: (
    reference: LighterTradingCredentialVaultReference,
  ) => Promise<string | null>;
}

export async function loadLighterTradingSecretMaterial(
  reference: LighterTradingCredentialVaultReference,
  reader: LighterTradingSecretReader,
): Promise<LighterTradingSecretMaterial> {
  validateReference(reference);
  let value: string | null;
  try {
    value = await reader.readTradingApiPrivateKey(reference);
  } catch {
    throw unavailable(reference);
  }

  if (value === null) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading API private key is not present in the encrypted local vault.",
      "Import the Lighter trading credential in Vex before preparing a live order create.",
    );
  }

  return materialFromSecret(value);
}

export function materialFromSecret(secret: string): LighterTradingSecretMaterial {
  const privateKey = secret.trim();
  if (privateKey.length < 16) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading API private key is not usable.",
      "Import a complete Lighter trading API private key in the encrypted local vault.",
    );
  }
  if (/^ro:\d+:(?:single|all):\d+:[a-fA-F0-9]+$/.test(privateKey)) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Read-only Lighter tokens cannot sign trading transactions.",
      "Use a Lighter trading API private key stored in the encrypted local vault.",
    );
  }
  return Object.defineProperties({} as LighterTradingSecretMaterial, {
    kind: {
      value: "lighter_api_private_key_secret",
      enumerable: true,
    },
    privateKey: {
      value: privateKey,
      enumerable: false,
    },
    [LIGHTER_TRADING_SECRET_BRAND]: {
      value: true,
      enumerable: false,
    },
    toJSON: {
      value: () => ({
        kind: "lighter_api_private_key_secret",
        privateKey: "[redacted]" as const,
      }),
      enumerable: false,
    },
  });
}

function validateReference(reference: LighterTradingCredentialVaultReference): void {
  if (reference.kind !== "encrypted_vault_reference" || reference.vaultCredentialId.trim().length === 0) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter trading credential reference is invalid.",
      "Prepare the order from a fresh Lighter preview before loading trading credentials.",
    );
  }
}

function unavailable(reference: LighterTradingCredentialVaultReference): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter trading credential ${reference.vaultCredentialId} is not readable through the privileged vault boundary.`,
    "Unlock Vex and retry after the Lighter trading credential is imported.",
  );
}
