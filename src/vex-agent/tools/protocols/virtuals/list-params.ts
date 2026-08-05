/**
 * The untrusted-param boundary for the two chain-scoped `virtuals` list tools.
 *
 * EVERY RULE HERE CLOSES A MEASURED DEFECT (audit `reports/dexscreener-virtuals.md`
 * F12, SPEC §2.6 W9a). The handler used to CLAMP and COERCE:
 *
 *   - `limit: 500` silently became 50 and `limit: 0` silently became 20;
 *   - an unknown `status` (`"graduatd"`) silently became `"all"`, so a typo
 *     returned the UNFILTERED list;
 *   - an unknown `sortBy` silently became `mcap`, so a typo'd sort was invisible.
 *
 * All four are now refusals that NAME the parameter and the legal set, matching
 * `../runtime/list-params.ts`'s doctrine: *a silently ignored parameter is
 * indistinguishable from a parameter that had no matching rows*. That doctrine
 * matters more here than anywhere else in the namespace, because this is the
 * tool whose whole failure mode was an empty answer that looked like an empty
 * market.
 *
 * The numeric readers themselves are the shared ones — this module owns the
 * VOCABULARY (which keys exist, and their bounds), never a second copy of the
 * number-checking rules.
 */

import type { VirtualsSortField } from "@tools/virtuals/types.js";
import type { VirtualsChain } from "@tools/virtuals/types.js";
import {
  readNumber,
  type NumericParamSpecs,
  type Read,
} from "../runtime/list-params.js";
import { VIRTUALS_CHAIN_SLUGS, resolveVirtualsChain } from "./chain-param.js";

/** Rows returned to the agent after filtering. */
export const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Rows fetched per provider page. 200 is the provider's proven ceiling. */
export const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

/**
 * `page` has no useful upper bound of ours — the provider reports 54,785 rows
 * on BASE alone — so the ceiling exists only to reject a nonsense value that
 * would burn the page budget on empty responses.
 */
const MAX_PAGE = 10_000;

export const VIRTUALS_LIST_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: MAX_LIMIT },
  page: { domain: "nonNegative", integer: true, min: 1, max: MAX_PAGE },
  pageSize: { domain: "nonNegative", integer: true, min: 1, max: MAX_PAGE_SIZE },
};

export type StatusFilter = "undergrad" | "graduated" | "all";

const STATUS_FILTERS: readonly StatusFilter[] = ["undergrad", "graduated", "all"];

/** Agent-facing sort keyword → API sort field. */
export const SORT_MAP: Record<string, VirtualsSortField> = {
  mcap: "mcapInVirtual",
  volume: "volume24h",
  newest: "createdAt",
  recentGraduation: "lpCreatedAt",
};

/**
 * The legal chain values, as the MANIFEST spells them — a refusal must name the
 * vocabulary the agent was given, not the provider's internal one.
 */
const CHAIN_LIST = VIRTUALS_CHAIN_SLUGS.join(", ");

export interface VirtualsListRequest {
  readonly chain: VirtualsChain;
  readonly statusFilter: StatusFilter;
  /** The keyword as the agent spells it, for the echo. */
  readonly sortKeyword: string;
  readonly sort: VirtualsSortField;
  readonly limit: number;
  readonly page: number;
  readonly pageSize: number;
}

export function readChain(params: Record<string, unknown>): Read<VirtualsChain> {
  const raw = params.chain;
  if (raw === undefined || raw === null || raw === "") {
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

function readStatusFilter(params: Record<string, unknown>): Read<StatusFilter> {
  const raw = params.status;
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: "all" };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"status" must be a string, not ${typeof raw}. Legal values: ${STATUS_FILTERS.join(", ")}.` };
  }
  const value = raw.trim().toLowerCase();
  const match = STATUS_FILTERS.find((candidate) => candidate === value);
  if (match === undefined) {
    return {
      ok: false,
      reason: `Unknown status "${raw}". Legal values: ${STATUS_FILTERS.join(", ")}. `
        + "It is NOT applied as a no-op — an unrecognised status used to return the unfiltered list.",
    };
  }
  return { ok: true, value: match };
}

/**
 * `sortBy` is the documented param; `sort` stays accepted as its alias and
 * `sortBy` wins when both are sent. An unknown keyword is refused rather than
 * folded to mcap — the whole `status:"undergrad"` bug was a wrong sort silently
 * deciding which 50 rows existed.
 */
function readSortKeyword(params: Record<string, unknown>): Read<string> {
  const raw = params.sortBy ?? params.sort;
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: "mcap" };
  const key = params.sortBy === undefined || params.sortBy === null || params.sortBy === "" ? "sort" : "sortBy";
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a string, not ${typeof raw}. Legal values: ${Object.keys(SORT_MAP).join(", ")}.` };
  }
  if (SORT_MAP[raw] === undefined) {
    return { ok: false, reason: `Unknown ${key} "${raw}". Legal values: ${Object.keys(SORT_MAP).join(", ")}.` };
  }
  return { ok: true, value: raw };
}

function readWindowNumber(
  params: Record<string, unknown>,
  key: "limit" | "page" | "pageSize",
  fallback: number,
): Read<number> {
  const read = readNumber(params, key, VIRTUALS_LIST_NUMERIC_PARAMS);
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? fallback };
}

/** Read `virtuals.list`'s full param set, or refuse by name on the first defect. */
export function readVirtualsListParams(
  params: Record<string, unknown>,
): Read<VirtualsListRequest> {
  const chain = readChain(params);
  if (!chain.ok) return chain;
  const statusFilter = readStatusFilter(params);
  if (!statusFilter.ok) return statusFilter;
  const sortKeyword = readSortKeyword(params);
  if (!sortKeyword.ok) return sortKeyword;
  const limit = readWindowNumber(params, "limit", DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  const page = readWindowNumber(params, "page", 1);
  if (!page.ok) return page;
  const pageSize = readWindowNumber(params, "pageSize", DEFAULT_PAGE_SIZE);
  if (!pageSize.ok) return pageSize;

  const sort = SORT_MAP[sortKeyword.value];
  if (sort === undefined) {
    // Unreachable: readSortKeyword rejects any keyword absent from SORT_MAP.
    return { ok: false, reason: `Unknown sortBy "${sortKeyword.value}".` };
  }
  return {
    ok: true,
    value: {
      chain: chain.value,
      statusFilter: statusFilter.value,
      sortKeyword: sortKeyword.value,
      sort,
      limit: limit.value,
      page: page.value,
      pageSize: pageSize.value,
    },
  };
}

/** `virtuals.graduations` / `virtuals.geneses`: the same window vocabulary, no status/sort. */
export function readVirtualsWindow(
  params: Record<string, unknown>,
): Read<{ readonly limit: number; readonly page: number; readonly pageSize: number }> {
  const limit = readWindowNumber(params, "limit", DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  const page = readWindowNumber(params, "page", 1);
  if (!page.ok) return page;
  const pageSize = readWindowNumber(params, "pageSize", DEFAULT_PAGE_SIZE);
  if (!pageSize.ok) return pageSize;
  return { ok: true, value: { limit: limit.value, page: page.value, pageSize: pageSize.value } };
}
