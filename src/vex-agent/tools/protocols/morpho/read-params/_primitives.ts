/**
 * Shared param-reading primitives for the Morpho tools.
 *
 * Extracted unchanged from the single `read-params.ts` when the vaults lane
 * arrived: the tools' own param contracts live in `./markets.ts` and
 * `./vaults.ts` beside this file, and `../read-params.ts` stays the public entry
 * point, so no import outside this folder moved.
 *
 * REJECT BY NAME, NEVER SILENTLY DROP, NEVER SILENTLY CLAMP. rules/90 is
 * explicit: a parameter the caller supplied and we ignored is indistinguishable,
 * from the caller's side, from a parameter that had no effect. On a screening
 * tool that is worse than an error - the agent believes it filtered to markets
 * above a liquidity floor, and every downstream sizing decision inherits the
 * mistake.
 *
 * This COMPLEMENTS the protocol runtime rather than duplicating it. The runtime
 * (`protocols/runtime/params.ts`) already refuses an undeclared KEY, a
 * wrong-typed value and an off-`enum` string. What it cannot see is a well-typed
 * value outside its DOMAIN: `limit: 500`, `minLltvPercent: -3`,
 * `offset: 2.5`, a `marketId` that is really an address. Those are refused here,
 * by name, with the accepted range spelled out.
 *
 * Percent-in / fraction-out is done here and only here. Morpho speaks fractions
 * (0.0412 = 4.12%) and the agent speaks percent, so every `*Percent` param is
 * divided by 100 exactly once, on the way into a filter.
 */

import { describeUnsupportedChain, resolveMorphoChainId } from "@tools/morpho/chains.js";

/** A named rejection: which param was wrong, and what would have been accepted. */
export interface MorphoParamRejection {
  param: string;
  message: string;
}

export type MorphoParams<T> = { ok: true; value: T } | { ok: false; rejection: MorphoParamRejection };

export function reject<T>(param: string, message: string): MorphoParams<T> {
  return { ok: false, rejection: { param, message } };
}

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Max comma-separated entries on any list param. Over the bound is a named refusal. */
export const MAX_CSV_ENTRIES = 20;

// -- Primitive readers ----------------------------------------------

export function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function readOptionalBool(raw: unknown, param: string): MorphoParams<boolean | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return reject(param, `\`${param}\` must be true or false. Received ${JSON.stringify(raw)}.`);
}

export function readOptionalNumber(
  raw: unknown,
  param: string,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): MorphoParams<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return reject(param, `\`${param}\` must be a finite number.`);
  }
  if (bounds.integer === true && !Number.isInteger(raw)) {
    return reject(param, `\`${param}\` must be a whole number. Received ${raw}.`);
  }
  if (bounds.min !== undefined && raw < bounds.min) {
    return reject(param, `\`${param}\` must be at least ${bounds.min}. Received ${raw}.`);
  }
  if (bounds.max !== undefined && raw > bounds.max) {
    return reject(
      param,
      `\`${param}\` must be at most ${bounds.max}. Received ${raw}. `
      + "Vex refuses the value rather than clamping it, so you always know what was actually applied.",
    );
  }
  return { ok: true, value: raw };
}

export function readOptionalEnum<T extends string>(
  raw: unknown,
  param: string,
  allowed: readonly T[],
): MorphoParams<T | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (match === undefined) {
    return reject(param, `\`${param}\` must be one of: ${allowed.join(", ")}. Received "${value}".`);
  }
  return { ok: true, value: match };
}

/**
 * EVM addresses as a comma-separated string OR a string array (every manifest
 * declaring one of these params also declares `acceptsStringArray`). A malformed
 * entry is named.
 *
 * THE ARRAY BRANCH IS NOT OPTIONAL POLISH (funded live audit, 2026-08-18). This
 * reader used to open with `readOptionalString`, which yields `undefined` for an
 * array, so `tokenAddress: [USDC]` on `morpho.wallet.balance` read as NO filter
 * at all: the reply came back `nativeOnly`, "0 token(s) read", and no warning,
 * while the identical CSV form returned the wallet's real 0.403952 USDC. An
 * agent asking for a balance was told an absence of funds. Its sibling
 * `readChains` had the array branch from the start; this is the same shape, so
 * every entry - array member or CSV token - passes the SAME validation and a bad
 * one is still refused by name.
 */
export function readAddressCsv(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") return reject(param, `\`${param}\` array entries must be strings.`);
      tokens.push(...entry.split(","));
    }
  } else {
    const value = readOptionalString(raw);
    if (value === undefined) return { ok: true, value: undefined };
    tokens.push(...value.split(","));
  }

  const items = tokens.map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length > MAX_CSV_ENTRIES) {
    return reject(
      param,
      `\`${param}\` accepts at most ${MAX_CSV_ENTRIES} addresses, as a comma-separated string or an array; `
      + `${items.length} were supplied. `
      + "Narrow the list and retry - Vex will not silently drop the extras.",
    );
  }
  const out: string[] = [];
  for (const item of items) {
    if (!ADDRESS_PATTERN.test(item)) {
      return reject(param, `\`${param}\` contains "${item}", which is not a 0x-prefixed 40-hex EVM address.`);
    }
    const lower = item.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/**
 * `chainIds` accepts a comma-separated string OR a string array (the manifest
 * declares `acceptsStringArray`). An unsupported chain is refused by name with
 * the supported list, because "no markets on Katana" and "Vex does not read
 * Katana" are different answers.
 */
export function readChains(raw: unknown, param: string): MorphoParams<number[] | undefined> {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") return reject(param, `\`${param}\` array entries must be strings.`);
      tokens.push(entry);
    }
  } else {
    const value = readOptionalString(raw);
    if (value === undefined) return { ok: true, value: undefined };
    if (value.toLowerCase() === "all") return { ok: true, value: undefined };
    tokens.push(...value.split(","));
  }

  const out: number[] = [];
  for (const token of tokens.map((s) => s.trim()).filter((s) => s.length > 0)) {
    if (token.toLowerCase() === "all") return { ok: true, value: undefined };
    const chainId = resolveMorphoChainId(token);
    if (chainId === undefined) return reject(param, `\`${param}\`: ${describeUnsupportedChain(token)}`);
    if (!out.includes(chainId)) out.push(chainId);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/**
 * The tokens of a list param declared `acceptsStringArray`: a comma string, a
 * string array, or the sentinel `all`.
 *
 * WHY THIS EXISTS. The protocol runtime's `enum` check is a WHOLE-STRING exact
 * match, so a param whose documented form is a comma list cannot also declare
 * `enum` - `"identity,apy"` is refused at the boundary before the handler's own
 * splitting reader ever runs, and `"all"` with it. The fix is at the DECLARATION:
 * such a param declares `acceptsStringArray` and no `enum`, and validates its
 * members BY NAME here, where a rejection can say which token was wrong and what
 * the accepted set is. That rejection must never get weaker than the runtime's.
 */
export type CsvOrArray =
  | { kind: "absent" }
  | { kind: "all" }
  | { kind: "tokens"; tokens: string[] };

export function readCsvOrArray(raw: unknown, param: string): MorphoParams<CsvOrArray> {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") return reject(param, `\`${param}\` array entries must be strings.`);
      tokens.push(entry);
    }
  } else {
    const value = readOptionalString(raw);
    if (value === undefined) return { ok: true, value: { kind: "absent" } };
    tokens.push(...value.split(","));
  }

  const trimmed = tokens.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.some((token) => token.toLowerCase() === "all")) return { ok: true, value: { kind: "all" } };
  if (trimmed.length === 0) return { ok: true, value: { kind: "absent" } };
  return { ok: true, value: { kind: "tokens", tokens: trimmed } };
}

/** Ordered min/max sanity: a floor above its ceiling matches nothing, silently. */
export function checkRange(
  minParam: string,
  min: number | undefined,
  maxParam: string,
  max: number | undefined,
): MorphoParamRejection | null {
  if (min === undefined || max === undefined || min <= max) return null;
  return {
    param: minParam,
    message:
      `\`${minParam}\` (${min}) is greater than \`${maxParam}\` (${max}), so nothing can match. `
      + "Swap them or drop one.",
  };
}
