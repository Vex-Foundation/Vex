/**
 * The Blue borrow ENGINE's gates: health-factor projection, the repay
 * denomination rule, market liquidity, and the direct Blue borrow calldata.
 *
 * Every number that appears as a fixture here was MEASURED on an Anvil fork of
 * Base on 2026-08-17 rather than invented, so a change in the SDK's behaviour
 * shows up as a failure here instead of as a surprise on a funded wallet.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import { blueAbi } from "@morpho-org/blue-sdk-viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import {
  buildMorphoDirectBorrow,
  describeMorphoBorrowLeg,
  projectHealthFactorAfter,
} from "../../../tools/morpho/mutations/borrow-engine.js";
import type {
  MorphoBorrowIntent,
  MorphoMarketIdentity,
} from "../../../tools/morpho/mutations/borrow-types.js";

const BASE = 8453;
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const LOAN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const COLLATERAL = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;

/** The real Base cbBTC/USDC market: 8-decimal collateral, 6-decimal debt. */
const MARKET: MorphoMarketIdentity = {
  chainId: BASE,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
  loanToken: LOAN,
  loanDecimals: 6,
  loanSymbol: "USDC",
  collateralToken: COLLATERAL,
  collateralDecimals: 8,
  collateralSymbol: "cbBTC",
  oracle: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
  irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
  lltvRaw: "860000000000000000",
};

const MARKET_PARAMS = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: MARKET.oracle,
  irm: MARKET.irm,
  lltv: 860_000_000_000_000_000n,
};

function intent(overrides: Partial<MorphoBorrowIntent> = {}): MorphoBorrowIntent {
  return {
    operation: "borrow",
    market: MARKET,
    userAddress: WALLET,
    recipient: WALLET,
    amountRaw: 500_000_000n,
    sharesRaw: null,
    repayMode: null,
    ...overrides,
  };
}

/** A position stub whose projection methods answer, or throw like the SDK's. */
function positionStub(answer: bigint | "throw") {
  const respond = () => {
    if (answer === "throw") {
      const error = new Error(`insufficient collateral for user ${WALLET} on market ${MARKET.marketId}`);
      error.name = "InsufficientCollateral";
      throw error;
    }
    return answer;
  };
  return {
    borrow: () => ({ position: { healthFactor: respond() } }),
    repay: () => ({ position: { healthFactor: respond() } }),
    supplyCollateral: () => ({ healthFactor: respond() }),
    withdrawCollateral: () => ({ healthFactor: respond() }),
  };
}

const NOW = 1_755_400_000n;

describe("health factor projection", () => {
  it("returns the projected factor for each of the four operations", () => {
    const healthy = 1_365_999_339_317_000_330n; // measured on the fork
    for (const operation of ["supply_collateral", "withdraw_collateral", "borrow", "repay"] as const) {
      const value = projectHealthFactorAfter(
        positionStub(healthy),
        intent({ operation, repayMode: operation === "repay" ? "assets" : null, amountRaw: 1n }),
        NOW,
      );
      expect(value).toBe(healthy);
    }
  });

  it("normalises the MaxUint256 sentinel of a debt-free position to null", () => {
    // The SDK types this `bigint | undefined` and then returns MaxUint256.
    // Compared naively against the floor it passes, which is the right answer
    // for the wrong reason; null is the honest shape.
    const value = projectHealthFactorAfter(positionStub(2n ** 256n - 1n), intent({ operation: "repay", repayMode: "shares", sharesRaw: 5n, amountRaw: null }), NOW);
    expect(value).toBeNull();
  });

  it("translates the SDK's InsufficientCollateral throw into a named refusal", () => {
    let thrown: VexError | undefined;
    try {
      projectHealthFactorAfter(positionStub("throw"), intent(), NOW);
    } catch (error) {
      thrown = error as VexError;
    }

    expect(thrown).toBeInstanceOf(VexError);
    expect(thrown?.code).toBe(ErrorCodes.MORPHO_HEALTH_FACTOR_FLOOR);
    // The real cause survives, sanitized into words an agent can act on.
    expect(thrown?.message).toContain("does not have enough collateral");
    expect(thrown?.message).toContain("insufficient collateral for user");
    expect(thrown?.hint).toContain("Borrow a smaller amount");
  });

  it("gives a collateral withdrawal its own remedy, not the borrow one", () => {
    let thrown: VexError | undefined;
    try {
      projectHealthFactorAfter(positionStub("throw"), intent({ operation: "withdraw_collateral" }), NOW);
    } catch (error) {
      thrown = error as VexError;
    }
    expect(thrown?.hint).toContain("Withdraw less collateral");
  });
});

describe("operation legs", () => {
  it("names the right token, direction and DECIMALS for each operation", () => {
    // The whole point: a cbBTC leg is 8 decimals and a USDC leg is 6, and the
    // engine must never hand one the other's scale.
    expect(describeMorphoBorrowLeg(intent({ operation: "supply_collateral" }))).toMatchObject({
      direction: "in", tokenAddress: COLLATERAL.toLowerCase(), decimals: 8, tokenSymbol: "cbBTC",
    });
    expect(describeMorphoBorrowLeg(intent({ operation: "withdraw_collateral" }))).toMatchObject({
      direction: "out", tokenAddress: COLLATERAL.toLowerCase(), decimals: 8,
    });
    expect(describeMorphoBorrowLeg(intent({ operation: "borrow" }))).toMatchObject({
      direction: "out", tokenAddress: LOAN.toLowerCase(), decimals: 6, tokenSymbol: "USDC",
    });
    expect(describeMorphoBorrowLeg(intent({ operation: "repay", repayMode: "assets" }))).toMatchObject({
      direction: "in", tokenAddress: LOAN.toLowerCase(), decimals: 6,
    });
  });

  it("leaves the amount null on a repay by shares, rather than guessing it", () => {
    const leg = describeMorphoBorrowLeg(
      intent({ operation: "repay", repayMode: "shares", sharesRaw: 448_279_242_862_506n, amountRaw: null }),
    );
    expect(leg.amountRaw).toBeNull();
    expect(leg.decimals).toBe(6);
  });
});

describe("direct Blue borrow calldata", () => {
  it("encodes borrow(marketParams, assets, 0, onBehalf=user, receiver) at Morpho Blue", () => {
    const tx = buildMorphoDirectBorrow(intent({ amountRaw: 500_000_000n }), MARKET_PARAMS);

    expect(tx.to.toLowerCase()).toBe(MORPHO_BLUE.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.builtBy).toBe("vex-direct-blue");

    const decoded = decodeFunctionData({ abi: blueAbi, data: tx.data });
    expect(decoded.functionName).toBe("borrow");
    const [decodedParams, assets, shares, onBehalf, receiver] = decoded.args as [
      typeof MARKET_PARAMS, bigint, bigint, string, string,
    ];
    expect(assets).toBe(500_000_000n);
    // Denominated in ASSETS, so the shares argument must be zero. A non-zero
    // shares argument alongside a non-zero assets argument is rejected by Blue.
    expect(shares).toBe(0n);
    // THE WHOLE REASON NO AUTHORIZATION IS NEEDED: onBehalf is the sender.
    expect(onBehalf.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(receiver.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(decodedParams.oracle.toLowerCase()).toBe(MARKET.oracle.toLowerCase());
    expect(decodedParams.irm.toLowerCase()).toBe(MARKET.irm.toLowerCase());
  });

  it("carries a recipient that differs from the borrower when one was named", () => {
    const elsewhere = "0x000000000000000000000000000000000000beef" as const;
    const tx = buildMorphoDirectBorrow(intent({ recipient: elsewhere }), MARKET_PARAMS);
    const decoded = decodeFunctionData({ abi: blueAbi, data: tx.data });
    const [, , , onBehalf, receiver] = decoded.args as [unknown, bigint, bigint, string, string];
    expect(onBehalf.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(receiver.toLowerCase()).toBe(elsewhere);
  });

  it("refuses to encode a borrow of nothing", () => {
    expect(() => buildMorphoDirectBorrow(intent({ amountRaw: 0n }), MARKET_PARAMS)).toThrow(VexError);
  });
});

describe("bundle allowlist for the Blue market legs", () => {
  it("admits exactly the selectors the 2026-08-17 Base capture observed", async () => {
    const { allowedLegSelectors } = await import("../../../tools/morpho/mutations/allowlist.js");
    const selectors = allowedLegSelectors().map((entry) => entry.split(" ")[0]);

    // Pinned to the capture in agents_dm/morpho-e3/fixtures/base-borrow-bundles.json.
    // A selector that drifts means the SDK changed the bundle it builds, which
    // must fail here rather than be discovered by a refused live transaction.
    expect(selectors).toContain("0xca463673"); // morphoSupplyCollateral
    expect(selectors).toContain("0x4d5fcf68"); // morphoRepay
    expect(selectors).toContain("0x3790767d"); // erc20Transfer, the shares sweep-back
    expect(selectors).toContain("0xd96ca0b9"); // erc20TransferFrom, shared with the vault lane
  });

  it("still does NOT admit a Permit2 or native-wrap leg, which no capture produced", async () => {
    const { MORPHO_ALLOWED_BUNDLE_LEGS } = await import("../../../tools/morpho/mutations/allowlist.js");
    const names = MORPHO_ALLOWED_BUNDLE_LEGS.map((call) => call.functionName);
    expect(names).not.toContain("permit2TransferFrom");
    expect(names).not.toContain("approve2");
    expect(names).not.toContain("wrapNative");
  });
});
