/**
 * The vocabulary of a Morpho BLUE MARKET operation, in Vex's own terms.
 *
 * Same doctrine as `./types.ts` does for vaults: the intent is what Vex decided
 * to do, expressed before any SDK is involved, and every downstream check
 * verifies the built transaction against THIS rather than against the builder's
 * own account of what it built.
 *
 * ── FOUR OPERATIONS, ONE LEG EACH ───────────────────────────────────────────
 *
 * A Blue market operation moves exactly one token in one direction, which is
 * what makes it far simpler to record than Jupiter's `/operate` (whose signed
 * two-delta shape can touch collateral and debt in the same call). There is no
 * combined shape here at all, and that is a CONSEQUENCE OF THE OWNER'S OPTION-1
 * RULING rather than an oversight: see the non-goal note in `./borrow-engine.ts`.
 *
 *   supply_collateral   collateral token, wallet SENDS
 *   withdraw_collateral collateral token, wallet RECEIVES
 *   borrow              loan token,       wallet RECEIVES
 *   repay               loan token,       wallet SENDS
 *
 * ── TWO TOKENS, TWO DECIMALS, ALWAYS ────────────────────────────────────────
 *
 * A Blue market has a loan token and a collateral token and they rarely share a
 * scale: the market this engine was proven against pairs 8-decimal cbBTC
 * collateral with 6-decimal USDC debt. A raw amount that travels without the
 * decimals of ITS OWN token is the thousandfold error rules/90 names, so the
 * market identity below carries both scales separately and every leg names which
 * token it is denominated in.
 */

import type { Address } from "viem";

/** The four operations. There is no fifth, and no combined shape. */
export type MorphoBorrowOperation =
  | "supply_collateral"
  | "withdraw_collateral"
  | "borrow"
  | "repay";

/** Every operation, in a stable order, for exhaustive checks and vocabularies. */
export const MORPHO_BORROW_OPERATIONS: readonly MorphoBorrowOperation[] = [
  "supply_collateral",
  "withdraw_collateral",
  "borrow",
  "repay",
] as const;

/**
 * A Blue market, fully identified.
 *
 * `marketId` is the hash of the five parameters and PROVES NOTHING ON ITS OWN;
 * it is carried for correlation and for the activity row, while the parameters
 * beside it are what `./market-policy.ts` actually vouches for.
 */
export interface MorphoMarketIdentity {
  readonly chainId: number;
  readonly marketId: string;
  readonly loanToken: Address;
  readonly loanDecimals: number;
  readonly loanSymbol: string | null;
  readonly collateralToken: Address;
  readonly collateralDecimals: number;
  readonly collateralSymbol: string | null;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltvRaw: string;
}

/**
 * How a repayment names its size.
 *
 * SHARES IS THE ONLY WAY TO CLOSE A DEBT COMPLETELY. Borrow shares keep
 * accruing interest between the block the amount is computed and the block the
 * transaction lands, so a repayment denominated in ASSETS always leaves a
 * residue of dust debt behind. The fork proved it to the unit: borrowing exactly
 * 500,000,000 raw USDC produced a debt of 500,000,001, so repaying the borrowed
 * amount would have left the position open. Repaying by SHARES burns the exact
 * share count and lands at zero, which the fork also proved.
 */
export type MorphoRepayMode = "assets" | "shares";

/** ONE Blue market operation, fully resolved, before anything is built. */
export interface MorphoBorrowIntent {
  readonly operation: MorphoBorrowOperation;
  readonly market: MorphoMarketIdentity;
  /** The wallet whose position changes. It is also `onBehalf` and `msg.sender`. */
  readonly userAddress: Address;
  /** Where borrowed assets or withdrawn collateral land. */
  readonly recipient: Address;
  /**
   * Raw base units of the operation's OWN token, in the scale named by
   * `market.loanDecimals` or `market.collateralDecimals` as the operation
   * dictates. `null` only for a repayment denominated in shares, where the asset
   * amount is not knowable in advance.
   */
  readonly amountRaw: bigint | null;
  /** Borrow shares to burn. Non-null only when `repayMode` is `"shares"`. */
  readonly sharesRaw: bigint | null;
  /** Non-null only for `repay`. */
  readonly repayMode: MorphoRepayMode | null;
}

/**
 * A position read fresh and accrued to now.
 *
 * `healthFactorWad` IS NORMALISED AND THE NORMALISATION MATTERS. The SDK's
 * `AccrualPosition.healthFactor` is typed `bigint | undefined`, but a position
 * with collateral and NO DEBT was observed on the fork to return MaxUint256, a
 * sentinel. Compared naively against a floor that sentinel passes, which happens
 * to be the right answer for the wrong reason and would compare as a real number
 * anywhere else. It is turned into `null` here, once, so no consumer downstream
 * ever meets it.
 */
export interface MorphoPositionSnapshot {
  readonly collateralRaw: bigint;
  readonly borrowSharesRaw: bigint;
  readonly borrowAssetsRaw: bigint;
  /** `null` when the position carries no debt and therefore cannot be liquidated. */
  readonly healthFactorWad: bigint | null;
  readonly ltvWad: bigint | null;
  /**
   * The most the position could owe at the market's LLTV, in raw loan units.
   * `null` when the SDK cannot state it, which happens when there is no
   * collateral to value. Nullable rather than zero: "no capacity" and "capacity
   * unknown" are different facts, and only one of them is safe to borrow against.
   */
  readonly maxBorrowAssetsRaw: bigint | null;
}

/** The market's own totals, accrued to now. */
export interface MorphoMarketSnapshot {
  readonly totalSupplyAssetsRaw: bigint;
  readonly totalBorrowAssetsRaw: bigint;
  /** `totalSupplyAssets - totalBorrowAssets`, never below zero. */
  readonly availableLiquidityRaw: bigint;
}

/**
 * One token movement, named so an activity row and an agent read the same thing.
 *
 * `direction` is relative to the WALLET, matching the `tokenIn` = wallet-sends /
 * `tokenOut` = wallet-receives convention the ledger already uses for swaps and
 * for Jupiter's borrow legs.
 */
export interface MorphoBorrowLeg {
  readonly direction: "in" | "out";
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly decimals: number;
  /**
   * `null` ONLY for a repayment by shares, where the asset amount the operation
   * will consume is decided on-chain at execution. It is filled in from the
   * receipt by the settlement decoder rather than guessed here.
   */
  readonly amountRaw: string | null;
}

/**
 * The engine's verdict on an operation it is willing to prepare.
 *
 * A refusal is a thrown `VexError` naming its predicate, never a report with a
 * flag on it, so no caller proceeds past a failed gate by forgetting to read a
 * boolean.
 */
export interface MorphoBorrowPlan {
  readonly operation: MorphoBorrowOperation;
  readonly market: MorphoMarketIdentity;
  readonly userAddress: Address;
  readonly leg: MorphoBorrowLeg;
  readonly positionBefore: MorphoPositionSnapshot;
  /** The projected position, computed by the SDK from the same accrued state. */
  readonly healthFactorAfterWad: bigint | null;
  readonly marketSnapshot: MorphoMarketSnapshot;
  /** One line a person can read, naming what was checked and what will happen. */
  readonly explanation: string;
}
