import {
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

export type ParamRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

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
  const env = readEnum(params, "environment", LIGHTER_ENVIRONMENTS, true);
  if (!env.ok) return env;
  return { ok: true, value: env.value as LighterEnvironment };
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
