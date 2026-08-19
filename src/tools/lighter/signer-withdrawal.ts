import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";
import {
  LIGHTER_CORE_WITHDRAW_ASSET_INDEX,
  LIGHTER_CORE_WITHDRAW_ROUTE_TYPE,
  LIGHTER_CORE_WITHDRAW_TX_TYPE,
} from "./withdrawal/core-preflight.js";
import { getLighterFundingDeployment } from "./wallet-funding/deployments.js";

const UINT48_MAX = (1n << 48n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const MIN_EXPIRY_LEAD_MS = 15_000;
const MAX_EXPIRY_LEAD_MS = 5 * 60_000;

export interface LighterCoreWithdrawalSigningInput {
  readonly kind: "lighter_core_withdrawal_signing_input";
  readonly environment: "core";
  readonly restBaseUrl: string;
  readonly chainId: 304;
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

export interface LighterCoreWithdrawalSignerResult {
  readonly kind: "lighter_core_withdrawal_signer_result";
  readonly environment: "core";
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

export interface LighterCoreWithdrawalSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signWithdraw: (
    input: LighterCoreWithdrawalSigningInput,
  ) => Promise<LighterCoreWithdrawalSignerResult>;
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
    throw invalid("Core withdrawal signer expiry must be 15 seconds to 5 minutes in the future.");
  }
  const deployment = getLighterFundingDeployment("core");
  return {
    kind: "lighter_core_withdrawal_signing_input",
    environment: "core",
    restBaseUrl: deployment.restBaseUrl,
    chainId: 304,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    nonce,
    expiredAt,
    assetIndex: LIGHTER_CORE_WITHDRAW_ASSET_INDEX,
    routeType: LIGHTER_CORE_WITHDRAW_ROUTE_TYPE,
    amountUnits,
    matchHash: input.matchHash,
    secret: input.secret,
  };
}

export async function signLighterCoreWithdrawalWithAdapter(
  input: LighterCoreWithdrawalSigningInput,
  adapter: LighterCoreWithdrawalSignerAdapter,
): Promise<LighterCoreWithdrawalSignerResult> {
  if (adapter.source !== "official_lighter_signer") {
    throw invalid("Core withdrawal signing requires the official Lighter signer.");
  }
  const result = await adapter.signWithdraw(input);
  if (
    result.kind !== "lighter_core_withdrawal_signer_result"
    || result.environment !== "core"
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
    throw invalid("Core withdrawal signer result does not match the approved intent.");
  }
  if (result.txInfo.trim().length === 0 || result.txHash.trim().length === 0) {
    throw invalid("Core withdrawal signer returned incomplete transaction identity.");
  }
  if (Object.prototype.propertyIsEnumerable.call(result, "txInfo")) {
    throw invalid("Core withdrawal signed payload crossed an enumerable result boundary.");
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
    "No Core withdrawal was submitted. Re-run live preflight and approve a fresh exact intent.",
  );
}
