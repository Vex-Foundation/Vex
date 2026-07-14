import { Decimal } from "decimal.js";
import { z } from "zod";

import { normalizeProviderDecimal } from "./validation.js";

const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const signedDecimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);

const metaAndAssetCtxsSchema = z.tuple([
  z.object({
    universe: z.array(z.object({
      name: z.string().min(1).max(64),
      maxLeverage: z.union([z.number(), z.string()]).optional(),
      szDecimals: z.number().int().min(0).max(18).optional(),
    }).passthrough()).max(500),
  }).passthrough(),
  z.array(z.object({
    markPx: unsignedDecimal,
    prevDayPx: unsignedDecimal.nullable().optional(),
    openInterest: unsignedDecimal.optional(),
    funding: signedDecimal.nullable().optional(),
    dayNtlVlm: unsignedDecimal.nullable().optional(),
  }).passthrough()).max(500),
]);

export interface HyperliquidNormalizedMarketSnapshot {
  readonly coin: string;
  readonly maxLeverage: number | null;
  readonly szDecimals: number | null;
  readonly markPx: string;
  readonly change24hPct: string | null;
  readonly openInterestUsd: string | null;
  readonly fundingRate8hPct: string | null;
  readonly dayNtlVlmUsd: string | null;
}

/** Validate and canonicalize one untrusted `metaAndAssetCtxs` response. */
export function parseHyperliquidMarketSnapshot(
  value: unknown,
): readonly HyperliquidNormalizedMarketSnapshot[] {
  const [meta, contexts] = metaAndAssetCtxsSchema.parse(value);
  if (meta.universe.length !== contexts.length) {
    throw new Error("Hyperliquid market metadata/context lengths did not match.");
  }

  return meta.universe.map((asset, index) => {
    const context = contexts[index];
    if (context === undefined) throw new Error("Hyperliquid market context was missing.");
    const markPx = normalizeProviderDecimal(context.markPx, `Mark price for ${asset.name}`);
    const previous = context.prevDayPx === null || context.prevDayPx === undefined
      ? null
      : normalizeProviderDecimal(context.prevDayPx, `Previous-day price for ${asset.name}`);
    const openInterest = context.openInterest === undefined
      ? null
      : normalizeProviderDecimal(context.openInterest, `Open interest for ${asset.name}`);

    return {
      coin: asset.name,
      maxLeverage: parseMaxLeverage(asset.maxLeverage),
      szDecimals: asset.szDecimals ?? null,
      markPx,
      change24hPct: previous === null || new Decimal(previous).isZero()
        ? null
        : new Decimal(markPx).minus(previous).div(previous).mul(100).toFixed(),
      openInterestUsd: openInterest === null
        ? null
        : new Decimal(openInterest).mul(markPx).toFixed(),
      fundingRate8hPct: context.funding === null || context.funding === undefined
        ? null
        : canonicalSignedDecimal(context.funding, "Hyperliquid funding rate", 8),
      dayNtlVlmUsd: context.dayNtlVlm === null || context.dayNtlVlm === undefined
        ? null
        : normalizeProviderDecimal(context.dayNtlVlm, `Day notional volume for ${asset.name}`),
    };
  });
}

function parseMaxLeverage(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Hyperliquid market max leverage was invalid.");
  }
  return parsed;
}

function canonicalSignedDecimal(value: string, label: string, multiplier: number): string {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new Error(`${label} was invalid.`);
  return decimal.mul(multiplier).toFixed();
}
