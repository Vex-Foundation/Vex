/**
 * Sealing what a curve quote authorizes, and rendering what a person reads.
 *
 * The two live together because they are two views of ONE object: the approval
 * preview must not be able to state a figure the seal does not bind, and the
 * seal must not bind a figure the preview never showed. Both are built from the
 * same `PricedCurveTrade` in the same call.
 *
 * `buildTradePreview` is also what the `simulateOnly` execute returns, so the
 * plan a caller inspects without signing is literally the plan the signing path
 * would carry.
 */

import type { CurveState } from "@tools/virtuals/curve/index.js";
import {
  sealVirtualsSnapshot,
  type VirtualsExecutionSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/virtuals.js";

import type { TradeParams } from "./params.js";
import {
  human,
  snapshotFeeFrom,
  snapshotTaxesFrom,
  type PricedCurveTrade,
} from "./pricing.js";

/**
 * Seal what this quote authorizes.
 *
 * `contractFloorRaw` is derived ONCE, here at quote time, and the execute writes
 * THAT number into the calldata - it never recomputes a floor from a fresher
 * curve read. Re-deriving the floor from a fresh quote is exactly how a sibling
 * venue filled a 313,879.7 quote at 1,190.145 without reverting on 2026-08-27.
 */
export function buildVirtualsQuoteSnapshot(input: {
  readonly params: TradeParams;
  readonly state: CurveState;
  readonly priced: PricedCurveTrade;
  readonly expiresAt: string;
}): VirtualsExecutionSnapshot {
  const { params, state, priced } = input;
  return sealVirtualsSnapshot({
    v: 1,
    provider: "virtuals",
    chainId: params.deployment.chainId,
    side: priced.side,
    token: { address: state.token, symbol: state.tokenSymbol, decimals: state.tokenDecimals },
    virtual: {
      address: params.deployment.virtual,
      symbol: "VIRTUAL",
      decimals: params.deployment.virtualDecimals,
    },
    pair: state.pair,
    bondingV5Implementation: state.implementations.bondingV5,
    frouterV3Implementation: state.implementations.frouterV3,
    totalInRaw: priced.totalInRaw.toString(),
    curveAmountRaw: priced.curveAmountRaw.toString(),
    fee: snapshotFeeFrom(priced),
    taxes: snapshotTaxesFrom(priced),
    quotedOutRaw: priced.quotedOutRaw.toString(),
    contractFloorRaw: priced.contractFloorRaw.toString(),
    walletNetMinRaw: priced.walletNetMinRaw === null ? null : priced.walletNetMinRaw.toString(),
    slippageBps: params.slippageBps,
    expiresAt: input.expiresAt,
  });
}

/**
 * The whole approval preview: every row of the authority table the brief calls
 * user-visible, in one object.
 *
 * WHAT IS DELIBERATELY EXPLICIT, because the alternative is a number that reads
 * as something it is not:
 *
 *  - `contractFloor` carries `enforcedBy: "contract"` and, on a sell, says in
 *    words that it bounds the router's GROSS output.
 *  - `walletNetMin` carries `estimate: true` and the condition it holds under.
 *  - the Vex fee's sell arm says the amount is an estimate until settlement.
 *  - the anti-sniper block always carries its note, so a `0` is never read as an
 *    unexamined default.
 */
export function buildTradePreview(input: {
  readonly params: TradeParams;
  readonly state: CurveState;
  readonly priced: PricedCurveTrade;
  /**
   * The digest of the sealed quote, or NULL when this preview authorizes nothing
   * (the `simulateOnly` path, which seals no snapshot).
   */
  readonly proposalId: string | null;
  /**
   * NULL travels with a null `proposalId`: a preview that authorizes nothing has
   * nothing to expire, and stamping it with "now" would render as an
   * already-expired proposal - a fact about the trade that is not true.
   */
  readonly expiresAt: string | null;
  readonly allowanceLegNeeded: boolean;
}): Record<string, unknown> {
  const { params, state, priced } = input;
  const d = params.deployment;

  return {
    proposalId: input.proposalId,
    expiresAt: input.expiresAt,
    chain: d.key,
    chainId: d.chainId,
    side: priced.side,
    agent: {
      token: state.token,
      symbol: state.tokenSymbol,
      name: state.tokenName,
      decimals: state.tokenDecimals,
      pair: state.pair,
      creator: state.creator,
      virtualsId: state.virtualId,
      lifecycle: "bonding_curve",
    },
    contracts: {
      bondingV5: d.bondingV5,
      frouterV3: d.frouterV3,
      ffactoryV2: d.ffactoryV2,
      virtual: d.virtual,
      // The contract that would actually run the trade. Bound into the proposal
      // and re-read from the EIP-1967 slot immediately before signing.
      bondingV5Implementation: state.implementations.bondingV5,
      frouterV3Implementation: state.implementations.frouterV3,
      spender: d.frouterV3,
      spenderNote:
        "FRouterV3 is the allowance spender, not BondingV5: the router is what calls transferFrom. "
        + "Vex approves the EXACT amount this trade spends, never an unlimited allowance.",
    },
    blockPin: {
      blockNumber: state.blockNumber.toString(),
      blockTimestampSeconds: state.blockTimestampSeconds,
      note: "Every figure below was read at this one block, so the taxes, the quote and the balances describe the same instant.",
    },
    spend: {
      token: priced.side === "buy" ? d.virtual : state.token,
      symbol: priced.spendTokenSymbol,
      decimals: priced.spendTokenDecimals,
      totalDebitedRaw: priced.totalInRaw.toString(),
      totalDebited: human(priced.totalInRaw, priced.spendTokenDecimals),
      curveAmountRaw: priced.curveAmountRaw.toString(),
      curveAmount: human(priced.curveAmountRaw, priced.spendTokenDecimals),
      ...(priced.taxedInRaw === null
        ? {}
        : {
            afterCurveTaxRaw: priced.taxedInRaw.toString(),
            afterCurveTax: human(priced.taxedInRaw, priced.spendTokenDecimals),
            afterCurveTaxNote:
              "What the curve actually swaps: the curve amount minus the protocol tax and any anti-sniper tax, "
              + "which FRouterV3 pulls from the wallet in the same transaction.",
          }),
      walletBalanceRaw: state.spendBalanceRaw.toString(),
      walletBalance: human(state.spendBalanceRaw, priced.spendTokenDecimals),
      sufficient: state.spendBalanceRaw >= priced.totalInRaw,
      allowanceRaw: state.allowanceRaw.toString(),
      allowanceLegNeeded: input.allowanceLegNeeded,
    },
    receive: {
      token: priced.side === "buy" ? state.token : d.virtual,
      symbol: priced.receiveTokenSymbol,
      decimals: priced.receiveTokenDecimals,
      quotedRaw: priced.quotedOutRaw.toString(),
      quoted: human(priced.quotedOutRaw, priced.receiveTokenDecimals),
      quotedNote:
        priced.side === "buy"
          ? "FRouterV3.getAmountsOut for the post-tax input: the tokens the wallet receives."
          : "FRouterV3.getAmountsOut GROSS: before the curve's protocol tax and any anti-sniper tax, which are removed inside the transaction.",
    },
    floors: {
      contractFloorRaw: priced.contractFloorRaw.toString(),
      contractFloor: human(priced.contractFloorRaw, priced.receiveTokenDecimals),
      contractFloorSymbol: priced.receiveTokenSymbol,
      enforcedBy: "contract",
      enforcedNote:
        priced.side === "buy"
          ? "Passed as amountOutMin_ to BondingV5.buy and compared against the tokens the wallet receives. A fill below it reverts with SlippageTooHigh."
          : "Passed as amountOutMin_ to BondingV5.sell and compared against the router's GROSS output, BEFORE the curve's taxes. It is the only floor the chain enforces on a sell.",
      ...(priced.walletNetMinRaw === null
        ? {}
        : {
            walletNetMinRaw: priced.walletNetMinRaw.toString(),
            walletNetMin: human(priced.walletNetMinRaw, priced.receiveTokenDecimals),
            walletNetMinEstimate: true,
            walletNetMinNote:
              "ESTIMATE at the taxes read a moment before signing, not a bound the contract enforces: it is the "
              + "enforced gross floor minus the protocol tax and any anti-sniper tax. The estimate errs high on the "
              + "safe side, because the only tax that can move before inclusion is the anti-sniper one and it only "
              + "decays. A receipt below it is a settlement discrepancy Vex reports as such.",
          }),
      ...(priced.walletNetQuotedRaw === null
        ? {}
        : {
            walletNetAtQuoteRaw: priced.walletNetQuotedRaw.toString(),
            walletNetAtQuote: human(priced.walletNetQuotedRaw, priced.receiveTokenDecimals),
          }),
      slippageBps: params.slippageBps,
      slippagePercent: `${(params.slippageBps / 100).toFixed(2)}%`,
    },
    curveTax: {
      protocolTaxPct: priced.protocolTaxPct,
      protocolTaxNote:
        `FFactoryV2 charges ${priced.protocolTaxPct}% on this side, read on chain. It is the venue's fee, not Vex's, and it is already inside the figures above.`,
      antiSniper: {
        type: priced.antiSniper.type,
        appliesToThisSide: priced.antiSniper.appliesToThisSide,
        effectivePct: priced.antiSniper.effectivePct,
        windowActive: priced.antiSniper.windowActive,
        remainingSeconds: priced.antiSniper.remainingSeconds,
        acceptedBoundPct: priced.antiSniper.acceptedPct,
        note: priced.antiSniper.note,
      },
    },
    vexFee: priced.feeDisclosure,
    gas: {
      nativeBalanceRaw: state.nativeBalanceRaw.toString(),
      nativeBalance: human(state.nativeBalanceRaw, 18),
      note: "Gas is paid in the chain's native ETH and is not included in the figures above.",
    },
    execution: {
      tool: "virtuals__agent_trade_execute",
      note:
        "Execute with the SAME chain, token, side, amountIn and slippageBps as this quote, plus this proposalId. "
        + "Any difference is refused by name rather than re-priced.",
    },
  };
}
