import { lighterIntegratorFeesEqual } from "./fee-policy.js";
import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS,
  type LighterUnsignedOcoRequest,
} from "./oco-order.js";
import {
  LIGHTER_SIGNER_CHAIN_IDS,
  LIGHTER_SIGNER_UINT48_MAX,
  assertUnsignedCreateOrderFitsOfficialSigner,
} from "./signer-adapter.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";

export interface LighterCreateGroupedOrdersSigningInput {
  readonly kind: "lighter_create_grouped_orders_signing_input";
  readonly environment: LighterUnsignedOcoRequest["environment"];
  readonly restBaseUrl: string;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly group: LighterUnsignedOcoRequest;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterCreateGroupedOrdersSignerResult {
  readonly kind: "lighter_create_grouped_orders_signer_result";
  readonly environment: LighterUnsignedOcoRequest["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly clientOrderIndexes: readonly [string, string];
  readonly matchHash: string;
  readonly txType: typeof LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS;
  readonly txInfo: string;
  readonly txHash: string;
}

export interface LighterGroupedOrderSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signCreateGroupedOrders: (
    input: LighterCreateGroupedOrdersSigningInput,
  ) => Promise<LighterCreateGroupedOrdersSignerResult>;
}

export function buildLighterCreateGroupedOrdersSigningInput(input: {
  readonly group: LighterUnsignedOcoRequest;
  readonly secret: LighterTradingSecretMaterial;
  readonly nonce: string;
  readonly restBaseUrl: string;
}): LighterCreateGroupedOrdersSigningInput {
  assertGroup(input.group);
  requireNonce(input.nonce);
  return {
    kind: "lighter_create_grouped_orders_signing_input",
    environment: input.group.environment,
    restBaseUrl: input.restBaseUrl,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[input.group.environment],
    accountIndex: input.group.accountIndex,
    apiKeyIndex: input.group.apiKeyIndex,
    nonce: input.nonce,
    group: input.group,
    secret: input.secret,
  };
}

export async function signLighterCreateGroupedOrdersWithAdapter(
  input: LighterCreateGroupedOrdersSigningInput,
  adapter: LighterGroupedOrderSignerAdapter,
): Promise<LighterCreateGroupedOrdersSignerResult> {
  assertGroup(input.group);
  requireNonce(input.nonce);
  if (adapter.source !== "official_lighter_signer") {
    throw invalidSigner("Lighter grouped orders require the official Lighter signer adapter.");
  }
  const result = await adapter.signCreateGroupedOrders(input);
  const indexes = input.group.orders.map((order) => order.clientOrderIndex) as [string, string];
  if (
    result.environment !== input.environment
    || result.accountIndex !== input.accountIndex
    || result.apiKeyIndex !== input.apiKeyIndex
    || result.nonce !== input.nonce
    || result.matchHash !== input.group.matchHash
    || result.clientOrderIndexes[0] !== indexes[0]
    || result.clientOrderIndexes[1] !== indexes[1]
    || result.txType !== LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS
    || result.txInfo.trim().length === 0
    || result.txHash.trim().length === 0
  ) {
    throw invalidSigner("Lighter grouped-order signer result does not match the approved OCO group.");
  }
  return result;
}

function assertGroup(group: LighterUnsignedOcoRequest): void {
  if (group.groupingTypeCode !== 2 || group.orders.length !== 2) {
    throw invalidRequest("Lighter OCO signing requires exactly two orders with grouping type 2.");
  }
  const [stopLoss, takeProfit] = group.orders;
  assertUnsignedCreateOrderFitsOfficialSigner(stopLoss);
  assertUnsignedCreateOrderFitsOfficialSigner(takeProfit);
  if (
    !lighterIntegratorFeesEqual(group.integratorFees, stopLoss.integratorFees)
    || !lighterIntegratorFeesEqual(group.integratorFees, takeProfit.integratorFees)
    || stopLoss.orderTypeCode !== 2
    || takeProfit.orderTypeCode !== 4
    || stopLoss.marketIndex !== takeProfit.marketIndex
    || stopLoss.baseAmountInteger !== takeProfit.baseAmountInteger
    || stopLoss.isAsk !== takeProfit.isAsk
    || !stopLoss.reduceOnly
    || !takeProfit.reduceOnly
    || stopLoss.orderExpiryMs !== takeProfit.orderExpiryMs
    || stopLoss.clientOrderIndex === takeProfit.clientOrderIndex
  ) {
    throw invalidRequest("Lighter OCO child orders violate the native grouped-order contract.");
  }
}

function requireNonce(value: string): void {
  if (!/^[0-9]+$/.test(value) || BigInt(value) > LIGHTER_SIGNER_UINT48_MAX) {
    throw invalidRequest("Lighter grouped-order nonce is outside the uint48 wire range.");
  }
}

function invalidRequest(message: string): VexError {
  return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message, "Prepare the OCO protection again.");
}

function invalidSigner(message: string): VexError {
  return new VexError(ErrorCodes.SIGNER_MISMATCH, message, "Do not submit this grouped order.");
}
