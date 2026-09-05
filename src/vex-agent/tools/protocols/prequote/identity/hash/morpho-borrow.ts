/**
 * Morpho Blue MARKET-lane identities: supplying and withdrawing collateral,
 * drawing debt, repaying it (E3c, migration 081), and the LENDER'S side -
 * supplying the loan asset into the market and taking it back out, which reuse
 * the vault lane's `lend_deposit` / `lend_withdraw` kinds and are separated from
 * it by the `lane` discriminator documented further down.
 *
 * FOUR BORROW KINDS, NOT ONE. The four operations run against the SAME market and the
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
 * on every kind in this file.
 *
 * THE MARKET ID IS ALSO WHAT MAKES THE RAW AMOUNT READABLE, which is why no
 * token address and no decimal count appear below. A raw base-unit amount is
 * meaningless on its own ("1047061" is 1.05 at 6 decimals and 0.00105 at 9), but
 * the market id is the hash of the market's own params, so market id + kind
 * already determine the exact token the amount is denominated in and therefore
 * its scale. Binding the token as well would buy nothing and would cost
 * everything: the six executes take `marketId`, `chain`, one raw amount and
 * `slippageBps` and NOTHING ELSE, so the gate would have to read the market from
 * chain to build an identity, and a gate that needs the network to decide is a
 * gate that fails open on a bad RPC. Every field below is readable from the
 * params of BOTH the quote and the execute, with no IO at all.
 *
 * SLIPPAGE IS BOUND on all six, mirroring the vault lane: it bounds a full-debt
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
import { MORPHO_MARKET_LANE } from "../lane.js";

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
 * There is no `receiver`. None of the six executes takes one: withdrawn
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

/**
 * ── THE MARKET LANE'S SUPPLY AND WITHDRAW, UNDER THE VAULT LANE'S KINDS ──────
 *
 * Supplying a market's loan asset IS lending, so it files under the EXISTING
 * `lend_deposit` / `lend_withdraw` kinds rather than minting two more: the kind
 * answers "what did the agent do", and a per-venue-shape kind would make the
 * agent's own history unqueryable across venues. No migration, no new
 * vocabulary.
 *
 * WHICH MEANS THE KIND CAN NO LONGER DECIDE THE MATERIAL ON ITS OWN. A vault
 * deposit and a market supply are DIFFERENT OPERATIONS on DIFFERENT contracts
 * that now share a kind tag, so a `lane` discriminator carries the distinction
 * into the identity and the hash dispatcher reads it. It is on the MATCH INPUT,
 * not only on the registration, because the hash function is what has to tell
 * the two apart.
 *
 * `lane` IS DELIBERATELY ABSENT FROM BOTH MATERIALS. Adding it to the vault
 * material would shift every digest already recorded there for no safety gain,
 * and it is not needed: the two materials cannot align. A vault deposit hashes 9
 * space-joined fields with a 40-hex VAULT ADDRESS in position 5, while a market
 * supply hashes 8 with a 64-hex MARKET ID in that position. Different arity and
 * a different anchor shape mean no vault quote can produce a market supply's
 * digest, or the reverse, whatever the amounts.
 */
export interface LendMarketSupplyMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_deposit";
  readonly lane: typeof MORPHO_MARKET_LANE;
}

export interface LendMarketWithdrawMatchInput extends MorphoBorrowLegBase {
  readonly kind: "lend_withdraw";
  readonly lane: typeof MORPHO_MARKET_LANE;
}

export type MorphoBorrowMatchInput =
  | LendSupplyCollateralMatchInput
  | LendWithdrawCollateralMatchInput
  | LendBorrowMatchInput
  | LendRepayMatchInput
  | LendMarketSupplyMatchInput
  | LendMarketWithdrawMatchInput;

/**
 * Fixed-order material for the six market-lane kinds. The `kind` tag leads it,
 * and only the repayment carries a size MODE, because it is the only operation
 * that can name its size without an amount. `lane` is NOT part of the material -
 * see the block above for why it does not need to be.
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
