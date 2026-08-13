import { createHash } from "node:crypto";

import { ErrorCodes, VexError } from "../../errors.js";
import type {
  LighterAccount,
  LighterAccountResponse,
  LighterEnvironment,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
  LighterSimpleOrder,
} from "./types.js";

export const LIGHTER_ORDER_PREVIEW_PROVIDER_VERSION = "lighter-order-preview-v1";
export const LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT = "vex_assigned_uint48";

export const LIGHTER_ORDER_TYPES = ["limit", "market"] as const;
export const LIGHTER_ORDER_SIDES = ["buy", "sell"] as const;
export const LIGHTER_ORDER_TIME_IN_FORCE = [
  "good-till-time",
  "immediate-or-cancel",
  "post-only",
] as const;

export type LighterOrderType = (typeof LIGHTER_ORDER_TYPES)[number];
export type LighterOrderSide = (typeof LIGHTER_ORDER_SIDES)[number];
export type LighterOrderTimeInForce = (typeof LIGHTER_ORDER_TIME_IN_FORCE)[number];

export interface LighterOrderPreviewInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex?: number | null;
  readonly marketId: number;
  readonly side: LighterOrderSide;
  readonly baseAmount: string;
  readonly price: string;
  readonly orderType: LighterOrderType;
  readonly timeInForce: LighterOrderTimeInForce;
  readonly reduceOnly: boolean;
  readonly triggerPrice?: string | null;
  readonly orderExpiry: number;
  readonly clientOrderIndexPolicy: string;
  readonly nowMs?: number;
}

export interface LighterOrderPreviewContext {
  readonly market: LighterMarketDetail;
  readonly orderBook: LighterOrderBookOrdersResponse;
  readonly account: LighterAccountResponse;
}

export interface LighterOrderPreviewIdentity {
  readonly kind: "lighter_order";
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly marketIndex: string;
  readonly side: LighterOrderSide;
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly orderType: LighterOrderType;
  readonly timeInForce: LighterOrderTimeInForce;
  readonly reduceOnly: "0" | "1";
  readonly triggerPriceInteger: string;
  readonly expiryMs: string;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
}

export interface LighterOrderPreview {
  readonly previewId: string;
  readonly matchHash: string;
  readonly identity: LighterOrderPreviewIdentity;
  readonly expiresAt: string;
  readonly preview: {
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
    readonly apiKeyIndex: number | null;
    readonly marketIndex: number;
    readonly symbol: string;
    readonly marketType: string;
    readonly side: LighterOrderSide;
    readonly orderType: LighterOrderType;
    readonly timeInForce: LighterOrderTimeInForce;
    readonly reduceOnly: boolean;
    readonly baseAmount: {
      readonly display: string;
      readonly integer: string;
      readonly decimals: number;
    };
    readonly price: {
      readonly display: string;
      readonly integer: string;
      readonly decimals: number;
      readonly role: "limit_price" | "worst_acceptable_price";
    };
    readonly triggerPrice: {
      readonly display: string | null;
      readonly integer: string | null;
      readonly decimals: number;
    };
    readonly quoteNotional: {
      readonly integer: string;
      readonly display: string;
      readonly decimals: number;
    };
    readonly minimumChecks: {
      readonly minBaseAmountInteger: string;
      readonly minBaseAmountDisplay: string;
      readonly minQuoteAmountInteger: string;
      readonly minQuoteAmountDisplay: string;
      readonly baseAmountPasses: boolean;
      readonly quoteAmountPasses: boolean;
    };
    readonly marketData: {
      readonly bestBid: string | null;
      readonly bestAsk: string | null;
      readonly referencePrice: string | null;
      readonly priceComparison: "resting" | "crossing_or_taker" | "unknown";
    };
    readonly positionContext: {
      readonly verified: boolean;
      readonly marketPosition: string | null;
      readonly positionSide: "long" | "short" | "flat" | "unknown";
    };
    readonly riskNotes: readonly string[];
  };
}

export const LIGHTER_ORDER_PREVIEW_FRESHNESS_MS = 2 * 60 * 1000;
const MIN_ORDER_EXPIRY_OFFSET_MS = 5 * 60 * 1000;
const MAX_ORDER_EXPIRY_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;

export function buildLighterOrderPreview(
  input: LighterOrderPreviewInput,
  context: LighterOrderPreviewContext,
): LighterOrderPreview {
  const nowMs = input.nowMs ?? Date.now();
  validateInputScalars(input);
  assertMarketMatches(input, context.market);
  assertAccountContainsIndex(input, context.account);
  assertQuoteScale(context.market);
  assertExpiry(input.orderExpiry, nowMs);
  assertOrderCombination(input);

  const baseAmountInteger = decimalToInteger(
    input.baseAmount,
    context.market.supported_size_decimals,
    "baseAmount",
  );
  const priceInteger = decimalToInteger(
    input.price,
    context.market.supported_price_decimals,
    "price",
  );
  const triggerPriceInteger =
    input.triggerPrice === undefined || input.triggerPrice === null
      ? null
      : decimalToInteger(
          input.triggerPrice,
          context.market.supported_price_decimals,
          "triggerPrice",
        );
  const minBaseAmount = decimalToInteger(
    context.market.min_base_amount,
    context.market.supported_size_decimals,
    "market min_base_amount",
    { allowZero: true },
  );
  const minQuoteAmount = decimalToInteger(
    context.market.min_quote_amount,
    context.market.supported_quote_decimals,
    "market min_quote_amount",
    { allowZero: true },
  );
  const quoteNotionalInteger = baseAmountInteger * priceInteger;

  if (baseAmountInteger < minBaseAmount) {
    throw invalidRequest(
      `Lighter order preview refused: baseAmount is below market minimum ${context.market.min_base_amount}.`,
    );
  }
  if (quoteNotionalInteger < minQuoteAmount) {
    throw invalidRequest(
      `Lighter order preview refused: quote notional is below market minimum ${context.market.min_quote_amount}.`,
    );
  }

  const positionContext = readPositionContext(context.account, input.marketId);
  if (input.reduceOnly && !isReduceOnlyVerifiable(input.side, positionContext)) {
    throw invalidRequest(
      "Lighter order preview refused: reduce-only intent cannot be verified against the live account position.",
    );
  }

  const bestBid = bestPrice(context.orderBook.bids, "bid");
  const bestAsk = bestPrice(context.orderBook.asks, "ask");
  const priceComparison = classifyPriceComparison(input.side, input.orderType, input.price, bestBid, bestAsk);

  const identity: LighterOrderPreviewIdentity = {
    kind: "lighter_order",
    sessionId: input.sessionId,
    environment: input.environment,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex === undefined || input.apiKeyIndex === null ? "" : String(input.apiKeyIndex),
    marketIndex: String(input.marketId),
    side: input.side,
    baseAmountInteger: baseAmountInteger.toString(),
    priceInteger: priceInteger.toString(),
    orderType: input.orderType,
    timeInForce: input.timeInForce,
    reduceOnly: input.reduceOnly ? "1" : "0",
    triggerPriceInteger: triggerPriceInteger === null ? "" : triggerPriceInteger.toString(),
    expiryMs: String(input.orderExpiry),
    clientOrderIndexPolicy: input.clientOrderIndexPolicy,
    providerVersion: LIGHTER_ORDER_PREVIEW_PROVIDER_VERSION,
  };
  const matchHash = computeLighterOrderPreviewHash(identity);
  const previewId = `lop_${matchHash.slice(0, 24)}`;

  return {
    previewId,
    matchHash,
    identity,
    expiresAt: new Date(nowMs + LIGHTER_ORDER_PREVIEW_FRESHNESS_MS).toISOString(),
    preview: {
      environment: input.environment,
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex ?? null,
      marketIndex: input.marketId,
      symbol: context.market.symbol,
      marketType: context.market.market_type,
      side: input.side,
      orderType: input.orderType,
      timeInForce: input.timeInForce,
      reduceOnly: input.reduceOnly,
      baseAmount: {
        display: formatInteger(baseAmountInteger, context.market.supported_size_decimals),
        integer: baseAmountInteger.toString(),
        decimals: context.market.supported_size_decimals,
      },
      price: {
        display: formatInteger(priceInteger, context.market.supported_price_decimals),
        integer: priceInteger.toString(),
        decimals: context.market.supported_price_decimals,
        role: input.orderType === "market" ? "worst_acceptable_price" : "limit_price",
      },
      triggerPrice: {
        display: triggerPriceInteger === null
          ? null
          : formatInteger(triggerPriceInteger, context.market.supported_price_decimals),
        integer: triggerPriceInteger === null ? null : triggerPriceInteger.toString(),
        decimals: context.market.supported_price_decimals,
      },
      quoteNotional: {
        integer: quoteNotionalInteger.toString(),
        display: formatInteger(quoteNotionalInteger, context.market.supported_quote_decimals),
        decimals: context.market.supported_quote_decimals,
      },
      minimumChecks: {
        minBaseAmountInteger: minBaseAmount.toString(),
        minBaseAmountDisplay: formatInteger(
          minBaseAmount,
          context.market.supported_size_decimals,
        ),
        minQuoteAmountInteger: minQuoteAmount.toString(),
        minQuoteAmountDisplay: formatInteger(
          minQuoteAmount,
          context.market.supported_quote_decimals,
        ),
        baseAmountPasses: true,
        quoteAmountPasses: true,
      },
      marketData: {
        bestBid,
        bestAsk,
        referencePrice: readReferencePrice(context.market),
        priceComparison,
      },
      positionContext,
      riskNotes: [
        "Preview only. No order was signed, submitted, placed, cancelled, deposited, withdrawn, or transferred.",
        "A later API acceptance is not final execution; order outcome must be proven by Lighter order or transaction evidence.",
      ],
    },
  };
}

export function computeLighterOrderPreviewHash(input: LighterOrderPreviewIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(lighterOrderPreviewHashMaterial(input)))
    .digest("hex");
}

export function lighterOrderPreviewHashMaterial(input: LighterOrderPreviewIdentity): readonly string[] {
  return [
    input.kind,
    input.sessionId,
    input.environment,
    input.accountIndex,
    input.apiKeyIndex,
    input.marketIndex,
    input.side,
    input.baseAmountInteger,
    input.priceInteger,
    input.orderType,
    input.timeInForce,
    input.reduceOnly,
    input.triggerPriceInteger,
    input.expiryMs,
    input.clientOrderIndexPolicy,
    input.providerVersion,
  ];
}

function validateInputScalars(input: LighterOrderPreviewInput): void {
  if (input.sessionId.trim().length === 0) throw invalidRequest("Missing Lighter order preview sessionId.");
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) {
    throw invalidRequest("accountIndex must be a safe non-negative integer.");
  }
  if (input.apiKeyIndex !== undefined && input.apiKeyIndex !== null) {
    if (!Number.isInteger(input.apiKeyIndex) || input.apiKeyIndex < 0 || input.apiKeyIndex > 255) {
      throw invalidRequest("apiKeyIndex must be an integer from 0 to 255 when provided.");
    }
  }
  if (!Number.isInteger(input.marketId) || input.marketId < 0 || input.marketId > 65_535) {
    throw invalidRequest("marketId must be an integer from 0 to 65535.");
  }
  if (input.clientOrderIndexPolicy.trim().length === 0) {
    throw invalidRequest("clientOrderIndexPolicy is required.");
  }
}

function assertMarketMatches(input: LighterOrderPreviewInput, market: LighterMarketDetail): void {
  if (market.market_id !== input.marketId) {
    throw invalidRequest(
      `Lighter order preview refused: live market detail returned market ${market.market_id}, not ${input.marketId}.`,
    );
  }
  if (market.status !== "active") {
    throw invalidRequest(`Lighter order preview refused: market ${input.marketId} is not active.`);
  }
}

function assertAccountContainsIndex(input: LighterOrderPreviewInput, account: LighterAccountResponse): void {
  const match = account.accounts.some((row) => accountIndexOf(row) === input.accountIndex);
  if (!match) {
    throw invalidRequest(
      `Lighter order preview refused: live account read did not return account ${input.accountIndex}.`,
    );
  }
}

function assertQuoteScale(market: LighterMarketDetail): void {
  const expected = market.supported_size_decimals + market.supported_price_decimals;
  if (market.supported_quote_decimals !== expected) {
    throw invalidRequest(
      "Lighter order preview refused: market quote decimal scale did not match documented size+price decimals.",
    );
  }
}

function assertExpiry(orderExpiry: number, nowMs: number): void {
  if (!Number.isInteger(orderExpiry)) throw invalidRequest("orderExpiry must be an epoch-milliseconds integer.");
  const min = nowMs + MIN_ORDER_EXPIRY_OFFSET_MS;
  const max = nowMs + MAX_ORDER_EXPIRY_OFFSET_MS;
  if (orderExpiry < min || orderExpiry > max) {
    throw invalidRequest("orderExpiry must be between 5 minutes and 30 days from preview time.");
  }
}

function assertOrderCombination(input: LighterOrderPreviewInput): void {
  if (input.orderType === "market" && input.timeInForce !== "immediate-or-cancel") {
    throw invalidRequest("Market order previews require immediate-or-cancel time in force.");
  }
  if (input.orderType === "limit" && input.timeInForce === "immediate-or-cancel") {
    throw invalidRequest("Limit IOC behavior must be requested as a market-style worst-price preview in this wave.");
  }
  if (input.timeInForce === "post-only" && input.orderType !== "limit") {
    throw invalidRequest("Post-only previews are supported only for limit orders.");
  }
  if (input.triggerPrice !== undefined && input.triggerPrice !== null) {
    throw invalidRequest("Trigger-price order previews are not supported in this wave.");
  }
}

function decimalToInteger(
  value: string,
  decimals: number,
  field: string,
  options: { readonly allowZero?: boolean } = {},
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw invalidRequest(`${field} decimals must be an integer from 0 to 18.`);
  }
  const trimmed = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed)) {
    throw invalidRequest(`${field} must be a non-negative decimal string.`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const strippedFraction = fraction.replace(/0+$/, "");
  if (strippedFraction.length > decimals) {
    throw invalidRequest(`${field} has more decimal places than Lighter supports.`);
  }
  const padded = strippedFraction.padEnd(decimals, "0");
  const integer = BigInt(`${whole}${padded}`.replace(/^0+(?=\d)/, ""));
  if (integer < 0n || (integer === 0n && options.allowZero !== true)) {
    throw invalidRequest(`${field} must be greater than zero.`);
  }
  return integer;
}

function formatInteger(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
}

function accountIndexOf(account: LighterAccount): number | null {
  const value = account.index ?? account.account_index;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readPositionContext(
  account: LighterAccountResponse,
  marketId: number,
): LighterOrderPreview["preview"]["positionContext"] {
  const owner = account.accounts.find((row) => Array.isArray(row.positions));
  const positions = owner && Array.isArray(owner.positions) ? owner.positions : [];
  const position = positions.find((row) => {
    if (!isRecord(row)) return false;
    return row.market_id === marketId || row.marketId === marketId;
  });
  if (!isRecord(position)) {
    return { verified: false, marketPosition: null, positionSide: "unknown" };
  }
  const rawPosition = stringValue(position.position) ?? stringValue(position.size);
  const sign = typeof position.sign === "number" ? position.sign : null;
  const side = sign === null
    ? "unknown"
    : sign > 0
      ? "long"
      : sign < 0
        ? "short"
        : "flat";
  return {
    verified: rawPosition !== null && side !== "unknown",
    marketPosition: rawPosition,
    positionSide: side,
  };
}

function isReduceOnlyVerifiable(
  side: LighterOrderSide,
  position: LighterOrderPreview["preview"]["positionContext"],
): boolean {
  if (!position.verified) return false;
  if (position.positionSide === "long") return side === "sell";
  if (position.positionSide === "short") return side === "buy";
  return false;
}

function bestPrice(orders: readonly LighterSimpleOrder[], side: "ask" | "bid"): string | null {
  const prices = orders
    .map((order) => stringValue(order.price))
    .filter((value): value is string => value !== null);
  if (prices.length === 0) return null;
  return prices
    .slice()
    .sort((a, b) => compareDecimalStrings(a, b) * (side === "ask" ? 1 : -1))[0] ?? null;
}

function compareDecimalStrings(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a === null || b === null) return 0;
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.integer * (10n ** BigInt(scale - a.scale));
  const rightInteger = b.integer * (10n ** BigInt(scale - b.scale));
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  return 0;
}

function classifyPriceComparison(
  side: LighterOrderSide,
  orderType: LighterOrderType,
  price: string,
  bestBid: string | null,
  bestAsk: string | null,
): "resting" | "crossing_or_taker" | "unknown" {
  if (orderType === "market") return "crossing_or_taker";
  if (side === "buy") {
    if (bestAsk === null || decimalParts(price) === null || decimalParts(bestAsk) === null) return "unknown";
    return compareDecimalStrings(price, bestAsk) >= 0 ? "crossing_or_taker" : "resting";
  }
  if (bestBid === null || decimalParts(price) === null || decimalParts(bestBid) === null) return "unknown";
  return compareDecimalStrings(price, bestBid) <= 0 ? "crossing_or_taker" : "resting";
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

function readReferencePrice(market: LighterMarketDetail): string | null {
  const markPrice = stringValue(market.mark_price);
  if (markPrice !== null) return markPrice;
  const indexPrice = stringValue(market.index_price);
  if (indexPrice !== null) return indexPrice;
  return typeof market.last_trade_price === "number" && Number.isFinite(market.last_trade_price)
    ? String(market.last_trade_price)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): VexError {
  return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message);
}
