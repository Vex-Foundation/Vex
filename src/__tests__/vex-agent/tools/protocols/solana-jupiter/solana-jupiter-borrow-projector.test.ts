import { describe, expect, it } from "vitest";
import {
  projectJupiterLendBorrowPositions,
  projectJupiterLendBorrowVaults,
} from "@vex-agent/tools/protocols/solana-jupiter/borrow-projector.js";
import type {
  JupiterLendBorrowPosition,
  JupiterLendBorrowToken,
  JupiterLendBorrowVault,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";

const SOL_TOKEN: JupiterLendBorrowToken = {
  address: "So11111111111111111111111111111111111111112",
  chainId: "solana",
  name: "Wrapped SOL",
  symbol: "WSOL",
  uiSymbol: "SOL",
  decimals: 9,
  price: "73.95",
};

const USDC_TOKEN: JupiterLendBorrowToken = {
  address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  chainId: "solana",
  name: "USD Coin",
  symbol: "USDC",
  uiSymbol: "USDC",
  decimals: 6,
  price: "0.999",
};

// B3: rebuilt from the live fixture (`__tests__/solana/fixtures/lend-borrow/vaults-main.json`
// id 1) — `supplyToken`/`borrowToken` are NESTED token objects, and
// `collateralFactor`/`liquidationThreshold` are DIGIT STRINGS, not numbers.
const VAULT: JupiterLendBorrowVault = {
  id: 1,
  address: "nMzVs8GiXMVUENEwkev7JZfDcCENmz18ScheeVRdnb1",
  supplyToken: SOL_TOKEN,
  borrowToken: USDC_TOKEN,
  collateralFactor: "800",
  liquidationThreshold: "850",
  borrowable: "1000000000",
  withdrawable: "900000000",
  minimumBorrowing: "100000",
};

// A NON-6-decimal DEBT leg (the regression this pins): every vault in the
// recorded fixtures happens to borrow a 6-decimal stable, so a projector that
// mixed the two legs up, or hardcoded 6, would still look right there. Live
// 2026-07-24 observation: a WSOL-debt vault reports minimumBorrowing "1054"
// against 9 debt decimals, four orders of magnitude away from the 6-decimal
// vaults' ~"1047061" — reading either one without its own decimals is the
// 1000x hazard this projector now prevents.
const WSOL_DEBT_VAULT: JupiterLendBorrowVault = {
  ...VAULT,
  id: 77,
  supplyToken: USDC_TOKEN,
  borrowToken: SOL_TOKEN,
  borrowable: "12000000000",
  withdrawable: "500000000",
  minimumBorrowing: "1054",
};

const POSITION: JupiterLendBorrowPosition = {
  id: 42,
  vaultId: 1,
  ownerAddress: "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ",
  supply: "30000000",
  borrow: "5000000",
  dustBorrow: "5001",
};

/** Exact-arithmetic health fixture: 1 WSOL @ $100 collateral, 50 USDC @ $1 debt → 50.00% LTV. */
const HEALTH_VAULT: JupiterLendBorrowVault = {
  ...VAULT,
  supplyToken: { ...SOL_TOKEN, price: "100" },
  borrowToken: { ...USDC_TOKEN, price: "1" },
};
const HEALTH_POSITION: JupiterLendBorrowPosition = {
  ...POSITION,
  supply: "1000000000",
  borrow: "50000000",
  dustBorrow: "0",
};

function readPositions(
  positions: readonly JupiterLendBorrowPosition[] | null | undefined,
  vaults: readonly JupiterLendBorrowVault[] = [VAULT],
  filters?: { vaultIds?: readonly string[] },
) {
  return projectJupiterLendBorrowPositions({
    positions,
    market: "main",
    vaults: { status: "read", vaults },
    ...(filters ? { filters } : {}),
  });
}

describe("projectJupiterLendBorrowVaults", () => {
  it("formats collateralFactor/liquidationThreshold as exact percent strings (verified raw/10 scale)", () => {
    const [projected] = projectJupiterLendBorrowVaults([VAULT]);
    expect(projected!.maxLtvPercent).toBe("80.0%");
    expect(projected!.maxLtvRaw).toBe("800");
    expect(projected!.liquidationThresholdPercent).toBe("85.0%");
    expect(projected!.liquidationThresholdRaw).toBe("850");
  });

  it("carries vaultId, NESTED token addresses, and raw liquidity fields through unchanged", () => {
    const [projected] = projectJupiterLendBorrowVaults([VAULT]);
    expect(projected!.vaultId).toBe("1");
    expect(projected!.supplyTokenAddress).toBe(VAULT.supplyToken.address);
    expect(projected!.borrowTokenAddress).toBe(VAULT.borrowToken.address);
    expect(projected!.borrowableRaw).toBe("1000000000");
    expect(projected!.withdrawableRaw).toBe("900000000");
    expect(projected!.minimumBorrowingRaw).toBe("100000");
  });

  // 2026-07-25 restoration: the wire row always carried symbol/decimals/price
  // for both legs and the projector dropped all six, leaving every *Raw field
  // (and all six borrowOperate amount params, which use the same scales)
  // unreadable next to a bare mint address.
  it("carries BOTH legs' symbol, decimals, and provider price so every raw amount is readable", () => {
    const [projected] = projectJupiterLendBorrowVaults([VAULT]);
    expect(projected!.supplyTokenSymbol).toBe("WSOL");
    expect(projected!.supplyTokenDecimals).toBe(9);
    expect(projected!.supplyTokenPriceUsd).toBe("73.95");
    expect(projected!.borrowTokenSymbol).toBe("USDC");
    expect(projected!.borrowTokenDecimals).toBe(6);
    expect(projected!.borrowTokenPriceUsd).toBe("0.999");
  });

  it("keeps each leg's decimals bound to ITS OWN token on a non-6-decimal DEBT vault", () => {
    const [projected] = projectJupiterLendBorrowVaults([WSOL_DEBT_VAULT]);
    // Legs are swapped relative to VAULT — a projector reading the wrong leg,
    // or assuming 6, would silently misprice by 1000x here.
    expect(projected!.supplyTokenSymbol).toBe("USDC");
    expect(projected!.supplyTokenDecimals).toBe(6);
    expect(projected!.borrowTokenSymbol).toBe("WSOL");
    expect(projected!.borrowTokenDecimals).toBe(9);
    // Surfaced verbatim, never rescaled/gated — see the field's scale caveat.
    expect(projected!.minimumBorrowingRaw).toBe("1054");
    expect(projected!.borrowableRaw).toBe("12000000000");
    expect(projected!.withdrawableRaw).toBe("500000000");
  });

  it("degrades to null (never a fabricated percent) for a malformed raw value", () => {
    const [projected] = projectJupiterLendBorrowVaults([{ ...VAULT, collateralFactor: "not-a-number" }]);
    expect(projected!.maxLtvPercent).toBeNull();
  });

  it("vaultIds filter is an agent-controlled allow-list, never a default cap", () => {
    const vault2: JupiterLendBorrowVault = { ...VAULT, id: 2 };
    expect(projectJupiterLendBorrowVaults([VAULT, vault2])).toHaveLength(2);
    expect(projectJupiterLendBorrowVaults([VAULT, vault2], { vaultIds: ["2"] })).toHaveLength(1);
    expect(projectJupiterLendBorrowVaults([VAULT, vault2], { vaultIds: ["2"] })[0]!.vaultId).toBe("2");
  });

  it("tolerates a non-array input defensively (external API response)", () => {
    expect(projectJupiterLendBorrowVaults(null)).toEqual([]);
    expect(projectJupiterLendBorrowVaults(undefined)).toEqual([]);
  });

  it("a second live-observed collateralFactor/liquidationThreshold pair (ethena market, 920/940) also formats correctly", () => {
    // Fixture: __tests__/solana/fixtures/lend-borrow/vaults-ethena.json id 5.
    const ethenaVault: JupiterLendBorrowVault = { ...VAULT, collateralFactor: "920", liquidationThreshold: "940" };
    const [projected] = projectJupiterLendBorrowVaults([ethenaVault]);
    expect(projected!.maxLtvPercent).toBe("92.0%");
    expect(projected!.liquidationThresholdPercent).toBe("94.0%");
  });
});

describe("projectJupiterLendBorrowPositions", () => {
  // W4 (owner ruling 2026-07-25 — DISCLOSE, DO NOT BLOCK): in a `full`
  // autonomous session there is no approval preview, so THIS read is the only
  // place an agent can learn a leveraged position's health. The identity the
  // row previously told the agent to fetch separately is now carried inline —
  // a raw amount must never travel without the decimals needed to read it.
  it("carries position id, vaultId, raw amounts AND both legs' identity from the vault", () => {
    const [projected] = readPositions([POSITION]).positions;
    expect(projected).toMatchObject({
      positionId: "42",
      vaultId: "1",
      supplyRaw: "30000000",
      borrowRaw: "5000000",
      dustBorrowRaw: "5001",
      supplyTokenSymbol: "WSOL",
      supplyTokenDecimals: 9,
      borrowTokenSymbol: "USDC",
      borrowTokenDecimals: 6,
      maxLtvPercent: "80.0%",
      liquidationThresholdPercent: "85.0%",
    });
  });

  it("sums accrued dust into totalDebtRaw — the figure LTV is computed from", () => {
    const [projected] = readPositions([POSITION]).positions;
    expect(projected!.totalDebtRaw).toBe("5005001");
  });

  it("computes a current LTV and a distance to liquidation on the READ", () => {
    const [projected] = readPositions([HEALTH_POSITION], [HEALTH_VAULT]).positions;
    expect(projected!.risk).toEqual({
      status: "computed",
      collateralUsd: "100.00",
      debtUsd: "50.00",
      currentLtvPercent: "50.00%",
      ltvPercentagePointsToLiquidation: "35.00",
    });
  });

  it("surfaces the provider's isLiquidated flag, and 'unknown' when it is absent", () => {
    const rows = readPositions([
      { ...POSITION, id: 1, isLiquidated: true },
      { ...POSITION, id: 2, isLiquidated: false },
      { ...POSITION, id: 3 },
    ]).positions;
    expect(rows.map((r) => r.liquidationStatus)).toEqual(["liquidated", "not_liquidated", "unknown"]);
  });

  it("names the state when the vault list could not be read — never a silent absence", () => {
    const readout = projectJupiterLendBorrowPositions({
      positions: [POSITION],
      market: "main",
      vaults: { status: "unavailable", reason: "provider timed out" },
    });
    expect(readout.vaultDataStatus).toBe("unavailable");
    expect(readout.vaultDataReason).toContain("provider timed out");
    const [projected] = readout.positions;
    // Identity is explicitly null, not omitted, and the raw amounts survive.
    expect(projected).toMatchObject({
      supplyTokenDecimals: null,
      borrowTokenDecimals: null,
      maxLtvPercent: null,
      liquidationThresholdPercent: null,
      supplyRaw: "30000000",
    });
    expect(projected!.risk.status).toBe("unknown");
    if (projected!.risk.status !== "unknown") throw new Error("unreachable");
    expect(projected!.risk.reason).toMatch(/not a statement that this position is safe/i);
  });

  it("names the state when this position's vault is missing from the list", () => {
    const [projected] = readPositions([{ ...POSITION, vaultId: 999 }], [VAULT]).positions;
    expect(projected!.risk.status).toBe("unknown");
    if (projected!.risk.status !== "unknown") throw new Error("unreachable");
    expect(projected!.risk.reason).toMatch(/vault 999/i);
    expect(projected!.supplyTokenDecimals).toBeNull();
  });

  it("keeps each leg bound to ITS OWN token on a swapped-leg vault", () => {
    const swapped: JupiterLendBorrowPosition = { ...POSITION, vaultId: 77 };
    const [projected] = readPositions([swapped], [WSOL_DEBT_VAULT]).positions;
    expect(projected!.supplyTokenSymbol).toBe("USDC");
    expect(projected!.supplyTokenDecimals).toBe(6);
    expect(projected!.borrowTokenSymbol).toBe("WSOL");
    expect(projected!.borrowTokenDecimals).toBe(9);
  });

  it("states once, in the readout, how to read the risk fields", () => {
    const readout = readPositions([POSITION]);
    expect(readout.market).toBe("main");
    // The guidance is the safety control in autonomous mode — it must tell the
    // agent that 'unknown' is not 'safe' and what raises/lowers LTV.
    expect(readout.howToReadRisk).toMatch(/NOT a statement that the position is safe/i);
    expect(readout.howToReadRisk).toMatch(/liquidat/i);
    expect(readout.howToReadRisk).toMatch(/raw atomic units/i);
  });

  it("vaultIds filter narrows positions by their vaultId", () => {
    const other: JupiterLendBorrowPosition = { ...POSITION, id: 43, vaultId: 2 };
    const filtered = readPositions([POSITION, other], [VAULT], { vaultIds: ["1"] }).positions;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.positionId).toBe("42");
  });

  it("tolerates a non-array input defensively", () => {
    expect(readPositions(null).positions).toEqual([]);
  });
});
