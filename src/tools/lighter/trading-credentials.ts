import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_API_KEY_INDEX_ALL,
  type LighterEnvironment,
} from "./constants.js";

export const LIGHTER_TRADING_API_KEY_INDEX_MIN = 4;
export const LIGHTER_TRADING_API_KEY_INDEX_MAX = 254;

export const LIGHTER_SIGNER_SECRET_POLICY = {
  secretSource: "encrypted_vault_only",
  credentialMaterial: "lighter_api_private_key",
  forbiddenSinks: [
    "renderer",
    "preload",
    "agent_transcript",
    "logs",
    "telemetry",
    "cli_arguments",
    "provider_error_text",
  ],
  allowedApiKeyIndexes: {
    min: LIGHTER_TRADING_API_KEY_INDEX_MIN,
    max: LIGHTER_TRADING_API_KEY_INDEX_MAX,
  },
  reservedApiKeyIndexes: [0, 1, 2, 3, LIGHTER_API_KEY_INDEX_ALL],
} as const;

export type LighterTradingCredentialCapability = "lighter_transaction_signing";

export interface LighterTradingCredentialVaultReference {
  readonly kind: "encrypted_vault_reference";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly vaultCredentialId: string;
}

export interface LighterTradingCredentialNonceScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

export type LighterTradingCredentialReadiness =
  | {
      readonly ready: true;
      readonly capability: LighterTradingCredentialCapability;
      readonly reference: LighterTradingCredentialVaultReference;
      readonly nonceScope: LighterTradingCredentialNonceScope;
    }
  | {
      readonly ready: false;
      readonly capability: LighterTradingCredentialCapability;
      readonly code:
        | "invalid_account_index"
        | "invalid_api_key_index"
        | "missing_vault_reference"
        | "unsafe_vault_reference";
      readonly reason: string;
    };

export interface LighterTradingCredentialReadinessInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number | null | undefined;
  readonly vaultCredentialId?: string | null;
}

export function defaultLighterTradingVaultCredentialId(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}): string {
  return `lighter/${input.environment}/account-${input.accountIndex}/api-key-${input.apiKeyIndex}`;
}

export function evaluateLighterTradingCredentialReadiness(
  input: LighterTradingCredentialReadinessInput,
): LighterTradingCredentialReadiness {
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) {
    return blocked(
      "invalid_account_index",
      "accountIndex must be a safe non-negative integer.",
    );
  }

  const apiKeyIndex = input.apiKeyIndex;
  if (apiKeyIndex === null || apiKeyIndex === undefined) {
    return blocked(
      "invalid_api_key_index",
      "apiKeyIndex is required for Lighter trading credentials.",
    );
  }
  if (
    !Number.isInteger(apiKeyIndex)
    || apiKeyIndex < LIGHTER_TRADING_API_KEY_INDEX_MIN
    || apiKeyIndex > LIGHTER_TRADING_API_KEY_INDEX_MAX
  ) {
    return blocked(
      "invalid_api_key_index",
      "apiKeyIndex must be a trading API key index from 4 to 254.",
    );
  }

  const vaultCredentialId = input.vaultCredentialId?.trim();
  if (!vaultCredentialId) {
    return blocked(
      "missing_vault_reference",
      "A Lighter trading API private key must be available through an encrypted vault reference.",
    );
  }
  if (!isSafeVaultCredentialId(vaultCredentialId)) {
    return blocked(
      "unsafe_vault_reference",
      "vaultCredentialId must be an opaque local vault reference, not raw credential material.",
    );
  }

  const reference = {
    kind: "encrypted_vault_reference",
    environment: input.environment,
    accountIndex: input.accountIndex,
    apiKeyIndex,
    vaultCredentialId,
  } as const satisfies LighterTradingCredentialVaultReference;
  return {
    ready: true,
    capability: "lighter_transaction_signing",
    reference,
    nonceScope: {
      environment: input.environment,
      accountIndex: input.accountIndex,
      apiKeyIndex,
    },
  };
}

export function requireLighterTradingCredentialReadiness(
  input: LighterTradingCredentialReadinessInput,
): Extract<LighterTradingCredentialReadiness, { ready: true }> {
  const readiness = evaluateLighterTradingCredentialReadiness(input);
  if (readiness.ready) return readiness;
  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter trading credential is not ready: ${readiness.reason}`,
    "Configure a Lighter trading API private key in the encrypted local vault before any approval-gated order create path is enabled.",
  );
}

function blocked(
  code: Extract<LighterTradingCredentialReadiness, { ready: false }>["code"],
  reason: string,
): Extract<LighterTradingCredentialReadiness, { ready: false }> {
  return {
    ready: false,
    capability: "lighter_transaction_signing",
    code,
    reason,
  };
}

function isSafeVaultCredentialId(value: string): boolean {
  if (value.length < 3 || value.length > 160) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (/^(?:0x)?[a-fA-F0-9]{64}$/.test(value)) return false;
  if (/^ro:\d+:(?:single|all):\d+:[a-fA-F0-9]+$/.test(value)) return false;
  return true;
}
