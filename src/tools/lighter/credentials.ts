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
      `Add ${envKey} to the encrypted local secret vault. Do not use a Lighter API private key.`,
    );
  }
  const metadata = parseLighterReadOnlyAuthToken(environment, token, nowMs);
  if (metadata.expired) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Expired Lighter read-only auth token for ${environment}.`,
      `Replace ${envKey} with a current Lighter read-only token. Do not use a Lighter API private key.`,
    );
  }
  return token;
}
