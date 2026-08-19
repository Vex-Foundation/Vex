import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";
import {
  LIGHTER_CORE_WITHDRAW_TX_TYPE,
} from "./withdrawal/core-preflight.js";
import { getLighterSecureWithdrawalProfile } from "./withdrawal/profiles.js";
import { getLighterFundingDeployment } from "./wallet-funding/deployments.js";

const UINT48_MAX = (1n << 48n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const MIN_EXPIRY_LEAD_MS = 15_000;
const MAX_EXPIRY_LEAD_MS = 5 * 60_000;

export interface LighterWithdrawalSigningInput {
  readonly kind: "lighter_core_withdrawal_signing_input" | "lighter_rhc_withdrawal_signing_input";
  readonly environment: LighterEnvironment;
  readonly restBaseUrl: string;
  readonly chainId: 304 | 466324;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly assetIndex: 3;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly matchHash: string;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterWithdrawalSignerResult {
  readonly kind: "lighter_core_withdrawal_signer_result" | "lighter_rhc_withdrawal_signer_result";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly assetIndex: 3;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly matchHash: string;
  readonly txType: 13;
  /** Secret-bearing signed payload. Implementations must return it non-enumerably. */
  readonly txInfo: string;
  readonly txHash: string;
}

export interface LighterWithdrawalSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signWithdraw: (
    input: LighterWithdrawalSigningInput,
  ) => Promise<LighterWithdrawalSignerResult>;
}

export type LighterCoreWithdrawalSigningInput = LighterWithdrawalSigningInput & {
  readonly kind: "lighter_core_withdrawal_signing_input";
  readonly environment: "core";
  readonly chainId: 304;
};
export type LighterCoreWithdrawalSignerResult = LighterWithdrawalSignerResult & {
  readonly kind: "lighter_core_withdrawal_signer_result";
  readonly environment: "core";
};
export interface LighterCoreWithdrawalSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signWithdraw: (input: LighterCoreWithdrawalSigningInput) => Promise<LighterCoreWithdrawalSignerResult>;
}

export function buildLighterCoreWithdrawalSigningInput(input: {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly amountUnits: string;
  readonly matchHash: string;
  readonly secret: LighterTradingSecretMaterial;
  readonly nowMs?: number;
}): LighterCoreWithdrawalSigningInput {
  return buildLighterWithdrawalSigningInput({ environment: "core", ...input }) as LighterCoreWithdrawalSigningInput;
}

export function buildLighterWithdrawalSigningInput(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly amountUnits: string;
  readonly matchHash: string;
  readonly secret: LighterTradingSecretMaterial;
  readonly nowMs?: number;
}): LighterWithdrawalSigningInput {
  requireSafeIndex(input.accountIndex, "accountIndex");
  requireTradingKeyIndex(input.apiKeyIndex);
  const nonce = requireDecimal(input.nonce, UINT48_MAX, true, "nonce");
  const amountUnits = requireDecimal(input.amountUnits, UINT64_MAX, false, "amountUnits");
  if (!/^[0-9a-f]{64}$/.test(input.matchHash)) throw invalid("matchHash is invalid.");
  const expiredAt = requireDecimal(input.expiredAt, BigInt(Number.MAX_SAFE_INTEGER), false, "expiredAt");
  const nowMs = input.nowMs ?? Date.now();
  const expiryMs = Number(expiredAt);
  if (
    !Number.isSafeInteger(nowMs)
    || expiryMs < nowMs + MIN_EXPIRY_LEAD_MS
    || expiryMs > nowMs + MAX_EXPIRY_LEAD_MS
  ) {
    throw invalid(`${withdrawalLabel(input.environment)} signer expiry must be 15 seconds to 5 minutes in the future.`);
  }
  const deployment = getLighterFundingDeployment(input.environment);
  const profile = getLighterSecureWithdrawalProfile(input.environment);
  return {
    kind: input.environment === "core"
      ? "lighter_core_withdrawal_signing_input"
      : "lighter_rhc_withdrawal_signing_input",
    environment: input.environment,
    restBaseUrl: deployment.restBaseUrl,
    chainId: profile.signingChainId,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    nonce,
    expiredAt,
    assetIndex: profile.assetIndex,
    routeType: profile.routeType,
    amountUnits,
    matchHash: input.matchHash,
    secret: input.secret,
  };
}

export async function signLighterCoreWithdrawalWithAdapter(
  input: LighterCoreWithdrawalSigningInput,
  adapter: LighterCoreWithdrawalSignerAdapter,
): Promise<LighterCoreWithdrawalSignerResult> {
  return signLighterWithdrawalWithAdapter(input, adapter as unknown as LighterWithdrawalSignerAdapter) as Promise<LighterCoreWithdrawalSignerResult>;
}

export async function signLighterWithdrawalWithAdapter(
  input: LighterWithdrawalSigningInput,
  adapter: LighterWithdrawalSignerAdapter,
): Promise<LighterWithdrawalSignerResult> {
  if (adapter.source !== "official_lighter_signer") {
    throw invalid(`${withdrawalLabel(input.environment)} signing requires the official Lighter signer.`);
  }
  const result = await adapter.signWithdraw(input);
  const expectedKind = input.environment === "core"
    ? "lighter_core_withdrawal_signer_result"
    : "lighter_rhc_withdrawal_signer_result";
  if (
    result.kind !== expectedKind
    || result.environment !== input.environment
    || result.accountIndex !== input.accountIndex
    || result.apiKeyIndex !== input.apiKeyIndex
    || result.nonce !== input.nonce
    || result.expiredAt !== input.expiredAt
    || result.assetIndex !== input.assetIndex
    || result.routeType !== input.routeType
    || result.amountUnits !== input.amountUnits
    || result.matchHash !== input.matchHash
    || result.txType !== LIGHTER_CORE_WITHDRAW_TX_TYPE
  ) {
    throw invalid(`${withdrawalLabel(input.environment)} signer result does not match the approved intent.`);
  }
  if (result.txInfo.trim().length === 0 || result.txHash.trim().length === 0) {
    throw invalid(`${withdrawalLabel(input.environment)} signer returned incomplete transaction identity.`);
  }
  if (Object.prototype.propertyIsEnumerable.call(result, "txInfo")) {
    throw invalid(`${withdrawalLabel(input.environment)} signed payload crossed an enumerable result boundary.`);
  }
  return result;
}

function requireSafeIndex(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} is invalid.`);
}

function requireTradingKeyIndex(value: number): void {
  if (!Number.isInteger(value) || value < 4 || value > 254) {
    throw invalid("apiKeyIndex must be a managed trading-key slot from 4 to 254.");
  }
}

function requireDecimal(
  value: string,
  max: bigint,
  allowZero: boolean,
  field: string,
): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw invalid(`${field} must be a decimal integer.`);
  const parsed = BigInt(trimmed);
  if (parsed > max || (!allowZero && parsed === 0n)) throw invalid(`${field} is outside the signer range.`);
  return parsed.toString(10);
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No withdrawal was submitted. Re-run live preflight and approve a fresh exact environment-scoped intent.",
  );
}

function withdrawalLabel(environment: LighterEnvironment): string {
  return environment === "core" ? "Core withdrawal" : "RHC withdrawal";
}
