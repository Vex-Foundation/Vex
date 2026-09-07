/**
 * THE ONE DERIVATION of a Virtuals curve trade's money.
 *
 * The quote calls it, and the execute calls it AGAIN against a fresh chain read
 * immediately before signing. That is the whole design: two code paths computing
 * one quantity from different inputs is the defect every money-path binding in
 * this repository exists to prevent, so there is exactly one function that turns
 * (params, chain state, router quote) into legs, floors, fee and disclosure -
 * and the execute holds its own result against the sealed one field by field.
 *
 * ## The authority table, and where each row is enforced
 *
 * | field | authority | enforced |
 * |---|---|---|
 * | chain, contracts | `@tools/virtuals/curve/deployments.ts` | `params.ts` |
 * | implementations | EIP-1967 slot, re-read | `state.ts` -> snapshot |
 * | lifecycle (trading, graduated) | `BondingV5.tokenInfo` | `state.ts` |
 * | buyTax / sellTax | `FFactoryV2` | `state.ts` -> here |
 * | anti-sniper pct | `FRouterV3` maths over chain reads | `state.ts` -> here |
 * | accepted anti-sniper bound | caller param | here, and again pre-sign |
 * | quote | `FRouterV3.getAmountsOut` at one block | here |
 * | slippageBps | param, product policy | `params.ts` |
 * | floors | this module | here |
 * | Vex fee bps + receiver | `@tools/virtuals/curve/fee.ts` constants | here |
 *
 * ## Why the anti-sniper check lives here rather than in the state read
 *
 * The state read reports what the chain says. Whether that is ACCEPTABLE is a
 * consent question, and consent is a parameter. Keeping the two apart is what
 * lets the quote answer "the window is active at 74 percent with 41s left" as
 * information when the caller accepted 80, and as a refusal when they accepted
 * nothing.
 */

import { formatUnits } from "viem";

import {
  applySlippageFloor,
  computeBuyLegs,
  computeSellFloors,
  effectiveAntiSniperPct,
  resolveVirtualsCurveBuyFee,
  resolveVirtualsCurveSellFee,
  VIRTUALS_CURVE_FEE_BPS,
  VIRTUALS_CURVE_FEE_RECEIVER_EVM,
  type CurveState,
  type VirtualsCurveFeeDisclosure,
} from "@tools/virtuals/curve/index.js";

import type {
  VirtualsExecutionInputs,
  VirtualsSnapshotFee,
  VirtualsSnapshotTaxes,
} from "@vex-agent/tools/protocols/quote-authority/virtuals.js";

import type { TradeParams } from "./params.js";

/** The anti-sniper verdict for the traded side, against the caller's bound. */
export interface AntiSniperVerdict {
  readonly type: number;
  readonly appliesToThisSide: boolean;
  /** After the router's 99 percent clamp, on the traded side. */
  readonly effectivePct: number;
  readonly windowActive: boolean;
  readonly remainingSeconds: number;
  readonly acceptedPct: number | null;
  /** True when the trade may proceed under the caller's stated bound. */
  readonly withinAcceptedBound: boolean;
  /** Always present, so a zero is never read as an unexamined default. */
  readonly note: string;
}

/** Everything a quote states and an execute is bound to. */
export interface PricedCurveTrade {
  readonly side: "buy" | "sell";
  /** What leaves the wallet in total. VIRTUAL on a buy, agent tokens on a sell. */
  readonly totalInRaw: bigint;
  /** The `amountIn_` the curve call carries. */
  readonly curveAmountRaw: bigint;
  /** BUY: the post-tax amount the curve actually swaps. SELL: not applicable. */
  readonly taxedInRaw: bigint | null;
  /** BUY: quoted tokens out. SELL: the router's quoted GROSS VIRTUAL. */
  readonly quotedOutRaw: bigint;
  /** The `amountOutMin_` argument - enforced on chain on both sides. */
  readonly contractFloorRaw: bigint;
  /** SELL only: the labelled ESTIMATE of the wallet's net at the floor. */
  readonly walletNetMinRaw: bigint | null;
  /** SELL only: the wallet's estimated net if the fill lands on the quote. */
  readonly walletNetQuotedRaw: bigint | null;
  /** The curve's own protocol tax on this side, integer percent. */
  readonly protocolTaxPct: number;
  readonly antiSniper: AntiSniperVerdict;
  /** BUY: exact fee in VIRTUAL. SELL: null - the fee comes off the proceeds. */
  readonly feeRaw: bigint | null;
  readonly feeDisclosure: VirtualsCurveFeeDisclosure;
  /** The token the wallet SPENDS on this side, for the allowance and balance. */
  readonly spendTokenSymbol: string;
  readonly spendTokenDecimals: number;
  /** The token the wallet RECEIVES, for the floor's units. */
  readonly receiveTokenSymbol: string;
  readonly receiveTokenDecimals: number;
}

export type PricingResult =
  | { readonly ok: true; readonly priced: PricedCurveTrade }
  | { readonly ok: false; readonly reason: string; readonly hint?: string };

/**
 * Price one side of a curve trade from the state read at one block and the
 * router's answer at that same block.
 *
 * `quotedOutRaw` is passed in rather than fetched here because the caller owns
 * the block pin and, on a buy, must quote for `taxedIn` - a figure this module
 * computes. The caller therefore calls twice on a buy: once for the legs, then
 * `getAmountsOut(taxedIn)`, then here again with the answer. `buyTaxedInFor`
 * exists so that first step has one owner too.
 */
export function priceCurveTrade(input: {
  readonly params: TradeParams;
  readonly state: CurveState;
  readonly quotedOutRaw: bigint;
}): PricingResult {
  const { params, state } = input;
  const virtualDecimals = params.deployment.virtualDecimals;

  const antiSniper = judgeAntiSniper(params, state);
  if (!antiSniper.withinAcceptedBound) {
    return {
      ok: false,
      reason:
        `The anti-sniper window is ACTIVE on the ${params.side} side of this curve: the tax is `
        + `${antiSniper.effectivePct}% right now, with about ${antiSniper.remainingSeconds}s left before it reaches zero.`,
      hint:
        params.acceptAntiSniperTaxPct === null
          ? `Nothing was quoted for signing. Wait for the window to expire, or call again with acceptAntiSniperTaxPct set to the maximum percent you are willing to pay (1-98).`
          : `You accepted at most ${params.acceptAntiSniperTaxPct}%. Wait for the window to decay below that, or raise the bound deliberately.`,
    };
  }

  if (params.side === "buy") {
    const fee = resolveVirtualsCurveBuyFee({ deployment: params.deployment, committedRaw: params.amountInRaw });
    const legs = computeBuyLegs({
      curveAmountRaw: fee.curveAmountRaw,
      buyTaxPct: state.buyTaxPct,
      rawAntiSniperBuyPct: state.antiSniper.rawBuyPct,
    });
    const contractFloorRaw = applySlippageFloor(input.quotedOutRaw, params.slippageBps);
    return {
      ok: true,
      priced: {
        side: "buy",
        totalInRaw: fee.committedRaw,
        curveAmountRaw: fee.curveAmountRaw,
        taxedInRaw: legs.taxedInRaw,
        quotedOutRaw: input.quotedOutRaw,
        contractFloorRaw,
        walletNetMinRaw: null,
        walletNetQuotedRaw: null,
        protocolTaxPct: state.buyTaxPct,
        antiSniper,
        feeRaw: fee.feeRaw,
        feeDisclosure: fee.disclosure,
        spendTokenSymbol: "VIRTUAL",
        spendTokenDecimals: virtualDecimals,
        receiveTokenSymbol: state.tokenSymbol,
        receiveTokenDecimals: state.tokenDecimals,
      },
    };
  }

  const floors = computeSellFloors({
    quotedGrossRaw: input.quotedOutRaw,
    sellTaxPct: state.sellTaxPct,
    rawAntiSniperSellPct: state.antiSniper.rawSellPct,
    slippageBps: params.slippageBps,
  });
  const fee = resolveVirtualsCurveSellFee({
    deployment: params.deployment,
    estimatedProceedsRaw: floors.walletNetQuotedRaw,
  });
  return {
    ok: true,
    priced: {
      side: "sell",
      totalInRaw: params.amountInRaw,
      // The Vex fee comes off the OUTPUT on this side, so the curve receives
      // every token the caller asked to sell.
      curveAmountRaw: params.amountInRaw,
      taxedInRaw: null,
      quotedOutRaw: floors.quotedGrossRaw,
      contractFloorRaw: floors.contractGrossMinRaw,
      walletNetMinRaw: floors.walletNetMinRaw,
      walletNetQuotedRaw: floors.walletNetQuotedRaw,
      protocolTaxPct: state.sellTaxPct,
      antiSniper,
      feeRaw: null,
      feeDisclosure: fee.disclosure,
      spendTokenSymbol: state.tokenSymbol,
      spendTokenDecimals: state.tokenDecimals,
      receiveTokenSymbol: "VIRTUAL",
      receiveTokenDecimals: virtualDecimals,
    },
  };
}

/**
 * The curve input a BUY must be quoted for: the committed amount minus Vex's fee
 * minus the curve's own two taxes.
 *
 * Its own function because the quote has to happen BETWEEN the fee split and the
 * floor, and both the quote handler and the execute handler need the identical
 * figure to ask the router for.
 */
export function buyTaxedInFor(params: TradeParams, state: CurveState): bigint {
  const fee = resolveVirtualsCurveBuyFee({ deployment: params.deployment, committedRaw: params.amountInRaw });
  return computeBuyLegs({
    curveAmountRaw: fee.curveAmountRaw,
    buyTaxPct: state.buyTaxPct,
    rawAntiSniperBuyPct: state.antiSniper.rawBuyPct,
  }).taxedInRaw;
}

/**
 * Whether the anti-sniper tax on the traded side is inside the caller's bound.
 *
 * The DEFAULT REFUSES. An omitted `acceptAntiSniperTaxPct` means the caller
 * accepted none, and a window that taxes even 1 percent is then a refusal - not
 * because 1 percent is dangerous, but because a window that reads 1 percent now
 * read 99 percent a minute ago and the caller said nothing about either.
 */
export function judgeAntiSniper(params: TradeParams, state: CurveState): AntiSniperVerdict {
  const anti = state.antiSniper;
  const appliesToThisSide = params.side === "buy" ? anti.appliesOnBuy : anti.appliesOnSell;
  const rawPct = params.side === "buy" ? anti.rawBuyPct : anti.rawSellPct;
  const protocolTaxPct = params.side === "buy" ? state.buyTaxPct : state.sellTaxPct;
  const effectivePct = effectiveAntiSniperPct(rawPct, protocolTaxPct);
  const windowActive = effectivePct > 0;
  const accepted = params.acceptAntiSniperTaxPct;
  const withinAcceptedBound = !windowActive || (accepted !== null && effectivePct <= accepted);

  return {
    type: anti.type,
    appliesToThisSide,
    effectivePct,
    windowActive,
    remainingSeconds: anti.remainingSeconds,
    acceptedPct: accepted,
    withinAcceptedBound,
    note: antiSniperNote({
      appliesToThisSide,
      windowActive,
      effectivePct,
      remainingSeconds: anti.remainingSeconds,
      type: anti.type,
      clockSource: anti.clockSource,
      side: params.side,
    }),
  };
}

function antiSniperNote(x: {
  readonly appliesToThisSide: boolean;
  readonly windowActive: boolean;
  readonly effectivePct: number;
  readonly remainingSeconds: number;
  readonly type: number;
  readonly clockSource: "taxStartTime" | "startTime";
  readonly side: "buy" | "sell";
}): string {
  const clock = `The window is anchored on the pair's ${x.clockSource}, read on chain - never on the API's launchedAt.`;
  if (!x.appliesToThisSide) {
    return `Anti-sniper type ${x.type} does not tax the ${x.side} side at all, so there is no anti-sniper component here. ${clock}`;
  }
  if (!x.windowActive) {
    return `Anti-sniper type ${x.type} taxes the ${x.side} side, but its window has expired: the component is 0% now. ${clock}`;
  }
  return (
    `Anti-sniper type ${x.type} is ACTIVE on the ${x.side} side at ${x.effectivePct}% and decays to zero over about `
    + `${x.remainingSeconds}s. It is charged by FRouterV3 inside the trade, on top of the curve's protocol tax. ${clock}`
  );
}

/** The fee block exactly as the snapshot binds it, derived from one disclosure. */
export function snapshotFeeFrom(priced: PricedCurveTrade): VirtualsSnapshotFee {
  const d = priced.feeDisclosure;
  if (d.charged === true) {
    return {
      disposition: "charged_on_input",
      amountRaw: d.feeAmountRaw,
      receiver: d.receiver,
      bps: d.bps,
      disclosureText: d.note,
    };
  }
  if (d.charged === false) {
    return {
      disposition: "not_charged",
      amountRaw: null,
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      bps: 0,
      disclosureText: `${d.note} Reason: ${d.reason}`,
    };
  }
  return {
    disposition: "charged_on_settled_output",
    amountRaw: d.estimatedFeeAmountRaw,
    receiver: d.receiver,
    bps: d.bps,
    disclosureText: d.note,
  };
}

/** The tax block the snapshot binds. */
export function snapshotTaxesFrom(priced: PricedCurveTrade): VirtualsSnapshotTaxes {
  return {
    protocolTaxPct: priced.protocolTaxPct,
    effectiveAntiSniperPct: priced.antiSniper.effectivePct,
    antiSniperType: priced.antiSniper.type,
    acceptedAntiSniperPct: priced.antiSniper.acceptedPct,
  };
}

/**
 * What the execute re-resolved, in the shape the snapshot comparison walks.
 *
 * ONE function, used by the execute only - the quote seals through
 * `buildVirtualsQuoteSnapshot`, which calls the same two projections above, so
 * the two sides cannot describe the same trade differently.
 */
export function executionInputsFrom(input: {
  readonly params: TradeParams;
  readonly state: CurveState;
  readonly priced: PricedCurveTrade;
}): VirtualsExecutionInputs {
  const { params, state, priced } = input;
  return {
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
  };
}

/** Human-readable amount at a token's own decimals. Exact, never a float. */
export function human(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/** The rate line every disclosure repeats, so the number has one home. */
export const VEX_FEE_RATE_LABEL = `${VIRTUALS_CURVE_FEE_BPS} bps (0.25%)`;
