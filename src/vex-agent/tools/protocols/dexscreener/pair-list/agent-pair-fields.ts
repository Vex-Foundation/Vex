/**
 * The `AgentDexPair` field vocabulary — which fields exist, which are emitted by
 * default, and how the `fields` / `includeAllWindows` params select more.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE PROJECTION
 *
 * Measured on live payloads 2026-07-26: an agent-first rich pair row costs
 * 849.6 B, so 30 of them are 25,544 B. A lean 13-field row costs 358.7 B →
 * 10,816 B for the same 30 rows. Field projection is therefore the only lever
 * that lets EVERY row the provider returned reach the agent — the owner rule
 * forbids dropping rows, and permits choosing fields.
 *
 * So "which fields" is a budget decision that changes for budget reasons, while
 * "how a field is read off the provider row" changes for provider reasons. They
 * are split here so a future contributor widening the default set has to touch
 * exactly one list and can see the per-row cost next to it.
 *
 * `fields` is ADDITIVE, never subtractive: the lean set is always emitted, so a
 * caller can never accidentally project away `chainId` + `pairAddress` and hand
 * the agent a price with nothing to trade it on.
 */

import { PAIR_WINDOWS, type PairWindow } from "./pair-metrics.js";

/**
 * The default row. 13 fields, measured 358.7 B/row on live data.
 *
 * `baseName` is deliberately NOT here. A single live pool carries a
 * `baseToken.name` of 34,090 characters (re-confirmed twice, ~24 h apart), and
 * across one 30-row search name+symbol were 44,067 of 61,054 bytes. Leaving
 * `name` to the `fields` opt-in keeps that value out of the default call
 * WITHOUT truncating anything — the agent that asks for it still receives every
 * character.
 */
export const LEAN_PAIR_FIELDS = [
  "chainId",
  "dexId",
  "pairAddress",
  "baseAddress",
  "baseSymbol",
  "quoteSymbol",
  "priceUsd",
  "liquidityUsd",
  "volumeUsdSelected",
  "priceChangePctSelected",
  "turnoverRatioH24",
  "pairAgeSeconds",
  "labels",
] as const;

/** Per-window rich fields, expanded over {@link PAIR_WINDOWS}. */
const WINDOWED_RICH_FIELD_STEMS = [
  "volumeUsd",
  "priceChangePct",
  "txnBuyCount",
  "txnSellCount",
  "buySellRatio",
  "turnoverRatio",
] as const;

/** `m5` → `M5`, `h24` → `H24`. */
function windowSuffix(window: PairWindow): string {
  return window.charAt(0).toUpperCase() + window.slice(1).toUpperCase();
}

/**
 * Every per-window rich field name, e.g. `volumeUsdH24`, `txnBuyCountM5`.
 *
 * `turnoverRatioH24` is in the LEAN set, so it is filtered out here — a name
 * must belong to exactly one of the two sets or `resolvePairFields` would have
 * two answers for it.
 */
const LEAN_PAIR_FIELD_SET: ReadonlySet<string> = new Set(LEAN_PAIR_FIELDS);

export const WINDOWED_RICH_PAIR_FIELDS: readonly string[] = WINDOWED_RICH_FIELD_STEMS.flatMap(
  (stem) => PAIR_WINDOWS.map((window) => `${stem}${windowSuffix(window)}`),
).filter((name) => !LEAN_PAIR_FIELD_SET.has(name));

/** Opt-in fields that are not per-window. */
const FLAT_RICH_PAIR_FIELDS = [
  "baseName",
  "quoteAddress",
  "quoteName",
  "priceInQuoteToken",
  "liquidityBaseTokens",
  "liquidityQuoteTokens",
  "fdvUsd",
  "marketCapUsd",
  "marketCapEqualsFdv",
  "pairCreatedAtMs",
  "activeBoostCount",
  "hasWebsite",
  "hasSocials",
  "socialPlatforms",
  "imageUrl",
  "dexScreenerUrl",
  "decimalsAvailable",
] as const;

export const RICH_PAIR_FIELDS: readonly string[] = [
  ...FLAT_RICH_PAIR_FIELDS,
  ...WINDOWED_RICH_PAIR_FIELDS,
];

export const ALL_PAIR_FIELDS: readonly string[] = [...LEAN_PAIR_FIELDS, ...RICH_PAIR_FIELDS];

/**
 * `fields: "full"` — every field. Spelled as a sentinel rather than as a
 * boolean param so the honest sentence ("`full` returns every field") lives in
 * one place.
 */
export const ALL_FIELDS_SENTINEL = "full";

/** Resolved field selection. Membership is the only question callers ask. */
export type PairFieldSelection = ReadonlySet<string>;

export type PairFieldResolution =
  | { readonly ok: true; readonly fields: PairFieldSelection }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the requested field names against the vocabulary.
 *
 * Unknown names are REJECTED BY NAME rather than ignored: a caller who asks for
 * `liquidityQuote` and silently receives a row without it cannot tell the
 * difference between "the provider had no value" and "I misspelled the field".
 */
export function resolvePairFields(
  requested: readonly string[] | null,
  includeAllWindows: boolean,
): PairFieldResolution {
  const selected = new Set<string>(LEAN_PAIR_FIELDS);

  if (requested !== null) {
    if (requested.includes(ALL_FIELDS_SENTINEL)) {
      return { ok: true, fields: new Set(ALL_PAIR_FIELDS) };
    }
    const known = new Set(ALL_PAIR_FIELDS);
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason:
          `Unknown "fields" value(s): ${unknown.join(", ")}. `
          + `Use "${ALL_FIELDS_SENTINEL}" for every field, or pick from: ${ALL_PAIR_FIELDS.join(", ")}.`,
      };
    }
    for (const name of requested) selected.add(name);
  }

  if (includeAllWindows) {
    for (const name of WINDOWED_RICH_PAIR_FIELDS) selected.add(name);
  }

  return { ok: true, fields: selected };
}
