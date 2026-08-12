import { ErrorCodes, VexError } from "../../errors.js";
import { LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT } from "./order-preview.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

export const LIGHTER_SIGNER_ORDER_TYPE_CODES = {
  limit: 0,
  market: 1,
} as const;

export const LIGHTER_SIGNER_TIME_IN_FORCE_CODES = {
  "immediate-or-cancel": 0,
  "good-till-time": 1,
  "post-only": 2,
} as const;

export interface LighterUnsignedCreateOrderRequest {
  readonly kind: "lighter_unsigned_create_order";
  readonly environment: LighterOrderReadyForSignerPlan["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly clientOrderIndex: string;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly isAsk: boolean;
  readonly orderTypeCode: 0 | 1;
  readonly timeInForceCode: 0 | 1 | 2;
  readonly reduceOnly: boolean;
  readonly triggerPriceInteger: string;
  readonly orderExpiryMs: number;
  readonly matchHash: string;
}

export function buildLighterUnsignedCreateOrderRequest(
  plan: LighterOrderReadyForSignerPlan,
): LighterUnsignedCreateOrderRequest {
  if (plan.triggerPriceInteger !== null) {
    throw invalidRequest("Trigger-price Lighter create-order signing is not enabled in this wave.");
  }
  if (plan.clientOrderIndexPolicy !== LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT) {
    throw invalidRequest("Unsupported Lighter client-order-index policy for signing.");
  }

  return {
    kind: "lighter_unsigned_create_order",
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    marketIndex: plan.marketIndex,
    clientOrderIndex: deriveVexAssignedClientOrderIndex(plan.matchHash),
    baseAmountInteger: plan.baseAmountInteger,
    priceInteger: plan.priceInteger,
    isAsk: plan.side === "sell",
    orderTypeCode: LIGHTER_SIGNER_ORDER_TYPE_CODES[plan.orderType],
    timeInForceCode: LIGHTER_SIGNER_TIME_IN_FORCE_CODES[plan.timeInForce],
    reduceOnly: plan.reduceOnly,
    triggerPriceInteger: "0",
    orderExpiryMs: plan.orderExpiryMs,
    matchHash: plan.matchHash,
  };
}

export function deriveVexAssignedClientOrderIndex(matchHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(matchHash)) {
    throw invalidRequest("Lighter matchHash must be a 64-character lowercase hex string.");
  }
  const value = BigInt(`0x${matchHash.slice(0, 12)}`);
  return (value === 0n ? 1n : value).toString();
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Run a fresh Lighter order preview and approval preparation before trying again.",
  );
}
