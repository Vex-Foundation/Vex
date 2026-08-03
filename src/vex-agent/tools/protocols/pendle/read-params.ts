/**
 * Input contract for the two Pendle READ tools.
 *
 * REJECT BY NAME, NEVER SILENTLY DROP. The shared `enumField` helper returns
 * `undefined` for a value outside its allowed set, which means a model that asks
 * for `sort: "yield"` gets liquidity ordering and is never told. For a screening
 * tool that is worse than an error: the agent believes it ranked by yield, and
 * every downstream decision inherits the mistake. Every parser here returns the
 * offending PARAM NAME and what it would have accepted.
 *
 * The same rule already governs fee parameters on the money path — a
 * caller-supplied one is refused by name so an attempted overcharge surfaces
 * instead of vanishing. This is the read-side application of it.
 *
 * This COMPLEMENTS the protocol runtime rather than duplicating it. The runtime
 * (`protocols/runtime/params.ts`) already refuses an undeclared KEY and a
 * wrong-typed value, by name. What it cannot see is a well-typed value that is
 * outside the domain — `sort: "yield"`, `order: "sideways"`, `limit: -5`,
 * `expiryBefore: "next tuesday"`. Those are rejected here, by name, with the
 * accepted set spelled out.
 *
 * Scope: NEW read params only. Nothing here touches the quote tools' schemas,
 * whose inputs feed the persisted prequote authorization contract and are frozen
 * for this tranche.
 */

import { PENDLE_SUPPORTED_CHAIN_IDS, pendleChainSlug, resolvePendleChainId } from "@tools/pendle/chains.js";
import type { PendleReadMarketSortKey } from "@tools/pendle/read/request.js";

/** A named rejection: which param was wrong, and what would have been accepted. */
export interface PendleReadParamRejection {
  param: string;
  message: string;
}

export type PendleReadParams<T> =
  | { ok: true; value: T }
  | { ok: false; rejection: PendleReadParamRejection };

function reject<T>(param: string, message: string): PendleReadParams<T> {
  return { ok: false, rejection: { param, message } };
}

// ── Primitive readers (each rejects by name) ───────────────────────

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readOptionalBool(raw: unknown, param: string): PendleReadParams<boolean | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return reject(param, `\`${param}\` must be true or false.`);
}

function readOptionalNumber(
  raw: unknown,
  param: string,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): PendleReadParams<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return reject(param, `\`${param}\` must be a finite number.`);
  }
  if (bounds.integer === true && !Number.isInteger(raw)) {
    return reject(param, `\`${param}\` must be a whole number.`);
  }
  if (bounds.min !== undefined && raw < bounds.min) {
    return reject(param, `\`${param}\` must be at least ${bounds.min}.`);
  }
  if (bounds.max !== undefined && raw > bounds.max) {
    return reject(param, `\`${param}\` must be at most ${bounds.max}.`);
  }
  return { ok: true, value: raw };
}

function readOptionalEnum<T extends string>(
  raw: unknown,
  param: string,
  allowed: readonly T[],
): PendleReadParams<T | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const lower = value.toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === lower);
  if (match === undefined) {
    return reject(param, `\`${param}\` must be one of: ${allowed.join(", ")}. Received "${value}".`);
  }
  return { ok: true, value: match };
}

/** ISO-8601 instant, rejected by name when unparseable. */
function readOptionalInstant(raw: unknown, param: string): PendleReadParams<number | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return reject(param, `\`${param}\` must be an ISO-8601 date or timestamp (for example 2027-01-01).`);
  }
  return { ok: true, value: ms };
}

/** Comma-separated free-text tokens, bounded and lowercased. */
function readCsv(raw: unknown, max: number): string[] | undefined {
  const value = readOptionalString(raw);
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .slice(0, max);
  return items.length > 0 ? items : undefined;
}

/**
 * Comma-separated chain slugs/ids → chain ids. An unsupported chain is REFUSED
 * by name with the supported list, rather than quietly producing a view that
 * omits it — "no markets on solana" and "we do not read solana" are different
 * answers.
 */
function readChains(raw: unknown, param: string): PendleReadParams<number[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const lower = value.toLowerCase();
  if (lower === "all") return { ok: true, value: undefined };

  const out: number[] = [];
  for (const token of lower.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const chainId = resolvePendleChainId(token);
    if (chainId === undefined) {
      const supported = PENDLE_SUPPORTED_CHAIN_IDS.map((id) => pendleChainSlug(id)).join(", ");
      return reject(param, `\`${param}\` contains "${token}", which Pendle does not support. Supported: ${supported}.`);
    }
    if (!out.includes(chainId)) out.push(chainId);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

// ── pendle.yields ──────────────────────────────────────────────────

/**
 * Agent-facing sort vocabulary → the provider sort key the read client accepts.
 *
 * Only keys whose ordering was verified live are here. The endpoint accepts an
 * unknown `order_by` and silently returns default order, so an unverified key
 * would make us claim a ranking we did not get.
 */
export const PENDLE_YIELD_SORTS = {
  liquidity: "details.liquidity",
  impliedApy: "details.impliedApy",
  aggregatedApy: "details.aggregatedApy",
  underlyingApy: "details.underlyingApy",
  maxBoostedApy: "details.maxBoostedApy",
  tvl: "details.totalTvl",
  volume: "details.tradingVolume",
  expiry: "expiry",
  name: "name",
} as const satisfies Record<string, PendleReadMarketSortKey>;

export type PendleYieldSort = keyof typeof PENDLE_YIELD_SORTS;

const YIELD_SORT_KEYS = Object.keys(PENDLE_YIELD_SORTS) as PendleYieldSort[];

/** Row fields a caller may keep. `all` (the default) keeps everything. */
export const PENDLE_YIELD_FIELDS = [
  "identity",
  "apy",
  "liquidity",
  "expiry",
  "legs",
  "points",
  "protocols",
] as const;

export type PendleYieldField = (typeof PENDLE_YIELD_FIELDS)[number];

export interface PendleYieldsQuery {
  chainIds: number[] | undefined;
  minLiquidityUsd: number | undefined;
  maxLiquidityUsd: number | undefined;
  minImpliedApyPercent: number | undefined;
  maxImpliedApyPercent: number | undefined;
  expiryBeforeMs: number | undefined;
  expiryAfterMs: number | undefined;
  minDaysToExpiry: number | undefined;
  maxDaysToExpiry: number | undefined;
  underlyingSymbol: string | undefined;
  categories: string[] | undefined;
  excludeCategories: string[] | undefined;
  isNew: boolean | undefined;
  isPrime: boolean | undefined;
  includeMatured: boolean;
  sort: PendleYieldSort;
  order: "asc" | "desc";
  offset: number;
  limit: number;
  fields: PendleYieldField[] | undefined;
}

/** Default page size. There is NO hard ceiling — the caller sets its own. */
export const PENDLE_YIELDS_DEFAULT_LIMIT = 20;

export function parsePendleYieldsParams(p: Record<string, unknown>): PendleReadParams<PendleYieldsQuery> {
  const chains = readChains(p.chainIds, "chainIds");
  if (!chains.ok) return chains;

  const numeric: Array<[keyof PendleYieldsQuery, string, { min?: number; max?: number; integer?: boolean }]> = [
    ["minLiquidityUsd", "minLiquidityUsd", { min: 0 }],
    ["maxLiquidityUsd", "maxLiquidityUsd", { min: 0 }],
    ["minImpliedApyPercent", "minImpliedApyPercent", {}],
    ["maxImpliedApyPercent", "maxImpliedApyPercent", {}],
    ["minDaysToExpiry", "minDaysToExpiry", { integer: true }],
    ["maxDaysToExpiry", "maxDaysToExpiry", { integer: true }],
  ];
  const numbers: Partial<Record<string, number | undefined>> = {};
  for (const [, param, bounds] of numeric) {
    const parsed = readOptionalNumber(p[param], param, bounds);
    if (!parsed.ok) return parsed;
    numbers[param] = parsed.value;
  }

  const expiryBefore = readOptionalInstant(p.expiryBefore, "expiryBefore");
  if (!expiryBefore.ok) return expiryBefore;
  const expiryAfter = readOptionalInstant(p.expiryAfter, "expiryAfter");
  if (!expiryAfter.ok) return expiryAfter;

  const isNew = readOptionalBool(p.isNew, "isNew");
  if (!isNew.ok) return isNew;
  const isPrime = readOptionalBool(p.isPrime, "isPrime");
  if (!isPrime.ok) return isPrime;
  const includeMatured = readOptionalBool(p.includeMatured, "includeMatured");
  if (!includeMatured.ok) return includeMatured;

  const sort = readOptionalEnum(p.sort, "sort", YIELD_SORT_KEYS);
  if (!sort.ok) return sort;
  const order = readOptionalEnum(p.order, "order", ["asc", "desc"] as const);
  if (!order.ok) return order;

  const offset = readOptionalNumber(p.offset, "offset", { min: 0, integer: true });
  if (!offset.ok) return offset;
  const limit = readOptionalNumber(p.limit, "limit", { min: 1, integer: true });
  if (!limit.ok) return limit;

  const fields = parseFieldList(p.fields, "fields", PENDLE_YIELD_FIELDS);
  if (!fields.ok) return fields;

  const minLiquidity = numbers.minLiquidityUsd;
  const maxLiquidity = numbers.maxLiquidityUsd;
  if (minLiquidity !== undefined && maxLiquidity !== undefined && minLiquidity > maxLiquidity) {
    return reject("minLiquidityUsd", "`minLiquidityUsd` cannot be greater than `maxLiquidityUsd`.");
  }
  const minApy = numbers.minImpliedApyPercent;
  const maxApy = numbers.maxImpliedApyPercent;
  if (minApy !== undefined && maxApy !== undefined && minApy > maxApy) {
    return reject("minImpliedApyPercent", "`minImpliedApyPercent` cannot be greater than `maxImpliedApyPercent`.");
  }
  const minDays = numbers.minDaysToExpiry;
  const maxDays = numbers.maxDaysToExpiry;
  if (minDays !== undefined && maxDays !== undefined && minDays > maxDays) {
    return reject("minDaysToExpiry", "`minDaysToExpiry` cannot be greater than `maxDaysToExpiry`.");
  }

  return {
    ok: true,
    value: {
      chainIds: chains.value,
      minLiquidityUsd: minLiquidity,
      maxLiquidityUsd: maxLiquidity,
      minImpliedApyPercent: minApy,
      maxImpliedApyPercent: maxApy,
      expiryBeforeMs: expiryBefore.value,
      expiryAfterMs: expiryAfter.value,
      minDaysToExpiry: minDays,
      maxDaysToExpiry: maxDays,
      underlyingSymbol: readOptionalString(p.underlyingSymbol)?.toLowerCase(),
      categories: readCsv(p.categories, 16),
      excludeCategories: readCsv(p.excludeCategories, 16),
      isNew: isNew.value,
      isPrime: isPrime.value,
      includeMatured: includeMatured.value ?? false,
      sort: sort.value ?? "liquidity",
      order: order.value ?? "desc",
      offset: offset.value ?? 0,
      limit: limit.value ?? PENDLE_YIELDS_DEFAULT_LIMIT,
      fields: fields.value,
    },
  };
}

// ── pendle.position.value ──────────────────────────────────────────

export const PENDLE_POSITION_KINDS = ["pt", "yt", "lp", "sy"] as const;
export type PendlePositionKind = (typeof PENDLE_POSITION_KINDS)[number];

export const PENDLE_POSITION_SORTS = ["value", "expiry", "chain"] as const;
export type PendlePositionSort = (typeof PENDLE_POSITION_SORTS)[number];

export const PENDLE_POSITION_FIELDS = ["identity", "balance", "value", "expiry", "accrued"] as const;
export type PendlePositionField = (typeof PENDLE_POSITION_FIELDS)[number];

export interface PendlePositionsQuery {
  chainIds: number[] | undefined;
  kinds: PendlePositionKind[] | undefined;
  redeemableOnly: boolean;
  minValueUsd: number | undefined;
  includeAccrued: boolean;
  sort: PendlePositionSort;
  fields: PendlePositionField[] | undefined;
}

export function parsePendlePositionParams(
  p: Record<string, unknown>,
): PendleReadParams<PendlePositionsQuery> {
  const chains = readChains(p.chainIds, "chainIds");
  if (!chains.ok) return chains;

  const kinds = parseFieldList(p.kinds, "kinds", PENDLE_POSITION_KINDS);
  if (!kinds.ok) return kinds;

  const redeemableOnly = readOptionalBool(p.redeemableOnly, "redeemableOnly");
  if (!redeemableOnly.ok) return redeemableOnly;
  const includeAccrued = readOptionalBool(p.includeAccrued, "includeAccrued");
  if (!includeAccrued.ok) return includeAccrued;

  const minValueUsd = readOptionalNumber(p.minValueUsd, "minValueUsd", { min: 0 });
  if (!minValueUsd.ok) return minValueUsd;

  const sort = readOptionalEnum(p.sort, "sort", PENDLE_POSITION_SORTS);
  if (!sort.ok) return sort;

  const fields = parseFieldList(p.fields, "fields", PENDLE_POSITION_FIELDS);
  if (!fields.ok) return fields;

  return {
    ok: true,
    value: {
      chainIds: chains.value,
      kinds: kinds.value,
      redeemableOnly: redeemableOnly.value ?? false,
      minValueUsd: minValueUsd.value,
      includeAccrued: includeAccrued.value ?? true,
      sort: sort.value ?? "value",
      fields: fields.value,
    },
  };
}

// ── Shared: csv-of-enum with a named rejection ─────────────────────

function parseFieldList<T extends string>(
  raw: unknown,
  param: string,
  allowed: readonly T[],
): PendleReadParams<T[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  if (value.toLowerCase() === "all") return { ok: true, value: undefined };

  const out: T[] = [];
  for (const token of value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)) {
    const match = allowed.find((a) => a.toLowerCase() === token);
    if (match === undefined) {
      return reject(param, `\`${param}\` contains "${token}"; allowed values are: ${allowed.join(", ")}, or "all".`);
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}
