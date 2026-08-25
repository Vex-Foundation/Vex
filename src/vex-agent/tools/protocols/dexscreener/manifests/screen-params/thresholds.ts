/**
 * Threshold and quality params for the site screening family.
 *
 * Every threshold is a SERVER-side filter: it changes which rows the provider
 * ranks, not which rows survive locally. That is why the set is enumerated key
 * by key instead of accepted as an opaque filter bag. The provider FAILS OPEN
 * on a filter name it does not know, silently dropping it and answering with
 * the wrong population and an HTTP 200, so a declared key that is type-checked,
 * echoed back and refused by name is the only defence that exists.
 *
 * UNIT IN THE KEY, always. `Usd`, `Pct`, `Seconds` and `Count` are suffixes and
 * not decoration: the key is the only unit signal a model sees when it composes
 * one call's output into the next call's input. The descriptions repeat the
 * unit because the key alone is not read aloud to a user.
 *
 * The min/max pairs are built by one factory rather than typed out 21 times,
 * so a correction to the "null removes a default floor" sentence cannot land on
 * the floor and miss the ceiling.
 */

import type { ProtocolParamDef } from "../../../types.js";

/**
 * The sentence every threshold carries about the two states it can be in.
 *
 * Two, not three: `null` was retired by plan 14.6 item 1 because a tool schema
 * cannot declare a nullable number, so the removal mechanism an agent could
 * actually discover is the boolean `disableQualityFloor`.
 */
const THRESHOLD_STATE_CLAUSE =
  "Omit it to leave the tool's default in place, or send a number to set your own; whichever "
  + "happens is echoed in filtersApplied. null is not accepted here: send "
  + "disableQualityFloor: true to drop every default floor at once.";

/**
 * What EVERY ceiling on this channel does beyond bounding, measured.
 *
 * The provider treats a maximum as PRESENCE PLUS BOUND: a row that carries no
 * value for the field is not "below the ceiling", it is excluded. Measured
 * 2026-08-24 against a 64,420-row solana population: `filters[liquidity][max]`
 * at 1e12 returned 62,733 (1,687 rows with no liquidity figure removed),
 * `filters[fdv][max]` at 1e15 returned 61,134 (3,286 removed), and
 * `filters[launchpadProgress][max]` at 1e6 returned 22,315, i.e. launchpad
 * rows only. It is one rule for the whole family, so it is stated once here
 * rather than repeated on each ceiling.
 *
 * The class it silently removes is exactly the class an agent is usually
 * hunting: a ceiling meant to find SMALL pools also deletes every pair whose
 * pool size the provider never reported.
 */
const MAX_PRESENCE_CLAUSE =
  "PRESENCE RULE, measured, and it applies to every ceiling on this surface: a maximum matches "
  + "only rows that CARRY the field. A row the provider reported no value for is excluded, not "
  + "kept as if it were below the bound. Measured on a 64,420-row solana population: a liquidity "
  + "ceiling removed 1,687 rows that carry no liquidity figure, an FDV ceiling removed 3,286, and "
  + "a launchpad-progress ceiling reduced the set to launchpad pairs only. So a ceiling narrows on "
  + "two axes at once, and the second one is silent.";

/**
 * Thresholds that measure over `thresholdWindow`.
 *
 * The second sentence is the A2 depth declaration: the provider ANDs several
 * windows of the SAME family (`volume[h24][min]=1e6` with
 * `volume[m5][min]=1000` returned 104 rows, measured), while this surface
 * carries one `thresholdWindow` for all families and therefore reaches one
 * window per family. Saying so is the difference between a bound the agent can
 * plan around and a capability it cannot know is missing.
 */
const WINDOWED_CLAUSE =
  "Measured over thresholdWindow, which defaults to window. One window per threshold family is "
  + "reachable here: the provider itself accepts several windows of one family at once and ANDs "
  + "them (a 1,000,000 USD h24 volume floor combined with a 1,000 USD m5 volume floor was measured "
  + "returning 104 rows), but this surface carries a single thresholdWindow, so a two-window "
  + "condition on one metric has to be checked against the returned rows instead of filtered for.";

function bound(
  key: string,
  kind: "Floor" | "Ceiling",
  subject: string,
  extra: string
): ProtocolParamDef {
  const presence = kind === "Ceiling" ? ` ${MAX_PRESENCE_CLAUSE}` : "";
  return {
    key,
    type: "number",
    description: `${kind} on ${subject}. ${extra}${presence} ${THRESHOLD_STATE_CLAUSE}`,
  };
}

export const SCREEN_THRESHOLD_PARAMS: readonly ProtocolParamDef[] = [
  bound(
    "minLiquidityUsd",
    "Floor",
    "pool liquidity, in US dollars",
    "Liquidity has no window: it is the pool's depth right now. Bonding-curve pairs carry no "
      + "liquidity field at all, so any liquidity threshold excludes them by construction."
  ),
  bound(
    "maxLiquidityUsd",
    "Ceiling",
    "pool liquidity, in US dollars",
    "Useful for finding small pools deliberately; liquidity has no window."
  ),
  bound(
    "minMarketCapUsd",
    "Floor",
    "market capitalisation, in US dollars",
    "The provider's own circulating-supply valuation, with no window."
  ),
  bound(
    "maxMarketCapUsd",
    "Ceiling",
    "market capitalisation, in US dollars",
    "The provider's own circulating-supply valuation, with no window."
  ),
  bound(
    "minFdvUsd",
    "Floor",
    "fully diluted valuation, in US dollars",
    "FDV values the total supply rather than the circulating supply, so it is the larger number."
  ),
  bound(
    "maxFdvUsd",
    "Ceiling",
    "fully diluted valuation, in US dollars",
    "FDV values the total supply rather than the circulating supply, so it is the larger number."
  ),
  bound(
    "minVolumeUsd",
    "Floor",
    "traded volume, in US dollars",
    WINDOWED_CLAUSE
  ),
  bound(
    "maxVolumeUsd",
    "Ceiling",
    "traded volume, in US dollars",
    WINDOWED_CLAUSE
  ),
  bound(
    "minTxnCount",
    "Floor",
    "the number of trades, as a COUNT and not a volume",
    WINDOWED_CLAUSE
  ),
  bound(
    "maxTxnCount",
    "Ceiling",
    "the number of trades, as a COUNT and not a volume",
    WINDOWED_CLAUSE
  ),
  bound(
    "minBuyCount",
    "Floor",
    "the number of BUY trades, as a COUNT",
    WINDOWED_CLAUSE
  ),
  bound(
    "maxBuyCount",
    "Ceiling",
    "the number of BUY trades, as a COUNT",
    WINDOWED_CLAUSE
  ),
  bound(
    "minSellCount",
    "Floor",
    "the number of SELL trades, as a COUNT",
    `${WINDOWED_CLAUSE} A sell-side floor is what separates a real two-sided market from a pair `
      + "nobody can exit."
  ),
  bound(
    "maxSellCount",
    "Ceiling",
    "the number of SELL trades, as a COUNT",
    WINDOWED_CLAUSE
  ),
  bound(
    "minPriceChangePct",
    "Floor",
    "price change, as a PERCENT and not a fraction",
    `${WINDOWED_CLAUSE} 10 means ten percent.`
  ),
  bound(
    "maxPriceChangePct",
    "Ceiling",
    "price change, as a PERCENT and not a fraction",
    `${WINDOWED_CLAUSE} Negative values are legal, so -50 keeps only pairs down at least half.`
  ),
  bound(
    "minPairAgeSeconds",
    "Floor",
    "pair age, in SECONDS since the pair was created",
    "The provider filters age in whole and fractional hours, so this is converted for you; the "
      + "exact age comes back per row in pairAgeSeconds."
  ),
  bound(
    "maxPairAgeSeconds",
    "Ceiling",
    "pair age, in SECONDS since the pair was created",
    "86400 is one day. The provider filters in hours, so sub-hour precision comes from the "
      + "returned pairAgeSeconds rather than from this filter."
  ),
  bound(
    "minLaunchpadProgressPct",
    "Floor",
    "bonding-curve completion, as a PERCENT of the curve",
    "100 means the token has graduated and migrated to a DEX. Only launchpad pairs carry it."
  ),
  bound(
    "maxLaunchpadProgressPct",
    "Ceiling",
    "bonding-curve completion, as a PERCENT of the curve",
    "Below 100 keeps tokens still on the curve. Only launchpad pairs carry it."
  ),
  bound(
    "minBoostCount",
    "Floor",
    "the number of paid boosts ACTIVE on the pair, as a COUNT",
    "A boost is bought visibility, never demand or safety. This is more specific than onlyBoosted "
      + "and wins over it when both are sent."
  ),
  bound(
    "maxBoostCount",
    "Ceiling",
    "the number of paid boosts ACTIVE on the pair, as a COUNT",
    "It bounds WITHIN the boosted population and does not select against it. The presence rule "
      + "below is the whole story here: an active-boost count exists only on a boosted pair, so "
      + "maxBoostCount 3 means \"is boosted AND has at most 3 boosts\", never \"is not heavily "
      + "advertised\". Measured 2026-08-24 on solana: min 1 gave 105 rows (the boosted "
      + "population), max 10 gave 51, max 1000000 gave 105 again rather than the 64,420-row "
      + "baseline, and max 0 gave 0. THIS IS NOT A WAY TO EXCLUDE ADS: an agent setting it to "
      + "avoid ad-pumped pairs receives only ad-carrying pairs. To judge advertising, leave it "
      + "unset and read boostsActive per row, which is on every row by default."
  ),
];

/**
 * The one schema-representable way to remove a tool's default floors.
 *
 * Declared ONLY on the tools that actually apply floors: on a board with none
 * it would be a switch with nothing to switch, and a param that cannot change
 * an outcome is a param that misleads the model about what the board does.
 */
export const SCREEN_DISABLE_QUALITY_FLOOR: ProtocolParamDef = {
  key: "disableQualityFloor",
  type: "boolean",
  description:
    "Drop EVERY default quality floor this tool applies, in one flag. Defaults to false. Your own "
    + "explicit thresholds still apply, so disableQualityFloor with minLiquidityUsd 5000 means "
    + "\"none of the tool's defaults, but keep mine\". Each dropped default is named in "
    + "floorAccounting and qualityFloorApplied becomes false. Expect the unfloored result to "
    + "contain arithmetic artifacts: on the price-change boards the top rows without a floor are "
    + "billion-percent moves on pairs nobody can trade. "
    + "IT DOES NOT READMIT BONDING-CURVE PAIRS, and that is the half agents miss: dropping the "
    + "floors is necessary but not sufficient, because the provider excludes bonding-curve VENUES "
    + "by default and only includeLaunchpadPairs lifts that. Measured on solana: a launchpad "
    + "filter without the lift returned 0 on-curve pairs, and with the lift 71,334; adding a "
    + "25,000 USD liquidity floor to those 71,334 returned 0 again, because on-curve rows carry no "
    + "liquidity field at all. For on-curve pairs, send includeLaunchpadPairs AND keep every "
    + "liquidity threshold off.",
};

export const SCREEN_QUALITY_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "requireProfile",
    type: "boolean",
    description:
      "Keep only pairs whose base token has a DexScreener profile. Measured on solana: 28,080 of "
      + "53,094 pairs qualify. Having a profile means the issuer filled a form in, not that the "
      + "project is real. Sending false sends NO profile filter at all, because the provider has no "
      + "not-profiled filter to send; on a board that applies this by default that removes the "
      + "floor, and the floor accounting reports it as removed rather than as held.",
  },
  {
    key: "onlyBoosted",
    type: "boolean",
    description:
      "Keep only pairs carrying at least one ACTIVE paid boost. This is an advertising signal and "
      + "not a quality signal: it says the project paid DexScreener for visibility. Use "
      + "minBoostCount when you want a specific number rather than at least one.",
  },
  {
    key: "onlyAds",
    type: "boolean",
    description:
      "Keep only pairs with an ad placement running RIGHT NOW. Bought visibility, never demand or "
      + "safety. Distinct from onlyRecentAds: a pair running a placement now may have bought it "
      + "long ago.",
  },
  {
    key: "onlyRecentAds",
    type: "boolean",
    description:
      "Keep only pairs that bought an ad slot RECENTLY, whether or not it is currently running; "
      + "this is the site's own ads badge. Bought visibility, never demand or safety. Combine with "
      + "onlyAds to require both, since the provider ANDs them.",
  },
];
