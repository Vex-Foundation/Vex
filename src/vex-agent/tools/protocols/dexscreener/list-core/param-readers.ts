/**
 * The untrusted-param boundary shared by every DexScreener list tool.
 *
 * `execute_tool` params come straight from the model, so these readers convert an
 * open `Record<string, unknown>` into typed values or an explicit rejection.
 * Extracted from `../pair-list/list-query.ts` unchanged when the feed and
 * narrative tools gained the same vocabulary: three families reading `limit` with
 * three copies of the rules is how `limit: 0` came to mean "20" in one handler
 * and "everything" in another.
 *
 * EVERY RULE HERE CLOSES A MEASURED DEFECT
 *
 * The previous readers checked `typeof value === "number"` and nothing else:
 *
 * - `minLiquidityUsd: NaN` made every comparison false, dropped all 30 rows and
 *   reported `matched: 0` — an empty market, invented by a bad parameter.
 * - `limit: -5` fell through to a hidden default.
 * - `limit: 0` meant "20" in `search` and "everything" in three other tools. One
 *   value, two opposite meanings; it is now REJECTED so it can mean neither.
 * - `minLiquidityUsd: 0` FILTERED, because `(liq ?? -Infinity) >= 0` is false for
 *   a null-liquidity row. A zero floor must be a no-op.
 * - Echoed identifiers kept the caller's casing (`"BASE"`) while every row said
 *   `"base"`, so the echo disagreed with the data it described.
 *
 * A rejection always NAMES the offending parameter. A silently ignored parameter
 * is indistinguishable from a parameter that had no matching rows.
 *
 * `limit` HAS NO DEFAULT anywhere. Omitting it returns every row the provider
 * returned; a default cap would be the silent-truncation pattern the project
 * rules forbid.
 */

export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface NumericParamSpec {
  /**
   * `nonNegative` — a negative value is meaningless (USD, counts, seconds,
   * ratios, token units). `signed` — a negative value is a real threshold
   * (`minPriceChangePct: -20` is "down no more than 20 %").
   */
  readonly domain: "nonNegative" | "signed";
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
}

export type NumericParamSpecs = Readonly<Record<string, NumericParamSpec>>;

/**
 * `limit` and `offset` — identical on every list tool in this namespace.
 *
 * `limit` has a MINIMUM of 1 and no default: `0` is rejected rather than given
 * one of its two historical meanings. The 200 ceiling is above the provider's
 * hard 30-row cap on purpose — it bounds the parameter without pretending the
 * provider can be asked for more.
 */
export const WINDOW_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: 200 },
  offset: { domain: "nonNegative", integer: true },
};

/** `undefined`, `null` and `""` all mean "not supplied" (JSON/storage semantics). */
export function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export function readNumber(
  params: Record<string, unknown>,
  key: string,
  specs: NumericParamSpecs,
): Read<number | null> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: null };
  const spec = specs[key];
  if (spec === undefined) {
    return { ok: false, reason: `"${key}" is not a numeric parameter of this tool.` };
  }
  if (typeof raw !== "number") {
    return { ok: false, reason: `"${key}" must be a number, not ${typeof raw}.` };
  }
  if (!Number.isFinite(raw)) {
    // NaN is the dangerous one: every comparison against it is false, so an
    // unchecked NaN threshold empties the result set and looks like a market.
    return {
      ok: false,
      reason: `"${key}" must be a finite number — received ${String(raw)}. Every comparison against `
        + "a non-finite threshold is false, which would silently drop every row.",
    };
  }
  if (spec.integer === true && !Number.isInteger(raw)) {
    return { ok: false, reason: `"${key}" must be a whole number, received ${raw}.` };
  }
  if (spec.domain === "nonNegative" && raw < 0) {
    return { ok: false, reason: `"${key}" must not be negative, received ${raw}.` };
  }
  if (spec.min !== undefined && raw < spec.min) {
    return { ok: false, reason: `"${key}" must be at least ${spec.min}, received ${raw}.` };
  }
  if (spec.max !== undefined && raw > spec.max) {
    return { ok: false, reason: `"${key}" must be at most ${spec.max}, received ${raw}.` };
  }
  return { ok: true, value: raw };
}

export function readBoolean(params: Record<string, unknown>, key: string): Read<boolean> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: false };
  if (typeof raw !== "boolean") {
    return { ok: false, reason: `"${key}" must be true or false, not ${typeof raw}.` };
  }
  return { ok: true, value: raw };
}

/**
 * Comma-separated list → normalised array.
 *
 * A local reader rather than the shared `strArray` helper because that one
 * returns `undefined` for a wrong-typed value, and a filter that silently does
 * not apply is exactly the failure mode this module exists to remove.
 */
export function readStringList(
  params: Record<string, unknown>,
  key: string,
  options: { readonly lowercase: boolean },
): Read<string[] | null> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: `"${key}" must be a comma-separated string, not ${typeof raw}.`,
    };
  }
  const parts = raw
    .split(",")
    .map((part) => (options.lowercase ? part.trim().toLowerCase() : part.trim()))
    .filter((part) => part !== "");
  if (parts.length === 0) {
    return { ok: false, reason: `"${key}" was supplied but contained no values.` };
  }
  return { ok: true, value: parts };
}

export function readEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): Read<T> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: fallback };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be one of: ${allowed.join(", ")}.` };
  }
  const normalised = raw.trim().toLowerCase();
  const match = allowed.find((candidate) => candidate.toLowerCase() === normalised);
  if (match === undefined) {
    return { ok: false, reason: `"${key}" must be one of: ${allowed.join(", ")} — received "${raw}".` };
  }
  return { ok: true, value: match };
}

/**
 * The echo of what was actually applied — only keys the caller supplied.
 *
 * Shared so `filtersApplied` means the same thing in every payload: normalised
 * values, absent keys omitted rather than emitted as `null`.
 */
export type FiltersApplied = Record<string, string | number | boolean | readonly string[]>;
