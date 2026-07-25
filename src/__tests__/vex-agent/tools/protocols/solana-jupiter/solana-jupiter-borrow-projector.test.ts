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
  // Deliberately still identity + raw amounts only: a `/borrow/positions` row
  // carries NO token descriptor on the wire (only `vaultId`), so symbol/
  // decimals here would require a second `/borrow/vaults` fetch. The vault
  // read is where that identity lives, and it now carries decimals — the
  // manifest points the agent at that cross-reference.
  it("carries position id, vaultId, and raw amounts through unchanged", () => {
    const [projected] = projectJupiterLendBorrowPositions([POSITION]);
    expect(projected).toEqual({
      positionId: "42", vaultId: "1", supplyRaw: "30000000", borrowRaw: "5000000", dustBorrowRaw: "5001",
    });
  });

  it("vaultIds filter narrows positions by their vaultId", () => {
    const other: JupiterLendBorrowPosition = { ...POSITION, id: 43, vaultId: 2 };
    const filtered = projectJupiterLendBorrowPositions([POSITION, other], { vaultIds: ["1"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.positionId).toBe("42");
  });

  it("tolerates a non-array input defensively", () => {
    expect(projectJupiterLendBorrowPositions(null)).toEqual([]);
  });
});
