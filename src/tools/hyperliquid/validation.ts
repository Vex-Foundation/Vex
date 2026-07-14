import { Decimal } from "decimal.js";
import { formatPrice } from "@nktkas/hyperliquid/utils";
import { z } from "zod";

import { HYPERLIQUID_MIN_NOTIONAL_USD } from "./constants.js";
import { HyperliquidClientError, HyperliquidValidationError } from "./errors.js";
import type { DecimalString } from "./types.js";

/** Canonical financial input: decimal, no exponent, no redundant trailing zero. */
const canonicalDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/, "must be canonical decimal notation")
  .refine((value) => value !== "-0", "must not be negative zero");

export function parseDecimalString(input: string): DecimalString {
  const parsed = canonicalDecimalSchema.safeParse(input);
  if (!parsed.success) {
    throw new HyperliquidClientError("invalid_decimal", `Invalid decimal "${input}".`, { cause: parsed.error });
  }
  try {
    const decimal = new Decimal(parsed.data);
    if (!decimal.isFinite()) {
      throw new HyperliquidValidationError(`Decimal "${input}" is not finite.`);
    }
    return parsed.data as DecimalString;
  } catch (cause) {
    if (cause instanceof HyperliquidClientError) throw cause;
    throw new HyperliquidClientError("invalid_decimal", `Invalid decimal "${input}".`, { cause });
  }
}

export function canonicalDecimal(value: Decimal.Value): DecimalString {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new HyperliquidValidationError("Financial decimal must be finite.");
  const raw = decimal.toFixed();
  const canonical = raw.includes(".")
    ? raw.replace(/(?:\.0+|(?<fraction>\.\d*?[1-9])0+)$/, "$<fraction>")
    : raw;
  return parseDecimalString(canonical === "-0" ? "0" : canonical);
}

/** Normalize a provider decimal response into Vex's canonical boundary form. */
export function normalizeProviderDecimal(value: unknown, label: string): DecimalString {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new HyperliquidValidationError(`${label} must be a non-negative decimal string.`);
  }
  return canonicalDecimal(value);
}

export function compareDecimals(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const compared = new Decimal(left).cmp(new Decimal(right));
  return compared < 0 ? -1 : compared > 0 ? 1 : 0;
}

export function assertPositiveDecimal(value: DecimalString, label: string): void {
  if (new Decimal(value).lte(0)) throw new HyperliquidValidationError(`${label} must be greater than zero.`);
}

function decimalPlaces(value: DecimalString): number {
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
}

function significantFigures(value: DecimalString): number {
  const significant = value.replace(".", "").replace(/^0+/, "");
  return significant === "" ? 0 : significant.length;
}

/** Hyperliquid perp price rule: max five significant figures and market precision. */
export function assertValidPerpPrice(price: DecimalString, szDecimals: number): void {
  assertValidPrice(price, szDecimals, 6);
}

/** Spot uses MAX_DECIMALS=8 while perps use 6; both retain 5 sig figs. */
export function assertValidSpotPrice(price: DecimalString, szDecimals: number): void {
  assertValidPrice(price, szDecimals, 8);
}

function assertValidPrice(price: DecimalString, szDecimals: number, maxDecimals: number): void {
  assertPositiveDecimal(price, "Price");
  const maxDecimalPlaces = Math.max(0, maxDecimals - szDecimals);
  if (decimalPlaces(price) > maxDecimalPlaces) {
    throw new HyperliquidValidationError(`Price may use at most ${maxDecimalPlaces} decimal places for this asset.`);
  }
  if (!new Decimal(price).isInteger() && significantFigures(price) > 5) {
    throw new HyperliquidValidationError("Price may use at most five significant figures.");
  }
}

export function roundSizeDown(size: DecimalString, szDecimals: number): DecimalString {
  assertPositiveDecimal(size, "Size");
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 18) {
    throw new HyperliquidValidationError("Asset size precision is invalid.");
  }
  const rounded = new Decimal(size).toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN);
  if (rounded.lte(0)) throw new HyperliquidValidationError("Size rounds down to zero.");
  return canonicalDecimal(rounded);
}

export function assertValidPerpSize(size: DecimalString, szDecimals: number): void {
  assertPositiveDecimal(size, "Size");
  if (decimalPlaces(size) > szDecimals) {
    throw new HyperliquidValidationError(`Size may use at most ${szDecimals} decimal places for this asset.`);
  }
}

export function assertMinimumNotional(
  price: DecimalString,
  size: DecimalString,
  reduceOnly: boolean,
): void {
  if (reduceOnly) return;
  const notional = new Decimal(price).mul(new Decimal(size));
  if (notional.lt(HYPERLIQUID_MIN_NOTIONAL_USD)) {
    throw new HyperliquidValidationError(`Order notional must be at least $${HYPERLIQUID_MIN_NOTIONAL_USD}.`);
  }
}

export function assertValidLeverage(leverage: number, maxLeverage: number): void {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > maxLeverage) {
    throw new HyperliquidValidationError(`Leverage must be an integer from 1 to ${maxLeverage}.`);
  }
}

/** Derive an IOC cap price without binary floating-point arithmetic. */
export function marketOrderPrice(
  markPrice: DecimalString,
  side: "buy" | "sell",
  slippageBps: number,
  szDecimals = 0,
): DecimalString {
  assertPositiveDecimal(markPrice, "Mark price");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new HyperliquidValidationError("Slippage must be an integer from 0 to 10000 basis points.");
  }
  const adjustment = new Decimal(slippageBps).div(10_000);
  const result = side === "buy"
    ? new Decimal(markPrice).mul(new Decimal(1).add(adjustment))
    : new Decimal(markPrice).mul(new Decimal(1).sub(adjustment));
  if (result.lte(0)) throw new HyperliquidValidationError("Slippage cap price must be positive.");
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 6) {
    throw new HyperliquidValidationError("Asset size precision is invalid.");
  }
  return canonicalDecimal(formatPrice(result.toFixed(), szDecimals));
}
