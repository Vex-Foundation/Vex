import type { LighterIntegratorFees } from "./fee-policy.js";
import { createHash } from "node:crypto";

import {
  buildLighterOrderPreview,
  LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT,
  LIGHTER_ORDER_PREVIEW_FRESHNESS_MS,
  type LighterOrderPreview,
  type LighterOrderPreviewContext,
  type LighterOrderSide,
} from "./order-preview.js";
import {
  assertUnsignedCreateOrderFitsOfficialSigner,
} from "./signer-adapter.js";
import {
  deriveVexAssignedClientOrderIndex,
  LIGHTER_SIGNER_ORDER_TYPE_CODES,
  LIGHTER_SIGNER_TIME_IN_FORCE_CODES,
  type LighterUnsignedCreateOrderRequest,
} from "./signer-order.js";
import type { LighterEnvironment } from "./types.js";
import { ErrorCodes, VexError } from "../../errors.js";

export const LIGHTER_OCO_PROVIDER_VERSION = "lighter-oco-preview-v1";
export const LIGHTER_OCO_GROUPING_TYPE = 2 as const;
export const LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS = 28 as const;

export interface LighterOcoPreviewInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex?: number | null;
  readonly marketId: number;
  readonly side: LighterOrderSide;
  readonly baseAmount: string;
  readonly stopLoss: {
    readonly triggerPrice: string;
    readonly price: string;
  };
  readonly takeProfit: {
    readonly triggerPrice: string;
    readonly price: string;
  };
  readonly orderExpiry: number;
  readonly clientOrderIndexPolicy?: string;
  readonly nowMs?: number;
  readonly integratorFees?: LighterIntegratorFees | null;
}

export interface LighterOcoPreviewIdentity {
  readonly kind: "lighter_oco";
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly marketIndex: string;
  readonly side: LighterOrderSide;
  readonly baseAmountInteger: string;
  readonly stopLossMatchHash: string;
  readonly takeProfitMatchHash: string;
  readonly expiryMs: string;
  readonly groupingType: "one-cancels-the-other";
  readonly providerVersion: string;
}

export interface LighterOcoPreview {
  readonly previewId: string;
  readonly matchHash: string;
  readonly identity: LighterOcoPreviewIdentity;
  readonly expiresAt: string;
  readonly stopLoss: LighterOrderPreview;
  readonly takeProfit: LighterOrderPreview;
  readonly preview: {
    readonly integratorFees?: LighterIntegratorFees | null;
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
    readonly apiKeyIndex: number | null;
    readonly marketIndex: number;
    readonly symbol: string;
    readonly marketType: "perp";
    readonly side: LighterOrderSide;
    readonly baseAmount: LighterOrderPreview["preview"]["baseAmount"];
    readonly orderExpiry: number;
    readonly stopLoss: {
      readonly triggerPrice: LighterOrderPreview["preview"]["triggerPrice"];
      readonly executionBound: LighterOrderPreview["preview"]["price"];
    };
    readonly takeProfit: {
      readonly triggerPrice: LighterOrderPreview["preview"]["triggerPrice"];
      readonly executionBound: LighterOrderPreview["preview"]["price"];
    };
    readonly positionContext: LighterOrderPreview["preview"]["positionContext"];
    readonly riskNotes: readonly string[];
  };
}

export function buildLighterOcoPreview(
  input: LighterOcoPreviewInput,
  context: LighterOrderPreviewContext,
): LighterOcoPreview {
  const nowMs = input.nowMs ?? Date.now();
  if (context.market.market_type !== "perp") {
    throw invalidRequest("Lighter OCO protection is supported only for perpetual positions.");
  }
  const common = {
    integratorFees: input.integratorFees ?? null,
    sessionId: input.sessionId,
    environment: input.environment,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex ?? null,
    marketId: input.marketId,
    side: input.side,
    baseAmount: input.baseAmount,
    timeInForce: "immediate-or-cancel" as const,
    reduceOnly: true,
    orderExpiry: input.orderExpiry,
    clientOrderIndexPolicy:
      input.clientOrderIndexPolicy ?? LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT,
    nowMs,
  };
  const stopLoss = buildLighterOrderPreview({
    ...common,
    price: input.stopLoss.price,
    triggerPrice: input.stopLoss.triggerPrice,
    orderType: "stop-loss",
  }, context);
  const takeProfit = buildLighterOrderPreview({
    ...common,
    price: input.takeProfit.price,
    triggerPrice: input.takeProfit.triggerPrice,
    orderType: "take-profit",
  }, context);

  if (
    stopLoss.preview.baseAmount.integer !== takeProfit.preview.baseAmount.integer
    || stopLoss.preview.side !== takeProfit.preview.side
    || stopLoss.preview.marketIndex !== takeProfit.preview.marketIndex
    || stopLoss.preview.positionContext.positionSide !== takeProfit.preview.positionContext.positionSide
  ) {
    throw invalidRequest("Lighter OCO legs do not resolve to one exact position identity.");
  }
  if (stopLoss.matchHash === takeProfit.matchHash) {
    throw invalidRequest("Lighter OCO legs must have distinct order identities.");
  }

  const identity: LighterOcoPreviewIdentity = {
    kind: "lighter_oco",
    sessionId: input.sessionId,
    environment: input.environment,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex === undefined || input.apiKeyIndex === null
      ? ""
      : String(input.apiKeyIndex),
    marketIndex: String(input.marketId),
    side: input.side,
    baseAmountInteger: stopLoss.preview.baseAmount.integer,
    stopLossMatchHash: stopLoss.matchHash,
    takeProfitMatchHash: takeProfit.matchHash,
    expiryMs: String(input.orderExpiry),
    groupingType: "one-cancels-the-other",
    providerVersion: LIGHTER_OCO_PROVIDER_VERSION,
  };
  const matchHash = computeLighterOcoHash(identity);
  return {
    previewId: `loc_${matchHash.slice(0, 24)}`,
    matchHash,
    identity,
    expiresAt: new Date(nowMs + LIGHTER_ORDER_PREVIEW_FRESHNESS_MS).toISOString(),
    stopLoss,
    takeProfit,
    preview: {
      integratorFees: input.integratorFees ?? null,
      environment: input.environment,
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex ?? null,
      marketIndex: input.marketId,
      symbol: context.market.symbol,
      marketType: "perp",
      side: input.side,
      baseAmount: stopLoss.preview.baseAmount,
      orderExpiry: input.orderExpiry,
      stopLoss: {
        triggerPrice: stopLoss.preview.triggerPrice,
        executionBound: stopLoss.preview.price,
      },
      takeProfit: {
        triggerPrice: takeProfit.preview.triggerPrice,
        executionBound: takeProfit.preview.price,
      },
      positionContext: stopLoss.preview.positionContext,
      riskNotes: [
        "Preview only. No grouped order was signed or submitted.",
        "Both reduce-only legs are submitted through Lighter's native one-cancels-the-other transaction; Vex never emulates the cancellation link.",
        "API acceptance is not final protection. Both exact child orders must be proven from authenticated Lighter account evidence.",
      ],
    },
  };
}

export function computeLighterOcoHash(identity: LighterOcoPreviewIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([
      identity.kind,
      identity.sessionId,
      identity.environment,
      identity.accountIndex,
      identity.apiKeyIndex,
      identity.marketIndex,
      identity.side,
      identity.baseAmountInteger,
      identity.stopLossMatchHash,
      identity.takeProfitMatchHash,
      identity.expiryMs,
      identity.groupingType,
      identity.providerVersion,
    ]))
    .digest("hex");
}

export interface LighterOcoSignerPlan {
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly matchHash: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly side: LighterOrderSide;
  readonly baseAmountInteger: string;
  readonly orderExpiryMs: number;
  readonly stopLoss: {
    readonly matchHash: string;
    readonly priceInteger: string;
    readonly triggerPriceInteger: string;
  };
  readonly takeProfit: {
    readonly matchHash: string;
    readonly priceInteger: string;
    readonly triggerPriceInteger: string;
  };
}

export interface LighterUnsignedOcoRequest {
  readonly integratorFees?: LighterIntegratorFees | null;
  readonly kind: "lighter_unsigned_oco";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly groupingTypeCode: typeof LIGHTER_OCO_GROUPING_TYPE;
  readonly orders: readonly [LighterUnsignedCreateOrderRequest, LighterUnsignedCreateOrderRequest];
  readonly matchHash: string;
}

export function buildLighterUnsignedOcoRequest(
  plan: LighterOcoSignerPlan,
): LighterUnsignedOcoRequest {
  if (!/^[0-9a-f]{64}$/.test(plan.matchHash)) {
    throw invalidRequest("Lighter OCO match hash is invalid.");
  }
  const stopLoss = buildOcoLeg(plan, "stop-loss");
  const takeProfit = buildOcoLeg(plan, "take-profit");
  assertUnsignedCreateOrderFitsOfficialSigner(stopLoss);
  assertUnsignedCreateOrderFitsOfficialSigner(takeProfit);
  if (stopLoss.clientOrderIndex === takeProfit.clientOrderIndex) {
    throw invalidRequest("Lighter OCO child client-order indexes must be distinct.");
  }
  return {
    kind: "lighter_unsigned_oco",
    ...(plan.integratorFees == null ? {} : { integratorFees: plan.integratorFees ?? null }),
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    groupingTypeCode: LIGHTER_OCO_GROUPING_TYPE,
    orders: [stopLoss, takeProfit],
    matchHash: plan.matchHash,
  };
}

function buildOcoLeg(
  plan: LighterOcoSignerPlan,
  kind: "stop-loss" | "take-profit",
): LighterUnsignedCreateOrderRequest {
  const leg = plan[kind === "stop-loss" ? "stopLoss" : "takeProfit"];
  const clientHash = createHash("sha256")
    .update(`${plan.matchHash}:${kind}:${leg.matchHash}`)
    .digest("hex");
  return {
    kind: "lighter_unsigned_create_order",
    ...(plan.integratorFees == null ? {} : { integratorFees: plan.integratorFees ?? null }),
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    marketIndex: plan.marketIndex,
    clientOrderIndex: deriveVexAssignedClientOrderIndex(clientHash),
    baseAmountInteger: plan.baseAmountInteger,
    priceInteger: leg.priceInteger,
    isAsk: plan.side === "sell",
    orderTypeCode: LIGHTER_SIGNER_ORDER_TYPE_CODES[kind],
    timeInForceCode: LIGHTER_SIGNER_TIME_IN_FORCE_CODES["immediate-or-cancel"],
    reduceOnly: true,
    triggerPriceInteger: leg.triggerPriceInteger,
    orderExpiryMs: plan.orderExpiryMs,
    matchHash: leg.matchHash,
  };
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Run a fresh Lighter OCO preview and approval before trying again.",
  );
}
