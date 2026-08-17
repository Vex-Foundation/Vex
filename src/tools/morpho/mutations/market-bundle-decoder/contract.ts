/**
 * The VOCABULARY and the SHAPE RULES of a Morpho Blue market bundle: what the
 * caller must bring, what an accepted bundle is reported as, and the structural
 * facts every leg is read against.
 *
 * Split out of `../market-bundle-decoder.ts` so the entry point stays a readable
 * orchestration. The per-leg argument checks live in `./legs.ts`; this file owns
 * only what a leg is checked WITH.
 */

import { decodeFunctionData, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { MORPHO_CONTRACTS } from "../../constants.js";
import { MORPHO_BUNDLER_ENTRY_CALL } from "../allowlist.js";
import type { MorphoBorrowIntent } from "../borrow-types.js";
import type { MorphoDecodedLeg } from "../types.js";

/** The market params every Blue leg embeds, in the order the ABI tuple carries them. */
export interface MorphoMarketParamsTuple {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

/**
 * The bound the caller PROVED for itself and holds the built transaction to.
 *
 * `transferBoundRaw` is required for a shares repayment and forbidden for every
 * other operation: it is the amount the SDK's own approval requirement named,
 * which for a shares repayment is the over-pull rather than the debt. Passing it
 * for an assets repayment would silently widen the amount check to a number the
 * intent never authorised.
 */
export interface MorphoMarketBundleBounds {
  readonly transferBoundRaw?: bigint;
  /**
   * The highest borrow SHARE PRICE a repayment may carry, computed by the caller
   * from a FRESH market read and the declared slippage. Required for both repay
   * denominations and forbidden elsewhere.
   *
   * PROVENANCE, because this argument is easy to read as the wrong thing: in the
   * capture, `morphoRepay`'s fourth argument is 1,115,725,098,290,572,320,872 on
   * the assets repayment and 1,115,725,099,482,372,327,457 on the shares one.
   * Those are within a whisker of each other while the operations' amounts
   * differ by a factor of two, which is what proves the argument is a PRICE and
   * not a spend ceiling. Reading it as an asset ceiling and bounding it by the
   * approved pull would refuse every genuine build.
   */
  readonly maxBorrowSharePriceRaw?: bigint;
}

/** The verifier's account of a market bundle it ACCEPTED. A rejection throws. */
export interface MorphoMarketBundleReport {
  readonly shape: "bundler3-multicall";
  readonly to: string;
  readonly toRole: "bundler3";
  readonly selector: string;
  readonly functionName: string;
  readonly valueRaw: string;
  readonly operation: "supply_collateral" | "repay";
  readonly legs: readonly MorphoDecodedLeg[];
  /** The token the bundle pulls from the wallet. Collateral on a supply, loan on a repay. */
  readonly pulledToken: string;
  /** The amount the decoder PROVED the bundle pulls. The transfer bound on a shares repay. */
  readonly pulledAmountRaw: string;
  /** The Blue-side amount, `null` when the operation is denominated in shares. */
  readonly verifiedAmountRaw: string | null;
  /** The share count a shares repayment burns, `null` otherwise. */
  readonly verifiedSharesRaw: string | null;
  /** The on-chain borrow share-price guard a repayment carries, `null` on a supply. */
  readonly maxBorrowSharePriceRaw: string | null;
  /** The address the residual sweep returns the over-pull to, `null` when there is no sweep. */
  readonly sweepRecipient: string | null;
}

const REJECT_HINT =
  "Nothing was signed and nothing was sent. Re-read the market and re-build the operation; if the same "
  + "transaction comes back, report it rather than retrying, because a build that does not match the intent "
  + "does not become correct on a second attempt.";

export function reject(message: string, hint: string = REJECT_HINT): never {
  throw new VexError(ErrorCodes.MORPHO_BUNDLE_REJECTED, message, hint);
}

export const ZERO_CALLBACK_HASH = `0x${"0".repeat(64)}`;
export const MAX_UINT_256 = (1n << 256n) - 1n;

/**
 * The leg order each operation must arrive in, cited to the capture.
 *
 * This is an EXACT sequence, not a set: a bundle with the right legs in the
 * wrong order, or with a leg repeated, is refused. Order is what makes the pull
 * precede the spend and the sweep follow it.
 */
export const EXPECTED_LEGS: Readonly<Record<"supply_collateral" | "repay_assets" | "repay_shares", readonly string[]>> = {
  // captures[0].legs
  supply_collateral: ["erc20TransferFrom", "morphoSupplyCollateral"],
  // captures[1].legs
  repay_assets: ["erc20TransferFrom", "morphoRepay"],
  // captures[2].legs
  repay_shares: ["erc20TransferFrom", "morphoRepay", "erc20Transfer"],
};

export type MarketBundleKind = keyof typeof EXPECTED_LEGS;

export function bundleKindOf(intent: MorphoBorrowIntent): MarketBundleKind {
  if (intent.operation === "supply_collateral") return "supply_collateral";
  if (intent.operation !== "repay") {
    reject(
      `Refusing a Morpho market bundle: ${intent.operation} is not a bundled operation. Under Vex's option-1 ruling `
      + "borrow and withdraw_collateral are direct Morpho Blue calls, verified by `blue-call-decoder.ts`, and a "
      + "bundle arriving for one of them is the wrong shape entirely.",
    );
  }
  if (intent.repayMode === null) {
    reject(
      "Refusing a Morpho repayment: the intent does not say whether it is denominated in assets or in shares, and "
      + "the two build different bundles with different bounds. Vex will not guess which one it is holding.",
    );
  }
  return intent.repayMode === "shares" ? "repay_shares" : "repay_assets";
}

export function contractsFor(chainId: number): { bundler3: Address; generalAdapter1: Address } {
  const contracts = MORPHO_CONTRACTS[chainId];
  const bundler3 = contracts?.bundler3 ?? null;
  const generalAdapter1 = contracts?.generalAdapter1 ?? null;
  if (bundler3 === null || generalAdapter1 === null) {
    throw new VexError(
      ErrorCodes.MORPHO_CONTRACT_UNAVAILABLE,
      `Vex has no pinned Bundler3 and GeneralAdapter1 pair for chain ${chainId}, so it cannot verify which `
      + "contracts a market bundle built for that chain would call.",
      "Adding a chain means re-extracting the pinned registry into `src/tools/morpho/constants.ts` with dated "
      + "provenance, never guessing a deployment.",
    );
  }
  return { bundler3, generalAdapter1 };
}

export function selectorOf(data: string): string {
  if (!data.startsWith("0x") || data.length < 10) {
    reject(
      `Refusing a Morpho market bundle: a call's calldata is ${data.length} characters long and carries no readable `
      + "function selector. Vex does not sign bytes it cannot read.",
    );
  }
  return data.slice(0, 10).toLowerCase();
}

export function amountMismatch(field: string, saw: bigint, expected: bigint): never {
  reject(
    `Refusing a Morpho market bundle: its ${field} is ${saw} raw units, but the intent Vex approved is ${expected}. `
    + "The transaction does not do what was asked.",
  );
}

export function addressMismatch(field: string, saw: string, expected: string): never {
  reject(
    `Refusing a Morpho market bundle: its ${field} is ${saw}, but the intent Vex approved names ${expected}.`,
  );
}

/** The `(target, data, value, skipRevert, callbackHash)` tuple Bundler3 takes. */
export interface RawCall {
  to: Address;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
}

export function decodeOuterBundle(data: Hex): readonly RawCall[] {
  let decoded: { args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: MORPHO_BUNDLER_ENTRY_CALL.abi, data });
  } catch {
    reject(
      "Refusing a Morpho market bundle: the Bundler3 call did not decode as `multicall` against the pinned Bundler3 "
      + "ABI, so Vex cannot see which contracts it would call.",
    );
  }
  const bundle = decoded.args?.[0];
  if (!Array.isArray(bundle)) {
    reject("Refusing a Morpho market bundle: the Bundler3 `multicall` payload did not decode into a list of calls.");
  }
  return bundle as readonly RawCall[];
}
