import { readLighterOrderFeeTerms } from "./order-fee-terms.js";
import type { LighterIntegratorFees } from "./fee-policy.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { assertLighterPhaseOneOrderPolicy } from "./order-policy.js";
import { LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT } from "./order-preview.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

export const LIGHTER_SIGNER_ORDER_TYPE_CODES = {
  limit: 0,
  market: 1,
  "stop-loss": 2,
  "stop-loss-limit": 3,
  "take-profit": 4,
  "take-profit-limit": 5,
} as const;

export const LIGHTER_SIGNER_TIME_IN_FORCE_CODES = {
  "immediate-or-cancel": 0,
  "good-till-time": 1,
  "post-only": 2,
} as const;

export interface LighterUnsignedCreateOrderRequest {
  readonly kind: "lighter_unsigned_create_order";
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly environment: LighterOrderReadyForSignerPlan["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly clientOrderIndex: string;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly isAsk: boolean;
  readonly orderTypeCode: 0 | 1 | 2 | 3 | 4 | 5;
  readonly timeInForceCode: 0 | 1 | 2;
  readonly reduceOnly: boolean;
  readonly triggerPriceInteger: string;
  readonly orderExpiryMs: number;
  readonly matchHash: string;
}

export function buildLighterUnsignedCreateOrderRequest(
  plan: LighterOrderReadyForSignerPlan,
): LighterUnsignedCreateOrderRequest {
  assertLighterPhaseOneOrderPolicy(plan.orderType, plan.timeInForce);
  const protective = plan.orderType === "stop-loss"
    || plan.orderType === "stop-loss-limit"
    || plan.orderType === "take-profit"
    || plan.orderType === "take-profit-limit";
  if (protective !== (plan.triggerPriceInteger !== null)) {
    throw invalidRequest(
      protective
        ? "Protective Lighter create-order signing requires an approved trigger price."
        : "Trigger-price input is accepted only for protective Lighter create orders.",
    );
  }
  if (plan.clientOrderIndexPolicy !== LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT) {
    throw invalidRequest("Unsupported Lighter client-order-index policy for signing.");
  }

  const timeInForceCode = LIGHTER_SIGNER_TIME_IN_FORCE_CODES[plan.timeInForce];
  // Lighter requires OrderExpiry to be the nil value (0) exactly for
  // immediate-or-cancel orders (all market orders and IOC limits) and a positive
  // timestamp for good-till-time / post-only. Sending a positive expiry on an IOC
  // order fails the official signer with ErrOrderExpiryInvalid. The plan/intent
  // keep the original expiry for approval binding; only the signed order is nilled.
  const orderExpiryMs =
    !protective
    && timeInForceCode === LIGHTER_SIGNER_TIME_IN_FORCE_CODES["immediate-or-cancel"]
      ? 0
      : plan.orderExpiryMs;

  return {
    kind: "lighter_unsigned_create_order",
    ...(plan.integratorFees == null ? {} : { integratorFees: readLighterOrderFeeTerms(plan.integratorFees) }),
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    marketIndex: plan.marketIndex,
    clientOrderIndex: deriveVexAssignedClientOrderIndex(plan.matchHash),
    baseAmountInteger: plan.baseAmountInteger,
    priceInteger: plan.priceInteger,
    isAsk: plan.side === "sell",
    orderTypeCode: LIGHTER_SIGNER_ORDER_TYPE_CODES[plan.orderType],
    timeInForceCode,
    reduceOnly: plan.reduceOnly,
    triggerPriceInteger: plan.triggerPriceInteger ?? "0",
    orderExpiryMs,
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
