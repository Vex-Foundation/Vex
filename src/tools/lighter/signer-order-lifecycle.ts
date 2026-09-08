import { readLighterOrderFeeTerms } from "./order-fee-terms.js";
import type { LighterIntegratorFees } from "./fee-policy.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { LIGHTER_ENDPOINTS, type LighterEnvironment } from "./constants.js";
import {
  LIGHTER_SIGNER_CHAIN_IDS,
  LIGHTER_SIGNER_INT64_MAX,
  LIGHTER_SIGNER_UINT32_MAX,
  LIGHTER_SIGNER_UINT48_MAX,
} from "./signer-adapter.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";

export const LIGHTER_TX_TYPE_CANCEL_ORDER = 15;
export const LIGHTER_TX_TYPE_CANCEL_ALL_ORDERS = 16;
export const LIGHTER_TX_TYPE_MODIFY_ORDER = 17;
export const LIGHTER_PROVIDER_ORDER_INDEX_MAX = (1n << 60n) - 1n;

interface LighterOrderLifecycleSigningScope {
  readonly environment: LighterEnvironment;
  readonly restBaseUrl: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterCancelOrderSigningInput extends LighterOrderLifecycleSigningScope {
  readonly kind: "lighter_cancel_order_signing_input";
  readonly marketIndex: number;
  /** Exact provider `order_id`, retained as decimal text across JavaScript boundaries. */
  readonly providerOrderId: string;
}

export interface LighterModifyOrderSigningInput extends LighterOrderLifecycleSigningScope {
  readonly kind: "lighter_modify_order_signing_input";
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly marketIndex: number;
  /** Exact provider `order_id`, retained as decimal text across JavaScript boundaries. */
  readonly providerOrderId: string;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly triggerPriceInteger: string;
}

export interface LighterCancelAllOrdersSigningInput extends LighterOrderLifecycleSigningScope {
  readonly kind: "lighter_cancel_all_orders_signing_input";
  readonly timeInForce: 0;
  readonly cancelAtMs: "0";
}

export interface LighterOrderLifecycleSignerResult {
  readonly kind: "lighter_order_lifecycle_signer_result";
  readonly operation: "cancel_order" | "modify_order" | "cancel_all_orders";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly txType: 15 | 16 | 17;
  readonly txInfo: string;
  readonly txHash: string;
}

export interface LighterOrderLifecycleSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signCancelOrder: (
    input: LighterCancelOrderSigningInput,
  ) => Promise<LighterOrderLifecycleSignerResult>;
  readonly signModifyOrder: (
    input: LighterModifyOrderSigningInput,
  ) => Promise<LighterOrderLifecycleSignerResult>;
  readonly signCancelAllOrders: (
    input: LighterCancelAllOrdersSigningInput,
  ) => Promise<LighterOrderLifecycleSignerResult>;
}

export function buildLighterCancelOrderSigningInput(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly marketIndex: number;
  readonly providerOrderId: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterCancelOrderSigningInput {
  const scope = lifecycleScope(input);
  requireMarketIndex(input.marketIndex);
  requireDecimal("providerOrderId", input.providerOrderId, LIGHTER_PROVIDER_ORDER_INDEX_MAX, false);
  return {
    kind: "lighter_cancel_order_signing_input",
    ...scope,
    marketIndex: input.marketIndex,
    providerOrderId: input.providerOrderId,
  };
}

export function buildLighterModifyOrderSigningInput(input: {
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly marketIndex: number;
  readonly providerOrderId: string;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly triggerPriceInteger?: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterModifyOrderSigningInput {
  const scope = lifecycleScope(input);
  requireMarketIndex(input.marketIndex);
  requireDecimal("providerOrderId", input.providerOrderId, LIGHTER_PROVIDER_ORDER_INDEX_MAX, false);
  requireDecimal("baseAmountInteger", input.baseAmountInteger, LIGHTER_SIGNER_UINT48_MAX, false);
  requireDecimal("priceInteger", input.priceInteger, LIGHTER_SIGNER_UINT32_MAX, false);
  const triggerPriceInteger = input.triggerPriceInteger ?? "0";
  requireDecimal("triggerPriceInteger", triggerPriceInteger, LIGHTER_SIGNER_UINT32_MAX, true);
  return {
    kind: "lighter_modify_order_signing_input",
    ...(input.integratorFees == null ? {} : { integratorFees: readLighterOrderFeeTerms(input.integratorFees) }),
    ...scope,
    marketIndex: input.marketIndex,
    providerOrderId: input.providerOrderId,
    baseAmountInteger: input.baseAmountInteger,
    priceInteger: input.priceInteger,
    triggerPriceInteger,
  };
}

export function buildLighterCancelAllOrdersSigningInput(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterCancelAllOrdersSigningInput {
  return {
    kind: "lighter_cancel_all_orders_signing_input",
    ...lifecycleScope(input),
    timeInForce: 0,
    cancelAtMs: "0",
  };
}

function lifecycleScope(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterOrderLifecycleSigningScope {
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) {
    throw invalid("accountIndex must be a safe non-negative integer.");
  }
  if (!Number.isInteger(input.apiKeyIndex) || input.apiKeyIndex < 4 || input.apiKeyIndex > 254) {
    throw invalid("apiKeyIndex must be a managed trading index from 4 through 254.");
  }
  requireDecimal("nonce", input.nonce, LIGHTER_SIGNER_UINT48_MAX, true);
  requireDecimal("expiredAt", input.expiredAt, LIGHTER_SIGNER_INT64_MAX, false);
  return {
    environment: input.environment,
    restBaseUrl: LIGHTER_ENDPOINTS[input.environment].restBaseUrl,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[input.environment],
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: input.expiredAt,
    secret: input.secret,
  };
}

function requireMarketIndex(value: number): void {
  const isPerps = Number.isInteger(value) && value >= 0 && value <= 254;
  const isSpot = Number.isInteger(value) && value >= 2048 && value <= 4094;
  if (!isPerps && !isSpot) throw invalid("marketIndex is outside Lighter's supported range.");
}

function requireDecimal(
  field: string,
  value: string,
  maximum: bigint,
  allowZero: boolean,
): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw invalid(`${field} must be canonical decimal text.`);
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > maximum) {
    throw invalid(`${field} is outside the official signer range.`);
  }
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Refresh the exact provider order state and prepare the lifecycle action again.",
  );
}
