/**
 * THE FEE DECISION on the generic EVM signing lane, as arithmetic.
 *
 * Every invariant here is one a user's money depends on, and every one of them
 * is a pure function of fields the proposal digest already binds, so they are
 * tested as pure functions:
 *
 *   the RATE is 25 whole basis points and comes from a build constant;
 *   the RECEIVER is the shared Vex treasury and comes from a build constant;
 *   the AMOUNT is `floor(valueWei * 25 / 10000)`, exact bigint, never rounded up;
 *   the fee leg's GAS CEILING is the SIGNED limit, derived through the same
 *     production headroom helper the signer applies, never a copied literal;
 *   the THRESHOLD skips a fee that does not EXCEED its own collection cost, with
 *     equality on the skip side.
 */

import { describe, it, expect } from "vitest";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { VEX_TREASURY_EVM } from "../../../../../../lib/vex-treasury.js";
import type { WalletTransactionFeeBounds } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import {
  approvedPerGasCapWei,
  quoteWalletTxVexFee,
  walletTxFeeVenue,
  walletTxVexFeeDisclosure,
  walletTxVexFeeSkipSentence,
  walletTxVexFeeStagedBounds,
  VEX_FEE_TRANSFER_ESTIMATED_GAS,
  VEX_FEE_TRANSFER_GAS_LIMIT,
  WALLET_TX_FEE_ACTIVITY_EVENT_ROLE,
  WALLET_TX_FEE_BPS,
  WALLET_TX_FEE_RECEIVER_EVM,
} from "@vex-agent/tools/internal/wallet/transaction/vex-fee.js";

/** 1 gwei, so a signed fee-leg ceiling of 42000 gas costs 42000 gwei = 4.2e13 wei. */
const ONE_GWEI = 1_000_000_000n;

function eip1559(maxFeePerGasWei: bigint): WalletTransactionFeeBounds {
  return {
    mode: "eip1559",
    gasLimit: "500000",
    maxFeePerGasWei: maxFeePerGasWei.toString(),
    maxPriorityFeePerGasWei: "1000000",
    maxTotalFeeWei: (500_000n * maxFeePerGasWei).toString(),
  };
}

function legacy(gasPriceWei: bigint): WalletTransactionFeeBounds {
  return {
    mode: "legacy",
    gasLimit: "500000",
    gasPriceWei: gasPriceWei.toString(),
    maxTotalFeeWei: (500_000n * gasPriceWei).toString(),
  };
}

describe("T-FEE 1 and 2: the rate and the receiver are build constants", () => {
  it("charges 25 whole basis points", () => {
    expect(WALLET_TX_FEE_BPS).toBe(25);
    expect(Number.isInteger(WALLET_TX_FEE_BPS)).toBe(true);
  });

  it("sends the fee to the shared Vex EVM treasury and nowhere else", () => {
    expect(WALLET_TX_FEE_RECEIVER_EVM).toBe(VEX_TREASURY_EVM);
    // The venue is what the runtime transfer is built from, so it must carry
    // the same address rather than a second copy that could drift.
    expect(walletTxFeeVenue({ chainSlug: "base", nativeSymbol: "ETH", nativeDecimals: 18 }).receiver)
      .toBe(VEX_TREASURY_EVM);
  });

  it("records the leg under the migration-088 role", () => {
    expect(WALLET_TX_FEE_ACTIVITY_EVENT_ROLE).toBe("tx_vex_fee");
  });
});

describe("T-FEE 3: the amount is exact bigint arithmetic that floors", () => {
  it("takes floor(valueWei * 25 / 10000)", () => {
    // 1 ETH at 25 bps is 0.0025 ETH.
    const quote = quoteWalletTxVexFee(10n ** 18n, ONE_GWEI);
    expect(quote.feeWei).toBe(2_500_000_000_000_000n);
    expect(quote.charged).toBe(true);
  });

  it("never rounds a remainder up - the user is not charged a wei Vex did not earn", () => {
    // 10^18 + 399 wei: the extra 399 * 25 / 10000 truncates away entirely.
    const quote = quoteWalletTxVexFee(10n ** 18n + 399n, ONE_GWEI);
    expect(quote.feeWei).toBe(2_500_000_000_000_000n);
  });

  it("survives a value far beyond Number.MAX_SAFE_INTEGER without losing precision", () => {
    const huge = 123_456_789_012_345_678_901_234_567n;
    const quote = quoteWalletTxVexFee(huge, ONE_GWEI);
    expect(quote.feeWei).toBe((huge * 25n) / 10_000n);
  });
});

describe("T-FEE 4: the fee leg's gas ceiling is the SIGNED limit", () => {
  it("is derived through the production headroom helper, not a copied literal", () => {
    // Pinned THROUGH the helper: a change to the headroom policy must move this
    // ceiling with it. The staged primitive applies the same helper to its own
    // fresh estimate BEFORE checking the approved bounds, so a ceiling set at
    // the 21000 intrinsic floor would refuse every fee transfer ever made.
    expect(VEX_FEE_TRANSFER_ESTIMATED_GAS).toBe(21_000n);
    expect(VEX_FEE_TRANSFER_GAS_LIMIT).toBe(gasLimitWithHeadroom(VEX_FEE_TRANSFER_ESTIMATED_GAS));
    expect(VEX_FEE_TRANSFER_GAS_LIMIT).toBeGreaterThan(VEX_FEE_TRANSFER_ESTIMATED_GAS);
  });

  it("bounds the fee leg at its own gas limit and the action's approved per-gas caps", () => {
    const bounds = walletTxVexFeeStagedBounds(eip1559(ONE_GWEI));
    expect(bounds).toEqual({
      mode: "eip1559",
      gasLimit: VEX_FEE_TRANSFER_GAS_LIMIT,
      maxFeePerGasWei: ONE_GWEI,
      maxPriorityFeePerGasWei: 1_000_000n,
    });
  });

  it("uses the legacy gas price when that is what was approved", () => {
    expect(walletTxVexFeeStagedBounds(legacy(7n))).toEqual({
      mode: "legacy",
      gasLimit: VEX_FEE_TRANSFER_GAS_LIMIT,
      gasPriceWei: 7n,
    });
  });

  it("states the same maxNetworkFeeWei the card shows: the signed limit times the cap", () => {
    const quote = quoteWalletTxVexFee(10n ** 18n, ONE_GWEI);
    expect(quote.maxNetworkFeeWei).toBe(VEX_FEE_TRANSFER_GAS_LIMIT * ONE_GWEI);
  });

  it("has no EVM per-gas cap for Solana bounds, so nothing about a fee is stated", () => {
    const solana: WalletTransactionFeeBounds = {
      mode: "solana",
      computeUnitLimit: "200000",
      computeUnitPriceMicroLamports: "1000",
      baseFeeLamports: "5000",
      maxPriorityFeeLamports: "200",
      maxTotalFeeLamports: "5200",
    };
    expect(approvedPerGasCapWei(solana)).toBeNull();
    expect(walletTxVexFeeStagedBounds(solana)).toBeNull();
  });
});

describe("T-FEE 5 and 10: when no fee is taken, and why", () => {
  it("takes nothing from a transaction that sends no native value", () => {
    const quote = quoteWalletTxVexFee(0n, ONE_GWEI);
    expect(quote.charged).toBe(false);
    if (!quote.charged) expect(quote.reason).toBe("no_native_value");
    expect(quote.feeWei).toBe(0n);
  });

  it("takes nothing when 25 bps of the value floors to zero", () => {
    // 399 wei * 25 / 10000 = 0 exactly.
    const quote = quoteWalletTxVexFee(399n, 1n);
    expect(quote.charged).toBe(false);
    if (!quote.charged) expect(quote.reason).toBe("floors_to_zero");
    expect(quote.feeWei).toBe(0n);
  });

  it("takes nothing when the fee EQUALS its own collection cost - equality skips", () => {
    // Choose a value whose 25 bps lands exactly on the collection cost.
    const cap = 1n;
    const cost = VEX_FEE_TRANSFER_GAS_LIMIT * cap;
    const valueWei = (cost * 10_000n) / 25n;
    const quote = quoteWalletTxVexFee(valueWei, cap);
    expect(quote.feeWei).toBe(cost);
    expect(quote.charged).toBe(false);
    if (!quote.charged) expect(quote.reason).toBe("at_or_below_collection_cost");
  });

  it("takes nothing ONE WEI BELOW the threshold", () => {
    const cap = 1n;
    const cost = VEX_FEE_TRANSFER_GAS_LIMIT * cap;
    // The largest value whose fee is exactly `cost - 1`.
    const valueWei = ((cost - 1n) * 10_000n) / 25n;
    const quote = quoteWalletTxVexFee(valueWei, cap);
    expect(quote.feeWei).toBe(cost - 1n);
    expect(quote.charged).toBe(false);
  });

  it("CHARGES one wei above the threshold - the boundary is exclusive on the charged side", () => {
    const cap = 1n;
    const cost = VEX_FEE_TRANSFER_GAS_LIMIT * cap;
    const valueWei = ((cost + 1n) * 10_000n) / 25n;
    const quote = quoteWalletTxVexFee(valueWei, cap);
    expect(quote.feeWei).toBe(cost + 1n);
    expect(quote.charged).toBe(true);
  });

  it("names BOTH figures in the at-or-below reason, not only the verdict", () => {
    const cap = 1n;
    const cost = VEX_FEE_TRANSFER_GAS_LIMIT * cap;
    const quote = quoteWalletTxVexFee((cost * 10_000n) / 25n, cap);
    expect(quote.charged).toBe(false);
    if (quote.charged) return;
    // The ONE sentence: the card, the prepare result and the confirm report all
    // render this same function, so a reader is never told two stories.
    const sentence = walletTxVexFeeSkipSentence(quote);
    expect(sentence).toContain(quote.feeWei.toString());
    expect(sentence).toContain(quote.maxNetworkFeeWei.toString());
  });
});

describe("the disclosure generalizes off 18-decimal ETH", () => {
  it("renders the human amount with the CHAIN's own decimals and names the asset", () => {
    // A 6-decimal native. `formatEther` would have reported this as 1e-12 of
    // the truth.
    const venue = walletTxFeeVenue({ chainSlug: "x", nativeSymbol: "XTZ", nativeDecimals: 6 });
    const quote = quoteWalletTxVexFee(4_000_000_000n, 1n);
    expect(quote.charged).toBe(true);
    const disclosure = walletTxVexFeeDisclosure(venue, quote);
    if (!disclosure.charged) throw new Error("expected a charged disclosure");
    expect(disclosure.nativeSymbol).toBe("XTZ");
    expect(disclosure.nativeDecimals).toBe(6);
    expect(disclosure.feeAmountHuman).toBe("10");
    // DEPRECATED and ETH-only: absent here, because the name would be a lie.
    expect(disclosure.feeAmountEth).toBeUndefined();
  });

  it("still emits the deprecated feeAmountEth on an ETH/18 venue", () => {
    const venue = walletTxFeeVenue({ chainSlug: "base", nativeSymbol: "ETH", nativeDecimals: 18 });
    const quote = quoteWalletTxVexFee(10n ** 18n, ONE_GWEI);
    const disclosure = walletTxVexFeeDisclosure(venue, quote);
    if (!disclosure.charged) throw new Error("expected a charged disclosure");
    expect(disclosure.feeAmountEth).toBe("0.0025");
    expect(disclosure.feeAmountHuman).toBe("0.0025");
  });
});
