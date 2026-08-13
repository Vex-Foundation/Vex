import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import {
  parseLighterReadOnlyAuthToken,
  type LighterReadOnlyAuthTokenMetadata,
} from "./auth-token.js";

export const LIGHTER_READ_ONLY_AUTH_TOKEN_ENV_KEYS = {
  core: "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
  rhc: "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
} as const satisfies Record<LighterEnvironment, string>;

export interface LighterReadOnlyCredentialStatus {
  readonly environment: LighterEnvironment;
  readonly envKey: (typeof LIGHTER_READ_ONLY_AUTH_TOKEN_ENV_KEYS)[LighterEnvironment];
  readonly configured: boolean;
  readonly capability: "read_only_account_data";
  readonly metadata: LighterReadOnlyAuthTokenMetadata | null;
}

export interface LighterReadOnlyAccountAuthorization {
  readonly token: string;
  readonly metadata: LighterReadOnlyAuthTokenMetadata;
  readonly accountIndex: number;
  readonly accountIndexSource: "credential" | "caller";
}

export function lighterReadOnlyAuthTokenEnvKey(
  environment: LighterEnvironment,
): (typeof LIGHTER_READ_ONLY_AUTH_TOKEN_ENV_KEYS)[LighterEnvironment] {
  return LIGHTER_READ_ONLY_AUTH_TOKEN_ENV_KEYS[environment];
}

export function getLighterReadOnlyCredentialStatus(
  environment: LighterEnvironment,
  nowMs = Date.now(),
): LighterReadOnlyCredentialStatus {
  const envKey = lighterReadOnlyAuthTokenEnvKey(environment);
  const token = process.env[envKey]?.trim();
  if (!token) {
    return {
      environment,
      envKey,
      configured: false,
      capability: "read_only_account_data",
      metadata: null,
    };
  }
  return {
    environment,
    envKey,
    configured: true,
    capability: "read_only_account_data",
    metadata: parseLighterReadOnlyAuthToken(environment, token, nowMs),
  };
}

export function requireLighterReadOnlyAuthToken(
  environment: LighterEnvironment,
  nowMs = Date.now(),
): string {
  const envKey = lighterReadOnlyAuthTokenEnvKey(environment);
  const token = process.env[envKey]?.trim();
  if (!token) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Missing Lighter read-only auth token for ${environment}.`,
      `Open Settings > API keys and save ${envKey} in the encrypted local vault. Do not use a Lighter API private key.`,
    );
  }
  const metadata = parseLighterReadOnlyAuthToken(environment, token, nowMs);
  if (metadata.expired) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Expired Lighter read-only auth token for ${environment}.`,
      `Open Settings > API keys and replace ${envKey} with a current Lighter read-only token. Do not use a Lighter API private key.`,
    );
  }
  return token;
}

export function authorizeLighterReadOnlyAuthTokenForAccount(
  environment: LighterEnvironment,
  token: string,
  requestedAccountIndex?: number,
  nowMs = Date.now(),
): LighterReadOnlyAccountAuthorization {
  const metadata = parseLighterReadOnlyAuthToken(environment, token, nowMs);
  if (metadata.expired) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Expired Lighter read-only auth token for ${environment}.`,
      `Open Settings > API keys and replace ${lighterReadOnlyAuthTokenEnvKey(environment)} with a current Lighter read-only token. Do not use a Lighter API private key.`,
    );
  }

  const accountIndex = requestedAccountIndex ?? metadata.accountIndex;
  if (metadata.scope === "single" && accountIndex !== metadata.accountIndex) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Lighter read-only auth token for ${environment} is scoped to account ${metadata.accountIndex}, not account ${accountIndex}.`,
      "Use the account index embedded in the read-only token, or generate an all-subaccount read-only token.",
    );
  }

  return {
    token,
    metadata,
    accountIndex,
    accountIndexSource: requestedAccountIndex === undefined ? "credential" : "caller",
  };
}

export function requireLighterReadOnlyAuthForAccount(
  environment: LighterEnvironment,
  requestedAccountIndex?: number,
  nowMs = Date.now(),
): LighterReadOnlyAccountAuthorization {
  const token = requireLighterReadOnlyAuthToken(environment, nowMs);
  return authorizeLighterReadOnlyAuthTokenForAccount(environment, token, requestedAccountIndex, nowMs);
}
