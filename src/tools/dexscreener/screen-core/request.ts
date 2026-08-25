/**
 * The screening request model and the provider query-string builder.
 *
 * ONE owner for the screener channel's wire grammar. Every screening tool
 * (trending, top, gainers, losers, new, launchpad, and the token channel)
 * describes what it wants as a `ScreenRequest` and this module turns that into
 * the exact bracket-form query string the site sends. Nothing else in the
 * codebase may assemble that string, because the provider FAILS OPEN on filter
 * names it does not know: an unknown or misspelled key is silently dropped and
 * the answer comes back looking successful with the wrong population in it.
 * A local whitelist is the only defence, so the whitelist and the emitter are
 * the same table.
 *
 * Measured grammar facts this module encodes (recon sections 2.1 to 2.7, and
 * the 2026-08-24 live probes archived beside them):
 *
 *  - The site builds the string with
 *    `qs.stringify({rankBy, filters}, {encodeValuesOnly: true, ...})`, so the
 *    BRACKETS ARE LITERAL and only values are percent-encoded.
 *  - List filters index explicitly: `filters[chainIds][0]=solana`,
 *    `filters[chainIds][1]=bsc`. There is no repeated-key form.
 *  - `filters[excludedDexIds]` is a TRAP. The server applies a hidden default
 *    exclusion of bonding-curve launchpad dexes; sending the key AT ALL, even
 *    as the empty item `filters[excludedDexIds][]=`, replaces that default.
 *    Measured: solana 53,094 rows, with an empty exclusion list 102,676. So
 *    "exclude one dex" can make the result set bigger. Both ways of sending
 *    the key set `exclusionDefaultReplaced` on the built query, and callers
 *    must surface that.
 *  - Windowed thresholds nest the window: `filters[volume][h24][min]`. The
 *    window-free family (`liquidity`, `marketCap`, `fdv`, `pairAge`,
 *    `launchpadProgress`, `activeBoosts`) names its own window internally and
 *    ignores the path segment.
 *  - `filters[pairAge]` is in HOURS and accepts fractions. The domain speaks
 *    seconds, so the conversion happens here, once.
 *  - `filters[metaIds]` takes narrative IDs, never slugs. A slug is accepted
 *    and returns zero rows, which is the fail-open failure again.
 *  - `filters[enhancedTokenInfo]` and
 *    `filters[includePairsInactiveInTimeframe]` are booleans.
 *
 * Deliberately NOT exposed, each for a measured reason:
 *
 *  - rankBy `fdv`: server defect, returns the `txns` ordering (100/100 rows
 *    identical). `marketCap` is the working substitute.
 *  - rankBy `moonshotProgress`: accepted, zero rows on every chain probed.
 *  - the audit/tax/holder filter family (`isHoneyPot`, `isRenounced`,
 *    `isOpenSource`, `buyTax`, `sellTax`, `holderCount`, `lpHolderCount`,
 *    `tokenSnifferScore`, ...): accepted and silently ignored on this surface.
 *    `assertKnownScreenFilterName` refuses them BY NAME so a tool cannot
 *    advertise screening the provider does not perform.
 *
 * S2b widened the ad vocabulary rather than overloading it (coordinator
 * decision, closing the S2a naming question): `filters[currentPurchasedImpressions]`
 * stays behind `onlyAds` and means a placement running RIGHT NOW, and
 * `filters[recentPurchasedImpressions]` gained its own param `onlyRecentAds`,
 * the site's `ads=1` badge, meaning the pair bought an ad slot recently whether
 * or not it is currently running. Two signals, two keys: folding the second
 * into `onlyAds` would have given one param two meanings and made an echoed
 * filter unreadable.
 */

import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** The path timeframe segment. Selects the ranked metric AND the activity gate. */
export type ScreenWindow = "m5" | "h1" | "h6" | "h24";

/** Every window, in the site's own order. */
export const SCREEN_WINDOWS: readonly ScreenWindow[] = ["m5", "h1", "h6", "h24"];

export type ScreenSortOrder = "asc" | "desc";

/**
 * The rank keys this build exposes: 17 of the provider's 19.
 *
 * `fdv` and `moonshotProgress` are omitted for the measured reasons in the
 * module header. An invalid key makes the provider refuse the WebSocket
 * upgrade with HTTP 422, so this union is also what keeps a tool from
 * producing an unopenable socket.
 *
 * This union is the FIRST of two lines of defence and the only one that can
 * answer with a useful message. If a key ever reaches the wire anyway, the
 * site bridge names the outcome `WS_UPGRADE_REFUSED` rather than a generic
 * transport failure, so the agent is told the request is permanently wrong
 * instead of being invited to retry it. Neither line is a substitute for the
 * other: the provider gives no reason with its 422, so only this union knows
 * WHICH key was wrong.
 */
export const SCREEN_RANK_KEYS = [
  "txns",
  "buys",
  "sells",
  "volume",
  "priceChangeM5",
  "priceChangeH1",
  "priceChangeH6",
  "priceChangeH24",
  "trendingScoreM5",
  "trendingScoreH1",
  "trendingScoreH6",
  "trendingScoreH24",
  "liquidity",
  "marketCap",
  "activeBoosts",
  "launchpadProgress",
  "pairAge",
] as const;

export type ScreenRankKey = (typeof SCREEN_RANK_KEYS)[number];

const RANK_KEYS: ReadonlySet<string> = new Set(SCREEN_RANK_KEYS);

/** The trending-score rank key for a window. The site's trending bar uses these. */
export function trendingScoreRankKey(window: ScreenWindow): ScreenRankKey {
  switch (window) {
    case "m5":
      return "trendingScoreM5";
    case "h1":
      return "trendingScoreH1";
    case "h6":
      return "trendingScoreH6";
    case "h24":
      return "trendingScoreH24";
  }
}

/** The price-change rank key for a window. Gainers use `desc`, losers `asc`. */
export function priceChangeRankKey(window: ScreenWindow): ScreenRankKey {
  switch (window) {
    case "m5":
      return "priceChangeM5";
    case "h1":
      return "priceChangeH1";
    case "h6":
      return "priceChangeH6";
    case "h24":
      return "priceChangeH24";
  }
}

/* ------------------------------------------------------------------ */
/* Filter whitelist: the ONLY names that may reach the wire            */
/* ------------------------------------------------------------------ */

/**
 * Provider filter names this build may emit, in EMISSION ORDER.
 *
 * The order is part of the contract: it makes a built query string a stable,
 * diffable artifact that tests can assert exactly, and it matches the order the
 * site's own UI produces (scope, then size, then activity, then quality).
 */
export const SCREEN_FILTER_NAMES = [
  "chainIds",
  "dexIds",
  "excludedDexIds",
  "labels",
  "metaIds",
  "launchpadIds",
  "baseTokenSuffixes",
  "liquidity",
  "marketCap",
  "fdv",
  "pairAge",
  "launchpadProgress",
  "activeBoosts",
  "volume",
  "txns",
  "buys",
  "sells",
  "priceChange",
  "enhancedTokenInfo",
  "currentPurchasedImpressions",
  "recentPurchasedImpressions",
  "includePairsInactiveInTimeframe",
] as const;

export type ScreenFilterName = (typeof SCREEN_FILTER_NAMES)[number];

const FILTER_NAMES: ReadonlySet<string> = new Set(SCREEN_FILTER_NAMES);

/**
 * Filter names the provider ACCEPTS and then ignores, measured on bsc,
 * ethereum and solana with no change to `pairsCount`.
 *
 * They are listed so the refusal can say why, rather than "unknown filter":
 * an agent asking to screen out honeypots deserves to hear that this surface
 * cannot do it, not that it typed the name wrong.
 */
export const SCREEN_FILTERS_ACCEPTED_BUT_IGNORED: readonly string[] = [
  "isHoneyPot",
  "isHoneypot",
  "isRenounced",
  "isOpenSource",
  "isFlagged",
  "buyTax",
  "sellTax",
  "holderCount",
  "lpHolderCount",
  "tokenSnifferScore",
  "categories",
  "circulatingSupply",
  "pairCreator",
  "moonshotPairCreator",
  "moonshotProgress",
  "moonshotMigrationDexIds",
  "baseTokens",
];

const IGNORED_FILTERS: ReadonlySet<string> = new Set(
  SCREEN_FILTERS_ACCEPTED_BUT_IGNORED
);

/** True when `name` is a filter this build is allowed to put on the wire. */
export function isKnownScreenFilterName(
  name: string
): name is ScreenFilterName {
  return FILTER_NAMES.has(name);
}

/**
 * Refuse a filter name that must never reach the provider, by name.
 *
 * The provider fails open on unknown names, so the refusal has to happen here.
 * A name from the measured dead list gets the specific remedy; anything else
 * gets the full allowed vocabulary, whole, so the caller can see what exists.
 */
export function assertKnownScreenFilterName(
  name: string
): asserts name is ScreenFilterName {
  if (FILTER_NAMES.has(name)) return;
  if (IGNORED_FILTERS.has(name)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED,
      `"${name}" is accepted by the DexScreener screener channel and then ignored: it changes no row, so sending it would report a screen that did not happen`,
      "This surface cannot screen on audit, tax or holder data. Use dexscreener__pair_details_get on a candidate pair for that, or drop the constraint."
    );
  }
  throw siteError(
    DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED,
    `"${name}" is not a DexScreener screener filter this build may send; the provider silently drops names it does not know, so it is refused here instead`,
    `Supported filters: ${SCREEN_FILTER_NAMES.join(", ")}.`
  );
}

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

/**
 * A threshold on a windowed metric.
 *
 * `window` pins the metric window explicitly. It exists because the frozen
 * default floors are h24-anchored EXACTLY as the site sends them, even when the
 * ranking window is m5, h1 or h6: the site's gainers board ranks by 5-minute
 * price change while requiring 300 transactions over 24 hours. A bare number
 * means "use the request's `thresholdWindow`", which is the agent's own choice.
 */
export interface WindowedThresholdValue {
  readonly value: number;
  readonly window?: ScreenWindow;
}

/**
 * A windowed threshold as a caller may write it.
 *
 * Two states only: `undefined` means "not specified", which is what lets a
 * default floor apply, and a value means the caller chose one. `null` is NOT a
 * legal value anywhere on this surface (plan 14.6 item 1): a floor is removed
 * with `disableQualityFloor`, which is representable in the tool schema, and a
 * null threshold was not.
 */
export type WindowedThreshold = number | WindowedThresholdValue;

/** A threshold on a metric that names its own window and ignores the path segment. */
export type PlainThreshold = number;

/** A boolean quality flag. `false` is a real instruction, not a removal. */
export type ScreenFlag = boolean;

/**
 * What a screening tool asks the provider for.
 *
 * Every field is the DOMAIN vocabulary (seconds, USD, percent, counts); the
 * provider's units (hours, bracket paths, boolean strings) exist only inside
 * this module.
 */
export interface ScreenRequest {
  readonly rankBy: {
    readonly key: ScreenRankKey;
    readonly order: ScreenSortOrder;
  };
  /** Path timeframe: selects the ranked metric and excludes pairs inactive in it. */
  readonly window: ScreenWindow;
  /** Window the bare windowed thresholds apply to. Defaults to `window`. */
  readonly thresholdWindow?: ScreenWindow;

  readonly chainIds?: readonly string[];
  readonly dexIds?: readonly string[];
  /**
   * DANGEROUS BY CONSTRUCTION: sending this at all replaces the provider's
   * hidden bonding-curve exclusion. See the module header.
   */
  readonly excludeDexIds?: readonly string[];
  readonly labels?: readonly string[];
  /** Narrative IDs from the metas catalog, never slugs. */
  readonly metaIds?: readonly string[];
  readonly launchpadIds?: readonly string[];
  readonly baseTokenSuffixes?: readonly string[];
  /**
   * Lift the provider's hidden bonding-curve exclusion, the safe way: emits
   * `filters[excludedDexIds][]=` with no dex named.
   */
  readonly includeLaunchpadPairs?: boolean;
  /** Lift the activity gate of the path timeframe. */
  readonly includeInactive?: boolean;

  readonly minLiquidityUsd?: PlainThreshold;
  readonly maxLiquidityUsd?: PlainThreshold;
  readonly minMarketCapUsd?: PlainThreshold;
  readonly maxMarketCapUsd?: PlainThreshold;
  readonly minFdvUsd?: PlainThreshold;
  readonly maxFdvUsd?: PlainThreshold;
  /** Domain unit is SECONDS. Converted to the provider's fractional hours here. */
  readonly minPairAgeSeconds?: PlainThreshold;
  readonly maxPairAgeSeconds?: PlainThreshold;
  readonly minLaunchpadProgressPct?: PlainThreshold;
  readonly maxLaunchpadProgressPct?: PlainThreshold;
  /** Active paid boosts on the pair. Maps to `filters[activeBoosts][min]`. */
  readonly minBoostCount?: PlainThreshold;
  /**
   * Ceiling on active paid boosts (`filters[activeBoosts][max]`).
   *
   * BOUNDS WITHIN THE BOOSTED POPULATION, and does not select against it. Like
   * every maximum on this channel it requires the field to be PRESENT, and an
   * active-boost count exists only on a boosted pair. Measured 2026-08-24 on
   * solana: min 1 gave 105 rows, max 10 gave 51, max 1e6 gave 105 (not the
   * 64,420-row baseline), max 0 gave 0. The earlier reading here ("a ceiling
   * of 10 returned 45 rows where the same query unbounded returned the whole
   * population") mistook that symptom for a working exclusion: 45 was the
   * boosted subset, never a subset of the population.
   */
  readonly maxBoostCount?: PlainThreshold;

  readonly minVolumeUsd?: WindowedThreshold;
  readonly maxVolumeUsd?: WindowedThreshold;
  readonly minTxnCount?: WindowedThreshold;
  readonly maxTxnCount?: WindowedThreshold;
  readonly minBuyCount?: WindowedThreshold;
  readonly maxBuyCount?: WindowedThreshold;
  readonly minSellCount?: WindowedThreshold;
  readonly maxSellCount?: WindowedThreshold;
  readonly minPriceChangePct?: WindowedThreshold;
  readonly maxPriceChangePct?: WindowedThreshold;

  /** Base token has a DexScreener profile (`filters[enhancedTokenInfo]`). */
  readonly requireProfile?: ScreenFlag;
  /**
   * At least one active boost. Shorthand for `minBoostCount: 1`; an explicit
   * `minBoostCount` wins, because a count is more specific than a flag.
   */
  readonly onlyBoosted?: ScreenFlag;
  /** A currently running ad placement (`filters[currentPurchasedImpressions][min]=1`). */
  readonly onlyAds?: ScreenFlag;
  /**
   * An ad slot bought RECENTLY, running or not
   * (`filters[recentPurchasedImpressions][min]=1`). This is the site's `ads=1`
   * badge. Distinct from `onlyAds`: a pair can have paid recently and have
   * nothing running now, and a pair running a placement now may have bought it
   * long ago. Both may be sent; the provider ANDs them.
   */
  readonly onlyRecentAds?: ScreenFlag;

  /**
   * Drop EVERY default floor the tool's preset declares, in one flag.
   *
   * Never reaches the wire: it is an instruction to `applyFloor`, which then
   * reports each dropped default. Individual numeric overrides still apply and
   * still travel, so `disableQualityFloor: true` with `minLiquidityUsd: 5000`
   * means "none of the presets, this one of mine".
   */
  readonly disableQualityFloor?: boolean;
}

/** Every threshold parameter a default floor may set. */
export type ScreenThresholdParam =
  | "minLiquidityUsd"
  | "maxLiquidityUsd"
  | "minMarketCapUsd"
  | "maxMarketCapUsd"
  | "minFdvUsd"
  | "maxFdvUsd"
  | "minPairAgeSeconds"
  | "maxPairAgeSeconds"
  | "minLaunchpadProgressPct"
  | "maxLaunchpadProgressPct"
  | "minBoostCount"
  | "maxBoostCount"
  | "minVolumeUsd"
  | "maxVolumeUsd"
  | "minTxnCount"
  | "maxTxnCount"
  | "minBuyCount"
  | "maxBuyCount"
  | "minSellCount"
  | "maxSellCount"
  | "minPriceChangePct"
  | "maxPriceChangePct"
  | "requireProfile"
  | "onlyBoosted"
  | "onlyAds"
  | "onlyRecentAds";

/**
 * How one numeric threshold param reaches the wire.
 *
 * ONE table, consumed twice: `buildScreenQuery` emits from it, and
 * `applyFloor` accounts against it. Two tables would let a floor be emitted
 * under one key and audited under another, which is exactly the class of
 * defect the effective-filter accounting exists to catch.
 *
 * The array order IS the emission order (see `SCREEN_FILTER_NAMES`).
 */
interface ThresholdWireSpec {
  readonly filter: ScreenFilterName;
  readonly bound: "min" | "max";
  /** True when the key nests the threshold window: `filters[txns][h24][min]`. */
  readonly windowed: boolean;
  /** Domain unit to provider unit, when they differ. */
  readonly convert?: (value: number) => number;
}

const THRESHOLD_WIRE: ReadonlyArray<
  readonly [ScreenThresholdParam, ThresholdWireSpec]
> = [
  ["minLiquidityUsd", { filter: "liquidity", bound: "min", windowed: false }],
  ["maxLiquidityUsd", { filter: "liquidity", bound: "max", windowed: false }],
  ["minMarketCapUsd", { filter: "marketCap", bound: "min", windowed: false }],
  ["maxMarketCapUsd", { filter: "marketCap", bound: "max", windowed: false }],
  ["minFdvUsd", { filter: "fdv", bound: "min", windowed: false }],
  ["maxFdvUsd", { filter: "fdv", bound: "max", windowed: false }],
  [
    "minPairAgeSeconds",
    { filter: "pairAge", bound: "min", windowed: false, convert: secondsToHours },
  ],
  [
    "maxPairAgeSeconds",
    { filter: "pairAge", bound: "max", windowed: false, convert: secondsToHours },
  ],
  [
    "minLaunchpadProgressPct",
    { filter: "launchpadProgress", bound: "min", windowed: false },
  ],
  [
    "maxLaunchpadProgressPct",
    { filter: "launchpadProgress", bound: "max", windowed: false },
  ],
  ["minBoostCount", { filter: "activeBoosts", bound: "min", windowed: false }],
  ["maxBoostCount", { filter: "activeBoosts", bound: "max", windowed: false }],
  ["minVolumeUsd", { filter: "volume", bound: "min", windowed: true }],
  ["maxVolumeUsd", { filter: "volume", bound: "max", windowed: true }],
  ["minTxnCount", { filter: "txns", bound: "min", windowed: true }],
  ["maxTxnCount", { filter: "txns", bound: "max", windowed: true }],
  ["minBuyCount", { filter: "buys", bound: "min", windowed: true }],
  ["maxBuyCount", { filter: "buys", bound: "max", windowed: true }],
  ["minSellCount", { filter: "sells", bound: "min", windowed: true }],
  ["maxSellCount", { filter: "sells", bound: "max", windowed: true }],
  ["minPriceChangePct", { filter: "priceChange", bound: "min", windowed: true }],
  ["maxPriceChangePct", { filter: "priceChange", bound: "max", windowed: true }],
];

const THRESHOLD_WIRE_BY_PARAM: ReadonlyMap<
  ScreenThresholdParam,
  ThresholdWireSpec
> = new Map(THRESHOLD_WIRE);

/**
 * How one quality FLAG reaches the wire.
 *
 * `onlyBoosted` shares `filters[activeBoosts][min]` with `minBoostCount`,
 * which is why the flag family names its key explicitly instead of deriving
 * one: the flag is satisfied by any active-boost floor of 1 or more, however
 * that floor got there.
 */
interface FlagWireSpec {
  readonly filter: ScreenFilterName;
  readonly key: string;
  /** The value that means the flag is IN FORCE on the wire. */
  readonly onValue: string;
  /** True when a numeric key satisfies the flag at or above `minNumeric`. */
  readonly minNumeric?: number;
}

const FLAG_WIRE: Readonly<Record<string, FlagWireSpec>> = {
  requireProfile: {
    filter: "enhancedTokenInfo",
    key: "filters[enhancedTokenInfo]",
    onValue: "true",
  },
  onlyBoosted: {
    filter: "activeBoosts",
    key: "filters[activeBoosts][min]",
    onValue: "1",
    minNumeric: 1,
  },
  onlyAds: {
    filter: "currentPurchasedImpressions",
    key: "filters[currentPurchasedImpressions][min]",
    onValue: "1",
    minNumeric: 1,
  },
  onlyRecentAds: {
    filter: "recentPurchasedImpressions",
    key: "filters[recentPurchasedImpressions][min]",
    onValue: "1",
    minNumeric: 1,
  },
};

const WINDOWED_PARAMS: ReadonlySet<ScreenThresholdParam> = new Set(
  THRESHOLD_WIRE.filter(([, spec]) => spec.windowed).map(([param]) => param)
);

const FLAG_PARAMS: ReadonlySet<ScreenThresholdParam> = new Set(
  Object.keys(FLAG_WIRE) as ScreenThresholdParam[]
);

/* ------------------------------------------------------------------ */
/* Built query                                                         */
/* ------------------------------------------------------------------ */

/** One filter as it went on the wire, for the envelope's `filtersApplied`. */
export interface ScreenFilterApplied {
  /** The provider filter family, e.g. `txns`. */
  readonly filter: ScreenFilterName;
  /** The full bracket key, e.g. `filters[txns][h24][min]`. */
  readonly key: string;
  /** The value as sent, before percent-encoding. */
  readonly value: string;
}

export interface ScreenQuery {
  /** The path timeframe segment. */
  readonly timeframe: ScreenWindow;
  /** The query string, brackets literal, values percent-encoded. */
  readonly queryString: string;
  /**
   * Every filter actually sent. This is the defence against the provider
   * silently dropping a key: the caller echoes it, so what was asked for and
   * what was screened are the same list.
   */
  readonly filtersApplied: readonly ScreenFilterApplied[];
  /**
   * The ordering that actually went on the wire.
   *
   * `filtersApplied` exists because an echo is the only proof that the screen
   * asked for is the screen that ran; the rank key and direction decide the
   * WHOLE ordering and had no echo at all, so an ascending liquidity board and
   * a descending one were byte-indistinguishable apart from their rows.
   */
  readonly rankApplied: {
    readonly key: ScreenRankKey;
    readonly order: ScreenSortOrder;
  };
  /**
   * True when `filters[excludedDexIds]` went on the wire in any form, which
   * REPLACED the provider's hidden bonding-curve exclusion and can therefore
   * make the result set larger. Never inferred by the caller; reported here.
   */
  readonly exclusionDefaultReplaced: boolean;
  /**
   * WHICH of the two exclusion forms went on the wire, because they do
   * opposite things to the population and only the name of the key is shared.
   *
   *  - `"none"`: the key was not sent and the provider's hidden default view
   *    of the chain stands.
   *  - `"lift"`: `filters[excludedDexIds][]=` went out, an EMPTY item that
   *    replaces the hidden default with nothing. It excludes no row; measured
   *    moving a chain total by about 2 percent, upward.
   *  - `"list"`: real dex ids went out and every row on them is gone from the
   *    population. Measured on solana with one venue named: the h24 total fell
   *    75.17 percent against the same query without the key.
   *
   * Consumers that reason about the DENOMINATOR must branch on this rather
   * than on `exclusionDefaultReplaced`, which is true for both forms, or on
   * the filter NAME in `filtersApplied`, which is `excludedDexIds` for both.
   */
  readonly exclusionForm: ScreenExclusionForm;
}

/** How `filters[excludedDexIds]` was spelled on the wire, if at all. */
export type ScreenExclusionForm = "none" | "lift" | "list";

/**
 * Build the provider query string for a screening request.
 *
 * Pure: no clock, no network, no ambient state. The same request always
 * produces the same string, which is what makes the fixtures below assertable
 * and the envelope's `filtersApplied` trustworthy.
 */
export function buildScreenQuery(request: ScreenRequest): ScreenQuery {
  if (!RANK_KEYS.has(request.rankBy.key)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_RANK_KEY_NOT_SUPPORTED,
      `"${request.rankBy.key}" is not a DexScreener screener rank key this build may send`,
      `Supported rank keys: ${SCREEN_RANK_KEYS.join(", ")}.`
    );
  }

  const parts: string[] = [
    `rankBy[key]=${encodeURIComponent(request.rankBy.key)}`,
    `rankBy[order]=${encodeURIComponent(request.rankBy.order)}`,
  ];
  const applied: ScreenFilterApplied[] = [];
  const thresholdWindow = request.thresholdWindow ?? request.window;
  let exclusionForm: ScreenExclusionForm = "none";

  const emit = (
    filter: ScreenFilterName,
    key: string,
    value: string
  ): void => {
    assertKnownScreenFilterName(filter);
    applied.push({ filter, key, value });
    parts.push(`${key}=${encodeURIComponent(value)}`);
  };

  const emitList = (
    filter: ScreenFilterName,
    values: readonly string[] | undefined
  ): void => {
    if (values === undefined) return;
    values.forEach((value, index) => {
      emit(filter, `filters[${filter}][${index}]`, value);
    });
  };

  emitList("chainIds", request.chainIds);
  emitList("dexIds", request.dexIds);

  // The exclusion trap, both forms. An explicit list already replaces the
  // hidden default, so the empty-item lift is redundant beside it and is not
  // sent twice; the effect is reported either way.
  if (request.excludeDexIds !== undefined && request.excludeDexIds.length > 0) {
    emitList("excludedDexIds", request.excludeDexIds);
    exclusionForm = "list";
  } else if (
    request.includeLaunchpadPairs === true ||
    (request.excludeDexIds !== undefined && request.excludeDexIds.length === 0)
  ) {
    emit("excludedDexIds", "filters[excludedDexIds][]", "");
    exclusionForm = "lift";
  }

  emitList("labels", request.labels);
  emitList("metaIds", request.metaIds);
  emitList("launchpadIds", request.launchpadIds);
  emitList("baseTokenSuffixes", request.baseTokenSuffixes);

  // The numeric family emits from the one wire table, in its declared order.
  for (const [param, spec] of THRESHOLD_WIRE) {
    const raw = readThresholdValue(request, param);
    if (raw === undefined) continue;
    if (spec.windowed) {
      const resolved = resolveWindowed(raw, thresholdWindow);
      emit(
        spec.filter,
        thresholdWireKey(spec, resolved.window),
        formatNumber(resolved.value)
      );
      continue;
    }
    const value = typeof raw === "number" ? raw : raw.value;
    emit(
      spec.filter,
      thresholdWireKey(spec),
      formatNumber(spec.convert === undefined ? value : spec.convert(value))
    );
  }

  // `onlyBoosted` is not emitted here: it resolves into the active-boost floor
  // above, because a count is more specific than a flag and two keys for one
  // filter would let the echo disagree with itself.
  for (const param of ["requireProfile", "onlyAds", "onlyRecentAds"] as const) {
    if (request[param] !== true) continue;
    const spec = FLAG_WIRE[param];
    if (spec === undefined) continue;
    emit(spec.filter, spec.key, spec.onValue);
  }
  if (request.includeInactive === true) {
    emit(
      "includePairsInactiveInTimeframe",
      "filters[includePairsInactiveInTimeframe]",
      "true"
    );
  }

  return {
    timeframe: request.window,
    queryString: parts.join("&"),
    filtersApplied: applied,
    rankApplied: { key: request.rankBy.key, order: request.rankBy.order },
    // Derived, never tracked separately: both forms replace the hidden
    // default, and one flag with two owners is how the two forms became
    // indistinguishable downstream in the first place.
    exclusionDefaultReplaced: exclusionForm !== "none",
    exclusionForm,
  };
}

/**
 * The bracket key one threshold spec produces.
 *
 * Shared by the emitter and the floor accounting so an audited key and an
 * emitted key cannot drift apart.
 */
function thresholdWireKey(
  spec: ThresholdWireSpec,
  window?: ScreenWindow
): string {
  return spec.windowed
    ? `filters[${spec.filter}][${String(window)}][${spec.bound}]`
    : `filters[${spec.filter}][${spec.bound}]`;
}

/**
 * The value a threshold param carries, with the one shorthand resolved.
 *
 * `onlyBoosted: true` means an active-boost floor of 1; an explicit
 * `minBoostCount` wins, because a count is more specific than a flag.
 */
function readThresholdValue(
  request: ScreenRequest,
  param: ScreenThresholdParam
): WindowedThreshold | undefined {
  const current: unknown = Reflect.get(request, param);
  if (current !== undefined) return current as WindowedThreshold;
  if (param === "minBoostCount" && request.onlyBoosted === true) return 1;
  return undefined;
}

function resolveWindowed(
  value: number | WindowedThresholdValue,
  fallback: ScreenWindow
): { readonly value: number; readonly window: ScreenWindow } {
  if (typeof value === "number") return { value, window: fallback };
  return { value: value.value, window: value.window ?? fallback };
}

/** Seconds to the provider's fractional hours, at the precision it accepts. */
function secondsToHours(seconds: number): number {
  return roundTo(seconds / 3600, 6);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Render a threshold for the wire.
 *
 * Refuses anything that would serialize to exponent notation or to `NaN`
 * rather than sending a value the provider would reject with an empty HTTP 400
 * or, worse, interpret as something else.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `A screener threshold must be a finite number; received ${String(value)}`,
      "Pass a finite number. To drop a tool's default floors, set disableQualityFloor."
    );
  }
  const rendered = String(value);
  if (rendered.includes("e") || rendered.includes("E")) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `A screener threshold of ${rendered} is outside the range this build renders in plain decimal form`,
      "Use a magnitude below 1e21; the provider's own filters saturate far below it."
    );
  }
  return rendered;
}

/* ------------------------------------------------------------------ */
/* Frozen per-tool default floors (plan section 14.5)                  */
/* ------------------------------------------------------------------ */

/**
 * One default the tool applies unless the agent said otherwise.
 *
 * `window` is present exactly for the windowed family and is h24 on every
 * frozen floor, matching what the site itself sends.
 */
export interface ScreenFloor {
  readonly param: ScreenThresholdParam;
  readonly value: number | boolean;
  readonly window?: ScreenWindow;
}

/** The preset a screening tool applies its floors from. */
export type ScreenPresetId =
  | "trending"
  | "topVolume"
  | "topTxns"
  | "topOther"
  | "gainers"
  | "losers"
  | "new"
  | "launchpadBonding"
  | "launchpadGraduated"
  | "tokensScreen";

/**
 * The frozen default floor matrix, plan section 14.5.
 *
 * Frozen means: these values are the plan's decision, not a re-derivation of
 * what the site's UI happens to send today. Where the two differ the plan wins
 * and the difference is noted here. The site's own new-pairs board also sends
 * `enhancedTokenInfo=true`; the frozen matrix for `new` deliberately does not,
 * because a brand-new pair usually has no profile yet and requiring one would
 * empty the board the tool exists to show.
 */
export const SCREEN_PRESET_FLOORS: Readonly<
  Record<ScreenPresetId, readonly ScreenFloor[]>
> = {
  trending: [],
  topVolume: [
    { param: "minTxnCount", value: 50, window: "h24" },
    { param: "minLiquidityUsd", value: 25_000 },
    { param: "requireProfile", value: true },
  ],
  topTxns: [{ param: "requireProfile", value: true }],
  topOther: [],
  gainers: [
    { param: "minTxnCount", value: 300, window: "h24" },
    { param: "minSellCount", value: 30, window: "h24" },
    { param: "minVolumeUsd", value: 100_000, window: "h24" },
    { param: "minLiquidityUsd", value: 250_000 },
    { param: "requireProfile", value: true },
  ],
  losers: [
    { param: "minTxnCount", value: 300, window: "h24" },
    { param: "minSellCount", value: 30, window: "h24" },
    { param: "minVolumeUsd", value: 100_000, window: "h24" },
    { param: "minLiquidityUsd", value: 250_000 },
    { param: "requireProfile", value: true },
  ],
  new: [
    { param: "maxPairAgeSeconds", value: 86_400 },
    { param: "minLiquidityUsd", value: 1_000 },
  ],
  launchpadBonding: [{ param: "maxLaunchpadProgressPct", value: 99.99 }],
  launchpadGraduated: [{ param: "minLaunchpadProgressPct", value: 100 }],
  tokensScreen: [],
};

/** How one declared default ended up on the wire. */
export type ScreenFloorDisposition =
  /** The caller said nothing and the default went on the wire unchanged. */
  | "applied"
  /** The caller replaced it with a value at least as strict as the default. */
  | "tightened"
  /** The caller replaced it with a LOOSER value; the declared floor is gone. */
  | "weakened"
  /** Nothing satisfying this floor reached the wire at all. */
  | "removed";

/**
 * What happened to one declared default, derived from the EFFECTIVE filter set.
 *
 * Every field here is read back out of the query that was actually built, not
 * out of the preset table. That is the whole point of the record: a preset row
 * says what the tool INTENDED, and two measured defects (a `requireProfile:
 * false` that removed the provider filter while the envelope still claimed the
 * floor, and a `minLiquidityUsd` weakening that grew the population from 162 to
 * 545 rows while the summary still quoted 250,000) came from reporting the
 * intention as if it were the outcome.
 */
export interface ScreenFloorRecord {
  readonly param: ScreenThresholdParam;
  readonly defaultValue: number | boolean;
  /** The window the DEFAULT is anchored to, for the windowed family. */
  readonly window?: ScreenWindow;
  readonly disposition: ScreenFloorDisposition;
  /**
   * The value in force on the wire, in the DOMAIN unit for numbers and as
   * "this filter is on the wire" for flags. Null when nothing is in force.
   */
  readonly effectiveValue: number | boolean | null;
  /** The bracket key that carried it, or null when nothing did. */
  readonly effectiveKey: string | null;
}

/** The request with the surviving defaults filled in, plus what the caller said. */
export interface ScreenFloorApplication {
  readonly request: ScreenRequest;
  /** The preset rows this application was asked to apply. */
  readonly floors: readonly ScreenFloor[];
  /** Floors the caller supplied a value for, so an override is distinguishable. */
  readonly callerSet: ReadonlySet<ScreenThresholdParam>;
  /** True when the caller asked for every default floor to be dropped. */
  readonly qualityFloorDisabled: boolean;
}

/** The honest floor accounting, derived from a built query. */
export interface ScreenFloorAccounting {
  /**
   * True only when every declared floor is in force on the wire at the default
   * value or stricter. A weakened floor, a removed floor, a floor re-anchored
   * to another window, and a preset that declares no floors at all are all
   * false: there is then no quality floor to claim.
   */
  readonly qualityFloorApplied: boolean;
  /** Every declared floor with its outcome, in preset order. */
  readonly floors: readonly ScreenFloorRecord[];
  /** Defaults that went on the wire because the caller said nothing. */
  readonly defaultsApplied: readonly ScreenFloorRecord[];
  /** Defaults the caller replaced, tightened or weakened. */
  readonly defaultsOverridden: readonly ScreenFloorRecord[];
  /** Defaults that reached no wire filter at all. */
  readonly defaultsDisabled: readonly ScreenFloorRecord[];
}

/**
 * Fill in a preset's default floors.
 *
 * Pure, and total. `undefined` means the caller said nothing and the default
 * applies; any other value means the caller decided. `disableQualityFloor`
 * drops every default at once and is the ONLY removal mechanism: `null` is not
 * a legal threshold value on this surface, because a tool schema cannot
 * declare it and an agent cannot discover it.
 *
 * What happened is NOT decided here: it is decided by `accountFloors` against
 * the query this request produces, because only the wire says which filters
 * ran.
 */
export function applyFloor(
  request: ScreenRequest,
  floors: readonly ScreenFloor[]
): ScreenFloorApplication {
  const patch: Record<string, unknown> = {};
  const callerSet = new Set<ScreenThresholdParam>();
  const disabled = request.disableQualityFloor === true;

  for (const floor of floors) {
    // `Reflect.get` reads by a computed key without asserting an index
    // signature onto `ScreenRequest`, whose keys are a closed, named set.
    const current: unknown = Reflect.get(request, floor.param);
    if (current !== undefined) {
      callerSet.add(floor.param);
      continue;
    }
    if (disabled) continue;
    patch[floor.param] = floorValue(floor);
  }

  return {
    request: { ...request, ...patch } as ScreenRequest,
    floors,
    callerSet,
    qualityFloorDisabled: disabled,
  };
}

/**
 * Account every declared floor against the filters that actually went out.
 *
 * The lookup is by wire KEY, from the same table the emitter used, so a floor
 * counts as in force only when a filter of that family and bound is really on
 * the query string. A windowed floor re-anchored to another window is reported
 * as removed rather than as satisfied: the site's gainers floor is 300
 * transactions over h24, and 300 over m5 is a different screen.
 */
export function accountFloors(
  application: ScreenFloorApplication,
  query: ScreenQuery
): ScreenFloorAccounting {
  const records = application.floors.map((floor) =>
    accountOne(floor, application, query)
  );
  return {
    qualityFloorApplied:
      records.length > 0 &&
      records.every(
        (record) =>
          record.disposition === "applied" || record.disposition === "tightened"
      ),
    floors: records,
    defaultsApplied: records.filter(
      (record) => record.disposition === "applied"
    ),
    defaultsOverridden: records.filter(
      (record) =>
        record.disposition === "tightened" || record.disposition === "weakened"
    ),
    defaultsDisabled: records.filter(
      (record) => record.disposition === "removed"
    ),
  };
}

function accountOne(
  floor: ScreenFloor,
  application: ScreenFloorApplication,
  query: ScreenQuery
): ScreenFloorRecord {
  const base = {
    param: floor.param,
    defaultValue: floor.value,
    ...(floor.window === undefined ? {} : { window: floor.window }),
  };
  const gone = {
    ...base,
    disposition: "removed" as const,
    effectiveValue: null,
    effectiveKey: null,
  };

  if (FLAG_PARAMS.has(floor.param)) {
    const spec = FLAG_WIRE[floor.param];
    if (spec === undefined) return gone;
    const sent = query.filtersApplied.find((entry) => entry.key === spec.key);
    if (sent === undefined) return gone;
    const inForce =
      spec.minNumeric === undefined
        ? sent.value === spec.onValue
        : Number(sent.value) >= spec.minNumeric;
    return inForce
      ? {
          ...base,
          disposition: "applied",
          effectiveValue: true,
          effectiveKey: sent.key,
        }
      : gone;
  }

  const spec = THRESHOLD_WIRE_BY_PARAM.get(floor.param);
  if (spec === undefined || typeof floor.value !== "number") return gone;

  const expectedKey =
    floor.window === undefined
      ? thresholdWireKey(spec)
      : thresholdWireKey(spec, floor.window);
  const sent = query.filtersApplied.find((entry) => entry.key === expectedKey);
  if (sent === undefined) {
    // The family may still be on the wire under another window. Naming that
    // key is what stops "removed" from reading as "you sent nothing".
    const elsewhere = query.filtersApplied.find(
      (entry) =>
        entry.filter === spec.filter && entry.key.endsWith(`[${spec.bound}]`)
    );
    return elsewhere === undefined
      ? gone
      : { ...gone, effectiveKey: elsewhere.key };
  }

  const wireDefault =
    spec.convert === undefined ? floor.value : spec.convert(floor.value);
  const wireValue = Number(sent.value);
  const domainValue =
    spec.convert === undefined
      ? wireValue
      : readDomainValue(application.request, floor.param, wireValue);
  const atLeastAsStrict =
    spec.bound === "min" ? wireValue >= wireDefault : wireValue <= wireDefault;

  return {
    ...base,
    disposition: !atLeastAsStrict
      ? "weakened"
      : application.callerSet.has(floor.param)
        ? "tightened"
        : "applied",
    effectiveValue: domainValue,
    effectiveKey: sent.key,
  };
}

/**
 * The domain-unit value behind a converted wire value.
 *
 * Only the age family converts (seconds to fractional hours), and the
 * round-trip through hours is lossy, so the request's own number is read back
 * instead of being reconstructed. When the request does not carry one, the
 * wire value is reported with no invented precision.
 */
function readDomainValue(
  request: ScreenRequest,
  param: ScreenThresholdParam,
  wireValue: number
): number {
  const current: unknown = Reflect.get(request, param);
  return typeof current === "number" ? current : wireValue;
}

function floorValue(
  floor: ScreenFloor
): number | boolean | WindowedThresholdValue {
  if (FLAG_PARAMS.has(floor.param)) return floor.value;
  if (typeof floor.value !== "number") {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `The default floor for ${floor.param} must be a number, not ${typeof floor.value}`,
      "Correct SCREEN_PRESET_FLOORS; this is a build-time table, not caller input."
    );
  }
  if (WINDOWED_PARAMS.has(floor.param)) {
    return floor.window === undefined
      ? { value: floor.value }
      : { value: floor.value, window: floor.window };
  }
  return floor.value;
}
