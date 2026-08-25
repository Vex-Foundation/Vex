/**
 * The screener query-string builder, against the grammar measured on the live
 * site.
 *
 * The expected strings here are not derived from the implementation: each one
 * is the form the site itself sends, taken from the recon tables and from the
 * archived live probes (for example
 * `rankBy[key]=pairAge&rankBy[order]=asc&filters[chainIds][0]=solana&filters[excludedDexIds][]=&filters[dexIds][0]=pumpfun&filters[launchpadProgress][max]=99.99`,
 * captured 2026-08-24 for the pumpfun bonding board). If the builder's output
 * drifts from these, the tools stop screening what they claim to screen, and
 * the provider will not say so: it drops unknown keys silently.
 */

import { describe, expect, it } from "vitest";
import {
  accountFloors,
  applyFloor,
  buildScreenQuery,
  assertKnownScreenFilterName,
  isKnownScreenFilterName,
  priceChangeRankKey,
  SCREEN_FILTER_NAMES,
  SCREEN_PRESET_FLOORS,
  trendingScoreRankKey,
  type ScreenRequest,
} from "../../tools/dexscreener/screen-core/request.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import { VexError } from "../../errors.js";

/** Build the default request a tool issues, floors included, and render it. */
function defaultQuery(
  preset: keyof typeof SCREEN_PRESET_FLOORS,
  request: ScreenRequest
): string {
  const floored = applyFloor(request, SCREEN_PRESET_FLOORS[preset]);
  return buildScreenQuery(floored.request).queryString;
}

const SOLANA = ["solana"] as const;

describe("buildScreenQuery: the six screening tools' default requests", () => {
  it("trending pins the window's trending score and applies no floor", () => {
    expect(
      defaultQuery("trending", {
        rankBy: { key: trendingScoreRankKey("h24"), order: "desc" },
        window: "h24",
        chainIds: SOLANA,
      })
    ).toBe(
      "rankBy[key]=trendingScoreH24&rankBy[order]=desc&filters[chainIds][0]=solana"
    );
  });

  it("top by volume applies the site's own h24-anchored floor", () => {
    expect(
      defaultQuery("topVolume", {
        rankBy: { key: "volume", order: "desc" },
        window: "h24",
        chainIds: SOLANA,
      })
    ).toBe(
      "rankBy[key]=volume&rankBy[order]=desc&filters[chainIds][0]=solana" +
        "&filters[liquidity][min]=25000" +
        "&filters[txns][h24][min]=50" +
        "&filters[enhancedTokenInfo]=true"
    );
  });

  it("keeps the floor anchored to h24 even when the ranking window is m5", () => {
    expect(
      defaultQuery("topVolume", {
        rankBy: { key: "volume", order: "desc" },
        window: "m5",
        chainIds: SOLANA,
      })
    ).toContain("filters[txns][h24][min]=50");
  });

  it("gainers rank by the window's price change under the full quality floor", () => {
    expect(
      defaultQuery("gainers", {
        rankBy: { key: priceChangeRankKey("h6"), order: "desc" },
        window: "h6",
        chainIds: SOLANA,
      })
    ).toBe(
      "rankBy[key]=priceChangeH6&rankBy[order]=desc&filters[chainIds][0]=solana" +
        "&filters[liquidity][min]=250000" +
        "&filters[volume][h24][min]=100000" +
        "&filters[txns][h24][min]=300" +
        "&filters[sells][h24][min]=30" +
        "&filters[enhancedTokenInfo]=true"
    );
  });

  it("losers are the same universe, ascending", () => {
    const gainers = defaultQuery("gainers", {
      rankBy: { key: priceChangeRankKey("h24"), order: "desc" },
      window: "h24",
      chainIds: SOLANA,
    });
    const losers = defaultQuery("losers", {
      rankBy: { key: priceChangeRankKey("h24"), order: "asc" },
      window: "h24",
      chainIds: SOLANA,
    });
    expect(losers).toBe(gainers.replace("order]=desc", "order]=asc"));
  });

  it("new pairs convert the 24 hour age floor from seconds to the provider's hours", () => {
    expect(
      defaultQuery("new", {
        rankBy: { key: "pairAge", order: "asc" },
        window: "h24",
        chainIds: SOLANA,
      })
    ).toBe(
      "rankBy[key]=pairAge&rankBy[order]=asc&filters[chainIds][0]=solana" +
        "&filters[liquidity][min]=1000" +
        "&filters[pairAge][max]=24"
    );
  });

  it("the launchpad bonding board reproduces the captured probe exactly", () => {
    // Verbatim from
    // scratchpad/live-turn2/momentum-launch/raw/launch-pumpfun-bonding-newest,
    // the session whose pairs frame is the bonding fixture.
    expect(
      defaultQuery("launchpadBonding", {
        rankBy: { key: "pairAge", order: "asc" },
        window: "h6",
        chainIds: SOLANA,
        dexIds: ["pumpfun"],
        includeLaunchpadPairs: true,
      })
    ).toBe(
      "rankBy[key]=pairAge&rankBy[order]=asc" +
        "&filters[chainIds][0]=solana" +
        "&filters[dexIds][0]=pumpfun" +
        "&filters[excludedDexIds][]=" +
        "&filters[launchpadProgress][max]=99.99"
    );
  });

  it("the graduated board selects by launchpad origin and needs no exclusion lift", () => {
    const query = buildScreenQuery(
      applyFloor(
        {
          rankBy: { key: trendingScoreRankKey("h6"), order: "desc" },
          window: "h6",
          chainIds: SOLANA,
          launchpadIds: ["pumpfun"],
        },
        SCREEN_PRESET_FLOORS.launchpadGraduated
      ).request
    );
    expect(query.queryString).toBe(
      "rankBy[key]=trendingScoreH6&rankBy[order]=desc" +
        "&filters[chainIds][0]=solana" +
        "&filters[launchpadIds][0]=pumpfun" +
        "&filters[launchpadProgress][min]=100"
    );
    expect(query.exclusionDefaultReplaced).toBe(false);
  });
});

describe("buildScreenQuery: the exclusion trap", () => {
  const base: ScreenRequest = {
    rankBy: { key: "volume", order: "desc" },
    window: "h24",
    chainIds: SOLANA,
  };

  it("sends the empty item and reports the replacement when lifting the hidden default", () => {
    const query = buildScreenQuery({ ...base, includeLaunchpadPairs: true });
    expect(query.queryString).toContain("&filters[excludedDexIds][]=");
    expect(query.exclusionDefaultReplaced).toBe(true);
  });

  it("reports the replacement when a dex is excluded by name, because that lifts it too", () => {
    const query = buildScreenQuery({ ...base, excludeDexIds: ["pumpswap"] });
    expect(query.queryString).toContain("&filters[excludedDexIds][0]=pumpswap");
    expect(query.queryString).not.toContain("filters[excludedDexIds][]=");
    expect(query.exclusionDefaultReplaced).toBe(true);
  });

  it("does not send the key twice when a named exclusion and the lift are both asked for", () => {
    const query = buildScreenQuery({
      ...base,
      excludeDexIds: ["pumpswap"],
      includeLaunchpadPairs: true,
    });
    expect(
      query.filtersApplied.filter((entry) => entry.filter === "excludedDexIds")
    ).toHaveLength(1);
    expect(query.exclusionDefaultReplaced).toBe(true);
  });

  it("sends nothing and reports no replacement when the key is not asked for", () => {
    const query = buildScreenQuery(base);
    expect(query.queryString).not.toContain("excludedDexIds");
    expect(query.exclusionDefaultReplaced).toBe(false);
  });

  it("treats an explicitly empty exclusion list as the lift, not as absence", () => {
    const query = buildScreenQuery({ ...base, excludeDexIds: [] });
    expect(query.queryString).toContain("&filters[excludedDexIds][]=");
    expect(query.exclusionDefaultReplaced).toBe(true);
  });
});

describe("buildScreenQuery: grammar details", () => {
  it("indexes list filters from zero and preserves input order", () => {
    expect(
      buildScreenQuery({
        rankBy: { key: "volume", order: "desc" },
        window: "h24",
        chainIds: ["solana", "bsc", "base"],
      }).queryString
    ).toBe(
      "rankBy[key]=volume&rankBy[order]=desc" +
        "&filters[chainIds][0]=solana&filters[chainIds][1]=bsc&filters[chainIds][2]=base"
    );
  });

  it("converts pair age from seconds to fractional hours", () => {
    expect(
      buildScreenQuery({
        rankBy: { key: "pairAge", order: "asc" },
        window: "h24",
        minPairAgeSeconds: 7200,
        maxPairAgeSeconds: 10_800,
      }).queryString
    ).toContain("filters[pairAge][min]=2&filters[pairAge][max]=3");
    expect(
      buildScreenQuery({
        rankBy: { key: "pairAge", order: "asc" },
        window: "h24",
        maxPairAgeSeconds: 1800,
      }).queryString
    ).toContain("filters[pairAge][max]=0.5");
  });

  it("nests a windowed threshold under the request's thresholdWindow by default", () => {
    expect(
      buildScreenQuery({
        rankBy: { key: "volume", order: "desc" },
        window: "h24",
        thresholdWindow: "h1",
        minVolumeUsd: 5000,
      }).queryString
    ).toContain("filters[volume][h1][min]=5000");
  });

  it("lets a threshold pin its own window regardless of thresholdWindow", () => {
    expect(
      buildScreenQuery({
        rankBy: { key: "volume", order: "desc" },
        window: "m5",
        thresholdWindow: "m5",
        minTxnCount: { value: 300, window: "h24" },
      }).queryString
    ).toContain("filters[txns][h24][min]=300");
  });

  it("sends the booleans the site sends", () => {
    const query = buildScreenQuery({
      rankBy: { key: "volume", order: "desc" },
      window: "m5",
      requireProfile: true,
      includeInactive: true,
      onlyAds: true,
      onlyBoosted: true,
    }).queryString;
    expect(query).toContain("filters[enhancedTokenInfo]=true");
    expect(query).toContain("filters[includePairsInactiveInTimeframe]=true");
    expect(query).toContain("filters[currentPurchasedImpressions][min]=1");
    expect(query).toContain("filters[activeBoosts][min]=1");
  });

  it("lets an explicit boost count win over the onlyBoosted shorthand", () => {
    const applied = buildScreenQuery({
      rankBy: { key: "activeBoosts", order: "desc" },
      window: "h24",
      onlyBoosted: true,
      minBoostCount: 5,
    }).filtersApplied.filter((entry) => entry.filter === "activeBoosts");
    expect(applied).toStrictEqual([
      { filter: "activeBoosts", key: "filters[activeBoosts][min]", value: "5" },
    ]);
  });

  it("percent-encodes values and leaves the brackets literal", () => {
    const query = buildScreenQuery({
      rankBy: { key: "volume", order: "desc" },
      window: "h24",
      metaIds: ["B0vdapRmSrv73SufLMKZ", "a b&c"],
    }).queryString;
    expect(query).toContain("filters[metaIds][0]=B0vdapRmSrv73SufLMKZ");
    expect(query).toContain("filters[metaIds][1]=a%20b%26c");
  });

  it("echoes every filter it sent, and nothing it did not", () => {
    const query = buildScreenQuery({
      rankBy: { key: "volume", order: "desc" },
      window: "h24",
      chainIds: SOLANA,
      minLiquidityUsd: 25_000,
    });
    expect(query.filtersApplied).toStrictEqual([
      { filter: "chainIds", key: "filters[chainIds][0]", value: "solana" },
      { filter: "liquidity", key: "filters[liquidity][min]", value: "25000" },
    ]);
  });

  it("refuses a rank key the provider would answer with a 422 upgrade refusal", () => {
    let thrown: unknown;
    try {
      buildScreenQuery({
        // The `fdv` sort is a measured server defect: it returns the `txns`
        // ordering. It must not be reachable even by a cast.
        rankBy: {
          key: "fdv" as unknown as "volume",
          order: "desc",
        },
        window: "h24",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.SCREEN_RANK_KEY_NOT_SUPPORTED
    );
  });

  it("refuses a non-finite threshold rather than sending NaN", () => {
    expect(() =>
      buildScreenQuery({
        rankBy: { key: "volume", order: "desc" },
        window: "h24",
        minLiquidityUsd: Number.NaN,
      })
    ).toThrow(/finite/);
  });
});

describe("filter-name whitelist", () => {
  it("accepts exactly the measured working filter vocabulary", () => {
    for (const name of SCREEN_FILTER_NAMES) {
      expect(isKnownScreenFilterName(name)).toBe(true);
      expect(() => assertKnownScreenFilterName(name)).not.toThrow();
    }
  });

  it("refuses a filter the provider accepts and then ignores, by name and with the reason", () => {
    let thrown: unknown;
    try {
      assertKnownScreenFilterName("isHoneyPot");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED
    );
    expect((thrown as VexError).message).toContain("isHoneyPot");
    expect((thrown as VexError).message).toContain("ignored");
  });

  it("refuses every member of the measured dead-filter family", () => {
    for (const name of [
      "isRenounced",
      "isOpenSource",
      "buyTax",
      "sellTax",
      "holderCount",
      "lpHolderCount",
      "tokenSnifferScore",
      "moonshotProgress",
    ]) {
      let thrown: unknown;
      try {
        assertKnownScreenFilterName(name);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as VexError).code).toBe(
        DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED
      );
      expect((thrown as VexError).message).toContain(name);
    }
  });

  it("refuses an unknown name and lists the whole supported vocabulary", () => {
    let thrown: unknown;
    try {
      assertKnownScreenFilterName("liquidityUSD");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED
    );
    for (const name of SCREEN_FILTER_NAMES) {
      expect((thrown as VexError).hint).toContain(name);
    }
  });
});

describe("applyFloor and accountFloors", () => {
  const request: ScreenRequest = {
    rankBy: { key: "priceChangeH24", order: "desc" },
    window: "h24",
  };

  /**
   * Account a request the way a tool does: apply the preset, build the query,
   * then read the outcome back OUT of that query. The indirection is the
   * contract under test - the accounting must come from the filters that were
   * really sent, not from the preset table that was consulted.
   */
  function account(
    partial: Partial<ScreenRequest>,
    preset: keyof typeof SCREEN_PRESET_FLOORS = "gainers"
  ) {
    const applied = applyFloor(
      { ...request, ...partial } as ScreenRequest,
      SCREEN_PRESET_FLOORS[preset]
    );
    const query = buildScreenQuery(applied.request);
    return { query, accounting: accountFloors(applied, query) };
  }

  it("fills in every default the caller said nothing about", () => {
    const { accounting } = account({});
    expect(accounting.defaultsApplied.map((entry) => entry.param)).toStrictEqual([
      "minTxnCount",
      "minSellCount",
      "minVolumeUsd",
      "minLiquidityUsd",
      "requireProfile",
    ]);
    expect(accounting.defaultsOverridden).toStrictEqual([]);
    expect(accounting.defaultsDisabled).toStrictEqual([]);
    expect(accounting.qualityFloorApplied).toBe(true);
  });

  it("reports a TIGHTENED override as a floor that still holds", () => {
    const { query, accounting } = account({ minLiquidityUsd: 1_000_000 });
    expect(query.queryString).toContain("filters[liquidity][min]=1000000");
    expect(accounting.defaultsOverridden).toStrictEqual([
      {
        param: "minLiquidityUsd",
        defaultValue: 250_000,
        disposition: "tightened",
        effectiveValue: 1_000_000,
        effectiveKey: "filters[liquidity][min]",
      },
    ]);
    expect(accounting.qualityFloorApplied).toBe(true);
  });

  it("reports a WEAKENED override as the floor it actually is, not the default", () => {
    // The measured defect: 250,000 was still claimed while the population the
    // query screened had grown from 162 rows to 545.
    const { query, accounting } = account({ minLiquidityUsd: 1_000 });
    expect(query.queryString).toContain("filters[liquidity][min]=1000");
    expect(accounting.defaultsOverridden).toStrictEqual([
      {
        param: "minLiquidityUsd",
        defaultValue: 250_000,
        disposition: "weakened",
        effectiveValue: 1_000,
        effectiveKey: "filters[liquidity][min]",
      },
    ]);
    expect(accounting.qualityFloorApplied).toBe(false);
  });

  it("reports requireProfile false as REMOVED, because no filter went out", () => {
    // The other measured defect: the provider has no not-profiled filter, so
    // `false` sends nothing at all, and the envelope claimed the floor anyway.
    const { query, accounting } = account({ requireProfile: false });
    expect(query.queryString).not.toContain("enhancedTokenInfo");
    expect(accounting.defaultsDisabled).toStrictEqual([
      {
        param: "requireProfile",
        defaultValue: true,
        disposition: "removed",
        effectiveValue: null,
        effectiveKey: null,
      },
    ]);
    expect(accounting.qualityFloorApplied).toBe(false);
  });

  it("disableQualityFloor drops every default at once and says so", () => {
    const { query, accounting } = account({ disableQualityFloor: true });
    for (const key of [
      "filters[liquidity][min]",
      "filters[volume]",
      "filters[txns]",
      "filters[sells]",
      "filters[enhancedTokenInfo]",
    ]) {
      expect(query.queryString).not.toContain(key);
    }
    expect(accounting.qualityFloorApplied).toBe(false);
    expect(accounting.defaultsDisabled.map((entry) => entry.param)).toStrictEqual([
      "minTxnCount",
      "minSellCount",
      "minVolumeUsd",
      "minLiquidityUsd",
      "requireProfile",
    ]);
    expect(accounting.defaultsApplied).toStrictEqual([]);
  });

  it("keeps an explicit threshold when every default floor is disabled", () => {
    const { query, accounting } = account({
      disableQualityFloor: true,
      minLiquidityUsd: 5_000,
    });
    expect(query.queryString).toContain("filters[liquidity][min]=5000");
    // The caller's own 5,000 is not the 250,000 default, so the DEFAULT floor
    // is still gone and the claim still fails.
    expect(accounting.qualityFloorApplied).toBe(false);
    expect(
      accounting.floors.find((entry) => entry.param === "minLiquidityUsd")
        ?.disposition
    ).toBe("weakened");
  });

  it("treats a floor re-anchored to another window as not in force", () => {
    const { accounting } = account({ minTxnCount: { value: 300, window: "m5" } });
    const record = accounting.floors.find(
      (entry) => entry.param === "minTxnCount"
    );
    // 300 trades over five minutes is a different screen from 300 over a day,
    // so the h24 floor the board declares is gone, and the key that replaced
    // it is named rather than left as an absence.
    expect(record?.disposition).toBe("removed");
    expect(record?.effectiveKey).toBe("filters[txns][m5][min]");
    expect(accounting.qualityFloorApplied).toBe(false);
  });

  it("claims no quality floor for a preset that declares none", () => {
    const { accounting } = account({}, "trending");
    expect(accounting.qualityFloorApplied).toBe(false);
    expect(accounting.defaultsApplied).toStrictEqual([]);
    expect(accounting.floors).toStrictEqual([]);
  });

  it("carries the h24 anchor into the filled-in windowed threshold", () => {
    const outcome = applyFloor(
      { ...request, window: "m5", thresholdWindow: "m5" } as ScreenRequest,
      SCREEN_PRESET_FLOORS.gainers
    );
    expect(outcome.request.minTxnCount).toStrictEqual({
      value: 300,
      window: "h24",
    });
  });

  it("does not mutate the request it was given", () => {
    const original: ScreenRequest = { ...request };
    applyFloor(original, SCREEN_PRESET_FLOORS.gainers);
    expect(original).toStrictEqual({ ...request });
  });
});
