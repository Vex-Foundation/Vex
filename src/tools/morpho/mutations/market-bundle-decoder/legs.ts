/**
 * The per-leg argument checks: what each allowlisted function must say for the
 * bundle to be the operation Vex intended.
 *
 * Split out of `../market-bundle-decoder.ts`. Every refusal here is about the
 * CONTENTS of a leg; the structural rules it is measured against live in
 * `./contract.js`.
 */

import { isAddressEqual, type Address } from "viem";

import type { MorphoBorrowIntent } from "../borrow-types.js";
import {
  MAX_UINT_256,
  addressMismatch,
  amountMismatch,
  reject,
  type MarketBundleKind,
  type MorphoMarketBundleBounds,
  type MorphoMarketParamsTuple,
} from "./contract.js";

/**
 * Every one of the five market params, compared field by field.
 *
 * The ABI tuple decodes to a NAMED OBJECT, not an array, so it is read by field.
 * Reading it positionally silently yields `undefined` for every field, which
 * compares unequal and would turn this into a check that always refuses.
 */
function requireMarketParams(saw: unknown, expected: MorphoMarketParamsTuple, leg: string): void {
  if (typeof saw !== "object" || saw === null) {
    reject(
      `Refusing a Morpho market bundle: its ${leg} leg carries no decodable market struct, so Vex cannot tell which `
      + "market it would touch.",
    );
  }
  const { loanToken, collateralToken, oracle, irm, lltv } = saw as MorphoMarketParamsTuple;
  if (!isAddressEqual(loanToken, expected.loanToken)) {
    addressMismatch(`${leg} loan token`, loanToken.toLowerCase(), expected.loanToken.toLowerCase());
  }
  if (!isAddressEqual(collateralToken, expected.collateralToken)) {
    addressMismatch(`${leg} collateral token`, collateralToken.toLowerCase(), expected.collateralToken.toLowerCase());
  }
  if (!isAddressEqual(oracle, expected.oracle)) {
    addressMismatch(`${leg} oracle`, oracle.toLowerCase(), expected.oracle.toLowerCase());
  }
  if (!isAddressEqual(irm, expected.irm)) {
    addressMismatch(`${leg} interest rate model`, irm.toLowerCase(), expected.irm.toLowerCase());
  }
  if (lltv !== expected.lltv) amountMismatch(`${leg} liquidation LTV`, lltv, expected.lltv);
}

/**
 * A Blue leg's trailing `bytes` argument, which Morpho hands to a callback.
 *
 * It is empty in every capture and Vex refuses it non-empty: a callback payload
 * is arbitrary code running mid-operation with the adapter's approvals live, and
 * Vex does not sign a callback it has not decoded.
 */
function requireEmptyCallback(data: unknown, leg: string): void {
  if (typeof data !== "string" || (data !== "0x" && data.length > 2)) {
    reject(
      `Refusing a Morpho market bundle: its ${leg} leg carries a non-empty callback payload. Morpho would hand that `
      + "payload to a contract mid-operation while the adapter's approvals are live, and Vex does not sign a "
      + "callback it has not decoded.",
    );
  }
}

export interface LegContext {
  readonly intent: MorphoBorrowIntent;
  readonly params: MorphoMarketParamsTuple;
  readonly kind: MarketBundleKind;
  readonly generalAdapter1: Address;
  /** The amount the pull leg must carry: the intent amount, or the approved transfer bound. */
  readonly pullAmountRaw: bigint;
  /** The token the pull leg must move. */
  readonly pullToken: Address;
  /** Vex's own borrow share-price ceiling for a repayment, `null` for a supply. */
  readonly maxBorrowSharePriceRaw: bigint | null;
}

export interface LegVerification {
  readonly summary: string;
  readonly pulledAmountRaw?: bigint;
  readonly verifiedAmountRaw?: bigint;
  readonly verifiedSharesRaw?: bigint;
  readonly maxBorrowSharePriceRaw?: bigint;
  readonly sweepRecipient?: string;
}

function verifyTransferFrom(args: readonly unknown[], ctx: LegContext): LegVerification {
  const [token, receiver, amount] = args as [Address, Address, bigint];
  if (!isAddressEqual(token, ctx.pullToken)) {
    addressMismatch("pulled token", token.toLowerCase(), ctx.pullToken.toLowerCase());
  }
  if (!isAddressEqual(receiver, ctx.generalAdapter1)) {
    addressMismatch("pull destination", receiver.toLowerCase(), ctx.generalAdapter1.toLowerCase());
  }
  if (amount !== ctx.pullAmountRaw) amountMismatch("pulled amount", amount, ctx.pullAmountRaw);
  const measuredAgainst = ctx.kind === "repay_shares"
    ? "the approved transfer bound, which a shares repayment over-pulls to"
    : "the intent's own amount";
  return {
    summary:
      `pulls ${amount} raw units of ${token.toLowerCase()} from the wallet into the adapter `
      + `${receiver.toLowerCase()}, measured against ${measuredAgainst}`,
    pulledAmountRaw: amount,
  };
}

function verifySupplyCollateral(args: readonly unknown[], ctx: LegContext): LegVerification {
  const [marketParams, assets, onBehalf, callbackData] = args as [readonly unknown[], bigint, Address, unknown];
  requireMarketParams(marketParams, ctx.params, "collateral supply");
  if (assets !== ctx.intent.amountRaw) {
    amountMismatch("supplied collateral", assets, ctx.intent.amountRaw ?? 0n);
  }
  if (!isAddressEqual(onBehalf, ctx.intent.userAddress)) {
    addressMismatch("collateral owner", onBehalf.toLowerCase(), ctx.intent.userAddress.toLowerCase());
  }
  requireEmptyCallback(callbackData, "collateral supply");
  return {
    summary:
      `supplies ${assets} raw collateral units to the market on behalf of ${onBehalf.toLowerCase()}, whose position `
      + "the collateral credits",
    verifiedAmountRaw: assets,
  };
}

function verifyRepay(args: readonly unknown[], ctx: LegContext): LegVerification {
  const [marketParams, assets, shares, slippageAmount, onBehalf, callbackData] =
    args as [readonly unknown[], bigint, bigint, bigint, Address, unknown];
  requireMarketParams(marketParams, ctx.params, "repayment");
  if (!isAddressEqual(onBehalf, ctx.intent.userAddress)) {
    addressMismatch("repaid position owner", onBehalf.toLowerCase(), ctx.intent.userAddress.toLowerCase());
  }
  requireEmptyCallback(callbackData, "repayment");

  requireBorrowSharePrice(slippageAmount, ctx);

  if (ctx.kind === "repay_shares") {
    if (assets !== 0n) {
      reject(
        `Refusing a Morpho repayment: it was authorised in SHARES but its Blue leg also names ${assets} raw asset `
        + "units. Morpho takes one denomination or the other, and a leg carrying both is not the operation asked for.",
      );
    }
    if (shares !== ctx.intent.sharesRaw) {
      amountMismatch("repaid share count", shares, ctx.intent.sharesRaw ?? 0n);
    }
    return {
      summary:
        `burns ${shares} raw borrow shares of ${onBehalf.toLowerCase()}'s debt, refusing on-chain any borrow share `
        + `price above ${slippageAmount}`,
      verifiedSharesRaw: shares,
      maxBorrowSharePriceRaw: slippageAmount,
    };
  }

  if (shares !== 0n) {
    reject(
      `Refusing a Morpho repayment: it was authorised in ASSETS but its Blue leg also names ${shares} raw borrow `
      + "shares. Morpho takes one denomination or the other, and a leg carrying both is not the operation asked for.",
    );
  }
  if (assets !== ctx.intent.amountRaw) amountMismatch("repaid amount", assets, ctx.intent.amountRaw ?? 0n);
  return {
    summary:
      `repays ${assets} raw loan units against ${onBehalf.toLowerCase()}'s debt, refusing on-chain any borrow share `
      + `price above ${slippageAmount}`,
    verifiedAmountRaw: assets,
    maxBorrowSharePriceRaw: slippageAmount,
  };
}

/**
 * Hold the repayment's on-chain price guard to a ceiling Vex derived itself.
 *
 * The comparison is ABSOLUTE against a number the caller computed from a fresh
 * market read, never a percentage of the trade, so it cannot scale with size and
 * hide a real loss (rules/90).
 */
function requireBorrowSharePrice(sawRaw: bigint, ctx: LegContext): void {
  if (sawRaw <= 0n) {
    reject(
      "Refusing a Morpho repayment: its Blue leg carries no positive borrow share-price guard, so nothing on-chain "
      + "would stop the repayment from settling at any price at all. That guard is the repayment's entire price "
      + "protection.",
    );
  }
  const ceiling = ctx.maxBorrowSharePriceRaw;
  if (ceiling === null) {
    reject(
      "Refusing a Morpho repayment: Vex computed no borrow share-price ceiling of its own to check the built one "
      + "against, so the guard in the transaction is unverified.",
    );
  }
  if (sawRaw > ceiling) {
    reject(
      `Refusing a Morpho repayment: its on-chain guard allows a borrow share price of ${sawRaw}, above the `
      + `${ceiling} Vex derived from the market's current borrow share price at the requested slippage. The `
      + "transaction would tolerate a worse price than was authorised.",
    );
  }
}

function verifySweep(args: readonly unknown[], ctx: LegContext): LegVerification {
  const [token, recipient, amount] = args as [Address, Address, bigint];
  if (ctx.kind !== "repay_shares") {
    reject(
      "Refusing a Morpho market bundle: it carries a residual `erc20Transfer` sweep on an operation that has no "
      + "over-pull to sweep. Only a repayment denominated in shares pulls more than it spends.",
    );
  }
  if (!isAddressEqual(token, ctx.params.loanToken)) {
    addressMismatch("swept token", token.toLowerCase(), ctx.params.loanToken.toLowerCase());
  }
  // THE CHECK THIS LEG EXISTS FOR. The sweep returns the whole over-pull, so a
  // recipient that is not the user is the entire excess walking away.
  if (!isAddressEqual(recipient, ctx.intent.userAddress)) {
    addressMismatch("residual sweep recipient", recipient.toLowerCase(), ctx.intent.userAddress.toLowerCase());
  }
  if (amount !== MAX_UINT_256) {
    reject(
      `Refusing a Morpho repayment: its residual sweep names ${amount} raw units rather than the MaxUint256 `
      + "sentinel the captured build uses to mean \"return the adapter's whole remaining balance\". A sweep that "
      + "returns a fixed number can leave the rest of the over-pull sitting in the adapter.",
    );
  }
  return {
    summary:
      `returns the adapter's entire remaining balance of ${token.toLowerCase()} to ${recipient.toLowerCase()}, which `
      + "is the over-pull a shares repayment cannot size in advance",
    sweepRecipient: recipient.toLowerCase(),
  };
}

export function verifyLeg(functionName: string, args: readonly unknown[], ctx: LegContext): LegVerification {
  switch (functionName) {
    case "erc20TransferFrom":
      return verifyTransferFrom(args, ctx);
    case "morphoSupplyCollateral":
      return verifySupplyCollateral(args, ctx);
    case "morphoRepay":
      return verifyRepay(args, ctx);
    case "erc20Transfer":
      return verifySweep(args, ctx);
    default:
      reject(
        `Refusing a Morpho market bundle: it contains an allowlisted-but-unhandled leg ${functionName}. A selector `
        + "on the allowlist with no verification behind it is an unchecked leg, which is refused rather than passed.",
      );
  }
}

/** Vex's own price ceiling: mandatory for a repayment, forbidden for a supply. */
function resolveSharePriceCeiling(kind: MarketBundleKind, ceiling: bigint | undefined): bigint | null {
  if (kind === "supply_collateral") {
    if (ceiling !== undefined) {
      reject(
        "Refusing a Morpho collateral supply: a borrow share-price ceiling was supplied for an operation that "
        + "carries no price guard at all. A bound with nothing to bind is a sign the caller believes it is holding a "
        + "different operation.",
      );
    }
    return null;
  }
  if (ceiling === undefined || ceiling <= 0n) {
    reject(
      "Refusing a Morpho repayment: Vex was given no positive borrow share-price ceiling of its own. The "
      + "repayment's Blue leg carries an on-chain price guard, and a guard checked against nothing is not checked.",
    );
  }
  return ceiling;
}

export function buildLegContext(
  intent: MorphoBorrowIntent,
  params: MorphoMarketParamsTuple,
  kind: MarketBundleKind,
  generalAdapter1: Address,
  bounds: MorphoMarketBundleBounds,
): LegContext {
  const pullToken = kind === "supply_collateral" ? params.collateralToken : params.loanToken;
  const maxBorrowSharePriceRaw = resolveSharePriceCeiling(kind, bounds.maxBorrowSharePriceRaw);

  if (kind === "repay_shares") {
    const bound = bounds.transferBoundRaw;
    if (bound === undefined || bound <= 0n) {
      reject(
        "Refusing a Morpho repayment denominated in shares: Vex was given no positive transfer bound to hold the "
        + "pull leg to. A shares repayment pulls MORE than the debt by an amount only the build knows, so without "
        + "that bound the amount leaving the wallet is unchecked.",
      );
    }
    return { intent, params, kind, generalAdapter1, pullAmountRaw: bound, pullToken, maxBorrowSharePriceRaw };
  }

  if (bounds.transferBoundRaw !== undefined) {
    reject(
      `Refusing a Morpho ${intent.operation}: a transfer bound of ${bounds.transferBoundRaw} was supplied for an `
      + "operation whose pull is exactly the intent's own amount. Accepting it would widen the amount check to a "
      + "number the intent never authorised.",
    );
  }
  const amount = intent.amountRaw;
  if (amount === null || amount <= 0n) {
    reject(
      `Refusing a Morpho ${intent.operation}: the intent carries no positive amount, so there is nothing to hold the `
      + "built transaction to.",
    );
  }
  return { intent, params, kind, generalAdapter1, pullAmountRaw: amount, pullToken, maxBorrowSharePriceRaw };
}
