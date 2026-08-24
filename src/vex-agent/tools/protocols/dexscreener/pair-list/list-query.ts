/**
 * The untrusted-param boundary for the PAIR list tools.
 *
 * `execute_tool` params come straight from the model, so this module converts an
 * open `Record<string, unknown>` into a typed `PairListQuery` or an explicit
 * rejection — nothing downstream re-reads the raw params.
 *
 * The reading RULES live in `../list-core/param-readers.ts`, shared with the feed
 * and narrative families so `limit` cannot validate one way here and another way
 * three handlers over. This module owns only the pair VOCABULARY: which keys
 * exist, what each one's numeric domain is, and how they assemble into a query.
 *
 * `minLiquidityUsd: 0` must be a no-op — enforced in `./pair-filters.ts`, which
 * knows which side of a threshold it is on.
 *
 * A caller-specific default limit may be supplied by the handler. It is always
 * echoed in `filtersApplied.limit`, and `hasMore` remains true when rows remain,
 * so the context budget is bounded without silent truncation.
 */

import {
  WINDOW_NUMERIC_PARAMS,
  readBoolean,
  readEnum,
  readNumber,
  readOmitFields,
  readStringList,
  type FiltersApplied,
  type NumericParamSpecs,
} from "../list-core/index.js";

import { PAIR_WINDOWS, type PairWindow } from "./pair-metrics.js";
import { resolvePairFields, type PairFieldSelection } from "./agent-pair-fields.js";

// ── Sorting vocabulary ───────────────────────────────────────────

export const PAIR_SORT_KEYS = [
  "relevance",
  "liquidityUsd",
  "volumeUsd",
  "turnoverRatio",
  "marketCapUsd",
  "fdvUsd",
  "pairAgeSeconds",
  "priceChangePct",
  "txnCount",
  "buySellRatio",
] as const;

export type PairSortKey = (typeof PAIR_SORT_KEYS)[number];

export const PAIR_SORT_DIRECTIONS = ["desc", "asc"] as const;

export type PairSortDirection = (typeof PAIR_SORT_DIRECTIONS)[number];

// ── Query shape ──────────────────────────────────────────────────

/** Every threshold is absolute — never a percentage of the sample. */
export interface PairListFilters {
  chainIds: string[] | null;
  dexIds: string[] | null;
  excludeDexIds: string[] | null;
  labels: string[] | null;
  quoteSymbols: string[] | null;
  minLiquidityUsd: number | null;
  maxLiquidityUsd: number | null;
  minVolumeUsd: number | null;
  maxVolumeUsd: number | null;
  minFdvUsd: number | null;
  maxFdvUsd: number | null;
  minMarketCapUsd: number | null;
  maxMarketCapUsd: number | null;
  minTxnCount: number | null;
  minBuySellRatio: number | null;
  maxBuySellRatio: number | null;
  minPriceChangePct: number | null;
  maxPriceChangePct: number | null;
  minTurnoverRatio: number | null;
  maxTurnoverRatio: number | null;
  minQuoteDepthTokens: number | null;
  minPairAgeSeconds: number | null;
  maxPairAgeSeconds: number | null;
  requireSocials: boolean;
  requireWebsite: boolean;
  requirePriceUsd: boolean;
  requireLiquidityUsd: boolean;
  onlyBoosted: boolean;
}

export interface PairListQuery {
  window: PairWindow;
  fields: PairFieldSelection;
  sortBy: PairSortKey;
  sortDir: PairSortDirection;
  /** `null` = every row the provider returned. */
  limit: number | null;
  offset: number;
  filters: PairListFilters;
  /** When true the envelope carries a capped sample of dropped rows with their values. */
  explainDrops: boolean;
  /** Echo of what was actually applied — only keys the caller supplied, normalised. */
  filtersApplied: FiltersApplied;
}

/**
 * The pair family omits NOTHING, and the reason is the parameter's whole text.
 *
 * Every issuer-authored field beyond the symbols is already additive via
 * `fields`, so subtracting it is the same as not asking for it; and the symbols
 * themselves are how a row is identified. A parameter whose every input is
 * either a no-op or a mistake is refused with the reason, not silently honoured.
 */
export const PAIR_OMIT_FIELDS_NOTE =
  "Pair rows can omit nothing. Every issuer-authored text field beyond the symbols (baseName, "
  + "quoteName, socialPlatforms, imageUrl) is already opt-in via \"fields\" — simply do not request "
  + "it — and baseSymbol/quoteSymbol are row identity, never omittable. Price, liquidity, volume "
  + "and every other number here is financially consumed and stays. Use \"fields\" to control what "
  + "a pair row costs.";

export type PairListQueryParse =
  | { readonly ok: true; readonly query: PairListQuery }
  | { readonly ok: false; readonly reason: string };

export interface PairListQueryDefaults {
  /**
   * `relevance` (provider order) for `search`: re-ranking a relevance sample by
   * liquidity and presenting it as depth is how a pool reporting $1.63 B against
   * 59.72 quote tokens reached position 1. `liquidityUsd` for `tokenPairs`,
   * which is a genuine pool list for one token.
   */
  readonly sortBy: PairSortKey;
  /** `chainIds` only means something where the provider mixed chains (search). */
  readonly allowChainFilter?: boolean;
  /** Agent-safe default row window; always reported in `filtersApplied`. */
  readonly limit?: number | null;
}

// ── Numeric parameter contracts ──────────────────────────────────

const NUMERIC_PARAMS: NumericParamSpecs = {
  // Window / paging — the shared contract, identical on every list tool.
  ...WINDOW_NUMERIC_PARAMS,
  // Thresholds.
  minLiquidityUsd: { domain: "nonNegative" },
  maxLiquidityUsd: { domain: "nonNegative" },
  minVolumeUsd: { domain: "nonNegative" },
  maxVolumeUsd: { domain: "nonNegative" },
  minFdvUsd: { domain: "nonNegative" },
  maxFdvUsd: { domain: "nonNegative" },
  minMarketCapUsd: { domain: "nonNegative" },
  maxMarketCapUsd: { domain: "nonNegative" },
  minTxnCount: { domain: "nonNegative", integer: true },
  minBuySellRatio: { domain: "nonNegative" },
  maxBuySellRatio: { domain: "nonNegative" },
  minPriceChangePct: { domain: "signed" },
  maxPriceChangePct: { domain: "signed" },
  minTurnoverRatio: { domain: "nonNegative" },
  maxTurnoverRatio: { domain: "nonNegative" },
  minQuoteDepthTokens: { domain: "nonNegative" },
  minPairAgeSeconds: { domain: "nonNegative", integer: true },
  maxPairAgeSeconds: { domain: "nonNegative", integer: true },
};

// ── Parse ────────────────────────────────────────────────────────

/**
 * Parse and validate the shared list vocabulary.
 *
 * Fails on the FIRST offending parameter. Reporting one actionable rejection is
 * more useful to an agent than a list it has to triage, and a second bad value
 * surfaces on the retry.
 */
export function parsePairListQuery(
  params: Record<string, unknown>,
  defaults: PairListQueryDefaults,
): PairListQueryParse {
  const filtersApplied: FiltersApplied = {};

  const window = readEnum(params, "window", PAIR_WINDOWS, "h24");
  if (!window.ok) return window;
  const sortBy = readEnum(params, "sortBy", PAIR_SORT_KEYS, defaults.sortBy);
  if (!sortBy.ok) return sortBy;
  const sortDir = readEnum(params, "sortDir", PAIR_SORT_DIRECTIONS, "desc");
  if (!sortDir.ok) return sortDir;

  filtersApplied.window = window.value;
  filtersApplied.sortBy = sortBy.value;
  filtersApplied.sortDir = sortDir.value;

  const includeAllWindows = readBoolean(params, "includeAllWindows");
  if (!includeAllWindows.ok) return includeAllWindows;
  const requestedFields = readStringList(params, "fields", { lowercase: false, acceptsArray: false });
  if (!requestedFields.ok) return requestedFields;
  const fields = resolvePairFields(requestedFields.value, includeAllWindows.value);
  if (!fields.ok) return fields;
  if (requestedFields.value !== null) filtersApplied.fields = requestedFields.value;
  if (includeAllWindows.value) filtersApplied.includeAllWindows = true;

  // Refused for every name — see PAIR_OMIT_FIELDS_NOTE. Read anyway (rather than
  // left undeclared) so the refusal carries the reason instead of the runtime's
  // generic "unknown parameter".
  const omitFields = readOmitFields(params, { allowed: [], note: PAIR_OMIT_FIELDS_NOTE });
  if (!omitFields.ok) return omitFields;

  const explainDrops = readBoolean(params, "explainDrops");
  if (!explainDrops.ok) return explainDrops;
  if (explainDrops.value) filtersApplied.explainDrops = true;

  const limit = readNumber(params, "limit", NUMERIC_PARAMS);
  if (!limit.ok) return limit;
  const offset = readNumber(params, "offset", NUMERIC_PARAMS);
  if (!offset.ok) return offset;
  const effectiveLimit = limit.value ?? defaults.limit ?? null;
  if (effectiveLimit !== null) filtersApplied.limit = effectiveLimit;
  if (offset.value !== null) filtersApplied.offset = offset.value;

  // Identity / venue.
  const chainIdsRead = readStringList(params, "chainIds", { lowercase: true, acceptsArray: true });
  if (!chainIdsRead.ok) return chainIdsRead;
  if (chainIdsRead.value !== null && defaults.allowChainFilter !== true) {
    return {
      ok: false,
      reason:
        '"chainIds" does not apply to this tool — every row it returns is already on the '
        + '"chain" you supplied. Use dexscreener__pairs_search when you need to compare chains.',
    };
  }

  // NOTE on the retired `chainId` spelling: it is gone everywhere in this
  // namespace, not aliased. `search` never regained a singular chain filter, and
  // W6a renamed the single-chain tools' required `chainId` to `chain`. One
  // filter with two spellings costs a second name to keep in sync AND measurably
  // degrades lexical tool retrieval (the duplicate key and its description both
  // score on "chain", which was enough to push `khalani.tokens.search` out of the
  // golden top-3 for "cross chain token search"). An agent that still tries the
  // old spelling gets `Unknown parameter "chainId" … Allowed parameters: query,
  // chainIds, …` (or `… chain, pairAddress, …` on a single-chain tool) from the
  // runtime param boundary, which names the replacement and is correctable in one
  // turn.
  const chainIds: string[] | null = chainIdsRead.value;
  const dexIds = readStringList(params, "dexIds", { lowercase: true, acceptsArray: true });
  if (!dexIds.ok) return dexIds;
  const excludeDexIds = readStringList(params, "excludeDexIds", { lowercase: true, acceptsArray: true });
  if (!excludeDexIds.ok) return excludeDexIds;
  const labels = readStringList(params, "labels", { lowercase: true, acceptsArray: true });
  if (!labels.ok) return labels;
  const quoteSymbols = readStringList(params, "quoteSymbols", { lowercase: true, acceptsArray: true });
  if (!quoteSymbols.ok) return quoteSymbols;

  const listEchoes: readonly (readonly [string, string[] | null])[] = [
    ["chainIds", chainIds],
    ["dexIds", dexIds.value],
    ["excludeDexIds", excludeDexIds.value],
    ["labels", labels.value],
    ["quoteSymbols", quoteSymbols.value],
  ];
  for (const [key, value] of listEchoes) {
    if (value !== null) filtersApplied[key] = value;
  }

  // Thresholds.
  const numeric: Record<string, number | null> = {};
  for (const key of Object.keys(NUMERIC_PARAMS)) {
    if (key === "limit" || key === "offset") continue;
    const read = readNumber(params, key, NUMERIC_PARAMS);
    if (!read.ok) return read;
    numeric[key] = read.value;
    if (read.value !== null) filtersApplied[key] = read.value;
  }

  // Quality flags.
  const requireSocials = readBoolean(params, "requireSocials");
  if (!requireSocials.ok) return requireSocials;
  const requireWebsite = readBoolean(params, "requireWebsite");
  if (!requireWebsite.ok) return requireWebsite;
  const requirePriceUsd = readBoolean(params, "requirePriceUsd");
  if (!requirePriceUsd.ok) return requirePriceUsd;
  const requireLiquidityUsd = readBoolean(params, "requireLiquidityUsd");
  if (!requireLiquidityUsd.ok) return requireLiquidityUsd;
  const onlyBoosted = readBoolean(params, "onlyBoosted");
  if (!onlyBoosted.ok) return onlyBoosted;

  const flagEchoes: readonly (readonly [string, boolean])[] = [
    ["requireSocials", requireSocials.value],
    ["requireWebsite", requireWebsite.value],
    ["requirePriceUsd", requirePriceUsd.value],
    ["requireLiquidityUsd", requireLiquidityUsd.value],
    ["onlyBoosted", onlyBoosted.value],
  ];
  for (const [key, value] of flagEchoes) {
    if (value) filtersApplied[key] = true;
  }

  return {
    ok: true,
    query: {
      window: window.value,
      fields: fields.fields,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      limit: effectiveLimit,
      offset: offset.value ?? 0,
      explainDrops: explainDrops.value,
      filters: {
        chainIds,
        dexIds: dexIds.value,
        excludeDexIds: excludeDexIds.value,
        labels: labels.value,
        quoteSymbols: quoteSymbols.value,
        minLiquidityUsd: numeric.minLiquidityUsd ?? null,
        maxLiquidityUsd: numeric.maxLiquidityUsd ?? null,
        minVolumeUsd: numeric.minVolumeUsd ?? null,
        maxVolumeUsd: numeric.maxVolumeUsd ?? null,
        minFdvUsd: numeric.minFdvUsd ?? null,
        maxFdvUsd: numeric.maxFdvUsd ?? null,
        minMarketCapUsd: numeric.minMarketCapUsd ?? null,
        maxMarketCapUsd: numeric.maxMarketCapUsd ?? null,
        minTxnCount: numeric.minTxnCount ?? null,
        minBuySellRatio: numeric.minBuySellRatio ?? null,
        maxBuySellRatio: numeric.maxBuySellRatio ?? null,
        minPriceChangePct: numeric.minPriceChangePct ?? null,
        maxPriceChangePct: numeric.maxPriceChangePct ?? null,
        minTurnoverRatio: numeric.minTurnoverRatio ?? null,
        maxTurnoverRatio: numeric.maxTurnoverRatio ?? null,
        minQuoteDepthTokens: numeric.minQuoteDepthTokens ?? null,
        minPairAgeSeconds: numeric.minPairAgeSeconds ?? null,
        maxPairAgeSeconds: numeric.maxPairAgeSeconds ?? null,
        requireSocials: requireSocials.value,
        requireWebsite: requireWebsite.value,
        requirePriceUsd: requirePriceUsd.value,
        requireLiquidityUsd: requireLiquidityUsd.value,
        onlyBoosted: onlyBoosted.value,
      },
      filtersApplied,
    },
  };
}
