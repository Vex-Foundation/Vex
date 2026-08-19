/**
 * Pairs / search / tokens / token-pairs validators.
 *
 * Covers the strict token parsers (`parseBaseToken` / `parseQuoteToken`), the
 * LENIENT nested sub-parsers (txns / volume / priceChange / liquidity / info /
 * boosts / labels), the strict `parsePair`, and the four response validators
 * that all back onto `parsePair`. Moved VERBATIM from the original
 * `validation.ts`.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import type {
  DexBoosts,
  DexLiquidity,
  DexPair,
  DexPairInfo,
  DexQuoteToken,
  DexToken,
  DexTxnCounts,
  PairsResponse,
  SearchResponse,
  TokensPairsResponse,
  TokensResponse,
} from "../types.js";
import { asOptionalNumber, asOptionalString, asString, parseOrThrow } from "./_shared.js";

// ---------------------------------------------------------------------------
// Token parsers (strict root, then field rules).
// ---------------------------------------------------------------------------

const baseTokenObjectSchema = z.object({
  address: asString("baseToken.address"),
  name: asString("baseToken.name"),
  symbol: asString("baseToken.symbol"),
});

function parseBaseToken(raw: unknown): DexToken {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: baseToken must be an object");
  }
  return parseOrThrow(baseTokenObjectSchema, raw);
}

/** quoteToken: non-record → throws; all fields optional-string (null fallback). */
const quoteTokenObjectSchema: z.ZodType<DexQuoteToken> = z.object({
  address: asOptionalString,
  name: asOptionalString,
  symbol: asOptionalString,
});

function parseQuoteToken(raw: unknown): DexQuoteToken {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: quoteToken must be an object");
  }
  return parseOrThrow(quoteTokenObjectSchema, raw);
}

// ---------------------------------------------------------------------------
// Nested object parsers (LENIENT — never throw; default/null on bad input).
// ---------------------------------------------------------------------------

/**
 * `parseTxnCounts`: non-record root → {}. Per entry: only record values are
 * kept; buys/sells fall back to 0 when not a number (typeof check accepts
 * NaN/Infinity). Non-record entries are SKIPPED (not added).
 */
const txnCountsSchema: z.ZodType<Record<string, DexTxnCounts>> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return {};
  const result: Record<string, DexTxnCounts> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      result[key] = {
        buys: typeof value.buys === "number" ? value.buys : 0,
        sells: typeof value.sells === "number" ? value.sells : 0,
      };
    }
  }
  return result;
});

/**
 * `parseNumberRecord`: non-record root → {}. Keeps only `typeof === "number"`
 * values (accepts NaN/Infinity). Non-number values skipped.
 */
const numberRecordSchema: z.ZodType<Record<string, number>> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
});

/**
 * `parsePair.priceChange`: `isRecord(raw.priceChange) ? parseNumberRecord(...)
 * : null`. Differs from `numberRecordSchema` which returns {} on non-record;
 * here a non-record root → null.
 */
const priceChangeSchema: z.ZodType<Record<string, number> | null> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return null;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
});

/** `parseLiquidity`: non-record → null; usd optional-number; base/quote → 0 default. */
const liquiditySchema: z.ZodType<DexLiquidity | null> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return null;
  return {
    usd: typeof raw.usd === "number" && !Number.isNaN(raw.usd) ? raw.usd : null,
    base: typeof raw.base === "number" ? raw.base : 0,
    quote: typeof raw.quote === "number" ? raw.quote : 0,
  };
});

/** `parseInfo`: non-record → null; websites/socials element-wise filtered records, else null. */
const infoSchema: z.ZodType<DexPairInfo | null> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return null;
  return {
    imageUrl: typeof raw.imageUrl === "string" && raw.imageUrl.length > 0 ? raw.imageUrl : null,
    websites: Array.isArray(raw.websites)
      ? raw.websites.filter(isRecord).map((w) => ({ url: typeof w.url === "string" ? w.url : "" }))
      : null,
    socials: Array.isArray(raw.socials)
      ? raw.socials.filter(isRecord).map((s) => ({
          platform: typeof s.platform === "string" ? s.platform : "",
          handle: typeof s.handle === "string" ? s.handle : "",
        }))
      : null,
  };
});

/** `parseBoosts`: non-record → null; active → 0 default. */
const boostsSchema: z.ZodType<DexBoosts | null> = z.unknown().optional().transform((raw) => {
  if (!isRecord(raw)) return null;
  return { active: typeof raw.active === "number" ? raw.active : 0 };
});

/** `parseLabels`: non-array → null; else element-wise string filter. */
const labelsSchema: z.ZodType<string[] | null> = z.unknown().optional().transform((raw) =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : null,
);

// ---------------------------------------------------------------------------
// Pair parser (strict root; field order mirrors the original return literal).
// ---------------------------------------------------------------------------

const pairObjectSchema: z.ZodType<DexPair> = z
  .object({
    chainId: asString("pair.chainId"),
    dexId: asString("pair.dexId"),
    url: asString("pair.url"),
    pairAddress: asString("pair.pairAddress"),
    labels: labelsSchema,
    baseToken: z.unknown().optional().transform((v) => parseBaseToken(v)),
    quoteToken: z.unknown().optional().transform((v) => parseQuoteToken(v)),
    priceNative: asString("pair.priceNative"),
    priceUsd: asOptionalString,
    txns: txnCountsSchema,
    volume: numberRecordSchema,
    priceChange: priceChangeSchema,
    liquidity: liquiditySchema,
    fdv: asOptionalNumber,
    marketCap: asOptionalNumber,
    pairCreatedAt: asOptionalNumber,
    info: infoSchema,
    boosts: boostsSchema,
  })
  .transform((p) => ({
    chainId: p.chainId,
    dexId: p.dexId,
    url: p.url,
    pairAddress: p.pairAddress,
    labels: p.labels,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceNative: p.priceNative,
    priceUsd: p.priceUsd,
    txns: p.txns,
    volume: p.volume,
    priceChange: p.priceChange,
    liquidity: p.liquidity,
    fdv: p.fdv,
    marketCap: p.marketCap,
    pairCreatedAt: p.pairCreatedAt,
    info: p.info,
    boosts: p.boosts,
  }));

/**
 * Strict single-pair parser. Exported so the TOLERANT metas-detail validator
 * (`validation/metas.ts`) can reuse the canonical pair shape element-wise
 * (wrapping each call in try/catch to skip a malformed pair instead of
 * throwing the whole feed) rather than duplicating the lenient sub-parsers.
 */
export function parsePair(raw: unknown): DexPair {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: pair must be an object");
  }
  return parseOrThrow(pairObjectSchema, raw);
}

// ---------------------------------------------------------------------------
// Response validators
// ---------------------------------------------------------------------------

export function validatePairsResponse(raw: unknown): PairsResponse {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected pairs response object");
  }
  return {
    schemaVersion: typeof raw.schemaVersion === "string" ? raw.schemaVersion : "",
    // `.map(parsePair)` throws per-element on a non-record element — preserved.
    pairs: Array.isArray(raw.pairs) ? raw.pairs.map(parsePair) : null,
  };
}

export function validateSearchResponse(raw: unknown): SearchResponse {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected search response object");
  }
  return {
    schemaVersion: typeof raw.schemaVersion === "string" ? raw.schemaVersion : "",
    pairs: Array.isArray(raw.pairs) ? raw.pairs.map(parsePair) : [],
  };
}

export function validateTokensResponse(raw: unknown): TokensResponse {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected tokens array");
  }
  return raw.map(parsePair);
}

export function validateTokensPairsResponse(raw: unknown): TokensPairsResponse {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected token-pairs array");
  }
  return raw.map(parsePair);
}
