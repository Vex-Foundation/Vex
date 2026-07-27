/**
 * The untrusted-param boundary for `dexscreener.trending`.
 *
 * The reading RULES come from `../list-core/param-readers.ts`; `limit`, `offset`,
 * `fields`, `sortBy`, `sortDir` and `window` are the same keys, with the same
 * validation and the same absence of a default on `limit`, as on every other
 * DexScreener list tool.
 *
 * `trending` had exactly one parameter before this card — `limit`, with no maximum
 * and a `0`-means-everything reading that meant the opposite in `search`.
 */

import {
  WINDOW_NUMERIC_PARAMS,
  readEnum,
  readNumber,
  readStringList,
  type FiltersApplied,
  type NumericParamSpecs,
} from "../list-core/index.js";
import { PAIR_WINDOWS } from "../pair-list/index.js";

import { resolveNarrativeFields, type NarrativeFieldSelection } from "./narrative-fields.js";

/** The same four windows as the pair family — one vocabulary for "which timeframe". */
export type NarrativeWindow = (typeof PAIR_WINDOWS)[number];

export const NARRATIVE_SORT_KEYS = [
  "relevance",
  "marketCapUsd",
  "liquidityUsd",
  "volumeUsdH24",
  "narrativeTokenCount",
  "marketCapChangePct",
] as const;

export type NarrativeSortKey = (typeof NARRATIVE_SORT_KEYS)[number];

export const NARRATIVE_SORT_DIRECTIONS = ["desc", "asc"] as const;

export type NarrativeSortDirection = (typeof NARRATIVE_SORT_DIRECTIONS)[number];

export interface NarrativeListFilters {
  minTokenCount: number | null;
  minMarketCapUsd: number | null;
  minLiquidityUsd: number | null;
  minVolumeUsd: number | null;
}

export interface NarrativeListQuery {
  window: NarrativeWindow;
  fields: NarrativeFieldSelection;
  sortBy: NarrativeSortKey;
  sortDir: NarrativeSortDirection;
  /** `null` = every row the provider returned. No default. */
  limit: number | null;
  offset: number;
  filters: NarrativeListFilters;
  filtersApplied: FiltersApplied;
}

export type NarrativeListQueryParse =
  | { readonly ok: true; readonly query: NarrativeListQuery }
  | { readonly ok: false; readonly reason: string };

const NARRATIVE_NUMERIC_PARAMS: NumericParamSpecs = {
  ...WINDOW_NUMERIC_PARAMS,
  minTokenCount: { domain: "nonNegative", integer: true },
  minMarketCapUsd: { domain: "nonNegative" },
  minLiquidityUsd: { domain: "nonNegative" },
  minVolumeUsd: { domain: "nonNegative" },
};

export function parseNarrativeListQuery(
  params: Record<string, unknown>,
): NarrativeListQueryParse {
  const filtersApplied: FiltersApplied = {};

  const window = readEnum(params, "window", PAIR_WINDOWS, "h24");
  if (!window.ok) return window;
  // `relevance` (provider order) is the default because the provider order is
  // undisclosed: re-ranking by market cap and presenting the result as "trending"
  // would invent a ranking, and the largest narrative is not the rotating one.
  const sortBy = readEnum(params, "sortBy", NARRATIVE_SORT_KEYS, "relevance");
  if (!sortBy.ok) return sortBy;
  const sortDir = readEnum(params, "sortDir", NARRATIVE_SORT_DIRECTIONS, "desc");
  if (!sortDir.ok) return sortDir;
  filtersApplied.window = window.value;
  filtersApplied.sortBy = sortBy.value;
  filtersApplied.sortDir = sortDir.value;

  const requestedFields = readStringList(params, "fields", { lowercase: false });
  if (!requestedFields.ok) return requestedFields;
  const fields = resolveNarrativeFields(requestedFields.value);
  if (!fields.ok) return fields;
  if (requestedFields.value !== null) filtersApplied.fields = requestedFields.value;

  const limit = readNumber(params, "limit", NARRATIVE_NUMERIC_PARAMS);
  if (!limit.ok) return limit;
  const offset = readNumber(params, "offset", NARRATIVE_NUMERIC_PARAMS);
  if (!offset.ok) return offset;

  // A narrative is a THEME and spans every chain at once, so there is nothing on
  // a row for a chain filter to match. Refused by name rather than ignored, and
  // the refusal names the two tools that do answer the question.
  const chainIds = readStringList(params, "chainIds", { lowercase: true });
  if (!chainIds.ok) return chainIds;
  if (chainIds.value !== null) {
    return {
      ok: false,
      reason:
        '"chainIds" does not apply to a narrative feed — a narrative is a cross-chain theme and '
        + "carries no chain of its own. Use dexscreener.meta with chainIds to see one narrative's "
        + "pools on chosen chains, or dexscreener.search for tokens.",
    };
  }

  const numeric: Record<string, number | null> = {};
  for (const key of ["minTokenCount", "minMarketCapUsd", "minLiquidityUsd", "minVolumeUsd"]) {
    const read = readNumber(params, key, NARRATIVE_NUMERIC_PARAMS);
    if (!read.ok) return read;
    numeric[key] = read.value;
    if (read.value !== null) filtersApplied[key] = read.value;
  }

  return {
    ok: true,
    query: {
      window: window.value,
      fields: fields.fields,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      limit: limit.value,
      offset: offset.value ?? 0,
      filters: {
        minTokenCount: numeric.minTokenCount ?? null,
        minMarketCapUsd: numeric.minMarketCapUsd ?? null,
        minLiquidityUsd: numeric.minLiquidityUsd ?? null,
        minVolumeUsd: numeric.minVolumeUsd ?? null,
      },
      filtersApplied,
    },
  };
}
