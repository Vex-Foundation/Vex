/**
 * The untrusted-param boundary shared by every protocol list tool.
 *
 * Namespace-neutral owner (relocated from `dexscreener/list-core/param-readers.ts`
 * when a fourth consumer — `trench` — joined DexScreener's pair/feed/narrative
 * list families; rule 04 default-owner move). DexScreener still imports the same
 * symbols through a re-export facade at the old path, so no dexscreener call site
 * changed.
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
 * Read a param the model may spell EITHER as a comma-separated string OR as an
 * array of strings, and return the canonical comma-string.
 *
 * The array form reduces to the string form — members are joined and the
 * ordinary comma path runs — so the two spellings cannot drift into two
 * behaviours. Measured cost of not accepting both
 * (`agents_dm/agentscan-phase4/persona-tests/call-records.json`, first record):
 * `dexscreener.profiles {chainIds: ["solana"]}` was rejected in 78 bytes while
 * `chainIds: "solana"` answered in 5,215. A JSON tool call makes the array
 * natural, and the param text alone did not prevent it.
 *
 * The string form is passed through BYTE-IDENTICAL. Callers send this value
 * upstream (`tokenAddresses`, `pairAddress`), and quietly re-normalising a
 * request that already worked is not a change this reader is entitled to make.
 *
 * A member that is not a string is named BY POSITION: re-sending a 12-element
 * array told only that "it must be strings" is a second wasted call.
 */
export function readStringOrArrayParam(
  params: Record<string, unknown>,
  key: string,
): Read<string | null> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return readStringArrayMembers(raw, key);
}

/**
 * The comma-string-ONLY reader, for params that are not lists of data.
 *
 * Kept separate rather than expressed as a flag inside the array reader so the
 * rejection can say WHY the array form is refused here — `fields` selects an
 * output projection, and an agent told only "must be a string" would reasonably
 * try the array again on the next tool.
 */
function readCommaStringParam(
  params: Record<string, unknown>,
  key: string,
): Read<string | null> {
  const raw = params[key];
  if (isAbsent(raw)) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return {
    ok: false,
    reason: Array.isArray(raw)
      ? `"${key}" must be a comma-separated string, not an array — it selects OUTPUT FIELDS rather `
        + 'than carrying a list of values (e.g. fields: "fdvUsd,marketCapUsd").'
      : `"${key}" must be a comma-separated string, not ${typeof raw}.`,
  };
}

function readStringArrayMembers(raw: unknown, key: string): Read<string | null> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: `"${key}" must be a comma-separated string or an array of strings, not ${typeof raw}.`,
    };
  }
  if (raw.length === 0) {
    return { ok: false, reason: `"${key}" was supplied as an empty array — it carries no values.` };
  }
  const members: string[] = [];
  for (const [index, member] of raw.entries()) {
    if (typeof member !== "string") {
      return {
        ok: false,
        reason:
          `"${key}" accepts a comma-separated string or an array of strings, but the item at `
          + `index ${index} is ${member === null ? "null" : typeof member}.`,
      };
    }
    members.push(member);
  }
  return { ok: true, value: members.join(",") };
}

/**
 * Comma-separated list (or array of strings) → normalised array.
 *
 * A local reader rather than the shared `strArray` helper because that one
 * returns `undefined` for a wrong-typed value, and a filter that silently does
 * not apply is exactly the failure mode this module exists to remove.
 *
 * `acceptsArray` mirrors the manifest's `acceptsStringArray` declaration and is
 * REQUIRED at every call site rather than defaulted, because widening a param is
 * a per-param decision: `fields` is a projection selector, not a data list, and
 * stays comma-string-only so the two ideas cannot blur.
 *
 * When arrays are accepted, both spellings run through the SAME split/trim/case
 * path — see {@link readStringOrArrayParam} — so `["ETHEREUM"]` and `"ETHEREUM"`
 * cannot normalise differently. Two spellings that both parse but disagree would
 * trade a loud rejection for a silent wrong answer.
 */
export function readStringList(
  params: Record<string, unknown>,
  key: string,
  options: { readonly lowercase: boolean; readonly acceptsArray: boolean },
): Read<string[] | null> {
  const read = options.acceptsArray
    ? readStringOrArrayParam(params, key)
    : readCommaStringParam(params, key);
  if (!read.ok) return read;
  if (read.value === null) return { ok: true, value: null };
  const parts = read.value
    .split(",")
    .map((part) => (options.lowercase ? part.trim().toLowerCase() : part.trim()))
    .filter((part) => part !== "");
  if (parts.length === 0) {
    return { ok: false, reason: `"${key}" was supplied but contained no values.` };
  }
  return { ok: true, value: parts };
}

/**
 * `omitFields` — subtractive projection, bounded by a per-family ALLOWLIST.
 *
 * An allowlist rather than a denylist because the set of fields that must never
 * leave a payload (identity, the provenance envelope, the external-content
 * labelling, every financially-consumed number) is the large set and the one
 * that grows. A new field is non-omittable by default, which is the safe
 * direction to be wrong in.
 *
 * The EMPTY allowlist is a real configuration, not a degenerate one: on the pair
 * family every subtractable text field is already opt-in via `fields`, so the
 * parameter could only ever be a no-op or a mistake. `note` carries that reason,
 * because "rejected" without it invites the agent to try the next name.
 */
export function readOmitFields(
  params: Record<string, unknown>,
  options: { readonly allowed: readonly string[]; readonly note: string },
): Read<readonly string[] | null> {
  const read = readStringList(params, "omitFields", { lowercase: false, acceptsArray: false });
  if (!read.ok) return read;
  if (read.value === null) return { ok: true, value: null };

  const rejected = read.value.filter((name) => !options.allowed.includes(name));
  if (rejected.length > 0) {
    return {
      ok: false,
      reason:
        `"omitFields" does not accept: ${rejected.join(", ")}. `
        + (options.allowed.length === 0
          ? options.note
          : `This tool can omit only: ${options.allowed.join(", ")}. ${options.note}`),
    };
  }
  return { ok: true, value: read.value };
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
