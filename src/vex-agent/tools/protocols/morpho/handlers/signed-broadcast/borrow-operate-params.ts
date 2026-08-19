/**
 * The `intent_params` payload of a Morpho Blue MARKET operation: the durable,
 * audit-facing record of what a specific `lend_borrow_operate` call actually
 * did.
 *
 * ── WHY THE OPERATION LIVES HERE AND NOT IN THE ROLE VOCABULARY ─────────────
 *
 * All four Blue operations file under ONE role, `lend_borrow_operate`, which
 * migration 079 already admits on the `eip155` lend arm. That is the Jupiter
 * precedent verbatim (`../../solana-jupiter/borrow-operate-params.ts`, whose own
 * header states the doctrine): one role covering many distinct delta shapes,
 * with the shape itself written into `intent_params` rather than multiplied into
 * new roles nobody can query consistently. `effects` is deliberately a
 * NORMALIZED array rather than the handler's raw parameters, so a later reader -
 * an operator, a migration, a feed - reads "collateral in 5000000 at 8 decimals"
 * without reverse-engineering which parameters were set.
 *
 * ── EVERY AMOUNT TRAVELS WITH THE DECIMALS OF ITS OWN TOKEN ─────────────────
 *
 * A Blue market pairs two tokens that rarely share a scale: the market this lane
 * was proven against pairs 8-decimal cbBTC collateral with 6-decimal USDC debt.
 * A raw amount beside a bare mint is the thousandfold error rules/90 names, so
 * the market block below carries BOTH decimals separately, every effect names
 * the token it is denominated in AND that token's own decimals, and the human
 * rendering is computed here rather than left to a reader to guess at.
 *
 * ── WHAT A `null` AMOUNT MEANS, AND WHY IT IS NOT A HOLE ────────────────────
 *
 * A repayment by SHARES has no asset amount at intent time: the assets consumed
 * are decided on chain when the share count is burned. Its effect carries
 * `amountRaw: null` with the share count stated separately, and the asset amount
 * is filled in from the receipt by `@vex-agent/sync/morpho-settlement-decoder.js`
 * rather than guessed. Writing a hopeful number here and correcting it later
 * would leave an intent that claimed something the wallet never authorised.
 */

import { formatUnits } from "viem";

import type {
  MorphoBorrowIntent,
  MorphoBorrowLeg,
  MorphoBorrowOperation,
  MorphoMarketIdentity,
  MorphoRepayMode,
} from "@tools/morpho/mutations.js";

/** Bumped on any breaking shape change. Existing rows keep their own version forever. */
export const MORPHO_BORROW_EFFECTS_VERSION = 1;

/** The market, with BOTH scales, because one `decimals` field on a two-token market is a money bug. */
export interface MorphoBorrowMarketParams {
  readonly chainId: number;
  readonly marketId: string;
  readonly loanToken: string;
  readonly loanDecimals: number;
  readonly loanSymbol: string | null;
  readonly collateralToken: string;
  readonly collateralDecimals: number;
  readonly collateralSymbol: string | null;
  readonly oracle: string;
  readonly irm: string;
  readonly lltvRaw: string;
}

/** One token movement, normalized. A Blue operation has exactly one. */
export interface MorphoBorrowEffect {
  /**
   * Which side of the position moved. Derived from the operation, never supplied.
   * `supply` is the LENDER'S side: assets lent into the market, earning the
   * borrowers' interest, backing no debt of the wallet's own.
   */
  readonly leg: "collateral" | "debt" | "supply";
  /** Relative to the WALLET: `in` = the wallet sends, `out` = the wallet receives. */
  readonly direction: "in" | "out";
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly decimals: number;
  /** `null` only for a repayment by shares. See the module header. */
  readonly amountRaw: string | null;
  readonly amountHuman: string | null;
}

/**
 * A `type` alias, deliberately NOT an `interface`. TypeScript gives an object
 * type alias an implicit index signature but withholds one from an interface, so
 * this shape is assignable to the `Record<string, unknown>` the `intentParams`
 * boundary takes without an `as unknown as` cast. Same fields, same strictness,
 * one fewer escape hatch on a money path.
 */
export type MorphoBorrowIntentParams = {
  readonly effectsVersion: typeof MORPHO_BORROW_EFFECTS_VERSION;
  readonly operation: MorphoBorrowOperation;
  readonly market: MorphoBorrowMarketParams;
  /** The wallet whose position changes. Also `onBehalf` and `msg.sender`. */
  readonly userAddress: string;
  /** Where borrowed assets or withdrawn collateral land. */
  readonly recipient: string;
  /** Non-null only for `repay`. */
  readonly repayMode: MorphoRepayMode | null;
  /** The borrow shares burned. Non-null only when `repayMode` is `"shares"`. */
  readonly sharesRaw: string | null;
  readonly effects: readonly MorphoBorrowEffect[];
};

/**
 * Which side of the position each operation touches. Exhaustive by construction.
 *
 * THE THIRD VALUE IS A THIRD SIDE, NOT A RE-USE OF EITHER. A Blue market
 * position has three independent balances - collateral posted, debt owed, and
 * assets SUPPLIED - and the supplier's side is the one whose owner is a lender
 * rather than a borrower. Filing a market supply under `collateral` would claim
 * it backs a debt (it does not, and it cannot be liquidated), and filing it
 * under `debt` would invert who owes whom. Both would corrupt every later query
 * that asks what a wallet's exposure on a market actually is.
 */
const OPERATION_LEG: Readonly<Record<MorphoBorrowOperation, "collateral" | "debt" | "supply">> = {
  supply_collateral: "collateral",
  withdraw_collateral: "collateral",
  borrow: "debt",
  repay: "debt",
  supply: "supply",
  withdraw: "supply",
};

function marketParams(market: MorphoMarketIdentity): MorphoBorrowMarketParams {
  return {
    chainId: market.chainId,
    marketId: market.marketId.toLowerCase(),
    loanToken: market.loanToken.toLowerCase(),
    loanDecimals: market.loanDecimals,
    loanSymbol: market.loanSymbol,
    collateralToken: market.collateralToken.toLowerCase(),
    collateralDecimals: market.collateralDecimals,
    collateralSymbol: market.collateralSymbol,
    oracle: market.oracle.toLowerCase(),
    irm: market.irm.toLowerCase(),
    lltvRaw: market.lltvRaw,
  };
}

/**
 * The strict, versioned `intent_params` for one resolved Blue market operation.
 *
 * Used for BOTH the intent-creation and the pre-broadcast refusal path, so a
 * refused operation's audit trail carries the SAME normalized shape a succeeded
 * one would - the Jupiter precedent's rule, and the reason a refusal is
 * queryable at all.
 */
export function buildMorphoBorrowIntentParams(
  intent: MorphoBorrowIntent,
  leg: MorphoBorrowLeg,
): MorphoBorrowIntentParams {
  return {
    effectsVersion: MORPHO_BORROW_EFFECTS_VERSION,
    operation: intent.operation,
    market: marketParams(intent.market),
    userAddress: intent.userAddress.toLowerCase(),
    recipient: intent.recipient.toLowerCase(),
    repayMode: intent.repayMode,
    sharesRaw: intent.sharesRaw === null ? null : intent.sharesRaw.toString(),
    effects: [
      {
        leg: OPERATION_LEG[intent.operation],
        direction: leg.direction,
        tokenAddress: leg.tokenAddress.toLowerCase(),
        tokenSymbol: leg.tokenSymbol,
        decimals: leg.decimals,
        amountRaw: leg.amountRaw,
        amountHuman: leg.amountRaw === null ? null : formatUnits(BigInt(leg.amountRaw), leg.decimals),
      },
    ],
  };
}
