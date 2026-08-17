/**
 * The market builders, driven with the CAPTURED bytes.
 *
 * The SDK is stubbed, but what it hands back is not invented: every `buildTx()`
 * below returns the real captured calldata, and the `action.args` alongside it
 * are the values decoded out of those same bytes. So a passing test proves the
 * builder accepts what the SDK genuinely produces, and a failing bound is a
 * bound that would have refused a real build.
 *
 * WHAT THESE TESTS ARE FOR. Not the decoder, which has its own suite, but the
 * two things only the builder can get wrong: the RAY-scaled price ceiling it
 * derives from a throwaway zero-slippage build, and the over-pull bound it holds
 * the SDK's `transferAmount` to on a repayment denominated in shares.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { VexError } from "../../../errors.js";
import {
  MORPHO_RAY,
  buildMorphoMarketOperation,
  type MorphoBorrowIntent,
  type MorphoMarketBuildRequest,
} from "@tools/morpho/mutations.js";

import {
  BASE_CHAIN_ID,
  BASE_GENERAL_ADAPTER_1,
  CAPTURED_COLLATERAL_RAW,
  CAPTURED_MARKET_ID,
  CAPTURED_MARKET_PARAMS,
  CAPTURED_REPAY_ASSETS_RAW,
  CAPTURED_REPAY_ASSETS_SHARE_PRICE,
  CAPTURED_REPAY_SHARES_RAW,
  CAPTURED_REPAY_SHARES_SHARE_PRICE,
  CAPTURED_SHARES_TRANSFER_BOUND_RAW,
  CAPTURED_USER,
  REPAY_ASSETS_TX,
  REPAY_SHARES_TX,
  SUPPLY_COLLATERAL_TX,
} from "./market-bundle-fixtures.js";

const PARAMS = CAPTURED_MARKET_PARAMS;
const SLIPPAGE_BPS = 50;

/**
 * The captured guards are the SDK's price at its OWN default 3 bps. A ceiling
 * derived at 50 bps must sit above them, which is what makes these fixtures
 * usable as accept cases.
 */
function ceilingAt(basePriceRaw: bigint, bps: number): bigint {
  return (basePriceRaw * (10_000n + BigInt(bps))) / 10_000n + 1n;
}

/** The base price a zero-slippage build would have reported, backed out of the capture. */
const REPAY_ASSETS_BASE_PRICE = (CAPTURED_REPAY_ASSETS_SHARE_PRICE * 10_000n) / 10_003n;
const REPAY_SHARES_BASE_PRICE = (CAPTURED_REPAY_SHARES_SHARE_PRICE * 10_000n) / 10_003n;

interface StubBuild {
  readonly tx: { readonly to: string; readonly data: string; readonly value?: bigint };
  readonly args: Record<string, unknown>;
}

/** A stub `blue` handle that replays captured bytes for whatever slippage it is asked for. */
function stubClient(options: {
  supply?: StubBuild;
  repayAtZero?: StubBuild;
  repayAtSlippage?: StubBuild;
  requirements?: readonly unknown[];
}): never {
  const requirements = options.requirements ?? [];
  const make = (build: StubBuild) => ({
    buildTx: () => ({ ...build.tx, action: { args: build.args } }),
    getRequirements: async () => requirements,
  });
  return {
    morpho: {
      blue: () => ({
        supplyCollateral: () => make(options.supply ?? { tx: SUPPLY_COLLATERAL_TX, args: {} }),
        repay: (params: { slippageTolerance?: bigint }) =>
          make(
            (params.slippageTolerance === 0n ? options.repayAtZero : options.repayAtSlippage)
              ?? { tx: REPAY_ASSETS_TX, args: {} },
          ),
      }),
    },
  } as never;
}

function intentOf(overrides: Partial<MorphoBorrowIntent>): MorphoBorrowIntent {
  return {
    operation: "repay",
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
    userAddress: CAPTURED_USER,
    recipient: CAPTURED_USER,
    amountRaw: null,
    sharesRaw: null,
    repayMode: null,
    ...overrides,
  } as MorphoBorrowIntent;
}

function requestOf(intent: MorphoBorrowIntent): MorphoMarketBuildRequest {
  return { intent, marketParams: PARAMS, positionData: {}, slippageBps: SLIPPAGE_BPS };
}

/** The single exact-amount approval the owner's policy allows, shaped as the SDK returns it. */
function approvalRequirement(token: Address, amount: bigint): readonly unknown[] {
  return [{ to: token, action: { type: "erc20Approval", args: { spender: BASE_GENERAL_ADAPTER_1, amount } } }];
}

describe("buildMorphoMarketOperation: the operations it will not build", () => {
  it("refuses a borrow, because bundling one would cost a standing authorization", async () => {
    await expect(
      buildMorphoMarketOperation(stubClient({}), requestOf(intentOf({ operation: "borrow", amountRaw: 1n }))),
    ).rejects.toThrow(/direct Morpho Blue call, not a bundle/);
  });

  it("refuses a collateral withdrawal for the same reason", async () => {
    await expect(
      buildMorphoMarketOperation(
        stubClient({}),
        requestOf(intentOf({ operation: "withdraw_collateral", amountRaw: 1n })),
      ),
    ).rejects.toThrow(/direct Morpho Blue call, not a bundle/);
  });
});

describe("buildMorphoMarketOperation: collateral supply", () => {
  it("builds, verifies the captured bytes, and reports no price ceiling", async () => {
    const intent = intentOf({ operation: "supply_collateral", amountRaw: CAPTURED_COLLATERAL_RAW });
    const built = await buildMorphoMarketOperation(
      stubClient({
        supply: { tx: SUPPLY_COLLATERAL_TX, args: {} },
        requirements: approvalRequirement(PARAMS.collateralToken, CAPTURED_COLLATERAL_RAW),
      }),
      requestOf(intent),
    );

    expect(built.transferBoundRaw).toBe(CAPTURED_COLLATERAL_RAW);
    // A collateral supply names its own amount, so the pull and the approval are
    // the same number and there is nothing to widen.
    expect(built.approvalAmountRaw).toBe(CAPTURED_COLLATERAL_RAW);
    // A supply has no share-price guard, so none is invented for it.
    expect(built.maxBorrowSharePriceCeilingRaw).toBeNull();
    expect(built.bundle.operation).toBe("supply_collateral");
    // The approval is measured against the COLLATERAL token, not the loan token.
    expect(built.sdkRequirements[0]?.token).toBe(PARAMS.collateralToken.toLowerCase());
  });
});

describe("buildMorphoMarketOperation: repayment denominated in assets", () => {
  const intent = intentOf({ repayMode: "assets", amountRaw: CAPTURED_REPAY_ASSETS_RAW });
  const zero: StubBuild = { tx: REPAY_ASSETS_TX, args: { maxSharePrice: REPAY_ASSETS_BASE_PRICE } };
  const real: StubBuild = {
    tx: REPAY_ASSETS_TX,
    args: { maxSharePrice: CAPTURED_REPAY_ASSETS_SHARE_PRICE, transferAmount: CAPTURED_REPAY_ASSETS_RAW },
  };

  it("derives a RAY ceiling from the throwaway build and accepts the real one under it", async () => {
    const built = await buildMorphoMarketOperation(
      stubClient({
        repayAtZero: zero,
        repayAtSlippage: real,
        requirements: approvalRequirement(PARAMS.loanToken, CAPTURED_REPAY_ASSETS_RAW),
      }),
      requestOf(intent),
    );

    expect(built.maxBorrowSharePriceCeilingRaw).toBe(ceilingAt(REPAY_ASSETS_BASE_PRICE, SLIPPAGE_BPS));
    // The ceiling must sit ABOVE the guard the build actually carries, or the
    // decoder behind it would have refused.
    expect(built.maxBorrowSharePriceCeilingRaw!).toBeGreaterThan(CAPTURED_REPAY_ASSETS_SHARE_PRICE);
    expect(built.transferBoundRaw).toBe(CAPTURED_REPAY_ASSETS_RAW);
    // An ASSETS repayment pulls exactly what it repays, so its approval is that
    // same amount: only the SHARES path widens to the ceiling.
    expect(built.approvalAmountRaw).toBe(CAPTURED_REPAY_ASSETS_RAW);
  });

  it("refuses a pull that is not exactly what an assets repayment repays", async () => {
    await expect(
      buildMorphoMarketOperation(
        stubClient({
          repayAtZero: zero,
          repayAtSlippage: { ...real, args: { ...real.args, transferAmount: CAPTURED_REPAY_ASSETS_RAW + 1n } },
        }),
        requestOf(intent),
      ),
    ).rejects.toThrow(/An assets repayment pulls what it repays/);
  });

  it("refuses a build whose price is unreadable rather than guessing a ceiling", async () => {
    await expect(
      buildMorphoMarketOperation(
        stubClient({ repayAtZero: { tx: REPAY_ASSETS_TX, args: {} }, repayAtSlippage: real }),
        requestOf(intent),
      ),
    ).rejects.toThrow(/no readable `maxSharePrice`/);
  });
});

describe("buildMorphoMarketOperation: repayment denominated in shares, and the over-pull", () => {
  const intent = intentOf({ repayMode: "shares", sharesRaw: CAPTURED_REPAY_SHARES_RAW });
  const zero: StubBuild = { tx: REPAY_SHARES_TX, args: { maxSharePrice: REPAY_SHARES_BASE_PRICE } };
  const real: StubBuild = {
    tx: REPAY_SHARES_TX,
    args: {
      maxSharePrice: CAPTURED_REPAY_SHARES_SHARE_PRICE,
      transferAmount: CAPTURED_SHARES_TRANSFER_BOUND_RAW,
    },
  };

  it("accepts the captured over-pull and surfaces it as the transfer bound", async () => {
    const built = await buildMorphoMarketOperation(
      stubClient({
        repayAtZero: zero,
        repayAtSlippage: real,
        requirements: approvalRequirement(PARAMS.loanToken, CAPTURED_SHARES_TRANSFER_BOUND_RAW),
      }),
      requestOf(intent),
    );

    // THE POINT OF THE WHOLE FILE: the approval is measured against the
    // over-pull of 500,005,281, not against the 500,000,001 debt.
    expect(built.transferBoundRaw).toBe(CAPTURED_SHARES_TRANSFER_BOUND_RAW);
    expect(built.sdkRequirements).toHaveLength(1);
    expect(built.sdkRequirements[0]?.amountRaw).toBe(CAPTURED_SHARES_TRANSFER_BOUND_RAW.toString());
    expect(built.bundle.sweepRecipient).toBe(CAPTURED_USER.toLowerCase());
  });

  it("APPROVES the ceiling rather than this build's transfer amount, so accrual cannot refuse it", async () => {
    const built = await buildMorphoMarketOperation(
      stubClient({
        repayAtZero: zero,
        repayAtSlippage: real,
        requirements: approvalRequirement(PARAMS.loanToken, CAPTURED_SHARES_TRANSFER_BOUND_RAW),
      }),
      requestOf(intent),
    );

    const ceiling = ceilingAt(REPAY_SHARES_BASE_PRICE, SLIPPAGE_BPS);
    const permitted = (CAPTURED_REPAY_SHARES_RAW * ceiling) / MORPHO_RAY + 1n;

    // THE RULING (2026-08-17). A shares repayment's cost ACCRUES, so binding the
    // approval to one build's transfer amount approved a number that was already
    // stale when the approval landed: the rebuild immediately before signing
    // legitimately asked for slightly more and the lane refused its own correct
    // operation. The ceiling IS the exact amount of a shares operation.
    expect(built.approvalAmountRaw).toBe(permitted);
    expect(built.approvalAmountRaw).toBeGreaterThan(built.transferBoundRaw);

    // And the widening grants nothing the bundle was not already held to: the
    // decoder's bound check is unchanged, so the pull can never exceed this.
    expect(built.transferBoundRaw).toBeLessThanOrEqual(built.approvalAmountRaw);

    // The SDK's own requirement is still cross-checked against the SDK's own
    // transfer amount. Two numbers, two purposes, both stated.
    expect(built.sdkRequirements[0]?.amountRaw).toBe(CAPTURED_SHARES_TRANSFER_BOUND_RAW.toString());
  });

  it("bounds the SDK's over-pull by what those shares cost at Vex's own worst price", async () => {
    const ceiling = ceilingAt(REPAY_SHARES_BASE_PRICE, SLIPPAGE_BPS);
    const permitted = (CAPTURED_REPAY_SHARES_RAW * ceiling) / MORPHO_RAY + 1n;
    // The captured pull sits comfortably under the bound, which is why it passes.
    expect(CAPTURED_SHARES_TRANSFER_BOUND_RAW).toBeLessThan(permitted);

    await expect(
      buildMorphoMarketOperation(
        stubClient({
          repayAtZero: zero,
          repayAtSlippage: { ...real, args: { ...real.args, transferAmount: permitted + 1n } },
        }),
        requestOf(intent),
      ),
    ).rejects.toThrow(/exceeds what the operation can possibly need/);
  });

  it("names the refusal canonically rather than throwing a bare Error", async () => {
    const caught = await buildMorphoMarketOperation(
      stubClient({
        repayAtZero: zero,
        repayAtSlippage: { ...real, args: { ...real.args, transferAmount: 10n ** 18n } },
      }),
      requestOf(intent),
    ).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(VexError);
    expect((caught as VexError).code).toBe("MORPHO_BUNDLE_REJECTED");
  });

  it("refuses a shares repayment with no share count to build from", async () => {
    await expect(
      buildMorphoMarketOperation(
        stubClient({ repayAtZero: zero, repayAtSlippage: real }),
        requestOf(intentOf({ repayMode: "shares", sharesRaw: 0n })),
      ),
    ).rejects.toThrow(/no positive share count/);
  });
});
