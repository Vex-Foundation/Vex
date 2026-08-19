/**
 * The Morpho BLUE MARKET bundle decoder, held to the captured bytes.
 *
 * The accept cases are the capture itself, unmodified. Every refusal case is the
 * SAME bytes with exactly one field re-encoded through viem, so a passing test
 * proves the decoder rejects that field rather than rejecting the fixture for
 * some unrelated reason.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, decodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { bundler3Abi, generalAdapter1Abi } from "@morpho-org/morpho-sdk/abis";

import { VexError } from "../../../errors.js";
import { definedValue } from "../../_test-value-guards.js";
import {
  verifyMorphoMarketBundle,
  type MorphoBorrowIntent,
  type MorphoBorrowOperation,
  type MorphoMarketBundleBounds,
  type MorphoRepayMode,
} from "@tools/morpho/mutations.js";

import {
  BASE_CHAIN_ID,
  BASE_GENERAL_ADAPTER_1,
  BASE_USDC,
  CAPTURED_COLLATERAL_RAW,
  CAPTURED_MARKET_ID,
  CAPTURED_MARKET_PARAMS,
  CAPTURED_REPAY_ASSETS_RAW,
  CAPTURED_REPAY_ASSETS_SHARE_PRICE,
  CAPTURED_REPAY_SHARES_RAW,
  CAPTURED_REPAY_SHARES_SHARE_PRICE,
  CAPTURED_SHARES_TRANSFER_BOUND_RAW,
  CAPTURED_MARKET_SUPPLY_RAW,
  CAPTURED_MARKET_SUPPLY_SHARE_PRICE,
  CAPTURED_USER,
  MARKET_SUPPLY_TX,
  REPAY_ASSETS_TX,
  REPAY_SHARES_TX,
  SUPPLY_COLLATERAL_TX,
  WITHDRAW_COLLATERAL_DIRECT_TX,
} from "./market-bundle-fixtures.js";

const PARAMS = CAPTURED_MARKET_PARAMS;

function intentOf(
  operation: MorphoBorrowOperation,
  overrides: {
    amountRaw?: bigint | null;
    sharesRaw?: bigint | null;
    repayMode?: MorphoRepayMode | null;
    userAddress?: Address;
  } = {},
): MorphoBorrowIntent {
  return {
    operation,
    market: {
      chainId: BASE_CHAIN_ID,
      marketId: CAPTURED_MARKET_ID,
      loanToken: PARAMS.loanToken,
      loanDecimals: 6,
      loanSymbol: "USDC",
      collateralToken: PARAMS.collateralToken,
      collateralDecimals: 8,
      collateralSymbol: "cbBTC",
      oracle: PARAMS.oracle,
      irm: PARAMS.irm,
      lltvRaw: PARAMS.lltv.toString(),
    },
    userAddress: overrides.userAddress ?? CAPTURED_USER,
    recipient: overrides.userAddress ?? CAPTURED_USER,
    amountRaw: overrides.amountRaw ?? null,
    sharesRaw: overrides.sharesRaw ?? null,
    repayMode: overrides.repayMode ?? null,
  };
}

const SUPPLY_INTENT = intentOf("supply_collateral", { amountRaw: CAPTURED_COLLATERAL_RAW });
const REPAY_ASSETS_INTENT = intentOf("repay", {
  amountRaw: CAPTURED_REPAY_ASSETS_RAW,
  repayMode: "assets",
});
const REPAY_SHARES_INTENT = intentOf("repay", { sharesRaw: CAPTURED_REPAY_SHARES_RAW, repayMode: "shares" });

const REPAY_ASSETS_BOUNDS: MorphoMarketBundleBounds = {
  maxSharePriceRaw: CAPTURED_REPAY_ASSETS_SHARE_PRICE,
};
const REPAY_SHARES_BOUNDS: MorphoMarketBundleBounds = {
  transferBoundRaw: CAPTURED_SHARES_TRANSFER_BOUND_RAW,
  maxSharePriceRaw: CAPTURED_REPAY_SHARES_SHARE_PRICE,
};

/** The Bundler3 call tuple, as viem decodes and re-encodes it. */
interface RawCall {
  to: Address;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
}

function legsOf(tx: { readonly data: string }): RawCall[] {
  const decoded = decodeFunctionData({ abi: bundler3Abi, data: tx.data as Hex });
  return (decoded.args?.[0] as readonly RawCall[]).map((call) => ({ ...call }));
}

function rebundle(calls: readonly RawCall[]): { to: string; data: string; value: bigint } {
  return {
    to: SUPPLY_COLLATERAL_TX.to,
    value: 0n,
    data: encodeFunctionData({ abi: bundler3Abi, functionName: "multicall", args: [calls] }),
  };
}

/**
 * The adapter ABI seen WIDE, so a tamper can hand `encodeFunctionData` the
 * argument list it wants to encode.
 *
 * The narrow const ABI types `args` as the exact tuple of the real function,
 * which is precisely what a tamper case exists to violate: the invalidity IS the
 * input under test. Widening the ABI to `Abi` expresses that in one place - the
 * encoder then takes `readonly unknown[]` and still refuses anything the ABI
 * cannot encode at runtime, so a tamper is still real viem-encoded calldata.
 */
const TAMPERABLE_ADAPTER_ABI: Abi = generalAdapter1Abi;

/** Re-encode ONE leg of a captured bundle with its arguments transformed. */
function tamper(
  tx: { readonly to: string; readonly data: string },
  legIndex: number,
  mutate: (args: unknown[]) => unknown[],
): { to: string; data: string; value: bigint } {
  const calls = legsOf(tx);
  const leg = definedValue(calls[legIndex], `captured leg ${legIndex}`);
  const decoded = decodeFunctionData({ abi: TAMPERABLE_ADAPTER_ABI, data: leg.data });
  leg.data = encodeFunctionData({
    abi: TAMPERABLE_ADAPTER_ABI,
    functionName: decoded.functionName,
    args: mutate([...(decoded.args ?? [])]),
  });
  return { ...rebundle(calls), to: tx.to };
}

const STRANGER: Address = "0x00000000000000000000000000000000DeaDBeef";

describe("verifyMorphoMarketBundle: the captured builds are accepted", () => {
  it("accepts the captured collateral supply and names both of its legs", () => {
    const report = verifyMorphoMarketBundle(SUPPLY_COLLATERAL_TX, SUPPLY_INTENT, PARAMS);

    expect(report.shape).toBe("bundler3-multicall");
    expect(report.operation).toBe("supply_collateral");
    expect(report.legs.map((leg) => leg.functionName)).toEqual([
      "erc20TransferFrom",
      "morphoSupplyCollateral",
    ]);
    expect(report.legs.map((leg) => leg.selector)).toEqual(["0xd96ca0b9", "0xca463673"]);
    expect(report.pulledToken).toBe(PARAMS.collateralToken.toLowerCase());
    expect(report.pulledAmountRaw).toBe(CAPTURED_COLLATERAL_RAW.toString());
    expect(report.verifiedAmountRaw).toBe(CAPTURED_COLLATERAL_RAW.toString());
    // A supply carries no price guard and no over-pull, so neither is invented.
    expect(report.maxSharePriceRaw).toBeNull();
    expect(report.sweepRecipient).toBeNull();
  });

  it("accepts the captured repayment denominated in assets", () => {
    const report = verifyMorphoMarketBundle(
      REPAY_ASSETS_TX,
      REPAY_ASSETS_INTENT,
      PARAMS,
      REPAY_ASSETS_BOUNDS,
    );

    expect(report.legs.map((leg) => leg.selector)).toEqual(["0xd96ca0b9", "0x4d5fcf68"]);
    expect(report.pulledToken).toBe(BASE_USDC.toLowerCase());
    expect(report.pulledAmountRaw).toBe(CAPTURED_REPAY_ASSETS_RAW.toString());
    expect(report.verifiedAmountRaw).toBe(CAPTURED_REPAY_ASSETS_RAW.toString());
    expect(report.verifiedSharesRaw).toBeNull();
    expect(report.maxSharePriceRaw).toBe(CAPTURED_REPAY_ASSETS_SHARE_PRICE.toString());
    expect(report.sweepRecipient).toBeNull();
  });

  it("accepts the captured repayment denominated in shares, sweep and all", () => {
    const report = verifyMorphoMarketBundle(
      REPAY_SHARES_TX,
      REPAY_SHARES_INTENT,
      PARAMS,
      REPAY_SHARES_BOUNDS,
    );

    expect(report.legs.map((leg) => leg.selector)).toEqual([
      "0xd96ca0b9",
      "0x4d5fcf68",
      "0x3790767d",
    ]);
    expect(report.verifiedSharesRaw).toBe(CAPTURED_REPAY_SHARES_RAW.toString());
    expect(report.verifiedAmountRaw).toBeNull();
    // THE MEASUREMENT THAT MATTERS: the pull is the over-transfer bound, not the
    // debt. The debt at capture was 500,000,001 and the pull was 500,005,281.
    expect(report.pulledAmountRaw).toBe(CAPTURED_SHARES_TRANSFER_BOUND_RAW.toString());
    expect(report.sweepRecipient).toBe(CAPTURED_USER.toLowerCase());
  });
});

describe("verifyMorphoMarketBundle: shape refusals", () => {
  it("refuses a direct Blue call, which belongs to the other decoder", () => {
    expect(() =>
      verifyMorphoMarketBundle(
        WITHDRAW_COLLATERAL_DIRECT_TX,
        intentOf("withdraw_collateral", { amountRaw: 500_000n }),
        PARAMS,
      ),
    ).toThrow(/not a bundled operation/);
  });

  it("refuses a repayment whose denomination the intent never states", () => {
    expect(() =>
      verifyMorphoMarketBundle(REPAY_ASSETS_TX, intentOf("repay", { amountRaw: CAPTURED_REPAY_ASSETS_RAW }), PARAMS),
    ).toThrow(/does not say whether it is denominated in assets or in shares/);
  });

  it("refuses a bundle sent to anything but the pinned Bundler3", () => {
    expect(() =>
      verifyMorphoMarketBundle({ ...SUPPLY_COLLATERAL_TX, to: STRANGER }, SUPPLY_INTENT, PARAMS),
    ).toThrow(/is not the Bundler3/);
  });

  it("refuses a bundle carrying native value", () => {
    expect(() =>
      verifyMorphoMarketBundle({ ...SUPPLY_COLLATERAL_TX, value: 1n }, SUPPLY_INTENT, PARAMS),
    ).toThrow(/wei of native currency/);
  });

  it("refuses a shares-repay bundle whose residual sweep has been dropped", () => {
    const withoutSweep = rebundle(legsOf(REPAY_SHARES_TX).slice(0, 2));
    expect(() =>
      verifyMorphoMarketBundle(withoutSweep, REPAY_SHARES_INTENT, PARAMS, REPAY_SHARES_BOUNDS),
    ).toThrow(/carries 2 legs where the captured build for this operation carries exactly 3/);
  });

  it("refuses a bundle whose legs are the right set in the wrong order", () => {
    const [pull, repay] = legsOf(REPAY_ASSETS_TX);
    const swapped = [definedValue(repay, "the repay leg"), definedValue(pull, "the pull leg")];
    expect(() =>
      verifyMorphoMarketBundle(rebundle(swapped), REPAY_ASSETS_INTENT, PARAMS, REPAY_ASSETS_BOUNDS),
    ).toThrow(/The leg ORDER is part of the shape/);
  });

  it("refuses a leg pointed at anything but the pinned GeneralAdapter1", () => {
    const calls = legsOf(SUPPLY_COLLATERAL_TX);
    calls[0] = { ...definedValue(calls[0], "the first captured leg"), to: STRANGER };
    expect(() => verifyMorphoMarketBundle(rebundle(calls), SUPPLY_INTENT, PARAMS)).toThrow(
      /is not the pinned GeneralAdapter1/,
    );
  });

  it("refuses a leg allowed to fail silently", () => {
    const calls = legsOf(SUPPLY_COLLATERAL_TX);
    calls[1] = { ...definedValue(calls[1], "the second captured leg"), skipRevert: true };
    expect(() => verifyMorphoMarketBundle(rebundle(calls), SUPPLY_INTENT, PARAMS)).toThrow(/skipRevert/);
  });

  it("refuses a leg declaring a reentrancy callback hash", () => {
    const calls = legsOf(SUPPLY_COLLATERAL_TX);
    calls[1] = {
      ...definedValue(calls[1], "the second captured leg"),
      callbackHash: `0x${"11".repeat(32)}` as Hex,
    };
    expect(() => verifyMorphoMarketBundle(rebundle(calls), SUPPLY_INTENT, PARAMS)).toThrow(
      /reentrancy callback hash/,
    );
  });
});

describe("verifyMorphoMarketBundle: amount and address refusals", () => {
  it("refuses a pull larger than the intent authorised", () => {
    const tampered = tamper(SUPPLY_COLLATERAL_TX, 0, (args) => [args[0], args[1], CAPTURED_COLLATERAL_RAW + 1n]);
    expect(() => verifyMorphoMarketBundle(tampered, SUPPLY_INTENT, PARAMS)).toThrow(
      /pulled amount is 5000001 raw units, but the intent Vex approved is 5000000/,
    );
  });

  it("refuses a pull diverted to somewhere other than the adapter", () => {
    const tampered = tamper(SUPPLY_COLLATERAL_TX, 0, (args) => [args[0], STRANGER, args[2]]);
    expect(() => verifyMorphoMarketBundle(tampered, SUPPLY_INTENT, PARAMS)).toThrow(/pull destination/);
  });

  it("refuses collateral credited to somebody else's position", () => {
    const tampered = tamper(SUPPLY_COLLATERAL_TX, 1, (args) => [args[0], args[1], STRANGER, args[3]]);
    expect(() => verifyMorphoMarketBundle(tampered, SUPPLY_INTENT, PARAMS)).toThrow(/collateral owner/);
  });

  it("refuses a leg whose embedded market is not the market the intent named", () => {
    const tampered = tamper(SUPPLY_COLLATERAL_TX, 1, (args) => [
      { ...(args[0] as Record<string, unknown>), oracle: STRANGER },
      args[1],
      args[2],
      args[3],
    ]);
    expect(() => verifyMorphoMarketBundle(tampered, SUPPLY_INTENT, PARAMS)).toThrow(
      /collateral supply oracle/,
    );
  });

  it("refuses a Blue leg carrying a non-empty callback payload", () => {
    const tampered = tamper(SUPPLY_COLLATERAL_TX, 1, (args) => [args[0], args[1], args[2], "0xdeadbeef"]);
    expect(() => verifyMorphoMarketBundle(tampered, SUPPLY_INTENT, PARAMS)).toThrow(
      /non-empty callback payload/,
    );
  });

  it("refuses a repayment that names both denominations at once", () => {
    const tampered = tamper(REPAY_ASSETS_TX, 1, (args) => [args[0], args[1], 1n, args[3], args[4], args[5]]);
    expect(() =>
      verifyMorphoMarketBundle(tampered, REPAY_ASSETS_INTENT, PARAMS, REPAY_ASSETS_BOUNDS),
    ).toThrow(/authorised in ASSETS but its Blue leg also names 1 raw borrow shares/);
  });

  it("refuses a repayment burning a different share count than the intent", () => {
    const tampered = tamper(REPAY_SHARES_TX, 1, (args) => [
      args[0],
      args[1],
      CAPTURED_REPAY_SHARES_RAW - 1n,
      args[3],
      args[4],
      args[5],
    ]);
    expect(() =>
      verifyMorphoMarketBundle(tampered, REPAY_SHARES_INTENT, PARAMS, REPAY_SHARES_BOUNDS),
    ).toThrow(/repaid share count/);
  });
});

describe("verifyMorphoMarketBundle: the residual sweep", () => {
  it("refuses a sweep pointed at anyone but the user, which is the whole over-pull walking away", () => {
    const tampered = tamper(REPAY_SHARES_TX, 2, (args) => [args[0], STRANGER, args[2]]);
    expect(() =>
      verifyMorphoMarketBundle(tampered, REPAY_SHARES_INTENT, PARAMS, REPAY_SHARES_BOUNDS),
    ).toThrow(/residual sweep recipient/);
  });

  it("refuses a sweep of a fixed amount, which can strand the rest of the over-pull", () => {
    const tampered = tamper(REPAY_SHARES_TX, 2, (args) => [args[0], args[1], 1n]);
    expect(() =>
      verifyMorphoMarketBundle(tampered, REPAY_SHARES_INTENT, PARAMS, REPAY_SHARES_BOUNDS),
    ).toThrow(/rather than the MaxUint256 sentinel/);
  });

  it("refuses a sweep of a token that is not the loan token", () => {
    const tampered = tamper(REPAY_SHARES_TX, 2, (args) => [PARAMS.collateralToken, args[1], args[2]]);
    expect(() =>
      verifyMorphoMarketBundle(tampered, REPAY_SHARES_INTENT, PARAMS, REPAY_SHARES_BOUNDS),
    ).toThrow(/swept token/);
  });
});

describe("verifyMorphoMarketBundle: the bounds the caller must bring", () => {
  it("refuses a shares repayment with no transfer bound to measure the pull against", () => {
    expect(() =>
      verifyMorphoMarketBundle(REPAY_SHARES_TX, REPAY_SHARES_INTENT, PARAMS, {
        maxSharePriceRaw: CAPTURED_REPAY_SHARES_SHARE_PRICE,
      }),
    ).toThrow(/no positive transfer bound/);
  });

  it("refuses a transfer bound smuggled onto an assets repayment, which would widen the amount check", () => {
    expect(() =>
      verifyMorphoMarketBundle(REPAY_ASSETS_TX, REPAY_ASSETS_INTENT, PARAMS, {
        ...REPAY_ASSETS_BOUNDS,
        transferBoundRaw: CAPTURED_REPAY_ASSETS_RAW * 2n,
      }),
    ).toThrow(/widen the amount check/);
  });

  it("refuses a repayment with no borrow share-price ceiling of Vex's own", () => {
    expect(() => verifyMorphoMarketBundle(REPAY_ASSETS_TX, REPAY_ASSETS_INTENT, PARAMS)).toThrow(
      /no positive borrow share-price ceiling/,
    );
  });

  it("refuses a price guard above the ceiling Vex derived, by a single raw unit", () => {
    expect(() =>
      verifyMorphoMarketBundle(REPAY_ASSETS_TX, REPAY_ASSETS_INTENT, PARAMS, {
        maxSharePriceRaw: CAPTURED_REPAY_ASSETS_SHARE_PRICE - 1n,
      }),
    ).toThrow(/would tolerate a worse price than was authorised/);
  });

  it("accepts a price guard exactly at the ceiling, so the bound is inclusive", () => {
    expect(() =>
      verifyMorphoMarketBundle(REPAY_ASSETS_TX, REPAY_ASSETS_INTENT, PARAMS, REPAY_ASSETS_BOUNDS),
    ).not.toThrow();
  });

  it("refuses a price ceiling supplied for a supply, which carries no guard to bind", () => {
    expect(() =>
      verifyMorphoMarketBundle(SUPPLY_COLLATERAL_TX, SUPPLY_INTENT, PARAMS, {
        maxSharePriceRaw: 1n,
      }),
    ).toThrow(/carries no price guard at all/);
  });
});

describe("verifyMorphoMarketBundle: every refusal is a canonical VexError", () => {
  it("throws MORPHO_BUNDLE_REJECTED rather than a bare Error", () => {
    let caught: unknown;
    try {
      verifyMorphoMarketBundle({ ...SUPPLY_COLLATERAL_TX, to: STRANGER }, SUPPLY_INTENT, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VexError);
    expect((caught as VexError).code).toBe("MORPHO_BUNDLE_REJECTED");
    expect((caught as VexError).hint).toContain("Nothing was signed and nothing was sent");
  });

  it("names the pinned adapter in the refusal so a reader can audit the target", () => {
    const calls = legsOf(SUPPLY_COLLATERAL_TX);
    calls[0] = { ...definedValue(calls[0], "the first captured leg"), to: STRANGER };
    expect(() => verifyMorphoMarketBundle(rebundle(calls), SUPPLY_INTENT, PARAMS)).toThrow(
      new RegExp(BASE_GENERAL_ADAPTER_1.toLowerCase()),
    );
  });
});

/**
 * THE MARKET SUPPLY LANE: direct lending of the LOAN asset into one Blue market.
 *
 * Its bundle is the same two-leg pull-then-spend shape a collateral supply
 * takes, and everything that differs is a thing this suite has to prove rather
 * than assume: a different token is pulled, a different Blue function is called,
 * and the Blue leg carries a SUPPLY share-price guard that a collateral supply
 * has no argument for at all.
 */
describe("verifyMorphoMarketBundle: the market supply", () => {
  const supplyIntent = intentOf("supply", { amountRaw: CAPTURED_MARKET_SUPPLY_RAW });
  const bounds: MorphoMarketBundleBounds = {
    maxSharePriceRaw: CAPTURED_MARKET_SUPPLY_SHARE_PRICE,
  };

  it("accepts the captured bytes and reports the LOAN token as the one pulled", () => {
    const report = verifyMorphoMarketBundle(MARKET_SUPPLY_TX, supplyIntent, PARAMS, bounds);

    expect(report.operation).toBe("supply");
    expect(report.legs.map((leg) => leg.functionName)).toEqual(["erc20TransferFrom", "morphoSupply"]);
    // A collateral supply pulls cbBTC; this pulls USDC. The two differ by two
    // decimal places as well as by token, so the wrong one is a hundredfold
    // error rather than a cosmetic mislabel.
    expect(report.pulledToken).toBe(BASE_USDC.toLowerCase());
    expect(report.pulledAmountRaw).toBe(CAPTURED_MARKET_SUPPLY_RAW.toString());
    expect(report.verifiedAmountRaw).toBe(CAPTURED_MARKET_SUPPLY_RAW.toString());
    expect(report.maxSharePriceRaw).toBe(CAPTURED_MARKET_SUPPLY_SHARE_PRICE.toString());
    // A supply pulls exactly what it lends, so there is no over-pull and nothing
    // to sweep back.
    expect(report.sweepRecipient).toBeNull();
  });

  it("refuses a supply credited to somebody else's position", () => {
    const stolen = tamper(MARKET_SUPPLY_TX, 1, (args) => [
      args[0], args[1], args[2], args[3], STRANGER, args[5],
    ]);

    expect(() => verifyMorphoMarketBundle(stolen, supplyIntent, PARAMS, bounds))
      .toThrow(/supply position owner/);
  });

  it("refuses a supply whose on-chain guard is looser than the ceiling Vex derived", () => {
    expect(() => verifyMorphoMarketBundle(MARKET_SUPPLY_TX, supplyIntent, PARAMS, {
      maxSharePriceRaw: CAPTURED_MARKET_SUPPLY_SHARE_PRICE - 1n,
    })).toThrow(/supply share price/);
  });

  it("refuses a supply with no share-price ceiling of Vex's own", () => {
    expect(() => verifyMorphoMarketBundle(MARKET_SUPPLY_TX, supplyIntent, PARAMS, {}))
      .toThrow(/no positive supply share-price ceiling/);
  });

  it("refuses a supply whose Blue leg lends a different amount than the intent", () => {
    expect(() => verifyMorphoMarketBundle(
      MARKET_SUPPLY_TX, intentOf("supply", { amountRaw: CAPTURED_MARKET_SUPPLY_RAW - 1n }), PARAMS, bounds,
    )).toThrow(/pulled amount/);
  });

  it("refuses the SUPPLIER'S WITHDRAW as a bundle: it is a direct Blue call in this lane", () => {
    expect(() => verifyMorphoMarketBundle(
      MARKET_SUPPLY_TX, intentOf("withdraw", { amountRaw: CAPTURED_MARKET_SUPPLY_RAW }), PARAMS, bounds,
    )).toThrow(/direct Morpho Blue calls/);
  });
});
