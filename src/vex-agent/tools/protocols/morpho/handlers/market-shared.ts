/**
 * The DISCLOSURE every Morpho Blue market tool carries, and the leg keys the
 * ledger reads.
 *
 * ── ONE PROJECTION, FIVE TOOLS ──────────────────────────────────────────────
 *
 * `morpho.market.quote` and the four executes must describe the same operation
 * the same way. If the quote said the health factor lands at 1.31 and the
 * execute reported it differently, the gate that requires a quote before
 * spending would be certifying a different operation than the one that runs. So
 * the market pair, the oracle vouching, the health-factor projection against the
 * floor, and the market's free liquidity are projected HERE, once, from the
 * engine's own plan, and every one of the five tools returns this block.
 *
 * ── WHY THE APPROVAL GATE NEEDS IT, NOT JUST THE AGENT ──────────────────────
 *
 * These four facts are what a person needs to answer "should I allow this?", and
 * three of them are invisible in the parameters: an operation named
 * "borrow 500000000" says nothing about which oracle is vouching for the
 * collateral, how close to liquidation the position lands, or whether the market
 * even holds the liquidity. They ride on the output so the approval prompt and
 * the ledger row show the same evidence the tool used.
 *
 * ── THE LEG KEYS ────────────────────────────────────────────────────────────
 *
 * A Blue market operation moves exactly ONE token in one direction, so the
 * output carries exactly one of `tokenIn`/`tokenOut` and never both. The
 * renderer reads those key names already. Writing the absent side as a mirror
 * leg would claim a movement that never happened, which
 * `./signed-broadcast/borrow-intent.ts` refuses at the ledger layer for the same
 * reason it is refused here.
 */

import { formatUnits } from "viem";

import {
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
  formatWad,
  type MorphoBlueMarketState,
  type MorphoBorrowLeg,
  type MorphoBorrowPlan,
} from "@tools/morpho/mutations.js";

/** How a token is named in a leg line: its symbol when known, its address otherwise. */
export function morphoLegToken(leg: MorphoBorrowLeg): string {
  return leg.tokenSymbol ?? leg.tokenAddress.toLowerCase();
}

/**
 * A human amount in the DOTTED form the ledger's amount grammar requires.
 *
 * `formatUnits` renders a whole number of tokens as `"5"`, and the renderer's
 * `amountDisplay` runs with `trustedHuman: false`: a bare integer is
 * indistinguishable from a RAW base-unit amount, so it deliberately prints
 * NOTHING rather than risk showing 5 base units as 5 tokens. A trailing `.0`
 * is what tells the two apart, so it is added here rather than left to the
 * renderer to guess (contract pinned with the renderer, 2026-08-17).
 */
export function morphoDottedAmount(rawAmount: bigint, decimals: number): string {
  const human = formatUnits(rawAmount, decimals);
  return human.includes(".") ? human : `${human}.0`;
}

/** The same, for an amount already rendered by the execution layer. */
function dotted(human: string): string {
  return human.includes(".") ? human : `${human}.0`;
}

/**
 * The single leg, in the key names the ledger's leg reader recognises.
 *
 * `tokenIn` means the WALLET SENDS and `tokenOut` means the WALLET RECEIVES,
 * matching the convention the swap and Jupiter borrow lanes already use. The
 * amount is the HUMAN rendering at the token's own decimals, because a raw base
 * unit beside a bare symbol is the thousandfold error rules/90 names.
 */
export function morphoMarketLegKeys(leg: MorphoBorrowLeg): Record<string, string> {
  const token = morphoLegToken(leg);
  if (leg.amountRaw === null) {
    // A repayment by shares: the token is known, the amount is decided on chain.
    return leg.direction === "in" ? { tokenIn: token } : { tokenOut: token };
  }
  const human = morphoDottedAmount(BigInt(leg.amountRaw), leg.decimals);
  return leg.direction === "in"
    ? { tokenIn: token, amountIn: human }
    : { tokenOut: token, amountOut: human };
}

/** The same keys, from PROVEN settled amounts rather than the plan's. */
export function morphoSettledLegKeys(
  leg: MorphoBorrowLeg,
  executedHuman: string,
): Record<string, string> {
  const token = morphoLegToken(leg);
  const human = dotted(executedHuman);
  return leg.direction === "in"
    ? { tokenIn: token, amountIn: human }
    : { tokenOut: token, amountOut: human };
}

export interface MorphoMarketDisclosure {
  readonly marketId: string;
  readonly chainId: number;
  /** Both tokens with BOTH scales: a Blue market's two tokens rarely share one. */
  readonly pair: {
    readonly loanToken: string;
    readonly loanSymbol: string | null;
    readonly loanDecimals: number;
    readonly collateralToken: string;
    readonly collateralSymbol: string | null;
    readonly collateralDecimals: number;
  };
  readonly oracle: {
    readonly address: string;
    readonly vouching: string;
    readonly explanation: string;
  };
  readonly lltv: { readonly raw: string; readonly decimal: string };
  readonly healthFactor: {
    /** `null` means the position carries NO DEBT, not that the read failed. */
    readonly before: string | null;
    readonly after: string | null;
    readonly floor: string;
    readonly note: string;
  };
  readonly liquidity: {
    readonly availableRaw: string;
    readonly availableHuman: string;
    readonly loanDecimals: number;
    readonly note: string;
  };
}

const NO_DEBT_NOTE =
  "A `null` health factor means the position carries NO DEBT afterwards and therefore CANNOT be liquidated. It is "
  + "not a failed read and it is not a zero.";

const HEALTH_NOTE =
  `Vex refuses any Blue market operation that would leave the position's health factor below `
  + `${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}, and re-checks it against freshly accrued state immediately before signing. `
  + "The floor is policy rather than advice because Morpho has NO CLOSE FACTOR: a liquidation takes the WHOLE "
  + "position, not the part that went underwater, so there is no partial-loss outcome to fall back on.";

/**
 * Project one planned operation into the block every market tool returns.
 *
 * Taken from the engine's own plan rather than re-read, so the disclosure and
 * the gate that produced it cannot disagree.
 */
export function projectMorphoMarketDisclosure(
  market: MorphoBlueMarketState,
  plan: MorphoBorrowPlan,
): MorphoMarketDisclosure {
  const { identity, policy, snapshot } = market;
  const before = plan.positionBefore.healthFactorWad;
  const after = plan.healthFactorAfterWad;
  return {
    marketId: identity.marketId.toLowerCase(),
    chainId: identity.chainId,
    pair: {
      loanToken: identity.loanToken.toLowerCase(),
      loanSymbol: identity.loanSymbol,
      loanDecimals: identity.loanDecimals,
      collateralToken: identity.collateralToken.toLowerCase(),
      collateralSymbol: identity.collateralSymbol,
      collateralDecimals: identity.collateralDecimals,
    },
    oracle: {
      address: policy.oracle,
      vouching: policy.oracleProvenance,
      explanation: policy.explanation,
    },
    lltv: { raw: policy.lltvRaw, decimal: policy.lltvDecimal },
    healthFactor: {
      before: before === null ? null : formatWad(before),
      after: after === null ? null : formatWad(after),
      floor: MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
      note: `${HEALTH_NOTE} ${NO_DEBT_NOTE}`,
    },
    liquidity: {
      availableRaw: snapshot.availableLiquidityRaw.toString(),
      availableHuman: formatUnits(snapshot.availableLiquidityRaw, identity.loanDecimals),
      loanDecimals: identity.loanDecimals,
      note:
        "Free liquidity is the market's total supplied assets minus its total borrowed assets, in the LOAN token. A "
        + "borrow larger than it cannot be funded no matter how healthy the position is, and adding collateral does "
        + "not help.",
    },
  };
}

/** The consent model each operation actually has, stated in the OUTPUT and not only the manifest. */
export const MORPHO_MARKET_PLAN_NOTE: Readonly<Record<string, string>> = {
  supply_collateral:
    "A collateral supply is up to TWO transactions behind one consent: an ERC-20 approve() for exactly this amount "
    + "to the chain's pinned GeneralAdapter1, then the supply itself through Bundler3. They are not atomic, so a "
    + "failure after the approval lands leaves a standing allowance capped at this amount, which the failure output "
    + "names.",
  withdraw_collateral:
    "A collateral withdrawal is ONE transaction: a direct call on Morpho Blue. It only RECEIVES, so there is no "
    + "approval, no bundle and no standing allowance at any point.",
  borrow:
    "A borrow is ONE transaction: a direct call on Morpho Blue with msg.sender == onBehalf. It only RECEIVES, so "
    + "there is no approval and no standing allowance. Vex NEVER grants GeneralAdapter1 the standing Morpho "
    + "authorization a bundled borrow would require, which is why this is a direct call.",
  repay:
    "A repayment is up to TWO transactions behind one consent: an ERC-20 approve() to the chain's pinned "
    + "GeneralAdapter1, then the repayment through Bundler3. They are not atomic, so a failure after the approval "
    + "lands leaves a standing allowance, which the failure output names.",
};

/** What a SHARES repayment does that an assets one cannot, in the output's own words. */
export const MORPHO_REPAY_SHARES_NOTE =
  "This repayment is denominated in borrow SHARES, which is the only way to close a Morpho debt completely. It "
  + "burns the position's exact share count and lands at zero. Because the assets those shares cost accrue between "
  + "the block this was priced and the block it lands, the bundle pulls slightly MORE than the debt and SWEEPS the "
  + "residual back to the wallet in the same transaction; the approval is sized to the ceiling those shares can cost "
  + "at the approved slippage, not to one build's transfer amount.";

export const MORPHO_REPAY_ASSETS_NOTE =
  "This repayment is denominated in ASSETS, so it repays exactly the amount named and LEAVES THE POSITION OPEN. It "
  + "cannot close the debt: interest accrues between the block this was priced and the block it lands, so a residue "
  + "of dust debt survives, keeps accruing, and keeps the collateral locked. Use `repayFullDebt: true` to close it.";

/** One leg per operation, always. Stated because the ledger row has no second leg either. */
export const MORPHO_ONE_LEG_NOTE =
  "A Blue market operation moves exactly ONE token in ONE direction, so this result carries one of `tokenIn` or "
  + "`tokenOut` and never both. There is no second leg to report and none is invented.";
