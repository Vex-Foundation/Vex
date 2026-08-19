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
  "quoteAddress",
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
 * Which OUTPUT FIELD each `min*`/`max*` filter compares against.
 *
 * THE DEFECT THIS CLOSES, measured live and ranked [high]
 *
 * `minQuoteDepthTokens` reads `liquidityQuoteTokens`, and nothing said so. A
 * context-free agent did the only reasonable thing: it named the field after the
 * filter (`quoteDepthTokens`), was rejected, then guessed `priceInQuoteToken` —
 * which was ACCEPTED and returned a price where a depth was wanted. Three calls
 * for one number, and the middle one produced a plausible wrong answer.
 *
 * The map is the single source for three consumers: the param text (asserted to
 * contain its field), the `fields` rejection's mapping table, and the redirect
 * that catches a filter-shaped guess. `pair-filters.ts` reads the same metric it
 * names here.
 */
export const PAIR_FILTER_FIELD_READS: Readonly<Record<string, string>> = {
  minLiquidityUsd: "liquidityUsd",
  maxLiquidityUsd: "liquidityUsd",
  minQuoteDepthTokens: "liquidityQuoteTokens",
  minVolumeUsd: "volumeUsdSelected",
  maxVolumeUsd: "volumeUsdSelected",
  minFdvUsd: "fdvUsd",
  maxFdvUsd: "fdvUsd",
  minMarketCapUsd: "marketCapUsd",
  maxMarketCapUsd: "marketCapUsd",
  minTurnoverRatio: "turnoverRatioH24",
  maxTurnoverRatio: "turnoverRatioH24",
  minPriceChangePct: "priceChangePctSelected",
  maxPriceChangePct: "priceChangePctSelected",
  minPairAgeSeconds: "pairAgeSeconds",
  maxPairAgeSeconds: "pairAgeSeconds",
};

/**
 * Filters that read a number Vex derives per window and does NOT emit as one
 * field, so they cannot appear in the map above.
 *
 * They are listed rather than left out, so "is this filter accounted for?" has a
 * mechanical answer and a new filter cannot be added with no field statement at
 * all. Their param text names the parts the number is computed from instead.
 */
export const PAIR_FILTERS_WITHOUT_ONE_FIELD: readonly string[] = [
  "minTxnCount",
  "minBuySellRatio",
  "maxBuySellRatio",
];

/**
 * The vocabulary, grouped the way an agent chooses fields.
 *
 * A flat list of 40 names in a rejection is a wall the agent scans for something
 * that looks close — which is how `priceInQuoteToken` got picked for a depth
 * question. Four groups turn "find a plausible name" into "pick the group, then
 * the name". The groups PARTITION the vocabulary exactly; a name in two of them
 * would put the ambiguity back.
 */
export const PAIR_FIELD_GROUPS: Readonly<Record<string, readonly string[]>> = {
  /** What the row IS: the pool, its tokens, its age, its links and flags. */
  identity: [
    "chainId",
    "dexId",
    "pairAddress",
    "baseAddress",
    "baseSymbol",
    "baseName",
    "quoteAddress",
    "quoteSymbol",
    "quoteName",
    "labels",
    "pairAgeSeconds",
    "pairCreatedAtMs",
    "dexScreenerUrl",
    "imageUrl",
    "socialPlatforms",
    "hasWebsite",
    "hasSocials",
    "activeBoostCount",
    "decimalsAvailable",
  ],
  /** What it holds and what it is worth — the fake-depth detectors live here. */
  depth: [
    "priceUsd",
    "priceInQuoteToken",
    "liquidityUsd",
    "liquidityBaseTokens",
    "liquidityQuoteTokens",
    "fdvUsd",
    "marketCapUsd",
    "marketCapEqualsFdv",
    "turnoverRatioH24",
  ],
  /** Activity in the ONE window `window` selected. */
  flow: ["volumeUsdSelected", "priceChangePctSelected"],
  /** The same activity broken out per m5/h1/h6/h24 — `includeAllWindows` adds all of them. */
  windows: WINDOWED_RICH_PAIR_FIELDS,
};

/**
 * Lookup from a plausible wrong name to the field that answers it.
 *
 * Covers both the filter's own key (`minQuoteDepthTokens`) and the key with its
 * `min`/`max` prefix stripped (`quoteDepthTokens`) — the second is the spelling
 * that actually cost a live call.
 */
const FIELD_REDIRECTS: ReadonlyMap<string, string> = new Map(
  Object.entries(PAIR_FILTER_FIELD_READS).flatMap(([filter, field]) => {
    const stem = filter.replace(/^(min|max)/, "");
    const unprefixed = stem.charAt(0).toLowerCase() + stem.slice(1);
    return [
      [filter.toLowerCase(), field] as const,
      [unprefixed.toLowerCase(), field] as const,
    ];
  }),
);

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
 * The rejection an agent has to be able to recover from IN ONE RETRY.
 *
 * Three parts, each earning its bytes: the offending names, a REDIRECT for any
 * name that looks like a filter (the guess that actually happened live), and the
 * vocabulary grouped rather than dumped. The filter → field table rides along so
 * the next filter the agent reaches for is answered before it is asked.
 */
function unknownFieldsRejection(unknown: readonly string[]): string {
  const redirects = unknown
    .map((name) => [name, FIELD_REDIRECTS.get(name.toLowerCase())] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([name, field]) => `${name} → ${field}`);

  const groups = Object.entries(PAIR_FIELD_GROUPS)
    .map(([group, fields]) => `${group}: ${fields.join(", ")}`)
    .join(" | ");

  const mapping = Object.entries(PAIR_FILTER_FIELD_READS)
    .map(([filter, field]) => `${filter} → ${field}`)
    .join(", ");

  return [
    `Unknown "fields" value(s): ${unknown.join(", ")}.`,
    redirects.length > 0 ? `Did you mean: ${redirects.join("; ")}?` : "",
    `Use "${ALL_FIELDS_SENTINEL}" for every field, or pick from — ${groups}.`,
    `Filters read these fields: ${mapping}. minTxnCount, minBuySellRatio and maxBuySellRatio read `
      + "numbers computed per selected window that are not emitted as one field; request "
      + "txnBuyCount<Window>/txnSellCount<Window> or buySellRatio<Window> to see the parts.",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

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
      return { ok: false, reason: unknownFieldsRejection(unknown) };
    }
    for (const name of requested) selected.add(name);
  }

  if (includeAllWindows) {
    for (const name of WINDOWED_RICH_PAIR_FIELDS) selected.add(name);
  }

  return { ok: true, fields: selected };
}
