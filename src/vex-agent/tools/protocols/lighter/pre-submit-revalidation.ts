import {
  buildLighterOrderPreview,
  LIGHTER_ORDER_PREVIEW_FRESHNESS_MS,
  type LighterOrderPreview,
  type LighterOrderPreviewContext,
} from "@tools/lighter/order-preview.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";

export interface LighterOrderPreSubmitRevalidationEvidence {
  readonly kind: "lighter_order_pre_submit_revalidation";
  readonly previewId: string;
  readonly matchHash: string;
  readonly checkedAt: string;
  readonly marketIndex: number;
  readonly marketStatus: string;
  readonly symbol: string;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly priceComparison: "resting" | "crossing_or_taker";
  readonly positionVerified: boolean;
  readonly positionSide: "long" | "short" | "flat" | "unknown";
  readonly checks: readonly [
    "approved_preview_identity",
    "market_active_and_precision",
    "live_market_minimums",
    "account_and_reduce_only",
    "approved_price_behavior",
  ];
}

export function revalidateApprovedLighterOrder(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly approvedPreview: LighterOrderPreviewRow;
  readonly context: LighterOrderPreviewContext;
  readonly nowMs: number;
}): LighterOrderPreSubmitRevalidationEvidence {
  const { plan, approvedPreview, context, nowMs } = input;
  assertPersistedPreviewMatchesPlan(plan, approvedPreview);
  const stored = readStoredPreview(approvedPreview.previewJson);
  const previewNowMs = Date.parse(approvedPreview.expiresAt) - LIGHTER_ORDER_PREVIEW_FRESHNESS_MS;
  if (!Number.isFinite(previewNowMs)) {
    throw blocked("The approved Lighter preview timestamp is invalid.");
  }

  let fresh: LighterOrderPreview;
  try {
    fresh = buildLighterOrderPreview({
      sessionId: plan.sessionId,
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      marketId: plan.marketIndex,
      side: plan.side,
      baseAmount: stored.baseAmountDisplay,
      price: stored.priceDisplay,
      orderType: plan.orderType,
      timeInForce: plan.timeInForce,
      reduceOnly: plan.reduceOnly,
      triggerPrice: stored.triggerPriceDisplay,
      orderExpiry: plan.orderExpiryMs,
      clientOrderIndexPolicy: plan.clientOrderIndexPolicy,
      nowMs: previewNowMs,
    }, context);
  } catch {
    throw blocked(
      "Live Lighter market or account state no longer satisfies the approved preview.",
    );
  }

  if (
    fresh.previewId !== plan.previewId
    || fresh.matchHash !== plan.matchHash
    || fresh.preview.baseAmount.integer !== plan.baseAmountInteger
    || fresh.preview.price.integer !== plan.priceInteger
    || fresh.preview.triggerPrice.integer !== plan.triggerPriceInteger
  ) {
    throw blocked("Live Lighter market precision changed the approved order identity.");
  }
  if (
    fresh.preview.baseAmount.decimals !== stored.baseAmountDecimals
    || fresh.preview.price.decimals !== stored.priceDecimals
    || fresh.preview.quoteNotional.decimals !== stored.quoteDecimals
  ) {
    throw blocked("Live Lighter market precision changed after approval.");
  }

  const currentBehavior = fresh.preview.marketData.priceComparison;
  if (currentBehavior === "unknown") {
    throw blocked("The live Lighter order book has no usable best-price evidence.");
  }
  assertApprovedPriceBehavior(plan, stored.priceComparison, fresh.preview);

  return {
    kind: "lighter_order_pre_submit_revalidation",
    previewId: plan.previewId,
    matchHash: plan.matchHash,
    checkedAt: new Date(nowMs).toISOString(),
    marketIndex: plan.marketIndex,
    marketStatus: context.market.status,
    symbol: context.market.symbol,
    bestBid: fresh.preview.marketData.bestBid,
    bestAsk: fresh.preview.marketData.bestAsk,
    priceComparison: currentBehavior,
    positionVerified: fresh.preview.positionContext.verified,
    positionSide: fresh.preview.positionContext.positionSide,
    checks: [
      "approved_preview_identity",
      "market_active_and_precision",
      "live_market_minimums",
      "account_and_reduce_only",
      "approved_price_behavior",
    ],
  };
}

function assertPersistedPreviewMatchesPlan(
  plan: LighterOrderReadyForSignerPlan,
  preview: LighterOrderPreviewRow,
): void {
  if (
    preview.previewId !== plan.previewId
    || preview.sessionId !== plan.sessionId
    || preview.matchHash !== plan.matchHash
    || preview.environment !== plan.environment
    || preview.accountIndex !== plan.accountIndex
    || preview.apiKeyIndex !== plan.apiKeyIndex
    || preview.marketIndex !== plan.marketIndex
    || preview.side !== plan.side
    || preview.baseAmountInteger !== plan.baseAmountInteger
    || preview.priceInteger !== plan.priceInteger
    || preview.orderType !== plan.orderType
    || preview.timeInForce !== plan.timeInForce
    || preview.reduceOnly !== plan.reduceOnly
    || preview.triggerPriceInteger !== plan.triggerPriceInteger
    || preview.orderExpiryMs !== plan.orderExpiryMs
    || preview.clientOrderIndexPolicy !== plan.clientOrderIndexPolicy
    || preview.providerVersion !== plan.providerVersion
  ) {
    throw blocked("The persisted Lighter preview no longer matches the approved execution intent.");
  }
}

function assertApprovedPriceBehavior(
  plan: LighterOrderReadyForSignerPlan,
  approvedBehavior: "resting" | "crossing_or_taker" | "unknown",
  fresh: LighterOrderPreview["preview"],
): void {
  const currentBehavior = fresh.marketData.priceComparison;
  if (plan.orderType === "market") {
    const liveOppositePrice = plan.side === "buy"
      ? fresh.marketData.bestAsk
      : fresh.marketData.bestBid;
    if (liveOppositePrice === null) {
      throw blocked("The live Lighter order book has no opposite-side liquidity for the approved market order.");
    }
    const comparison = compareDecimalStrings(liveOppositePrice, fresh.price.display);
    if ((plan.side === "buy" && comparison > 0) || (plan.side === "sell" && comparison < 0)) {
      throw blocked("The live Lighter price moved beyond the approved market-order worst price.");
    }
    return;
  }

  if (plan.timeInForce === "post-only") {
    if (currentBehavior !== "resting") {
      throw blocked("The approved post-only Lighter order would now cross the live book.");
    }
    return;
  }

  if (approvedBehavior === "unknown" || currentBehavior !== approvedBehavior) {
    throw blocked("The approved Lighter limit order changed between resting and taker behavior.");
  }
}

function readStoredPreview(value: Record<string, unknown>): {
  readonly baseAmountDisplay: string;
  readonly baseAmountDecimals: number;
  readonly priceDisplay: string;
  readonly priceDecimals: number;
  readonly triggerPriceDisplay: string | null;
  readonly quoteDecimals: number;
  readonly priceComparison: "resting" | "crossing_or_taker" | "unknown";
} {
  const baseAmount = readRecord(value.baseAmount);
  const price = readRecord(value.price);
  const triggerPrice = readRecord(value.triggerPrice);
  const quoteNotional = readRecord(value.quoteNotional);
  const marketData = readRecord(value.marketData);
  const priceComparison = marketData?.priceComparison;
  if (
    !baseAmount
    || !price
    || !triggerPrice
    || !quoteNotional
    || !marketData
    || typeof baseAmount.display !== "string"
    || !Number.isInteger(baseAmount.decimals)
    || typeof price.display !== "string"
    || !Number.isInteger(price.decimals)
    || !(triggerPrice.display === null || typeof triggerPrice.display === "string")
    || !Number.isInteger(quoteNotional.decimals)
    || (priceComparison !== "resting"
      && priceComparison !== "crossing_or_taker"
      && priceComparison !== "unknown")
  ) {
    throw blocked("The approved Lighter preview evidence is incomplete or invalid.");
  }
  return {
    baseAmountDisplay: baseAmount.display,
    baseAmountDecimals: baseAmount.decimals as number,
    priceDisplay: price.display,
    priceDecimals: price.decimals as number,
    triggerPriceDisplay: triggerPrice.display as string | null,
    quoteDecimals: quoteNotional.decimals as number,
    priceComparison,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compareDecimalStrings(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a === null || b === null) {
    throw blocked("The live Lighter order book returned an invalid price.");
  }
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.integer * (10n ** BigInt(scale - a.scale));
  const rightInteger = b.integer * (10n ** BigInt(scale - b.scale));
  return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
}

function decimalParts(value: string): { readonly integer: bigint; readonly scale: number } | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return {
    integer: BigInt(`${whole}${fraction}`.replace(/^0+(?=\d)/, "")),
    scale: fraction.length,
  };
}

function blocked(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `${reason} No trading key was loaded, no nonce was reserved, and no order was signed or submitted.`,
    "Run a fresh Lighter order preview and approve it only if the updated details are correct.",
  );
}
