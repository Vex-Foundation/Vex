/**
 * The verifier for the THIRD transaction shape in the Morpho lane:
 * `direct-blue-call`, a call made straight to Morpho Blue with no Bundler3 and
 * no adapter in between.
 *
 * ── WHY THIS IS A SEPARATE MODULE FROM `./bundle-decoder.ts` ────────────────
 *
 * Not a line-count split. `./bundle-decoder.ts` owns transactions that pass
 * through Bundler3's multicall or a vault's own entry point, and its whole job
 * is walking an inner leg list against a target-role set. A direct Blue call has
 * NO inner legs: it is one function call to one pinned contract, and what has to
 * be proved about it is entirely different (that the market parameters in the
 * calldata are the vouched-for ones, that `onBehalf` is the user themselves, and
 * that the amount matches the intent). Different reasons to change, so different
 * modules; the public gate re-exports both.
 *
 * ── WHAT THIS SHAPE COVERS ──────────────────────────────────────────────────
 *
 * Three operations, one shape, checked identically:
 *
 *   - `borrow`, encoded by Vex itself in `./borrow-engine.ts`, because the SDK's
 *     bundled borrow would require a standing authorization the owner refused;
 *   - `withdraw` of SUPPLIED loan assets, encoded by Vex for exactly the same
 *     reason, measured rather than assumed: the SDK's own `blue.withdraw()`
 *     builds a bundle whose single requirement is `blueAuthorization` (fixture
 *     `agents_dm/morpho-e3/fixtures/base-market-supply-withdraw.json`,
 *     captures[1]). The direct call was LANDED on an Anvil fork of Base on
 *     2026-08-18 with no authorization granted at any point;
 *   - `withdrawCollateral`, which the Morpho SDK ALREADY emits as a direct Blue
 *     call for its own reasons (`msg.sender` must be `onBehalf`, so there is
 *     nothing for a bundler to do).
 *
 * VEX'S OWN CALLDATA GETS THE SAME SCRUTINY AS THE SDK'S, and that is the point
 * of decoding something we just encoded. It is not ceremony: the encoder and the
 * checker read from different inputs (the encoder from the intent, the checker
 * from the bytes), so a mistake in the encoder's argument ORDER, a wrong market
 * struct, or a recipient that quietly became the wrong address is caught before
 * a signature exists. A builder that also gets to certify its own output is not
 * a check, and that rule does not stop applying because the builder is ours.
 *
 * ── ONBEHALF IS THE SECURITY-CRITICAL FIELD ─────────────────────────────────
 *
 * The entire no-authorization design rests on `onBehalf == msg.sender == the
 * user's own wallet`. If `onBehalf` were ever anything else, Morpho Blue would
 * demand an authorization Vex does not hold and the transaction would revert;
 * worse, in the mirror-image case, a transaction Vex signed for someone else's
 * position would be a transaction moving someone else's debt. It is checked
 * explicitly rather than assumed from the encoder.
 */

import { blueAbi } from "@morpho-org/blue-sdk-viem";
import { decodeFunctionData, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { MORPHO_CONTRACTS } from "../constants.js";
import type { MorphoBorrowIntent, MorphoBorrowOperation } from "./borrow-types.js";

/** The Blue functions this shape is allowed to carry. Closed, deliberately. */
const ALLOWED_BLUE_FUNCTIONS: Readonly<Record<MorphoBorrowOperation, string | null>> = {
  borrow: "borrow",
  withdraw_collateral: "withdrawCollateral",
  // The SUPPLIER'S withdrawal, encoded by Vex for the same reason `borrow` is:
  // the SDK's bundled build requires the standing `blueAuthorization` grant the
  // owner refuses. Fixture `base-market-supply-withdraw.json`, captures[1].
  withdraw: "withdraw",
  // Routed through Bundler3 and GeneralAdapter1 instead, so a direct Blue call
  // for any of these is NOT a shape this lane produces and is refused.
  supply_collateral: null,
  repay: null,
  supply: null,
};

/**
 * Operations whose call carries `(marketParams, assets, shares, onBehalf,
 * receiver)`. `withdrawCollateral` is the odd one out with no `shares` word, so
 * the positional read below is driven by this set rather than by a name test
 * repeated at each argument.
 */
const CARRIES_SHARES_WORD: Readonly<Record<string, true>> = { borrow: true, withdraw: true };

/** The decoder's account of a direct Blue call it ACCEPTED. */
export interface MorphoBlueCallReport {
  readonly shape: "direct-blue-call";
  readonly to: string;
  readonly toRole: "morphoBlue";
  readonly functionName: string;
  readonly valueRaw: string;
  readonly marketId: string;
  readonly onBehalf: string;
  readonly receiver: string;
  /** The amount the decoder PROVED the calldata moves, in raw units. */
  readonly verifiedAmountRaw: string;
  readonly summary: string;
}

function reject(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_BUNDLE_REJECTED, message, hint);
}

const NOTHING_SIGNED_HINT =
  "Nothing was signed or sent. A transaction that failed Vex's own decode is refused rather than passed through, "
  + "because opaque calldata on a money path is not evidence of anything.";

/**
 * Decode a direct Blue call and prove it against the intent.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` naming exactly which check failed.
 */
export function verifyMorphoBlueCall(
  transaction: { readonly to: Address; readonly data: Hex; readonly value: bigint },
  intent: MorphoBorrowIntent,
  marketParams: {
    readonly loanToken: Address;
    readonly collateralToken: Address;
    readonly oracle: Address;
    readonly irm: Address;
    readonly lltv: bigint;
  },
): MorphoBlueCallReport {
  const expectedFunction = ALLOWED_BLUE_FUNCTIONS[intent.operation];
  if (expectedFunction === null) {
    reject(
      `Refusing the transaction: a ${intent.operation.replace(/_/g, " ")} is routed through Bundler3 in this lane, so `
      + "a direct call to Morpho Blue is not a shape Vex builds for it.",
      NOTHING_SIGNED_HINT,
    );
  }

  const pinnedBlue = MORPHO_CONTRACTS[intent.market.chainId]?.morphoBlue;
  if (pinnedBlue === null || pinnedBlue === undefined) {
    reject(
      `Refusing the transaction: Vex has no pinned Morpho Blue address for chain ${intent.market.chainId}, so it `
      + "cannot confirm the call goes to Morpho Blue at all.",
      NOTHING_SIGNED_HINT,
    );
  }
  if (transaction.to.toLowerCase() !== pinnedBlue.toLowerCase()) {
    reject(
      `Refusing the transaction: it is addressed to ${transaction.to.toLowerCase()}, not to the chain's pinned Morpho `
      + `Blue ${pinnedBlue.toLowerCase()}.`,
      NOTHING_SIGNED_HINT,
    );
  }
  if (transaction.value !== 0n) {
    reject(
      `Refusing the transaction: it would send ${transaction.value} wei of native currency, and no Blue market `
      + "operation in this lane moves native value.",
      NOTHING_SIGNED_HINT,
    );
  }

  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    const result = decodeFunctionData({ abi: blueAbi, data: transaction.data });
    decoded = { functionName: result.functionName, args: (result.args ?? []) as readonly unknown[] };
  } catch (error) {
    reject(
      "Refusing the transaction: its calldata did not decode against the Morpho Blue ABI at all, so Vex cannot say "
      + `what it would do. The decoder reported: ${error instanceof Error ? error.message : String(error)}`,
      NOTHING_SIGNED_HINT,
    );
  }

  if (decoded.functionName !== expectedFunction) {
    reject(
      `Refusing the transaction: its calldata calls Morpho Blue's "${decoded.functionName}", and this operation is a `
      + `${intent.operation.replace(/_/g, " ")}, which must call "${expectedFunction}".`,
      NOTHING_SIGNED_HINT,
    );
  }

  // All three allowed functions share the same leading shape, and two of them
  // are byte-identical in arity:
  //   borrow(marketParams, assets, shares, onBehalf, receiver)
  //   withdraw(marketParams, assets, shares, onBehalf, receiver)
  //   withdrawCollateral(marketParams, assets, onBehalf, receiver)
  const [rawParams, ...rest] = decoded.args;
  const hasSharesWord = CARRIES_SHARES_WORD[decoded.functionName] === true;
  const assets = rest[0] as bigint;
  const shares = hasSharesWord ? (rest[1] as bigint) : 0n;
  const onBehalf = String(hasSharesWord ? rest[2] : rest[1]);
  const receiver = String(hasSharesWord ? rest[3] : rest[2]);

  const callParams = rawParams as Record<string, unknown>;
  const mismatched: string[] = (["loanToken", "collateralToken", "oracle", "irm"] as const)
    .filter((field) => String(callParams[field]).toLowerCase() !== marketParams[field].toLowerCase());
  if (BigInt(String(callParams["lltv"])) !== marketParams.lltv) mismatched.push("lltv");
  if (mismatched.length > 0) {
    reject(
      "Refusing the transaction: the market parameters inside its calldata are not the ones Vex vouched for "
      + `(${mismatched.join(", ")} differ). Morpho Blue identifies a market by these five values, so a calldata `
      + "carrying different ones would act on a different market than the one whose oracle and interest rate model "
      + "were checked.",
      NOTHING_SIGNED_HINT,
    );
  }

  if (onBehalf.toLowerCase() !== intent.userAddress.toLowerCase()) {
    reject(
      `Refusing the transaction: its onBehalf is ${onBehalf.toLowerCase()} and the wallet sending it is `
      + `${intent.userAddress.toLowerCase()}. Vex operates only on the sender's OWN position: that equality is the `
      + "entire reason this call needs no standing authorization on Morpho, and a mismatch would mean signing a "
      + "transaction against somebody else's debt.",
      NOTHING_SIGNED_HINT,
    );
  }
  if (receiver.toLowerCase() !== intent.recipient.toLowerCase()) {
    reject(
      `Refusing the transaction: it would send the proceeds to ${receiver.toLowerCase()} and the intent names `
      + `${intent.recipient.toLowerCase()}.`,
      NOTHING_SIGNED_HINT,
    );
  }

  const expectedAmount = intent.amountRaw ?? 0n;
  if (assets !== expectedAmount) {
    reject(
      `Refusing the transaction: its calldata moves ${assets} raw units and the intent is for ${expectedAmount}.`,
      NOTHING_SIGNED_HINT,
    );
  }
  if (hasSharesWord && shares !== 0n) {
    // The share KIND is named because the two are different balances: a borrow's
    // shares are debt owed and a supplier's are assets lent.
    const shareKind = decoded.functionName === "borrow" ? "borrow" : "supply";
    reject(
      `Refusing the transaction: it names ${shares} ${shareKind} shares alongside an asset amount. A Blue `
      + `${decoded.functionName} is denominated in one or the other, never both.`,
      NOTHING_SIGNED_HINT,
    );
  }

  // WHICH TOKEN THE AMOUNT IS DENOMINATED IN, and the trap this decides once:
  // only `withdraw_collateral` moves the COLLATERAL token. The borrow and the
  // SUPPLIER'S withdrawal both move the LOAN token, and the market this lane was
  // proven against pairs 8-decimal cbBTC against 6-decimal USDC, so reading the
  // wrong scale would misreport the size by a hundredfold.
  const isCollateralLeg = intent.operation === "withdraw_collateral";
  const decimals = isCollateralLeg ? intent.market.collateralDecimals : intent.market.loanDecimals;
  const symbol = isCollateralLeg
    ? intent.market.collateralSymbol ?? intent.market.collateralToken.toLowerCase()
    : intent.market.loanSymbol ?? intent.market.loanToken.toLowerCase();

  return {
    shape: "direct-blue-call",
    to: transaction.to.toLowerCase(),
    toRole: "morphoBlue",
    functionName: decoded.functionName,
    valueRaw: "0",
    marketId: intent.market.marketId,
    onBehalf: onBehalf.toLowerCase(),
    receiver: receiver.toLowerCase(),
    verifiedAmountRaw: assets.toString(),
    summary:
      `Direct call to Morpho Blue: ${decoded.functionName} of ${assets} raw units of ${symbol} (${decimals} decimals) `
      + `on market ${intent.market.marketId}, on behalf of ${onBehalf.toLowerCase()} and paid to `
      + `${receiver.toLowerCase()}. No Bundler3, no adapter and no standing authorization are involved.`,
  };
}
