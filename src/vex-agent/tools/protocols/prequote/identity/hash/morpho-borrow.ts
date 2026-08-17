/**
 * Morpho Blue BORROW-lane identities: supplying and withdrawing collateral,
 * drawing debt, and repaying it (E3c, migration 081).
 *
 * FOUR KINDS, NOT ONE. The four operations run against the SAME market and the
 * SAME wallet, and two of them can carry the same raw amount, so a shared kind
 * would let one operation's quote authorize another's execute as soon as the
 * remaining material agreed. The failure is not cosmetic: a collateral-supply
 * quote authorizing a borrow execute turns "put money in" into "take debt out".
 * Each kind therefore carries its tag as the FIRST material element, so the
 * operation is unmixable by construction rather than by a check somebody has to
 * remember. This mirrors the `lp_add` / `lp_remove` split (054) and the
 * `lend_deposit` / `lend_withdraw` split (080).
 *
 * THE MARKET ID IS THE ANCHOR, NOT THE TOKEN. A Morpho Blue market is
 * identified by the hash of its params (loan token, collateral token, oracle,
 * IRM, LLTV), and several markets can share a loan token while differing in
 * collateral, oracle, or LLTV. Binding only the token would let a quote taken
 * on a conservative market authorize an execute against a riskier one, which is
 * exactly the parameter a borrower is choosing between. The market id is bound
 * on all four kinds.
 *
 * THE MARKET ID IS ALSO WHAT MAKES THE RAW AMOUNT READABLE, which is why no
 * token address and no decimal count appear below. A raw base-unit amount is
 * meaningless on its own ("1047061" is 1.05 at 6 decimals and 0.00105 at 9), but
 * the market id is the hash of the market's own params, so market id + kind
 * already determine the exact token the amount is denominated in and therefore
 * its scale. Binding the token as well would buy nothing and would cost
 * everything: the four executes take `marketId`, `chain`, one raw amount and
 * `slippageBps` and NOTHING ELSE, so the gate would have to read the market from
 * chain to build an identity, and a gate that needs the network to decide is a
 * gate that fails open on a bad RPC. Every field below is readable from the
 * params of BOTH the quote and the execute, with no IO at all.
 *
 * SLIPPAGE IS BOUND on all four, mirroring the vault lane: it bounds a full-debt
 * repayment's share price and its approval ceiling, so an execute that widened
 * what the quote priced must not collide with it.
 *
 * A FULL-DEBT REPAYMENT HAS NO AMOUNT, and that is a distinct identity rather
 * than a missing one. `repayFullDebt: true` sends no `repayAmountRaw` at all
 * (the size is the position's own share count, read from chain), so the repay
 * material carries an explicit size MODE token next to the amount: a full-debt
 * repayment hashes as ("", "full") and an exact one as (amount, "exact"). The
 * two can never collide, and neither can collide with an exact repayment whose
 * amount happened to be absent, because an absent exact amount is refused before
 * it reaches the hash.
 *
 * THERE IS NO AUTHORIZATION IDENTITY. The borrow leg calls Morpho Blue directly
 * with `msg.sender == onBehalf`, so no `setAuthorization` is ever granted to an
 * adapter and there is no authorization operation to identify.
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Canonicalize a Morpho Blue market id (a bytes32 hex string) for the hash. Hex
 * is case-insensitive, so it lowercases after trimming; anything else is left
 * as the trimmed literal so the digest stays deterministic rather than throwing
 * inside a best-effort recorder.
 */
export function canonMarketId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The fields every borrow-lane identity binds, in the order they are hashed.
 *
 * There is no `receiver`. None of the four executes takes one: withdrawn
 * collateral and borrowed assets land in the signing wallet by construction, and
 * `parseMorphoMarketExecuteParams` refuses a caller-supplied `walletAddress` by
 * name. A field that is always equal to `walletAddress` would document a knob
 * that does not exist. If a receiver param is ever added, it must be bound here
 * in the same change.
 */
interface MorphoBorrowLegBase {
  readonly sessionId: string;
  /** VENUE binding - "morpho". */
  readonly provider: string;
  readonly chainId: number;
  /** Morpho Blue market id (bytes32 hex). The anchor of the identity. */
  readonly marketId: string;
  /** Selected EVM wallet. It is both the signer and `onBehalf` on this lane. */
  readonly walletAddress: string;
  /**
   * Amount in RAW base units of the operation's own token, which the market id
   * and the kind together determine. `""` ONLY for a full-debt repayment.
   */
  readonly amount: string;
  /** Applied price protection, already canonicalized to an integer string. */
  readonly slippageBps: string;
}

/**
 * Collateral SUPPLY. Material (FIXED order): ["lend_supply_collateral",
 * sessionId, provider, chainId, marketId, wallet, amount, slippageBps].
 */
export interface LendSupplyCollateralMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_supply_collateral";
}

/**
 * Collateral WITHDRAW. Material (FIXED order): ["lend_withdraw_collateral",
 * sessionId, provider, chainId, marketId, wallet, amount, slippageBps]. The
 * mirror of the supply, and unmixable with it because the tag leads.
 */
export interface LendWithdrawCollateralMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_withdraw_collateral";
}

/**
 * BORROW. Material (FIXED order): ["lend_borrow", sessionId, provider, chainId,
 * marketId, wallet, amount, slippageBps]. The operation that takes on debt, and
 * the one no collateral quote may ever authorize.
 */
export interface LendBorrowMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_borrow";
}

/**
 * REPAY. Material (FIXED order): ["lend_repay", sessionId, provider, chainId,
 * marketId, wallet, amount, sizeMode, slippageBps]. `sizeMode` is "full" for a
 * full-debt repayment (whose `amount` is "") and "exact" otherwise.
 */
export interface LendRepayMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_repay";
  /** True routes to the SHARES path, the only one that can close a debt. */
  readonly repayFullDebt: boolean;
}

export type MorphoBorrowMatchInput =
  | LendSupplyCollateralMatchInput
  | LendWithdrawCollateralMatchInput
  | LendBorrowMatchInput
  | LendRepayMatchInput;

/**
 * Fixed-order material for the four borrow-lane kinds. The `kind` tag leads it,
 * and only the repayment carries a size MODE, because it is the only operation
 * that can name its size without an amount.
 */
export function morphoBorrowHashMaterial(input: MorphoBorrowMatchInput): string {
  const head = [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonMarketId(input.marketId),
    canonAddress("eip155", input.walletAddress),
    input.amount === "" ? "" : canonAmount(input.amount),
  ];
  const sizeMode = input.kind === "lend_repay" ? [input.repayFullDebt ? "full" : "exact"] : [];
  return [...head, ...sizeMode, input.slippageBps].join(" ");
}
