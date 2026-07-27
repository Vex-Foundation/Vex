/**
 * The untrusted-param boundary for the six DexScreener FEED tools.
 *
 * The reading RULES come from `../list-core/param-readers.ts`, shared with the
 * pair and narrative families. This module owns only the feed VOCABULARY.
 *
 * THE SHARED KEYS ARE THE POINT
 *
 * `limit`, `offset`, `fields`, `chainIds`, `sortBy` and `sortDir` mean exactly
 * what they mean on `dexscreener.search`, with the same validation and the same
 * absence of a default on `limit`. That is a product requirement, not tidiness:
 * before this card these six tools declared ZERO parameters between them, so the
 * agent compensated for missing filters with call volume, every call returned
 * everything, and the result blobbed. An agent that has learned `chainIds` on
 * `search` must not have to learn a second spelling here.
 *
 * The per-tool extras (`updatedWithinSeconds`, `ctoOnly`, `claimedWithinSeconds`,
 * `minBoostCountTotal`) appear only on the tools whose feed reports the underlying
 * field, and a caller who sends one to a tool that cannot honour it is REJECTED BY
 * NAME. A silently-ignored freshness filter is indistinguishable from a feed with
 * nothing fresh in it.
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

import {
  OMITTABLE_FEED_FIELDS,
  OMIT_FEED_FIELDS_NOTE,
  resolveFeedFields,
  type FeedFieldSelection,
} from "./feed-fields.js";

/**
 * Sort keys over a feed window.
 *
 * `relevance` means "as DexScreener returned" — its feed order is undisclosed and
 * is not a ranking. `eventAgeSeconds` is the uniform freshness key: it reads the
 * profile update, takeover claim or ad placement time depending on the feed, which
 * is why it has one name.
 */
export const FEED_SORT_KEYS = [
  "relevance",
  "eventAgeSeconds",
  "boostCount",
  "boostCountTotal",
  "adImpressionCount",
] as const;

export type FeedSortKey = (typeof FEED_SORT_KEYS)[number];

export const FEED_SORT_DIRECTIONS = ["desc", "asc"] as const;

export type FeedSortDirection = (typeof FEED_SORT_DIRECTIONS)[number];

/** Every threshold absolute — never a percentage of the sample. */
export interface FeedListFilters {
  chainIds: string[] | null;
  /**
   * Freshness ceiling in seconds, read off `eventAgeSeconds`. Supplied under the
   * name that matches the feed's own event: `updatedWithinSeconds` on the profile
   * feeds, `claimedWithinSeconds` on takeovers, `placedWithinSeconds` on ads.
   */
  maxEventAgeSeconds: number | null;
  /** The parameter name the caller actually used — it becomes the drop reason. */
  eventAgeParamKey: string | null;
  ctoOnly: boolean;
  minBoostCountTotal: number | null;
}

export interface FeedListQuery {
  fields: FeedFieldSelection;
  sortBy: FeedSortKey;
  sortDir: FeedSortDirection;
  /** `null` = every row the provider returned. There is deliberately no default. */
  limit: number | null;
  offset: number;
  filters: FeedListFilters;
  /** When true the envelope carries a capped sample of dropped rows with their values. */
  explainDrops: boolean;
  /** Echoed as `fieldsOmitted`. `null` when the caller supplied no `omitFields`. */
  fieldsOmitted: readonly string[] | null;
  filtersApplied: FiltersApplied;
}

export type FeedListQueryParse =
  | { readonly ok: true; readonly query: FeedListQuery }
  | { readonly ok: false; readonly reason: string };

/**
 * What one feed tool supports, declared by its handler.
 *
 * Everything here is a statement about the PROVIDER FEED, not a preference: a
 * boost feed carries no timestamp of any kind, so `eventAgeParam` is `null` there
 * and a freshness filter is refused rather than silently doing nothing.
 */
export interface FeedListQueryDefaults {
  /**
   * The name this feed's freshness filter is spelled with, or `null` when the feed
   * reports no event time (both boost feeds, and the `attention` merge).
   */
  readonly eventAgeParam: string | null;
  /** `true` only on the two profile feeds — the only ones carrying `cto`. */
  readonly supportsCtoFilter: boolean;
  /** `true` where rows carry cumulative boost units (both boost feeds, attention). */
  readonly supportsBoostFilter: boolean;
  /** Sort keys this feed can actually order by. Must include `relevance`. */
  readonly sortKeys: readonly FeedSortKey[];
  readonly sortBy: FeedSortKey;
}

const FEED_AGE_PARAM_SPEC: NumericParamSpecs = {
  updatedWithinSeconds: { domain: "nonNegative", integer: true },
  claimedWithinSeconds: { domain: "nonNegative", integer: true },
  placedWithinSeconds: { domain: "nonNegative", integer: true },
  minBoostCountTotal: { domain: "nonNegative", integer: true },
};

const FEED_NUMERIC_PARAMS: NumericParamSpecs = {
  ...WINDOW_NUMERIC_PARAMS,
  ...FEED_AGE_PARAM_SPEC,
};

/** Every freshness param name, so an unsupported one can be named in a refusal. */
const ALL_EVENT_AGE_PARAMS = [
  "updatedWithinSeconds",
  "claimedWithinSeconds",
  "placedWithinSeconds",
] as const;

/**
 * Parse and validate the feed vocabulary.
 *
 * Fails on the FIRST offending parameter: one actionable rejection is more useful
 * to an agent than a list it has to triage, and a second bad value surfaces on the
 * retry.
 */
export function parseFeedListQuery(
  params: Record<string, unknown>,
  defaults: FeedListQueryDefaults,
): FeedListQueryParse {
  const filtersApplied: FiltersApplied = {};

  const sortBy = readEnum(params, "sortBy", defaults.sortKeys, defaults.sortBy);
  if (!sortBy.ok) return sortBy;
  const sortDir = readEnum(params, "sortDir", FEED_SORT_DIRECTIONS, "desc");
  if (!sortDir.ok) return sortDir;
  filtersApplied.sortBy = sortBy.value;
  filtersApplied.sortDir = sortDir.value;

  const requestedFields = readStringList(params, "fields", { lowercase: false, acceptsArray: false });
  if (!requestedFields.ok) return requestedFields;
  const omitFields = readOmitFields(params, {
    allowed: OMITTABLE_FEED_FIELDS,
    note: OMIT_FEED_FIELDS_NOTE,
  });
  if (!omitFields.ok) return omitFields;
  const fields = resolveFeedFields(requestedFields.value, omitFields.value);
  if (!fields.ok) return fields;
  if (requestedFields.value !== null) filtersApplied.fields = requestedFields.value;
  if (omitFields.value !== null) filtersApplied.omitFields = omitFields.value;

  const limit = readNumber(params, "limit", FEED_NUMERIC_PARAMS);
  if (!limit.ok) return limit;
  const offset = readNumber(params, "offset", FEED_NUMERIC_PARAMS);
  if (!offset.ok) return offset;

  const chainIds = readStringList(params, "chainIds", { lowercase: true, acceptsArray: true });
  if (!chainIds.ok) return chainIds;
  if (chainIds.value !== null) filtersApplied.chainIds = chainIds.value;

  // Freshness. The supported spelling is refused for the OTHER spellings so an
  // agent that guessed `claimedWithinSeconds` on a profile feed is told the name
  // this tool uses, rather than receiving an unfiltered window.
  for (const key of ALL_EVENT_AGE_PARAMS) {
    if (key === defaults.eventAgeParam) continue;
    if (params[key] === undefined || params[key] === null || params[key] === "") continue;
    return {
      ok: false,
      reason: defaults.eventAgeParam === null
        ? `"${key}" does not apply to this tool — DexScreener's boost feeds carry no timestamp of `
          + "any kind, so nothing here can be filtered or sorted by age. Use "
          + "dexscreener.profiles.recent for a time-ordered feed."
        : `"${key}" is not this tool's freshness filter — use "${defaults.eventAgeParam}".`,
    };
  }
  let maxEventAgeSeconds: number | null = null;
  if (defaults.eventAgeParam !== null) {
    const age = readNumber(params, defaults.eventAgeParam, FEED_NUMERIC_PARAMS);
    if (!age.ok) return age;
    maxEventAgeSeconds = age.value;
    if (age.value !== null) filtersApplied[defaults.eventAgeParam] = age.value;
  }

  const ctoOnly = readBoolean(params, "ctoOnly");
  if (!ctoOnly.ok) return ctoOnly;
  if (ctoOnly.value && !defaults.supportsCtoFilter) {
    return {
      ok: false,
      reason:
        '"ctoOnly" does not apply to this tool — only the two token-profile feeds carry the cto '
        + "flag. Use dexscreener.communityTakeovers for the takeover feed itself, or "
        + "dexscreener.profiles / dexscreener.profiles.recent with ctoOnly.",
    };
  }
  if (ctoOnly.value) filtersApplied.ctoOnly = true;

  const minBoostCountTotal = readNumber(params, "minBoostCountTotal", FEED_NUMERIC_PARAMS);
  if (!minBoostCountTotal.ok) return minBoostCountTotal;
  if (minBoostCountTotal.value !== null && !defaults.supportsBoostFilter) {
    return {
      ok: false,
      reason:
        '"minBoostCountTotal" does not apply to this tool — its rows carry no boost units. Use '
        + "dexscreener.boosts, dexscreener.boosts.top or dexscreener.attention.",
    };
  }
  if (minBoostCountTotal.value !== null) {
    filtersApplied.minBoostCountTotal = minBoostCountTotal.value;
  }

  const explainDrops = readBoolean(params, "explainDrops");
  if (!explainDrops.ok) return explainDrops;
  if (explainDrops.value) filtersApplied.explainDrops = true;

  return {
    ok: true,
    query: {
      fields: fields.fields,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      limit: limit.value,
      offset: offset.value ?? 0,
      explainDrops: explainDrops.value,
      fieldsOmitted: omitFields.value,
      filters: {
        chainIds: chainIds.value,
        maxEventAgeSeconds,
        eventAgeParamKey: defaults.eventAgeParam,
        ctoOnly: ctoOnly.value,
        minBoostCountTotal: minBoostCountTotal.value,
      },
      filtersApplied,
    },
  };
}
