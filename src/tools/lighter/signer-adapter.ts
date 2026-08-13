import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "./constants.js";
import type { LighterUnsignedCreateOrderRequest } from "./signer-order.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";

export const LIGHTER_SIGNER_CHAIN_IDS: Record<LighterEnvironment, number> = {
  core: 304,
  rhc: 466324,
} as const;

export const LIGHTER_SIGNER_UINT32_MAX = (1n << 32n) - 1n;
export const LIGHTER_SIGNER_INT64_MAX = (1n << 63n) - 1n;
export const LIGHTER_SIGNER_UINT48_MAX = (1n << 48n) - 1n;

export interface LighterCreateOrderSigningInput {
  readonly kind: "lighter_create_order_signing_input";
  readonly environment: LighterEnvironment;
  readonly restBaseUrl: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly order: LighterUnsignedCreateOrderRequest;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly createAccountAuth: (
    input: LighterAccountAuthSigningInput,
  ) => Promise<LighterAccountAuthSignerResult>;
  readonly signCreateOrder: (
    input: LighterCreateOrderSigningInput,
  ) => Promise<LighterCreateOrderSignerResult>;
}

export interface LighterAccountAuthSigningInput {
  readonly kind: "lighter_account_auth_signing_input";
  readonly environment: LighterEnvironment;
  readonly restBaseUrl: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly deadlineUnixSeconds: number;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterAccountAuthSignerResult {
  readonly kind: "lighter_account_auth_signer_result";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly deadlineUnixSeconds: number;
  readonly authToken: string;
  readonly publicKey: string;
}

export interface LighterCreateOrderSignerResult {
  readonly kind: "lighter_create_order_signer_result";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly clientOrderIndex: string;
  readonly matchHash: string;
  readonly txType: number;
  readonly txInfo: string;
  readonly txHash: string;
}

export function buildLighterAccountAuthSigningInput(input: {
  readonly order: LighterUnsignedCreateOrderRequest;
  readonly secret: LighterTradingSecretMaterial;
  readonly deadlineUnixSeconds: number;
}): LighterAccountAuthSigningInput {
  assertUnsignedCreateOrderFitsOfficialSigner(input.order);
  if (!Number.isSafeInteger(input.deadlineUnixSeconds) || input.deadlineUnixSeconds <= 0) {
    throw invalidRequest("deadlineUnixSeconds must be a positive safe integer before Lighter auth signing.");
  }
  return {
    kind: "lighter_account_auth_signing_input",
    environment: input.order.environment,
    restBaseUrl: LIGHTER_ENDPOINTS[input.order.environment].restBaseUrl,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[input.order.environment],
    accountIndex: input.order.accountIndex,
    apiKeyIndex: input.order.apiKeyIndex,
    deadlineUnixSeconds: input.deadlineUnixSeconds,
    secret: input.secret,
  };
}

export async function createLighterAccountAuthWithAdapter(
  input: LighterAccountAuthSigningInput,
  adapter: LighterSignerAdapter,
): Promise<LighterAccountAuthSignerResult> {
  if (adapter.source !== "official_lighter_signer") {
    throw invalidSigner("Lighter account authentication requires the official Lighter signer adapter.");
  }
  const result = await adapter.createAccountAuth(input);
  if (
    result.environment !== input.environment
    || result.accountIndex !== input.accountIndex
    || result.apiKeyIndex !== input.apiKeyIndex
    || result.deadlineUnixSeconds !== input.deadlineUnixSeconds
  ) {
    throw invalidSigner("Lighter account-auth result does not match the requested credential scope.");
  }
  if (!/^[a-fA-F0-9]{80}$/.test(result.publicKey)) {
    throw invalidSigner("Lighter account-auth result returned an invalid public key.");
  }
  assertCanonicalAuthToken(result.authToken, input);
  return result;
}

export function buildLighterCreateOrderSigningInput(input: {
  readonly order: LighterUnsignedCreateOrderRequest;
  readonly secret: LighterTradingSecretMaterial;
  readonly nonce: string;
}): LighterCreateOrderSigningInput {
  const { order, secret } = input;
  assertUnsignedCreateOrderFitsOfficialSigner(order);
  const nonce = requireDecimalInteger("nonce", input.nonce, LIGHTER_SIGNER_UINT48_MAX, {
    allowZero: true,
  });

  return {
    kind: "lighter_create_order_signing_input",
    environment: order.environment,
    restBaseUrl: LIGHTER_ENDPOINTS[order.environment].restBaseUrl,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[order.environment],
    accountIndex: order.accountIndex,
    apiKeyIndex: order.apiKeyIndex,
    nonce,
    order,
    secret,
  };
}

export async function signLighterCreateOrderWithAdapter(
  input: LighterCreateOrderSigningInput,
  adapter: LighterSignerAdapter,
): Promise<LighterCreateOrderSignerResult> {
  assertUnsignedCreateOrderFitsOfficialSigner(input.order);
  requireDecimalInteger("nonce", input.nonce, LIGHTER_SIGNER_UINT48_MAX, {
    allowZero: true,
  });
  if (adapter.source !== "official_lighter_signer") {
    throw invalidSigner("Lighter create-order signing requires the official Lighter signer adapter.");
  }

  const result = await adapter.signCreateOrder(input);
  if (
    result.environment !== input.environment
    || result.accountIndex !== input.accountIndex
    || result.apiKeyIndex !== input.apiKeyIndex
    || result.nonce !== input.nonce
    || result.clientOrderIndex !== input.order.clientOrderIndex
    || result.matchHash !== input.order.matchHash
  ) {
    throw invalidSigner("Lighter signer result does not match the prepared order.");
  }
  if (!Number.isInteger(result.txType) || result.txType < 0 || result.txType > 255) {
    throw invalidSigner("Lighter signer result returned an invalid transaction type.");
  }
  if (result.txInfo.trim().length === 0) {
    throw invalidSigner("Lighter signer result did not return transaction info.");
  }
  if (result.txHash.trim().length === 0) {
    throw invalidSigner("Lighter signer result did not return a transaction hash.");
  }
  return result;
}

export function assertUnsignedCreateOrderFitsOfficialSigner(
  order: LighterUnsignedCreateOrderRequest,
): void {
  requireSafeNonNegativeInteger("accountIndex", order.accountIndex);
  requireSafeNonNegativeInteger("apiKeyIndex", order.apiKeyIndex);
  requireSafeNonNegativeInteger("marketIndex", order.marketIndex);
  requireDecimalInteger("clientOrderIndex", order.clientOrderIndex, LIGHTER_SIGNER_UINT48_MAX);
  requireDecimalInteger("baseAmountInteger", order.baseAmountInteger, LIGHTER_SIGNER_UINT48_MAX);
  requireDecimalInteger("priceInteger", order.priceInteger, LIGHTER_SIGNER_UINT32_MAX);
  requireDecimalInteger("triggerPriceInteger", order.triggerPriceInteger, LIGHTER_SIGNER_UINT32_MAX, {
    allowZero: true,
  });
  requireDecimalInteger("orderExpiryMs", String(order.orderExpiryMs), LIGHTER_SIGNER_INT64_MAX);
}

function requireSafeNonNegativeInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest(`${field} must be a safe non-negative integer before Lighter signing.`);
  }
}

function requireDecimalInteger(
  field: string,
  value: string,
  max: bigint,
  options: { readonly allowZero?: boolean } = {},
): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw invalidRequest(`${field} must be a decimal integer before Lighter signing.`);
  }
  const parsed = BigInt(trimmed);
  if (parsed > max || (!options.allowZero && parsed === 0n)) {
    throw invalidRequest(`${field} is outside the official Lighter signer range.`);
  }
  return parsed.toString();
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Run a fresh Lighter order preview and approval preparation before trying again.",
  );
}

function invalidSigner(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Retry after the privileged Lighter signer adapter is configured.",
  );
}

function assertCanonicalAuthToken(
  token: string,
  input: LighterAccountAuthSigningInput,
): void {
  const parts = token.trim().split(":");
  if (
    parts.length !== 4
    || parts[0] !== String(input.deadlineUnixSeconds)
    || parts[1] !== String(input.accountIndex)
    || parts[2] !== String(input.apiKeyIndex)
    || !/^[a-fA-F0-9]+$/.test(parts[3] ?? "")
  ) {
    throw invalidSigner("Lighter account-auth result returned an invalid canonical auth token.");
  }
}
