/**
 * The untrusted-param boundary for the Virtuals list tools.
 *
 * EVERY RULE HERE CLOSES A MEASURED DEFECT. The original set closed four
 * clamps that turned a typo into a wrong answer (`limit: 500` silently became
 * 50; `status: "graduatd"` silently became "all"; an unknown `sortBy` silently
 * became mcap). PR-C1 adds the reason those refusals matter more on this
 * provider than anywhere else, measured on 2026-09-04:
 *
 *   - an UNKNOWN FILTER KEY is silently ignored and the provider returns the
 *     FULL population (`filters[bogusKeyXyz]=1` -> all 56,915 BASE rows);
 *   - an UNKNOWN VALUE in a known key returns ZERO rows with HTTP 200
 *     (`filters[factory]=ZZZ`, `filters[role]=ZZZ`, `filters[category]=ZZZ`);
 *   - `filters[status]` accepts ONLY the bare numeric form: every string and
 *     every operator form is ignored and returns the unfiltered population;
 *   - a NONSENSE SORT DIRECTION (`holderCount:sideways`) is accepted and
 *     silently treated as `desc`, while a MISSING direction is a 400.
 *
 * Nothing about a wrong request is observable in the response, so the vocabulary
 * has to be closed HERE. This module owns which keys exist and what they may
 * hold; the numeric readers themselves are the shared ones in
 * `../runtime/list-params.ts`, never a second copy of the number rules.
 */

import {
  VIRTUALS_FACTORIES,
  VIRTUALS_ROLES,
  VIRTUALS_SEARCH_SCOPES,
  VIRTUALS_SORT_DIRECTIONS,
  VIRTUALS_SORT_FIELDS,
  VIRTUALS_STATUS_FILTERS,
  VIRTUALS_VIBES_STATUSES,
  type VirtualsChain,
  type VirtualsFactory,
  type VirtualsFilters,
  type VirtualsRole,
  type VirtualsSearchScope,
  type VirtualsSortDirection,
  type VirtualsSortField,
  type VirtualsStatusFilter,
  type VirtualsVibesStatus,
} from "@tools/virtuals/types.js";
import {
  isAbsent,
  readNumber,
  type FiltersApplied,
  type NumericParamSpecs,
  type Read,
} from "../runtime/list-params.js";
import { VIRTUALS_CHAIN_SLUGS, resolveVirtualsChain } from "./chain-param.js";

/**
 * OUR page bound, and the reason for it. The provider served
 * `pagination[pageSize]=10000` live, so 100 is not its limit - it is ours: an
 * agent row carries 84 fields, and even after the projection drops the free-text
 * blobs a hundred rows is already a large tool result. Filtering is now
 * SERVER-SIDE, so a narrower page is not a narrower search: rows past the page
 * are reachable with `page`, and `totalMatched` says how many the filter found.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * `page` has no useful upper bound of ours - the provider reports 56,915 rows
 * on BASE alone - so the ceiling exists only to reject a nonsense value.
 */
const MAX_PAGE = 10_000;

export const VIRTUALS_LIST_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: MAX_PAGE_SIZE },
  pageSize: { domain: "nonNegative", integer: true, min: 1, max: MAX_PAGE_SIZE },
  page: { domain: "nonNegative", integer: true, min: 1, max: MAX_PAGE },

  minMcapInVirtual: { domain: "nonNegative" },
  maxMcapInVirtual: { domain: "nonNegative" },
  minHolderCount: { domain: "nonNegative", integer: true },
  maxHolderCount: { domain: "nonNegative", integer: true },
  minVolume24h: { domain: "nonNegative" },
  maxVolume24h: { domain: "nonNegative" },
  minLiquidityUsd: { domain: "nonNegative" },
  maxLiquidityUsd: { domain: "nonNegative" },
  // A price change is a SIGNED threshold: "down no more than 20 percent" is a
  // real screen, and a nonNegative domain would refuse it.
  minPriceChangePercent24h: { domain: "signed" },
  maxPriceChangePercent24h: { domain: "signed" },
  minTop10HolderPercentage: { domain: "nonNegative", max: 100 },
  maxTop10HolderPercentage: { domain: "nonNegative", max: 100 },
};

export type StatusFilter = VirtualsStatusFilter | "all";

const STATUS_FILTERS: readonly StatusFilter[] = [...VIRTUALS_STATUS_FILTERS, "all"];

/**
 * The four legacy keywords, kept as ALIASES of provider sort attributes so the
 * previous contract keeps working while the full 26-attribute surface opens.
 * `recentGraduation` is the one that is not a rename: it also implies the
 * graduated population, which the handler applies as `hasGraduated`.
 */
export const SORT_ALIASES: Record<string, VirtualsSortField> = {
  mcap: "mcapInVirtual",
  volume: "volume24h",
  newest: "createdAt",
  recentGraduation: "lpCreatedAt",
};

/** Everything `sortBy` accepts: the 26 provider attributes plus the aliases. */
export const SORT_CHOICES: readonly string[] = [
  ...VIRTUALS_SORT_FIELDS,
  ...Object.keys(SORT_ALIASES),
];

/**
 * The legal chain values, as the MANIFEST spells them - a refusal must name the
 * vocabulary the agent was given, not the provider's internal one.
 */
const CHAIN_LIST = VIRTUALS_CHAIN_SLUGS.join(", ");

export interface VirtualsListRequest {
  readonly chain: VirtualsChain;
  readonly statusFilter: StatusFilter;
  /** The keyword as the agent spells it, for the echo. */
  readonly sortKeyword: string;
  readonly sort: VirtualsSortField;
  readonly sortDirection: VirtualsSortDirection;
  readonly pageSize: number;
  readonly page: number;
  readonly filters: VirtualsFilters;
  readonly includePriceSeries: boolean;
  /** Exactly the keys the caller supplied, normalised, for `filtersApplied`. */
  readonly applied: FiltersApplied;
}

export function readChain(params: Record<string, unknown>): Read<VirtualsChain> {
  const raw = params.chain;
  if (isAbsent(raw)) {
    return { ok: false, reason: `Missing required: chain (one of ${CHAIN_LIST})` };
  }
  if (typeof raw !== "string") {
    return { ok: false, reason: `"chain" must be a string, not ${typeof raw}. Legal values: ${CHAIN_LIST}.` };
  }
  const chain = resolveVirtualsChain(raw);
  if (!chain) {
    return { ok: false, reason: `Invalid chain "${raw}". Must be one of ${CHAIN_LIST}.` };
  }
  return { ok: true, value: chain };
}

/**
 * A TRI-STATE boolean: absent stays absent. The shared `readBoolean` folds an
 * absent value to `false`, which on this provider is not "no opinion" - it is
 * `filters[isVerified]=false`, a different and much smaller population.
 */
function readOptionalBoolean(
  params: Record<string, unknown>,
  key: string,
): Read<boolean | undefined> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: undefined };
  if (typeof raw !== "boolean") {
    return { ok: false, reason: `"${key}" must be true or false, not ${typeof raw}.` };
  }
  return { ok: true, value: raw };
}

/** An enum with NO fallback: absent stays absent so the filter is not sent. */
function readOptionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  extra = "",
): Read<T | undefined> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a string, not ${typeof raw}. Legal values: ${allowed.join(", ")}.` };
  }
  const normalised = raw.trim().toLowerCase();
  const match = allowed.find((candidate) => candidate.toLowerCase() === normalised);
  if (match === undefined) {
    return {
      ok: false,
      reason: `Unknown ${key} "${raw}". Legal values: ${allowed.join(", ")}.${extra}`,
    };
  }
  return { ok: true, value: match };
}

/** A bounded free-text value. Refuses an empty or oversized string by name. */
const MAX_TEXT_PARAM = 128;
function readOptionalText(
  params: Record<string, unknown>,
  key: string,
): Read<string | undefined> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a string, not ${typeof raw}.` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `"${key}" was blank. Omit it rather than sending an empty string.` };
  }
  if (trimmed.length > MAX_TEXT_PARAM) {
    return { ok: false, reason: `"${key}" must be at most ${MAX_TEXT_PARAM} characters, received ${trimmed.length}.` };
  }
  return { ok: true, value: trimmed };
}

/**
 * A date threshold. Accepts `YYYY-MM-DD` and full ISO, both of which the
 * provider honours, and REFUSES anything unparseable: an unparseable date sent
 * upstream is not an error there, it is a filter that matches nothing.
 */
function readOptionalDate(
  params: Record<string, unknown>,
  key: string,
): Read<string | undefined> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a date string, not ${typeof raw}.` };
  }
  const trimmed = raw.trim();
  if (!Number.isFinite(Date.parse(trimmed))) {
    return {
      ok: false,
      reason: `"${key}" is not a date this reader can parse ("${raw}"). Use YYYY-MM-DD or a full ISO `
        + "timestamp. An unparseable date is not refused upstream - it silently matches nothing.",
    };
  }
  return { ok: true, value: trimmed };
}

function readWindowNumber(
  params: Record<string, unknown>,
  key: "page",
  fallback: number,
): Read<number> {
  const read = readNumber(params, key, VIRTUALS_LIST_NUMERIC_PARAMS);
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? fallback };
}

/**
 * `limit` and `pageSize` are now the SAME knob under two spellings: with
 * server-side filtering there is no over-fetch window to size separately, so
 * one page IS the answer. Both spellings stay accepted - the manifest declares
 * them `atMostOne` - and sending both is refused rather than silently resolved,
 * because a dropped spelling is indistinguishable from one that took effect.
 */
function readPageSize(params: Record<string, unknown>): Read<number> {
  const hasLimit = !isAbsent(params.limit);
  const hasPageSize = !isAbsent(params.pageSize);
  if (hasLimit && hasPageSize) {
    return {
      ok: false,
      reason:
        "Send `limit` OR `pageSize`, not both: they are the same knob under two spellings now that "
        + "filtering happens server-side. Whichever one was dropped would be invisible to you.",
    };
  }
  const key = hasPageSize ? "pageSize" : "limit";
  const read = readNumber(params, key, VIRTUALS_LIST_NUMERIC_PARAMS);
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? DEFAULT_PAGE_SIZE };
}

function readStatusFilter(params: Record<string, unknown>): Read<StatusFilter> {
  const raw = params.status;
  if (isAbsent(raw)) return { ok: true, value: "all" };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"status" must be a string, not ${typeof raw}. Legal values: ${STATUS_FILTERS.join(", ")}.` };
  }
  const value = raw.trim().toLowerCase();
  const match = STATUS_FILTERS.find((candidate) => candidate.toLowerCase() === value);
  if (match === undefined) {
    return {
      ok: false,
      reason: `Unknown status "${raw}". Legal values: ${STATUS_FILTERS.join(", ")}. `
        + "It is NOT applied as a no-op - an unrecognised status used to return the unfiltered list.",
    };
  }
  return { ok: true, value: match };
}

/**
 * `sortBy` is the documented param; `sort` stays accepted as its alias and
 * sending both is refused. An unknown keyword is refused rather than folded to
 * mcap - the whole `status:"undergrad"` bug was a wrong sort silently deciding
 * which rows existed.
 */
function readSortKeyword(params: Record<string, unknown>): Read<string> {
  const hasSortBy = !isAbsent(params.sortBy);
  const hasSort = !isAbsent(params.sort);
  if (hasSortBy && hasSort) {
    return {
      ok: false,
      reason: "Send `sortBy` OR `sort`, not both - they are the same knob and a dropped spelling is "
        + "indistinguishable from one that was honoured.",
    };
  }
  if (!hasSortBy && !hasSort) return { ok: true, value: "mcap" };
  const key = hasSortBy ? "sortBy" : "sort";
  const raw = params[key];
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a string, not ${typeof raw}. Legal values: ${SORT_CHOICES.join(", ")}.` };
  }
  const trimmed = raw.trim();
  const match = SORT_CHOICES.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  if (match === undefined) {
    return {
      ok: false,
      reason: `Unknown ${key} "${raw}". Legal values: ${SORT_CHOICES.join(", ")}. The provider refuses `
        + "an attribute it does not have (it answered 400 \"Attribute totalSupply not found on model "
        + "api::virtual.virtual\"), so an unlisted key is a failed call, not a default order.",
    };
  }
  return { ok: true, value: match };
}

interface RangeRead {
  readonly ok: true;
  readonly value: { min?: number; max?: number } | undefined;
}

function readRange(
  params: Record<string, unknown>,
  minKey: string,
  maxKey: string,
  applied: FiltersApplied,
): Read<{ min?: number; max?: number } | undefined> | RangeRead {
  const min = readNumber(params, minKey, VIRTUALS_LIST_NUMERIC_PARAMS);
  if (!min.ok) return min;
  const max = readNumber(params, maxKey, VIRTUALS_LIST_NUMERIC_PARAMS);
  if (!max.ok) return max;
  if (min.value === null && max.value === null) return { ok: true, value: undefined };
  if (min.value !== null && max.value !== null && min.value > max.value) {
    return {
      ok: false,
      reason: `"${minKey}" (${min.value}) is greater than "${maxKey}" (${max.value}), which can never match a row.`,
    };
  }
  if (min.value !== null) applied[minKey] = min.value;
  if (max.value !== null) applied[maxKey] = max.value;
  return {
    ok: true,
    value: {
      ...(min.value !== null ? { min: min.value } : {}),
      ...(max.value !== null ? { max: max.value } : {}),
    },
  };
}

/** Read `virtuals.list`'s full param set, or refuse by name on the first defect. */
export function readVirtualsListParams(
  params: Record<string, unknown>,
): Read<VirtualsListRequest> {
  const applied: FiltersApplied = {};

  const chain = readChain(params);
  if (!chain.ok) return chain;
  const statusFilter = readStatusFilter(params);
  if (!statusFilter.ok) return statusFilter;
  const sortKeyword = readSortKeyword(params);
  if (!sortKeyword.ok) return sortKeyword;
  const sortDirection = readOptionalEnum(params, "sortDirection", VIRTUALS_SORT_DIRECTIONS);
  if (!sortDirection.ok) return sortDirection;
  const pageSize = readPageSize(params);
  if (!pageSize.ok) return pageSize;
  const page = readWindowNumber(params, "page", 1);
  if (!page.ok) return page;

  const query = readOptionalText(params, "query");
  if (!query.ok) return query;
  const searchScope = readOptionalEnum(params, "searchScope", VIRTUALS_SEARCH_SCOPES);
  if (!searchScope.ok) return searchScope;
  if (searchScope.value !== undefined && query.value === undefined) {
    return {
      ok: false,
      reason: "`searchScope` was sent without `query`, so it would decide nothing. Send the text to "
        + "search for, or omit both.",
    };
  }
  const symbol = readOptionalText(params, "symbol");
  if (!symbol.ok) return symbol;
  const tokenAddress = readOptionalText(params, "tokenAddress");
  if (!tokenAddress.ok) return tokenAddress;
  const creatorWallet = readOptionalText(params, "creatorWallet");
  if (!creatorWallet.ok) return creatorWallet;

  const factory = readOptionalEnum<VirtualsFactory>(
    params,
    "factory",
    VIRTUALS_FACTORIES,
    " Note: every ROBOTIC_* member returned zero rows live - robotics agents carry the plain factory "
      + "plus `isRobotics: true`, so use `isRobotics` for that screen.",
  );
  if (!factory.ok) return factory;
  const role = readOptionalEnum<VirtualsRole>(params, "role", VIRTUALS_ROLES);
  if (!role.ok) return role;
  const vibesStatus = readOptionalEnum<VirtualsVibesStatus>(
    params,
    "vibesStatus",
    VIRTUALS_VIBES_STATUSES,
  );
  if (!vibesStatus.ok) return vibesStatus;

  const booleanKeys = [
    "isVerified",
    "isDevCommitted",
    "hasMarginTrading",
    "hasFounderVideo",
    "hasRevenueConnect",
    "hasStaking",
    "hasGraduated",
    "hasGenesis",
    "hasAntiSniperTax",
    "hasAirdrop",
    "needAcf",
    "isProject60days",
    "launchRadarEnabled",
    "isRobotics",
    "includeLaunchX",
    "excludeLaunchX",
    "includePriceSeries",
  ] as const;
  const flags: Partial<Record<(typeof booleanKeys)[number], boolean>> = {};
  for (const key of booleanKeys) {
    const read = readOptionalBoolean(params, key);
    if (!read.ok) return read;
    if (read.value !== undefined) {
      flags[key] = read.value;
      applied[key] = read.value;
    }
  }
  if (flags.includeLaunchX === true && flags.excludeLaunchX === true) {
    return {
      ok: false,
      reason: "`includeLaunchX` and `excludeLaunchX` are opposites; sending both true can never match a row.",
    };
  }

  const dates: Record<string, string | undefined> = {};
  for (const key of ["createdAfter", "launchedAfter", "genesisStartsAfter", "genesisStartsBefore"]) {
    const read = readOptionalDate(params, key);
    if (!read.ok) return read;
    if (read.value !== undefined) {
      dates[key] = read.value;
      applied[key] = read.value;
    }
  }

  const mcap = readRange(params, "minMcapInVirtual", "maxMcapInVirtual", applied);
  if (!mcap.ok) return mcap;
  const holders = readRange(params, "minHolderCount", "maxHolderCount", applied);
  if (!holders.ok) return holders;
  const volume = readRange(params, "minVolume24h", "maxVolume24h", applied);
  if (!volume.ok) return volume;
  const liquidity = readRange(params, "minLiquidityUsd", "maxLiquidityUsd", applied);
  if (!liquidity.ok) return liquidity;
  const change = readRange(params, "minPriceChangePercent24h", "maxPriceChangePercent24h", applied);
  if (!change.ok) return change;
  const top10 = readRange(params, "minTop10HolderPercentage", "maxTop10HolderPercentage", applied);
  if (!top10.ok) return top10;

  const sort = SORT_ALIASES[sortKeyword.value] ?? (sortKeyword.value as VirtualsSortField);
  const direction = sortDirection.value ?? "desc";

  applied.chain = chain.value;
  if (statusFilter.value !== "all") applied.status = statusFilter.value;
  applied.sortBy = sortKeyword.value;
  applied.sortDirection = direction;
  if (query.value !== undefined) {
    applied.query = query.value;
    applied.searchScope = searchScope.value ?? "any";
  }
  if (symbol.value !== undefined) applied.symbol = symbol.value;
  if (tokenAddress.value !== undefined) applied.tokenAddress = tokenAddress.value;
  if (creatorWallet.value !== undefined) applied.creatorWallet = creatorWallet.value;
  if (factory.value !== undefined) applied.factory = factory.value;
  if (role.value !== undefined) applied.role = role.value;
  if (vibesStatus.value !== undefined) applied.vibesStatus = vibesStatus.value;

  const filters: VirtualsFilters = {
    ...(statusFilter.value === "all" ? {} : { status: statusFilter.value }),
    ...(query.value !== undefined
      ? { query: query.value, searchScope: searchScope.value ?? "any" }
      : {}),
    ...(symbol.value !== undefined ? { symbol: symbol.value } : {}),
    ...(tokenAddress.value !== undefined ? { tokenAddress: tokenAddress.value } : {}),
    ...(creatorWallet.value !== undefined ? { creatorWallet: creatorWallet.value } : {}),
    ...(factory.value !== undefined ? { factory: factory.value } : {}),
    ...(role.value !== undefined ? { role: role.value } : {}),
    ...(vibesStatus.value !== undefined ? { vibesStatus: vibesStatus.value } : {}),
    ...(flags.isVerified !== undefined ? { isVerified: flags.isVerified } : {}),
    ...(flags.isDevCommitted !== undefined ? { isDevCommitted: flags.isDevCommitted } : {}),
    ...(flags.hasMarginTrading !== undefined ? { hasMarginTrading: flags.hasMarginTrading } : {}),
    ...(flags.hasFounderVideo !== undefined ? { hasFounderVideo: flags.hasFounderVideo } : {}),
    ...(flags.hasRevenueConnect !== undefined ? { hasRevenueConnect: flags.hasRevenueConnect } : {}),
    ...(flags.hasStaking !== undefined ? { hasStaking: flags.hasStaking } : {}),
    ...(flags.hasGraduated !== undefined ? { hasGraduated: flags.hasGraduated } : {}),
    ...(flags.hasGenesis !== undefined ? { hasGenesis: flags.hasGenesis } : {}),
    ...(flags.hasAntiSniperTax !== undefined ? { hasAntiSniperTax: flags.hasAntiSniperTax } : {}),
    ...(flags.hasAirdrop !== undefined ? { hasAirdrop: flags.hasAirdrop } : {}),
    ...(flags.needAcf !== undefined ? { needAcf: flags.needAcf } : {}),
    ...(flags.isProject60days !== undefined ? { isProject60days: flags.isProject60days } : {}),
    ...(flags.launchRadarEnabled !== undefined ? { launchRadarEnabled: flags.launchRadarEnabled } : {}),
    ...(flags.isRobotics !== undefined ? { isRobotics: flags.isRobotics } : {}),
    ...(flags.includeLaunchX !== undefined ? { includeLaunchX: flags.includeLaunchX } : {}),
    ...(flags.excludeLaunchX !== undefined ? { excludeLaunchX: flags.excludeLaunchX } : {}),
    ...(dates.createdAfter !== undefined ? { createdAfter: dates.createdAfter } : {}),
    ...(dates.launchedAfter !== undefined ? { launchedAfter: dates.launchedAfter } : {}),
    ...(dates.genesisStartsAfter !== undefined ? { genesisStartsAfter: dates.genesisStartsAfter } : {}),
    ...(dates.genesisStartsBefore !== undefined ? { genesisStartsBefore: dates.genesisStartsBefore } : {}),
    ...(mcap.value !== undefined ? { mcapInVirtual: mcap.value } : {}),
    ...(holders.value !== undefined ? { holderCount: holders.value } : {}),
    ...(volume.value !== undefined ? { volume24h: volume.value } : {}),
    ...(liquidity.value !== undefined ? { liquidityUsd: liquidity.value } : {}),
    ...(change.value !== undefined ? { priceChangePercent24h: change.value } : {}),
    ...(top10.value !== undefined ? { top10HolderPercentage: top10.value } : {}),
  };

  return {
    ok: true,
    value: {
      chain: chain.value,
      statusFilter: statusFilter.value,
      sortKeyword: sortKeyword.value,
      sort,
      sortDirection: direction,
      pageSize: pageSize.value,
      page: page.value,
      filters,
      includePriceSeries: flags.includePriceSeries === true,
      applied,
    },
  };
}

/** The window vocabulary shared by the graduations and genesis reads. */
export function readVirtualsWindow(
  params: Record<string, unknown>,
): Read<{ readonly pageSize: number; readonly page: number }> {
  const pageSize = readPageSize(params);
  if (!pageSize.ok) return pageSize;
  const page = readWindowNumber(params, "page", 1);
  if (!page.ok) return page;
  return { ok: true, value: { pageSize: pageSize.value, page: page.value } };
}

export { readOptionalBoolean, readOptionalDate, readOptionalEnum, readOptionalText };
