import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";

export type LighterReadOnlyAuthScope = "single" | "all";

export interface LighterReadOnlyAuthTokenMetadata {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly scope: LighterReadOnlyAuthScope;
  readonly expiryUnixSeconds: number;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly expiresSoon: boolean;
}

const READ_ONLY_TOKEN_PREFIX = "ro";
const EXPIRY_SOON_SECONDS = 24 * 60 * 60;

export function parseLighterReadOnlyAuthToken(
  environment: LighterEnvironment,
  token: string,
  nowMs = Date.now(),
): LighterReadOnlyAuthTokenMetadata {
  const trimmed = token.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 5 || parts[0] !== READ_ONLY_TOKEN_PREFIX) {
    throw invalidToken("expected format ro:{account_index}:{single|all}:{expiry_unix}:{random_hex}");
  }

  const accountIndex = readSafeNonNegativeInteger(parts[1], "account_index");
  const scope = readScope(parts[2]);
  const expiryUnixSeconds = readSafeNonNegativeInteger(parts[3], "expiry_unix");
  if (!/^[0-9a-fA-F]+$/.test(parts[4] ?? "")) {
    throw invalidToken("random_hex must be non-empty hexadecimal text");
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const expiresAt = new Date(expiryUnixSeconds * 1000).toISOString();
  return {
    environment,
    accountIndex,
    scope,
    expiryUnixSeconds,
    expiresAt,
    expired: expiryUnixSeconds <= nowSeconds,
    expiresSoon: expiryUnixSeconds > nowSeconds && expiryUnixSeconds - nowSeconds <= EXPIRY_SOON_SECONDS,
  };
}

function readScope(value: string | undefined): LighterReadOnlyAuthScope {
  if (value === "single" || value === "all") return value;
  throw invalidToken("scope must be single or all");
}

function readSafeNonNegativeInteger(value: string | undefined, field: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw invalidToken(`${field} must be a non-negative decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidToken(`${field} is outside Vex's safe integer range`);
  }
  return parsed;
}

function invalidToken(detail: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Invalid Lighter read-only auth token metadata: ${detail}.`,
    "Use a Lighter read-only token beginning with ro:. Do not use an API private key or signer credential.",
  );
}
