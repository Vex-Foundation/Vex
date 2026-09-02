import {
  LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT,
  LIGHTER_ORDER_SIDES,
  LIGHTER_ORDER_TIME_IN_FORCE,
  LIGHTER_ORDER_TYPES,
  type LighterOrderSide,
  type LighterOrderTimeInForce,
  type LighterOrderType,
} from "@tools/lighter/order-preview.js";
import { lighterPhaseOneOrderPolicyFailure } from "@tools/lighter/order-policy.js";
import {
  LIGHTER_DEFAULT_ENVIRONMENT,
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_CANDLES_COUNT_MAX,
  LIGHTER_ENVIRONMENTS,
  LIGHTER_MARKET_FILTERS,
  LIGHTER_ORDER_BOOK_LIMIT_MAX,
  LIGHTER_ORDER_BOOK_LIMIT_MIN,
  LIGHTER_RECENT_TRADES_LIMIT_MAX,
  LIGHTER_RECENT_TRADES_LIMIT_MIN,
  LIGHTER_TIMESTAMP_MAX,
  LIGHTER_TIMESTAMP_MIN,
  type LighterCandleResolution,
  type LighterEnvironment,
  type LighterMarketFilter,
} from "@tools/lighter/constants.js";

export const LIGHTER_AGENT_MARKET_LIMIT_DEFAULT = 25;
export const LIGHTER_AGENT_MARKET_LIMIT_MAX = 50;
export const LIGHTER_AGENT_MARKET_PAGE_MAX = 1_000;
export const LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT = 25;
export const LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX = Math.min(50, LIGHTER_ORDER_BOOK_LIMIT_MAX);
export const LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT = 25;
export const LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX = Math.min(50, LIGHTER_RECENT_TRADES_LIMIT_MAX);
export const LIGHTER_AGENT_CANDLE_OUTPUT_MAX = 100;
export const LIGHTER_AGENT_ACCOUNT_ROW_MAX = 10;
export const LIGHTER_AGENT_ACCOUNT_POSITION_MAX = 25;
export const LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT = 25;
export const LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX = 50;
export const LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT = 25;
export const LIGHTER_AGENT_API_KEY_LIMIT_MAX = 50;
export const LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN = 5;
export const LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX = 30 * 24 * 60;
export const LIGHTER_ORDER_PREVIEW_MARKET_TYPES = ["perp", "spot"] as const;

export type LighterOrderPreviewMarketType =
  (typeof LIGHTER_ORDER_PREVIEW_MARKET_TYPES)[number];

export type ParamRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface LighterAccountLookup {
  readonly by: "index" | "l1_address";
  readonly value: number | string;
  readonly accountIndex: number | null;
  readonly l1Address: string | null;
  readonly activeOnly?: boolean;
}

export interface LighterOrderPreviewParams {
  readonly accountIndex?: number;
  readonly apiKeyIndex?: number | null;
  readonly marketId?: number;
  readonly marketSymbol?: string;
  readonly marketType?: LighterOrderPreviewMarketType;
  readonly side: LighterOrderSide;
  readonly baseAmount: string;
  readonly price: string;
  readonly triggerPrice?: string;
  readonly orderType: LighterOrderType;
  readonly timeInForce: LighterOrderTimeInForce;
  readonly reduceOnly: boolean;
  readonly orderExpiry: number;
  readonly clientOrderIndexPolicy: string;
}

export interface LighterOcoProtectionParams {
  readonly accountIndex?: number;
  readonly apiKeyIndex?: number | null;
  readonly marketId?: number;
  readonly marketSymbol?: string;
  readonly side: LighterOrderSide;
  readonly baseAmount: string;
  readonly stopLossTriggerPrice: string;
  readonly stopLossPrice: string;
  readonly takeProfitTriggerPrice: string;
  readonly takeProfitPrice: string;
  readonly orderExpiry: number;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readAddress(params: Record<string, unknown>, key: string): string | undefined {
  const value = readString(params, key);
  if (value === undefined) return undefined;
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : "__INVALID_ADDRESS__";
}

function allowedList(values: readonly string[]): string {
  return values.join(", ");
}

function readEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
  required: boolean,
): ParamRead<T | undefined> {
  const value = readString(params, key);
  if (value === undefined) {
    if (required) return { ok: false, reason: `Missing required: ${key}.` };
    return { ok: true, value: undefined };
  }
  if (values.includes(value as T)) return { ok: true, value: value as T };
  return {
    ok: false,
    reason: `${key} must be ${allowedList(values)}.`,
  };
}

export function readEnvironment(
  params: Record<string, unknown>,
): ParamRead<LighterEnvironment> {
  const env = readEnum(params, "environment", LIGHTER_ENVIRONMENTS, false);
  if (!env.ok) return env;
  return { ok: true, value: (env.value ?? LIGHTER_DEFAULT_ENVIRONMENT) as LighterEnvironment };
}

export function readMarketFilter(
  params: Record<string, unknown>,
): ParamRead<LighterMarketFilter | undefined> {
  return readEnum(params, "filter", LIGHTER_MARKET_FILTERS, false);
}

export function readResolution(
  params: Record<string, unknown>,
): ParamRead<LighterCandleResolution> {
  const resolution = readEnum(params, "resolution", LIGHTER_CANDLE_RESOLUTIONS, true);
  if (!resolution.ok) return resolution;
  return { ok: true, value: resolution.value as LighterCandleResolution };
}

export function readMarketId(
  params: Record<string, unknown>,
  required: boolean,
): ParamRead<number | undefined> {
  const value = readNumber(params, "marketId");
  if (value === undefined) {
    if (required) return { ok: false, reason: "Missing required: marketId." };
    return { ok: true, value: undefined };
  }
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    return { ok: false, reason: "marketId must be an integer from 0 to 65535." };
  }
  return { ok: true, value };
}

export function readAccountLookup(params: Record<string, unknown>): ParamRead<LighterAccountLookup> {
  const accountIndex = readNumber(params, "accountIndex");
  const l1Address = readAddress(params, "walletAddress");
  if (accountIndex !== undefined && l1Address !== undefined) {
    return { ok: false, reason: "Provide either accountIndex or walletAddress, not both." };
  }
  if (accountIndex === undefined && l1Address === undefined) {
    return { ok: false, reason: "Missing required: accountIndex or walletAddress." };
  }
  if (accountIndex !== undefined) {
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: "accountIndex must be a safe non-negative integer." };
    }
    return {
      ok: true,
      value: {
        by: "index",
        value: accountIndex,
        accountIndex,
        l1Address: null,
        activeOnly: readBoolean(params, "activeOnly"),
      },
    };
  }
  if (l1Address === "__INVALID_ADDRESS__") {
    return { ok: false, reason: "walletAddress must be a 0x-prefixed 20-byte EVM address." };
  }
  return {
    ok: true,
    value: {
      by: "l1_address",
      value: l1Address!,
      accountIndex: null,
      l1Address: l1Address!,
      activeOnly: readBoolean(params, "activeOnly"),
    },
  };
}

export function readOptionalAccountIndex(params: Record<string, unknown>): ParamRead<number | undefined> {
  const accountIndex = readNumber(params, "accountIndex");
  if (accountIndex === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: "accountIndex must be a safe non-negative integer." };
  }
  return { ok: true, value: accountIndex };
}

export function readRequiredAccountIndex(params: Record<string, unknown>): ParamRead<number> {
  const accountIndex = readOptionalAccountIndex(params);
  if (!accountIndex.ok) return accountIndex;
  if (accountIndex.value === undefined) return { ok: false, reason: "Missing required: accountIndex." };
  return { ok: true, value: accountIndex.value };
}

export function readLimit(
  params: Record<string, unknown>,
  options: {
    readonly key?: "limit" | "countBack" | "page";
    readonly min: number;
    readonly max: number;
    readonly defaultValue?: number;
    readonly required?: boolean;
  },
): ParamRead<number | undefined> {
  const key = options.key ?? "limit";
  const value = readNumber(params, key);
  if (value === undefined) {
    if (options.required === true) return { ok: false, reason: `Missing required: ${key}.` };
    return { ok: true, value: options.defaultValue };
  }
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    return { ok: false, reason: `${key} must be an integer from ${options.min} to ${options.max}.` };
  }
  return { ok: true, value };
}

export function readTimestamp(
  params: Record<string, unknown>,
  key: "startTimestamp" | "endTimestamp",
): ParamRead<number> {
  const value = readNumber(params, key);
  if (value === undefined) return { ok: false, reason: `Missing required: ${key}.` };
  if (!Number.isInteger(value)) {
    return { ok: false, reason: `${key} must be an epoch-milliseconds integer.` };
  }
  if (value < LIGHTER_TIMESTAMP_MIN) {
    return { ok: false, reason: `${key} must use epoch milliseconds, not seconds.` };
  }
  if (value > LIGHTER_TIMESTAMP_MAX) {
    return { ok: false, reason: `${key} is too far in the future.` };
  }
  return { ok: true, value };
}

export function readSetTimestampToEnd(params: Record<string, unknown>): boolean | undefined {
  return readBoolean(params, "setTimestampToEnd");
}

export function readCountBack(params: Record<string, unknown>): ParamRead<number | undefined> {
  return readLimit(params, {
    key: "countBack",
    min: 1,
    max: LIGHTER_CANDLES_COUNT_MAX,
  });
}

export function readOrderBookLimit(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    min: LIGHTER_ORDER_BOOK_LIMIT_MIN,
    max: LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX,
    defaultValue: LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT };
}

export function readRecentTradesLimit(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    min: LIGHTER_RECENT_TRADES_LIMIT_MIN,
    max: LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX,
    defaultValue: LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT };
}

export function readAccountOrderLimit(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    min: 1,
    max: LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX,
    defaultValue: LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT };
}

export function readApiKeyLimit(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    min: 1,
    max: LIGHTER_AGENT_API_KEY_LIMIT_MAX,
    defaultValue: LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT };
}

export function readMarketListLimit(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    min: 1,
    max: LIGHTER_AGENT_MARKET_LIMIT_MAX,
    defaultValue: LIGHTER_AGENT_MARKET_LIMIT_DEFAULT,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? LIGHTER_AGENT_MARKET_LIMIT_DEFAULT };
}

export function readMarketListPage(params: Record<string, unknown>): ParamRead<number> {
  const read = readLimit(params, {
    key: "page",
    min: 1,
    max: LIGHTER_AGENT_MARKET_PAGE_MAX,
    defaultValue: 1,
  });
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? 1 };
}

export function readLighterOrderPreviewParams(
  params: Record<string, unknown>,
  nowMs = Date.now(),
): ParamRead<LighterOrderPreviewParams> {
  const accountIndex = readOptionalAccountIndex(params);
  if (!accountIndex.ok) return accountIndex;
  const apiKeyIndex = readApiKeyIndex(params);
  if (!apiKeyIndex.ok) return apiKeyIndex;
  const marketId = readMarketId(params, false);
  if (!marketId.ok) return marketId;
  const marketSymbol = readString(params, "marketSymbol");
  if (marketId.value === undefined && marketSymbol === undefined) {
    return { ok: false, reason: "Missing required: marketId or marketSymbol." };
  }
  const marketType = readEnum(
    params,
    "marketType",
    LIGHTER_ORDER_PREVIEW_MARKET_TYPES,
    false,
  );
  if (!marketType.ok) return marketType;
  const side = readEnum(params, "side", LIGHTER_ORDER_SIDES, false);
  if (!side.ok) return side;
  if (side.value === undefined) {
    return { ok: false, reason: "Please choose buy or sell for the Lighter order preview." };
  }
  const orderType = readEnum(params, "orderType", LIGHTER_ORDER_TYPES, false);
  if (!orderType.ok) return orderType;
  const timeInForce = readEnum(params, "timeInForce", LIGHTER_ORDER_TIME_IN_FORCE, false);
  if (!timeInForce.ok) return timeInForce;
  const baseAmount = readRequiredString(params, "baseAmountIn");
  if (!baseAmount.ok) return baseAmount;
  const price = readRequiredString(params, "price");
  if (!price.ok) return price;
  const triggerPrice = readString(params, "triggerPrice");
  const orderExpiry = readOrderExpiry(params, nowMs);
  if (!orderExpiry.ok) return orderExpiry;
  const reduceOnly = readBoolean(params, "reduceOnly");
  if (reduceOnly !== undefined && typeof reduceOnly !== "boolean") {
    return { ok: false, reason: "reduceOnly must be boolean." };
  }
  const resolvedOrderType = (orderType.value ?? "market") as LighterOrderType;
  const limitFamily = resolvedOrderType === "limit"
    || resolvedOrderType === "stop-loss-limit"
    || resolvedOrderType === "take-profit-limit";
  if (limitFamily && timeInForce.value === undefined) {
    return {
      ok: false,
      reason: `${resolvedOrderType} requires an explicit timeInForce selection.`,
    };
  }
  const resolvedTimeInForce =
    (timeInForce.value ?? "immediate-or-cancel") as LighterOrderTimeInForce;
  const policyFailure = lighterPhaseOneOrderPolicyFailure(
    resolvedOrderType,
    resolvedTimeInForce,
  );
  if (policyFailure !== null) return { ok: false, reason: policyFailure };
  const protective = resolvedOrderType === "stop-loss"
    || resolvedOrderType === "stop-loss-limit"
    || resolvedOrderType === "take-profit"
    || resolvedOrderType === "take-profit-limit";
  if (protective) {
    if (triggerPrice === undefined) {
      return { ok: false, reason: `${resolvedOrderType} requires an explicit triggerPrice.` };
    }
    if (reduceOnly !== true) {
      return { ok: false, reason: `${resolvedOrderType} requires reduceOnly=true.` };
    }
    if (marketType.value === "spot") {
      return { ok: false, reason: `${resolvedOrderType} is supported only for Lighter perpetual markets.` };
    }
  } else if (triggerPrice !== undefined) {
    return { ok: false, reason: "triggerPrice requires a protective stop-loss or take-profit order type." };
  }
  const clientOrderIndexPolicy =
    readString(params, "clientOrderIndexPolicy") ?? LIGHTER_CLIENT_ORDER_INDEX_POLICY_DEFAULT;
  return {
    ok: true,
    value: {
      accountIndex: accountIndex.value,
      apiKeyIndex: apiKeyIndex.value ?? null,
      marketId: marketId.value,
      marketSymbol,
      marketType: marketType.value as LighterOrderPreviewMarketType | undefined,
      side: side.value as LighterOrderSide,
      baseAmount: baseAmount.value,
      price: price.value,
      ...(triggerPrice === undefined ? {} : { triggerPrice }),
      orderType: resolvedOrderType,
      timeInForce: resolvedTimeInForce,
      reduceOnly: reduceOnly ?? false,
      orderExpiry: orderExpiry.value,
      clientOrderIndexPolicy,
    },
  };
}

export function readLighterOcoProtectionParams(
  params: Record<string, unknown>,
  nowMs = Date.now(),
): ParamRead<LighterOcoProtectionParams> {
  const accountIndex = readOptionalAccountIndex(params);
  if (!accountIndex.ok) return accountIndex;
  const apiKeyIndex = readApiKeyIndex(params);
  if (!apiKeyIndex.ok) return apiKeyIndex;
  const marketId = readMarketId(params, false);
  if (!marketId.ok) return marketId;
  const marketSymbol = readString(params, "marketSymbol");
  if (marketId.value === undefined && marketSymbol === undefined) {
    return { ok: false, reason: "Missing required: marketId or marketSymbol." };
  }
  const side = readEnum(params, "side", LIGHTER_ORDER_SIDES, true);
  if (!side.ok) return side;
  if (side.value === undefined) return { ok: false, reason: "Missing required: side." };
  const baseAmount = readRequiredString(params, "baseAmountIn");
  if (!baseAmount.ok) return baseAmount;
  const stopLossTriggerPrice = readRequiredString(params, "stopLossTriggerPrice");
  if (!stopLossTriggerPrice.ok) return stopLossTriggerPrice;
  const stopLossPrice = readRequiredString(params, "stopLossPrice");
  if (!stopLossPrice.ok) return stopLossPrice;
  const takeProfitTriggerPrice = readRequiredString(params, "takeProfitTriggerPrice");
  if (!takeProfitTriggerPrice.ok) return takeProfitTriggerPrice;
  const takeProfitPrice = readRequiredString(params, "takeProfitPrice");
  if (!takeProfitPrice.ok) return takeProfitPrice;
  const orderExpiry = readOrderExpiry(params, nowMs);
  if (!orderExpiry.ok) return orderExpiry;
  return {
    ok: true,
    value: {
      accountIndex: accountIndex.value,
      apiKeyIndex: apiKeyIndex.value ?? null,
      marketId: marketId.value,
      marketSymbol,
      side: side.value,
      baseAmount: baseAmount.value,
      stopLossTriggerPrice: stopLossTriggerPrice.value,
      stopLossPrice: stopLossPrice.value,
      takeProfitTriggerPrice: takeProfitTriggerPrice.value,
      takeProfitPrice: takeProfitPrice.value,
      orderExpiry: orderExpiry.value,
    },
  };
}

function readRequiredString(
  params: Record<string, unknown>,
  key: string,
): ParamRead<string> {
  const value = readString(params, key);
  if (value === undefined) return { ok: false, reason: `Missing required: ${key}.` };
  return { ok: true, value };
}

export function readApiKeyIndex(params: Record<string, unknown>): ParamRead<number | undefined> {
  const value = readNumber(params, "apiKeyIndex");
  if (value === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    return { ok: false, reason: "apiKeyIndex must be an integer from 0 to 255." };
  }
  return { ok: true, value };
}

function readOrderExpiry(params: Record<string, unknown>, nowMs: number): ParamRead<number> {
  const absolute = readNumber(params, "orderExpiry");
  const offsetMinutes = readNumber(params, "orderExpiryOffsetMinutes");
  if (absolute !== undefined && offsetMinutes !== undefined) {
    return { ok: false, reason: "Provide orderExpiry or orderExpiryOffsetMinutes, not both." };
  }
  if (offsetMinutes !== undefined) return readRelativeOrderExpiry(offsetMinutes, nowMs);
  return readEpochMs(params, "orderExpiry");
}

function readRelativeOrderExpiry(offsetMinutes: number, nowMs: number): ParamRead<number> {
  if (!Number.isInteger(offsetMinutes)) {
    return { ok: false, reason: "orderExpiryOffsetMinutes must be a whole number of minutes." };
  }
  if (
    offsetMinutes < LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN
    || offsetMinutes > LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX
  ) {
    return {
      ok: false,
      reason:
        `orderExpiryOffsetMinutes must be between ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN} `
        + `and ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX} minutes.`,
    };
  }
  return { ok: true, value: nowMs + offsetMinutes * 60 * 1000 };
}

function readEpochMs(params: Record<string, unknown>, key: "orderExpiry"): ParamRead<number> {
  const value = readNumber(params, key);
  if (value === undefined) return { ok: false, reason: `Missing required: ${key}.` };
  if (!Number.isInteger(value)) return { ok: false, reason: `${key} must be an epoch-milliseconds integer.` };
  if (value < LIGHTER_TIMESTAMP_MIN) return { ok: false, reason: `${key} must use epoch milliseconds, not seconds.` };
  if (value > LIGHTER_TIMESTAMP_MAX) return { ok: false, reason: `${key} is too far in the future.` };
  return { ok: true, value };
}
