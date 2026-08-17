/**
 * Validator behaviour for the positions and activity lanes, driven by the
 * verbatim 2026-08-14 captures.
 *
 * The two asymmetries these tests exist to pin, because both look like ordinary
 * null-handling and neither is:
 *
 *   - a supply-only position has NO health factor and must SURVIVE, while a
 *     position with debt and no health factor must be DROPPED;
 *   - `margin` and `borrowPnl` are SIGNED and must not reach the unsigned money
 *     reader, which refuses a negative on purpose.
 */

import { describe, it, expect } from "vitest";
import {
  readMarketPosition,
  readSignedBigIntString,
  validateMorphoMarketPositionPage,
  validateMorphoVaultPositionPage,
  validateMorphoVaultV2Position,
  validateMorphoVaultV2UserVaults,
} from "../../tools/morpho/validation/positions.js";
import {
  readMarketTransaction,
  validateMorphoActivityPage,
} from "../../tools/morpho/validation/activity.js";
import { requireBigIntString } from "../../tools/morpho/validation/_shared.js";
import { definedValue } from "../_test-value-guards.js";
import {
  MORPHO_ACTIVITY_LIQUIDATION_PAGE,
  MORPHO_ACTIVITY_MIXED_PAGE,
  MORPHO_ACTIVITY_WALLET_PAGE,
  MORPHO_MARKET_POSITIONS_PAGE,
  MORPHO_VAULT_POSITIONS_PAGE,
  MORPHO_VAULT_V2_POSITION,
} from "../vex-agent/tools/protocols/morpho/position-fixtures.js";

/**
 * A deep clone the tests may edit without touching the shared fixture.
 *
 * Returns `unknown` on purpose: the fixtures are `as const`, so their inferred
 * type is deeply readonly and a direct cast to a mutable shape is the kind of
 * unsafe assertion the test type ratchet exists to catch. The clone genuinely
 * IS mutable, and going through `unknown` is the honest way to say so.
 */
function mutable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The first live row: a real position sitting far past its liquidation point. */
function firstPositionRow(): Record<string, unknown> {
  const page = mutable(MORPHO_MARKET_POSITIONS_PAGE) as {
    data: { marketPositions: { items: Record<string, unknown>[] } };
  };
  return page.data.marketPositions.items[0];
}

describe("morpho market position validation", () => {
  it("reads the live page and preserves the sub-1 health factor exactly", () => {
    const page = validateMorphoMarketPositionPage(MORPHO_MARKET_POSITIONS_PAGE);
    expect(page.droppedRows).toBe(0);
    expect(page.countTotal).toBe(22);
    const worst = page.positions[0];
    expect(worst.healthFactor).toBe(0.3053054108729547);
    expect(worst.market.listed).toBe(false);
    expect(worst.market.warnings.map((w) => w.type)).toContain("bad_debt_unrealized");
  });

  it("carries every amount with the decimals of the asset it is denominated in", () => {
    const worst = validateMorphoMarketPositionPage(MORPHO_MARKET_POSITIONS_PAGE).positions[0];
    // Collateral is USR at 18 decimals, debt is USDC at 6. Swapping them would
    // misread the position by twelve orders of magnitude.
    expect(worst.collateral?.decimals).toBe(18);
    expect(worst.collateral?.raw).toBe("11834574329029519386");
    expect(worst.borrow.decimals).toBe(6);
    expect(worst.borrow.raw).toBe("35468207");
  });

  it("reads SIGNED margin and borrow PnL that the unsigned money reader refuses", () => {
    const worst = validateMorphoMarketPositionPage(MORPHO_MARKET_POSITIONS_PAGE).positions[0];
    expect(worst.margin?.raw).toBe("-23633633");
    expect(worst.borrowPnl?.raw).toBe("-24648763");
    // The guard that makes the separate reader necessary rather than tidy.
    expect(requireBigIntString(-23633633)).toBeNull();
    expect(readSignedBigIntString(-23633633)).toBe("-23633633");
    expect(readSignedBigIntString(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(readSignedBigIntString("-12")).toBe("-12");
    expect(readSignedBigIntString("1.5")).toBeNull();
  });

  it("KEEPS a supply-only position whose health factor is null", () => {
    const row = firstPositionRow();
    row["healthFactor"] = null;
    row["priceVariationToLiquidationPrice"] = null;
    const state = row["state"] as Record<string, unknown>;
    state["borrowShares"] = 0;
    state["borrowAssets"] = 0;
    const position = readMarketPosition(row);
    expect(position).not.toBeNull();
    expect(position?.healthFactor).toBeNull();
  });

  it("DROPS a position that carries debt but reports no health factor", () => {
    const row = firstPositionRow();
    row["healthFactor"] = null;
    expect((row["state"] as Record<string, unknown>)["borrowShares"]).not.toBe(0);
    expect(readMarketPosition(row)).toBeNull();
  });

  it("drops a row whose loan-asset decimals cannot be read, rather than guessing a scale", () => {
    const row = firstPositionRow();
    const market = row["market"] as Record<string, unknown>;
    (market["loanAsset"] as Record<string, unknown>)["decimals"] = "six";
    expect(readMarketPosition(row)).toBeNull();
  });

  it("raises rather than reporting an empty page when every row fails validation", () => {
    const page = mutable(MORPHO_MARKET_POSITIONS_PAGE) as {
      data: { marketPositions: { items: Record<string, unknown>[] } };
    };
    for (const item of page.data.marketPositions.items) delete item["market"];
    expect(() => validateMorphoMarketPositionPage(page)).toThrow(/failed identity, decimals or health-factor/);
  });
});

describe("morpho vault position validation", () => {
  it("reads the V1 page with the vault asset supplying every scale", () => {
    const page = validateMorphoVaultPositionPage(MORPHO_VAULT_POSITIONS_PAGE);
    expect(page.droppedRows).toBe(0);
    expect(page.positions.length).toBeGreaterThan(0);
    const first = page.positions[0];
    expect(first.vaultVersion).toBe("v1");
    expect(first.assets.decimals).toBe(first.asset.decimals);
    expect(first.shares).toMatch(/^\d+$/);
  });

  it("reads a V2 position from its FLAT shape and labels the generation", () => {
    const position = validateMorphoVaultV2Position(MORPHO_VAULT_V2_POSITION);
    expect(position).not.toBeNull();
    expect(position?.vaultVersion).toBe("v2");
    expect(position?.assets.raw).toBe("204641793666795");
    expect(position?.assets.decimals).toBe(6);
    expect(position?.netApy).toBeCloseTo(0.0412, 3);
  });

  it("treats a null V2 position as an ANSWER, not a failure", () => {
    // A wallet that fully exited a vault it once used resolves to null on a
    // perfectly valid query. Raising there would fail a whole portfolio read.
    expect(validateMorphoVaultV2Position({ data: { vaultV2PositionByAddress: null } })).toBeNull();
  });

  it("dedupes the V2 vault sweep and reports what the scan covered", () => {
    const body = {
      data: {
        vaultV2transactions: {
          pageInfo: { countTotal: 40, count: 3, limit: 3, skip: 0 },
          items: [
            { vault: { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", chain: { id: 8453 } } },
            { vault: { address: "0xBEEF0E0834849ACC03F0089F01F4F1EEB06873C9", chain: { id: 8453 } } },
            { vault: { address: "0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf", chain: { id: 1 } } },
          ],
        },
      },
    };
    const scan = validateMorphoVaultV2UserVaults(body);
    expect(scan.vaults).toHaveLength(2);
    expect(scan.scanned).toBe(3);
    expect(scan.total).toBe(40);
  });
});

describe("morpho activity validation", () => {
  it("reads a mixed-type page and keeps the union member that actually arrived", () => {
    const page = validateMorphoActivityPage(MORPHO_ACTIVITY_MIXED_PAGE);
    expect(page.droppedRows).toBe(0);
    const shapes = new Set(page.transactions.map((t) => t.dataShape));
    expect(shapes.has("MarketTransactionCollateralTransferData")).toBe(true);
    expect(shapes.has("MarketTransactionTransferData")).toBe(true);
    // A collateral transfer carries NO shares. An empty map, never a zero.
    const collateral = definedValue(
      page.transactions.find((t) => t.dataShape === "MarketTransactionCollateralTransferData"),
      "a collateral-transfer transaction",
    );
    expect(collateral.shares).toEqual({});
    expect(collateral.amounts["assets"]?.asset).toBe("collateral");
  });

  it("denominates a liquidation's two legs in DIFFERENT assets at their own scales", () => {
    const page = validateMorphoActivityPage(MORPHO_ACTIVITY_LIQUIDATION_PAGE);
    const row = page.transactions[0];
    expect(row.type).toBe("Liquidation");
    expect(row.liquidatorAddress).toBe("0x6cf59693571329db4a613f9a398205e6de04d05f");
    expect(row.amounts["repaidAssets"]).toEqual({
      raw: "12004",
      decimals: 6,
      symbol: "USDC",
      asset: "loan",
    });
    expect(row.amounts["seizedAssets"]).toEqual({
      raw: "38708708374333048",
      decimals: 18,
      symbol: "WLD",
      asset: "collateral",
    });
    expect(row.amounts["badDebtAssets"]?.raw).toBe("0");
  });

  it("DROPS a liquidation whose seized leg has no collateral asset to scale it", () => {
    const page = mutable(MORPHO_ACTIVITY_LIQUIDATION_PAGE) as {
      data: { marketTransactions: { items: Record<string, unknown>[] } };
    };
    const row = page.data.marketTransactions.items[0];
    (row["market"] as Record<string, unknown>)["collateralAsset"] = null;
    // "Somebody was liquidated" with no idea what was taken reads as a small
    // event. Omitting it is the honest option.
    expect(readMarketTransaction(row)).toBeNull();
  });

  it("keeps an unknown union member as an amount-less row rather than hiding the event", () => {
    const page = mutable(MORPHO_ACTIVITY_MIXED_PAGE) as {
      data: { marketTransactions: { items: Record<string, unknown>[] } };
    };
    const row = page.data.marketTransactions.items[0];
    (row["data"] as Record<string, unknown>)["__typename"] = "MarketTransactionSomethingNewData";
    const parsed = readMarketTransaction(row);
    expect(parsed).not.toBeNull();
    expect(parsed?.amounts).toEqual({});
    expect(parsed?.dataShape).toBe("MarketTransactionSomethingNewData");
  });

  it("reports a short page without treating it as the end of the list", () => {
    // Captured live: first 3 requested, 2 returned, 220 in total.
    const page = validateMorphoActivityPage(MORPHO_ACTIVITY_WALLET_PAGE);
    expect(page.countTotal).toBe(220);
    expect(page.transactions.length).toBeLessThan(page.limit);
    expect(page.skip + page.transactions.length).toBeLessThan(page.countTotal);
  });

  it("raises rather than reporting an empty page when every row fails validation", () => {
    const page = mutable(MORPHO_ACTIVITY_MIXED_PAGE) as {
      data: { marketTransactions: { items: Record<string, unknown>[] } };
    };
    for (const item of page.data.marketTransactions.items) delete item["txHash"];
    expect(() => validateMorphoActivityPage(page)).toThrow(/failed identity or amount validation/);
  });
});
