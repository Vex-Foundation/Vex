/**
 * The filter and sort DEPTH added on 2026-08-18, after an external coverage
 * audit found the Morpho discover tools shipping 15 of 43 market filters and 6
 * of 23 usable sort keys.
 *
 * Every case here holds one of two lines. Either a new predicate reaches the
 * wire under the exact `MarketFilters` / `VaultFilters` /
 * `MarketTransactionFilters` field name live introspection confirmed on
 * 2026-08-18 - a misspelled field is a GraphQL error at best and an unfiltered
 * page at worst - or a bad value is REFUSED BY NAME rather than dropped. The
 * second line is the one that matters on a screening tool: a dropped filter is
 * invisible from the caller's side, so the agent believes it screened and every
 * later sizing decision inherits the mistake (rules/90).
 */

import { describe, expect, it } from "vitest";

import {
  MORPHO_ASSET_TAGS,
  MORPHO_MARKET_SORT_KEYS,
  MORPHO_VAULT_SORT_KEYS,
  MORPHO_VAULT_V1_SORTS,
  MORPHO_VAULT_V2_SORTS,
} from "@tools/morpho/request.js";
import {
  parseMorphoActivityParams,
  parseMorphoMarketsParams,
  parseMorphoVaultsParams,
} from "../../../../../vex-agent/tools/protocols/morpho/read-params.js";

const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const OTHER_MARKET_ID = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda";
const ORACLE = "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9";
const IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687";

function acceptedMarkets(params: Record<string, unknown>) {
  const parsed = parseMorphoMarketsParams(params);
  if (!parsed.ok) throw new Error(`expected acceptance, got: ${parsed.rejection.message}`);
  return parsed.value;
}

function refusalOf(
  parsed: ReturnType<typeof parseMorphoMarketsParams | typeof parseMorphoVaultsParams | typeof parseMorphoActivityParams>,
): { param: string; message: string } {
  if (parsed.ok) throw new Error("expected a refusal, got an accepted query");
  return parsed.rejection;
}

describe("morpho.markets.discover: the filters the audit found missing", () => {
  it("sends every new predicate under its live schema field name", () => {
    const query = acceptedMarkets({
      marketIds: `${MARKET_ID},${OTHER_MARKET_ID}`,
      oracleAddress: ORACLE,
      irmAddress: [IRM],
      loanAssetTags: "stablecoin",
      collateralAssetTags: ["lst", "lrt"],
      isIdle: false,
    });

    expect(query.filters.uniqueKey_in).toEqual([MARKET_ID, OTHER_MARKET_ID]);
    expect(query.filters.oracleAddress_in).toEqual([ORACLE.toLowerCase()]);
    expect(query.filters.irmAddress_in).toEqual([IRM.toLowerCase()]);
    expect(query.filters.loanAssetTags_in).toEqual(["stablecoin"]);
    expect(query.filters.collateralAssetTags_in).toEqual(["lst", "lrt"]);
    expect(query.filters.isIdle).toBe(false);
  });

  it("echoes each new filter in filtersApplied, so a screen can be audited", () => {
    const query = acceptedMarkets({ marketIds: [MARKET_ID], oracleAddress: ORACLE, isIdle: true });
    expect(query.echo["marketIds"]).toEqual([MARKET_ID]);
    expect(query.echo["oracleAddress"]).toEqual([ORACLE.toLowerCase()]);
    expect(query.echo["isIdle"]).toBe(true);
  });

  it("accepts a list as a comma string AND as an array, because a model sends either", () => {
    const asString = acceptedMarkets({ marketIds: `${MARKET_ID},${OTHER_MARKET_ID}` });
    const asArray = acceptedMarkets({ marketIds: [MARKET_ID, OTHER_MARKET_ID] });
    expect(asArray.filters.uniqueKey_in).toEqual(asString.filters.uniqueKey_in);
  });

  it("REFUSES a contract address where a market id belongs, and says which it is", () => {
    const rejection = refusalOf(parseMorphoMarketsParams({ marketIds: ORACLE }));
    expect(rejection.param).toBe("marketIds");
    expect(rejection.message).toMatch(/contract ADDRESS/);
  });

  it("REFUSES a market id where a contract address belongs", () => {
    const rejection = refusalOf(parseMorphoMarketsParams({ oracleAddress: MARKET_ID }));
    expect(rejection.param).toBe("oracleAddress");
    expect(rejection.message).toMatch(/MARKET id/);
  });

  // An unknown tag is NOT an error to Morpho: it is a predicate matching
  // nothing, which the agent would read as "no such markets exist".
  it("REFUSES an invented asset tag and spells out the whole real vocabulary", () => {
    const rejection = refusalOf(parseMorphoMarketsParams({ loanAssetTags: "bluechip" }));
    expect(rejection.param).toBe("loanAssetTags");
    for (const tag of MORPHO_ASSET_TAGS) expect(rejection.message).toContain(tag);
    expect(rejection.message).toMatch(/matches nothing/);
  });

  it("normalises a tag to Morpho's own spelling, whose comparison is exact", () => {
    expect(acceptedMarkets({ collateralAssetTags: "LST" }).filters.collateralAssetTags_in).toEqual(["lst"]);
  });

  it("REFUSES a non-boolean isIdle rather than reading it as truthy", () => {
    expect(refusalOf(parseMorphoMarketsParams({ isIdle: "yes" })).param).toBe("isIdle");
  });

  it("accepts every widened sort key, and refuses one outside the table", () => {
    for (const sort of MORPHO_MARKET_SORT_KEYS) {
      expect(acceptedMarkets({ sort }).sort).toBe(sort);
    }
    // Ranking by raw base units is a deliberate omission: it presents a decimals
    // artefact as a size ordering.
    expect(refusalOf(parseMorphoMarketsParams({ sort: "supplyAssets" })).param).toBe("sort");
  });
});

describe("morpho.vaults.discover: the V1-only predicates, refused rather than half-applied", () => {
  it("sends assetTags and suppliesMarketIds under their live field names at version v1", () => {
    const parsed = parseMorphoVaultsParams({ version: "v1", assetTags: "stablecoin", suppliesMarketIds: MARKET_ID });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.v1Filters.assetTags_in).toEqual(["stablecoin"]);
    expect(parsed.value.v1Filters.marketUniqueKey_in).toEqual([MARKET_ID]);
    expect(parsed.value.echo["suppliesMarketIds"]).toEqual([MARKET_ID]);
  });

  // The default `version` is "both", so the unqualified call is the dangerous
  // one: applying a V1-only predicate there would mix filtered V1 rows with
  // UNFILTERED V2 rows under one heading.
  it("REFUSES each V1-only predicate at the default version, naming the fix", () => {
    for (const param of ["assetTags", "suppliesMarketIds"]) {
      const rejection = refusalOf(parseMorphoVaultsParams({ [param]: param === "assetTags" ? "stablecoin" : MARKET_ID }));
      expect(rejection.param).toBe(param);
      expect(rejection.message).toContain('version` to "v1"');
    }
  });

  it("REFUSES them explicitly at version v2 too", () => {
    expect(refusalOf(parseMorphoVaultsParams({ version: "v2", assetTags: "stablecoin" })).param).toBe("assetTags");
  });

  it("accepts every widened sort key on the generation that declares it", () => {
    for (const sort of MORPHO_VAULT_SORT_KEYS) {
      const version = sort in MORPHO_VAULT_V1_SORTS ? "v1" : "v2";
      const parsed = parseMorphoVaultsParams({ version, sort });
      expect(parsed.ok, `${version}/${sort}`).toBe(true);
    }
  });

  it("REFUSES a V2-only key at version v1, naming v2 as the version that serves it", () => {
    const v2Only = MORPHO_VAULT_SORT_KEYS.filter((key) => !(key in MORPHO_VAULT_V1_SORTS));
    expect(v2Only.length).toBeGreaterThan(0);
    for (const sort of v2Only) {
      const rejection = refusalOf(parseMorphoVaultsParams({ version: "v1", sort }));
      expect(rejection.param).toBe("sort");
      expect(rejection.message).toContain('version: "v2"');
    }
  });

  it("REFUSES a V1-only key at version v2, naming v1", () => {
    const v1Only = MORPHO_VAULT_SORT_KEYS.filter((key) => !(key in MORPHO_VAULT_V2_SORTS));
    for (const sort of v1Only) {
      const rejection = refusalOf(parseMorphoVaultsParams({ version: "v2", sort }));
      expect(rejection.message).toContain('version: "v1"');
    }
  });
});

describe("morpho.markets.activity: hash lookup, liquidator and the size floors", () => {
  it("sends every new predicate under its live schema field name", () => {
    const parsed = parseMorphoActivityParams({
      txHash: `0x${"a".repeat(64)}`,
      liquidatorAddress: ORACLE,
      minBadDebtAssetsRaw: "1000000",
      minSeizedAssetsRaw: "500000000000000000",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filters.hash).toBe(`0x${"a".repeat(64)}`);
    expect(parsed.value.filters.liquidatorAddress_in).toEqual([ORACLE.toLowerCase()]);
    expect(parsed.value.filters.badDebtAssets_gte).toBe("1000000");
    expect(parsed.value.filters.seizedAssets_gte).toBe("500000000000000000");
    expect(parsed.value.echo["minBadDebtAssetsRaw"]).toBe("1000000");
  });

  it("REFUSES an address where a transaction hash belongs", () => {
    const rejection = refusalOf(parseMorphoActivityParams({ txHash: ORACLE }));
    expect(rejection.param).toBe("txHash");
    expect(rejection.message).toMatch(/contract ADDRESS/);
  });

  // "0.5" and "500000" differ by six orders of magnitude on a USDC market, so
  // the human form is refused rather than rounded into a floor nobody asked for.
  it("REFUSES a human decimal size floor rather than rounding it", () => {
    const rejection = refusalOf(parseMorphoActivityParams({ minBadDebtAssetsRaw: "0.5" }));
    expect(rejection.param).toBe("minBadDebtAssetsRaw");
    expect(rejection.message).toMatch(/RAW base units/);
  });

  it("REFUSES an unquoted number, which cannot carry a token amount at full precision", () => {
    const rejection = refusalOf(parseMorphoActivityParams({ minSeizedAssetsRaw: 1_000_000 }));
    expect(rejection.param).toBe("minSeizedAssetsRaw");
    expect(rejection.message).toMatch(/STRING of raw base units/);
  });

  it("leaves every new filter absent when it was not asked for", () => {
    const parsed = parseMorphoActivityParams({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filters.hash).toBeUndefined();
    expect(parsed.value.filters.liquidatorAddress_in).toBeUndefined();
    expect(parsed.value.filters.badDebtAssets_gte).toBeUndefined();
  });
});
