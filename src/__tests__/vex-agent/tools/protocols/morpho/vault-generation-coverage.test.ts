/**
 * Two coverage defects the 2026-08-18 audit found, and the disclosure that
 * closed the third.
 *
 * `market.get` was answering "which vaults supply this market" from
 * `supplyingVaults` alone, which Morpho serves as V1 (MetaMorpho) vaults ONLY.
 * On the Base cbBTC/USDC market that reported 13 suppliers and hid 14 - and the
 * hidden ones were not obscure, they included a V2 vault carrying the SAME NAME
 * as a V1 one already in the list. A reply that is silently half a population is
 * worse than a short one, because nothing in it says so.
 *
 * The vault reads then knew a curator's name and a boolean and nothing else,
 * while the whole deposit gate rests on that curator vouching for the markets a
 * vault lends into. The disclosure block is display-only under rules/90, so
 * every case below also holds the line that an ABSENT field stays absent rather
 * than being reported as a finding.
 */

import { describe, expect, it } from "vitest";

import { validateMorphoMarketDetail } from "@tools/morpho/validation/markets.js";
import {
  validateMorphoVaultV1Detail,
  validateMorphoVaultV2Detail,
} from "@tools/morpho/validation/vaults.js";
import { projectMarketDetail } from "../../../../../vex-agent/tools/protocols/morpho/projectors.js";
import { projectVaultDetail } from "../../../../../vex-agent/tools/protocols/morpho/projectors/vaults.js";
import { MORPHO_MARKET_DETAIL } from "./fixtures.js";
import { MORPHO_VAULT_V1_DETAIL, MORPHO_VAULT_V2_DETAIL_GATED } from "./vault-fixtures.js";

const MARKET_OPTIONS = {
  includeHistory: false,
  lookback: "seven_days",
  includeSupplyingVaults: true,
} as const;

describe("market.get supplier list: both vault generations, each tagged", () => {
  const detail = validateMorphoMarketDetail(MORPHO_MARKET_DETAIL, MARKET_OPTIONS);

  it("merges supplyingVaults and supplyingVaultV2s into one population", () => {
    const versions = (detail.supplyingVaults ?? []).map((vault) => vault.version);
    expect(versions).toContain("v1");
    expect(versions).toContain("v2");
  });

  // V1 nests its APY under `state`, V2 serves it FLAT. Reading a V2 row through
  // the V1 shape returns null on every row, which reads as missing data rather
  // than as a wrong path.
  it("reads each generation's APY through its OWN shape, so neither comes back null", () => {
    for (const version of ["v1", "v2"] as const) {
      const rows = (detail.supplyingVaults ?? []).filter((vault) => vault.version === version);
      expect(rows.length, version).toBeGreaterThan(0);
      expect(rows.every((row) => typeof row.netApy === "number"), version).toBe(true);
    }
  });

  it("keeps two same-named vaults distinguishable by address and version", () => {
    const named = (detail.supplyingVaults ?? []).filter((vault) => vault.name === "Gauntlet USDC Prime");
    expect(named.length).toBe(2);
    expect(new Set(named.map((vault) => vault.address)).size).toBe(2);
    expect(new Set(named.map((vault) => vault.version)).size).toBe(2);
  });

  it("projects the version on every row and warns that a name is not an identity", () => {
    const projected = projectMarketDetail(detail, false, "seven_days") as Record<string, unknown>;
    const suppliers = projected["supplyingVaults"] as Record<string, unknown>;
    const rows = suppliers["vaults"] as Array<Record<string, unknown>>;
    expect(rows.every((row) => row["version"] === "v1" || row["version"] === "v2")).toBe(true);
    expect(suppliers["count"]).toBe(rows.length);
    expect(String(suppliers["note"])).toContain("BOTH GENERATIONS");
  });

  it("still returns null when the caller did not ask for suppliers", () => {
    const without = validateMorphoMarketDetail(MORPHO_MARKET_DETAIL, {
      ...MARKET_OPTIONS,
      includeSupplyingVaults: false,
    });
    expect(without.supplyingVaults).toBeNull();
  });
});

describe("vault.get curator disclosure", () => {
  const v1 = validateMorphoVaultV1Detail(MORPHO_VAULT_V1_DETAIL, { includeAllocations: false });

  it("reads the vault's own published description and image", () => {
    expect(v1.description).toContain("Smokehouse USDC vault");
    expect(v1.imageUrl).toContain("steakhouse");
  });

  it("reads the curator's links, image and assets under management", () => {
    const curator = v1.curators[0];
    expect(curator?.name).toBe("Steakhouse Financial");
    expect(curator?.aumUsd).toBeCloseTo(2277792414.443664, 3);
    expect(curator?.links.map((link) => link.type)).toEqual(["url", "forum", "twitter"]);
    expect(curator?.links[0]?.url).toBe("https://www.steakhouse.financial");
  });

  // A link with no URL is not a link. Emitting it with an empty href would put a
  // dead reference in front of an agent about to trust this curator with funds.
  it("drops a link Morpho served without a URL rather than emitting an empty one", () => {
    expect(v1.curators[0]?.links.some((link) => link.type === "broken")).toBe(false);
  });

  it("keeps a published-but-null field null rather than inventing a value", () => {
    expect(v1.curators[0]?.description).toBeNull();
  });

  it("reads how Morpho classifies the account holding the curator role", () => {
    expect(v1.curatorAccountTypes).toEqual(["safe"]);
  });

  // Morpho exposes no `curatorMetadata` equivalent on V2 (introspection,
  // 2026-08-18), and an absence must be reported as an absence.
  it("reports V2's missing classification as empty, not as a single-key finding", () => {
    const v2 = validateMorphoVaultV2Detail(MORPHO_VAULT_V2_DETAIL_GATED, { includeAllocations: false });
    expect(v2.curatorAccountTypes).toEqual([]);
    expect(v2.description).toContain("uncurated test vault");
  });

  it("projects a disclosure block that names it as the curator's own claim", () => {
    const projected = projectVaultDetail(v1, false);
    const disclosure = projected["disclosure"] as Record<string, unknown>;
    expect(disclosure["vaultDescription"]).toBe(v1.description);
    expect(disclosure["curatorAccountTypes"]).toEqual(["safe"]);
    const note = String(disclosure["note"]);
    expect(note).toMatch(/not an audit/);
    expect(note).toMatch(/EMPTY list means Morpho published no classification/);
    const curators = disclosure["curators"] as Array<Record<string, unknown>>;
    expect((curators[0]?.["links"] as unknown[]).length).toBe(3);
  });

  // A screening row does not select the disclosure fields, and that must not
  // cost the caller the curator identity it does select.
  it("keeps a curator row usable when the disclosure fields were never asked for", () => {
    const bare = validateMorphoVaultV2Detail(MORPHO_VAULT_V2_DETAIL_GATED, { includeAllocations: false });
    for (const curator of bare.curators) {
      expect(curator.links).toEqual([]);
      expect(curator.aumUsd).toBeNull();
    }
  });
});
