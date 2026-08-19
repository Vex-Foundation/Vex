/**
 * Morpho vault validators against the LIVE 2026-08-14 fixtures.
 *
 * Accept paths assert the numbers the fixture actually contains, so a validator
 * that silently rescaled or renamed a field fails here rather than in front of a
 * user. Reject paths assert the tolerant/strict split: a display gap becomes
 * null and the row survives, an identity or decimals gap drops the row and is
 * COUNTED, and a body where every row drops raises rather than reading as
 * "no vaults matched".
 */

import { describe, it, expect } from "vitest";
import {
  readVaultV1,
  readVaultV2,
  validateMorphoVaultPage,
  validateMorphoVaultV1Detail,
  validateMorphoVaultV2Detail,
} from "../../tools/morpho/validation/vaults.js";
import {
  MORPHO_VAULTS_V1_PAGE,
  MORPHO_VAULTS_V2_PAGE,
  MORPHO_VAULT_V1_DETAIL,
  MORPHO_VAULT_V2_DETAIL_GATED,
} from "../vex-agent/tools/protocols/morpho/vault-fixtures.js";
import { definedValue, mutableRecord, mutableRecordArray } from "../_test-value-guards.js";

const V1_ROW = MORPHO_VAULTS_V1_PAGE.data.vaults.items[0] as unknown;
const V2_ROW = MORPHO_VAULTS_V2_PAGE.data.vaultV2s.items[0] as unknown;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("morpho vault page validation", () => {
  it("reads a live V1 page with both BigInt serialisations intact", () => {
    const page = validateMorphoVaultPage(clone(MORPHO_VAULTS_V1_PAGE), "v1");
    expect(page.droppedRows).toBe(0);
    expect(page.countTotal).toBe(MORPHO_VAULTS_V1_PAGE.data.vaults.pageInfo.countTotal);

    const first = page.vaults[0];
    expect(first.version).toBe("v1");
    expect(first.address).toBe(String(MORPHO_VAULTS_V1_PAGE.data.vaults.items[0].address).toLowerCase());
    // `totalAssets` arrived as a JSON NUMBER and `totalSupply` as a STRING in the
    // same row; both must reach the agent as decimal strings of base units.
    expect(first.totalAssets.raw).toBe(String(MORPHO_VAULTS_V1_PAGE.data.vaults.items[0].state.totalAssets));
    expect(typeof first.totalSupplyRaw).toBe("string");
    expect(first.totalAssets.decimals).toBe(first.asset.decimals);
    // V1 has no gating mechanism, and a single global timelock.
    expect(first.gating).toBeNull();
    expect(first.timelockSeconds).toBe(MORPHO_VAULTS_V1_PAGE.data.vaults.items[0].state.timelock);
    // A V1 list row carries no `liquidity` block at all; claiming total assets
    // were withdrawable would be exactly the wrong default.
    expect(first.liquidity).toBeNull();
    expect(first.fees.management).toBeNull();
  });

  it("reads a live V2 page flat, with gating and both fee legs", () => {
    const page = validateMorphoVaultPage(clone(MORPHO_VAULTS_V2_PAGE), "v2");
    expect(page.droppedRows).toBe(0);

    const first = page.vaults[0];
    expect(first.version).toBe("v2");
    expect(first.totalAssets.raw).toBe(String(MORPHO_VAULTS_V2_PAGE.data.vaultV2s.items[0].totalAssets));
    // V2 timelocks are per-function, so there is no single number to report.
    expect(first.timelockSeconds).toBeNull();
    expect(first.gating).not.toBeNull();
    expect(definedValue(first.gating, "first V2 vault gating").gates).toHaveLength(4);
    expect(first.fees.management).not.toBeNull();
    expect(first.liquidity).not.toBeNull();
  });

  it("classifies a live gated vault by the SIDE the gate blocks", () => {
    const page = validateMorphoVaultPage(clone(MORPHO_VAULTS_V2_PAGE), "v2");
    const gated = page.vaults.filter((v) => v.gating?.gated === true);
    expect(gated.length).toBeGreaterThan(0);
    for (const vault of gated) {
      const gating = definedValue(vault.gating, `gating of vault ${vault.address}`);
      const withAddress = gating.gates.filter((g) => g.address !== null);
      expect(withAddress.length).toBeGreaterThan(0);
      // `sendAssets` and `receiveShares` are the DEPOSIT direction; `sendShares`
      // and `receiveAssets` are the WITHDRAWAL direction.
      const depositSide = withAddress.some((g) => g.name === "sendAssets" || g.name === "receiveShares");
      const withdrawalSide = withAddress.some((g) => g.name === "sendShares" || g.name === "receiveAssets");
      expect(gating.depositGated).toBe(depositSide);
      expect(gating.withdrawalGated).toBe(withdrawalSide);
    }
  });

  it("keeps the vault APY bases apart and never renames one into another", () => {
    const page = validateMorphoVaultPage(clone(MORPHO_VAULTS_V1_PAGE), "v1");
    for (const [index, vault] of page.vaults.entries()) {
      const state = MORPHO_VAULTS_V1_PAGE.data.vaults.items[index].state;
      expect(vault.apy.apy).toBe(state.apy);
      expect(vault.apy.netApy).toBe(state.netApy);
      expect(vault.apy.netApyExcludingRewards).toBe(state.netApyExcludingRewards);
    }
    // The arithmetic the whole labelling rule rests on: net is gross after fee.
    const withFee = definedValue(
      page.vaults.find((v) => (v.fees.performance ?? 0) > 0),
      "a V1 vault with a performance fee",
    );
    const grossApy = definedValue(withFee.apy.apy, "gross APY of the fee-bearing vault");
    const performanceFee = definedValue(withFee.fees.performance, "performance fee of the fee-bearing vault");
    const netApy = definedValue(withFee.apy.netApy, "net APY of the fee-bearing vault");
    const expected = grossApy * (1 - performanceFee);
    expect(Math.abs(netApy - expected)).toBeLessThan(0.001);
  });
});

describe("morpho vault row rejection", () => {
  it("drops a row whose asset decimals cannot be read, and counts it", () => {
    const body = clone(MORPHO_VAULTS_V1_PAGE);
    const items = mutableRecordArray(body.data.vaults.items, "V1 page items");
    mutableRecord(items[0]["asset"], "first V1 row asset")["decimals"] = "6";
    const page = validateMorphoVaultPage(body, "v1");
    expect(page.droppedRows).toBe(1);
    expect(page.vaults).toHaveLength(items.length - 1);
  });

  it("drops a row with no readable total assets rather than showing a vault with no size", () => {
    const row = mutableRecord(clone(V1_ROW), "cloned V1 row");
    mutableRecord(row["state"], "cloned V1 row state")["totalAssets"] = null;
    expect(readVaultV1(row)).toBeNull();
  });

  it("drops a V2 row whose address is malformed", () => {
    const row = mutableRecord(clone(V2_ROW), "cloned V2 row");
    row["address"] = "not-an-address";
    expect(readVaultV2(row)).toBeNull();
  });

  it("keeps a row whose DISPLAY fields are absent, with nulls rather than a drop", () => {
    const row = mutableRecord(clone(V2_ROW), "cloned V2 row");
    row["name"] = null;
    row["symbol"] = "";
    row["netApy"] = null;
    row["sharePrice"] = null;
    const readRow = readVaultV2(row);
    expect(readRow).not.toBeNull();
    const vault = definedValue(readRow, "V2 row with display gaps");
    expect(vault.name).toBeNull();
    expect(vault.symbol).toBeNull();
    expect(vault.apy.netApy).toBeNull();
    expect(vault.sharePrice).toBeNull();
    // Identity and scale survived, so the row is still safe to show.
    expect(vault.totalAssets.decimals).toBe(vault.asset.decimals);
  });

  it("raises rather than returning an empty page when EVERY row fails", () => {
    const body = clone(MORPHO_VAULTS_V1_PAGE);
    for (const item of mutableRecordArray(body.data.vaults.items, "V1 page items")) {
      item["address"] = "0xnope";
    }
    expect(() => validateMorphoVaultPage(body, "v1")).toThrow(/could not read/i);
  });

  it("raises when the response carries no vault block at all", () => {
    expect(() => validateMorphoVaultPage({ data: {} }, "v2")).toThrow(/data\.vaultV2s/);
  });
});

describe("morpho vault detail validation", () => {
  it("reads the V1 detail's roles, pending-config COUNT and allocations", () => {
    const detail = validateMorphoVaultV1Detail(clone(MORPHO_VAULT_V1_DETAIL), { includeAllocations: true });
    const state = MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.state;

    expect(detail.version).toBe("v1");
    expect(detail.guardianAddress).toBe(String(state.guardian).toLowerCase());
    expect(detail.allocatorAddresses.length).toBe(MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.allocators.length);
    // The COUNT, never the paginated governance log itself.
    expect(detail.pendingConfigCount).toBe(state.pendingConfigs.pageInfo.countTotal);
    expect(detail.sentinelAddresses).toEqual([]);
    expect(detail.timelocks).toEqual([]);

    expect(detail.allocations).not.toBeNull();
    const allocations = definedValue(detail.allocations, "V1 detail allocations");
    expect(allocations.length).toBe(state.allocation.length);
    const first = allocations[0];
    expect(first.marketId).toBe(state.allocation[0].market.marketId);
    expect(first.capRaw).toBe(String(state.allocation[0].supplyCap));
    // The allocation's own market APY, kept separate from the vault's net APY.
    expect(first.marketSupplyApy).toBe(state.allocation[0].market.state.supplyApy);
    // A V1 detail DOES carry withdrawable liquidity, unlike a V1 list row.
    expect(detail.liquidity).not.toBeNull();
  });

  it("omits allocations entirely when they were not requested", () => {
    const detail = validateMorphoVaultV1Detail(clone(MORPHO_VAULT_V1_DETAIL), { includeAllocations: false });
    expect(detail.allocations).toBeNull();
  });

  it("reads the V2 detail's sentinels, per-function timelocks and gate", () => {
    const detail = validateMorphoVaultV2Detail(clone(MORPHO_VAULT_V2_DETAIL_GATED), { includeAllocations: true });
    const raw = MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress;

    expect(detail.version).toBe("v2");
    expect(detail.sentinelAddresses.length).toBeGreaterThan(0);
    expect(detail.guardianAddress).toBeNull();
    expect(detail.timelocks.length).toBe(raw.timelocks.length);
    expect(detail.timelocks[0].functionName).toBe(raw.timelocks[0].functionName);
    expect(definedValue(detail.gating, "V2 detail gating").gated).toBe(true);
    expect(detail.adapters.length).toBe(raw.adapters.items.length);
    expect(detail.maxApy).toBe(raw.maxApy);
  });

  it("takes allocations only from the market-bearing member of the cap union", () => {
    const detail = validateMorphoVaultV2Detail(clone(MORPHO_VAULT_V2_DETAIL_GATED), { includeAllocations: true });
    const marketCaps = MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress.caps.items.filter(
      (c) => c.data.__typename === "MarketV1CapData",
    );
    // A collateral or adapter cap is a cap, not a market the vault supplies:
    // counting it would overstate how many markets the vault is exposed to.
    const allocations = definedValue(detail.allocations, "V2 detail allocations");
    expect(allocations.length).toBe(marketCaps.length);
    expect(allocations.length).toBeLessThan(
      MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress.caps.items.length,
    );
    for (const allocation of allocations) {
      expect(allocation.marketId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(allocation.relativeCapWad).not.toBeNull();
    }
  });

  it("refuses a detail body with no readable object rather than inventing an empty vault", () => {
    expect(() => validateMorphoVaultV1Detail({ data: { vaultByAddress: null } }, { includeAllocations: true }))
      .toThrow(/vaultByAddress/);
  });
});
