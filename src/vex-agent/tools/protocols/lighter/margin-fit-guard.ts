import {
  formatCapitalUnits,
  resolveLighterInitialMarginFraction,
} from "@tools/lighter/capital-share.js";
import {
  assessLighterOrderMarginFit,
  LIGHTER_UNREAD_EXCHANGE_FEE_TICKS,
  type LighterBookLevelInteger,
  type LighterOrderMarginFit,
} from "@tools/lighter/order-margin-fit.js";
import {
  decimalToLighterInteger,
  formatLighterIntegerAmount,
  isProtectiveOrderType,
} from "@tools/lighter/order-preview.js";
import type { LighterClient } from "@tools/lighter/client.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterEnvironment,
  LighterMarketDetail,
  LighterSimpleOrder,
} from "@tools/lighter/types.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";

/**
 * Below this share of available margin an order is admitted without the extra
 * reads: 2% of notional on top of initial margin covers any fee tier and
 * fill-to-mark gap Lighter charges, and a 10% price allowance covers movement
 * since the preview.
 */
const QUICK_FIT_EXTRA_FRACTION = 0.02;
const QUICK_FIT_PRICE_ALLOWANCE = 1.1;
/** Resting orders read to price how far a matching order walks the book. */
const BOOK_DEPTH_READ = 50;

export type LighterMarginFitClient =
  Pick<LighterClient, "getMarketDetails">
  & Partial<Pick<LighterClient, "getAccountLimits" | "getOrderBookOrders">>;

export type LighterMarginFitPreview = Pick<
  LighterOrderPreviewRow,
  "marketIndex" | "side" | "baseAmountInteger" | "priceInteger" | "orderType" | "reduceOnly" | "integratorFees"
> & Partial<Pick<LighterOrderPreviewRow, "previewJson">>;

/**
 * Refuse, before an approval card exists and again before signing, an order
 * that Lighter's own margin check would cancel with no fill.
 *
 * This is not the user's capital share: it applies with no share configured,
 * and it only mirrors the exchange's rule (see `order-margin-fit.ts`). Lighter
 * stays the final arbiter, so a read this check cannot make lets the order
 * through rather than refusing it; the refusal names the largest size that
 * fits so the trader or agent can resize.
 */
export async function assertLighterOrderFitsAccountMargin(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccount;
  readonly preview: LighterMarginFitPreview;
  readonly client: LighterMarginFitClient;
}): Promise<void> {
  const { environment, accountIndex, account, preview } = input;
  if (preview.reduceOnly || isProtectiveOrderType(preview.orderType)) return;
  const available = account.available_balance;
  if (typeof available !== "string") return;
  const positionRow = account.positions?.find((row) => row.market_id === preview.marketIndex) ?? null;
  if (clearlyFits(preview, positionRow, available)) return;

  let market: LighterMarketDetail | undefined;
  let accountTakerTicks: number;
  let levels: readonly LighterSimpleOrder[] | null;
  try {
    const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
    const [details, limits, book] = await Promise.all([
      input.client.getMarketDetails(environment, { marketId: preview.marketIndex, filter: "all" }),
      auth === null || input.client.getAccountLimits === undefined
        ? Promise.resolve(null)
        : input.client.getAccountLimits(environment, { accountIndex }, auth).catch(() => null),
      input.client.getOrderBookOrders === undefined
        ? Promise.resolve(null)
        : input.client.getOrderBookOrders(environment, { marketId: preview.marketIndex, limit: BOOK_DEPTH_READ })
          .catch(() => null),
    ]);
    market = [...details.order_book_details, ...details.spot_order_book_details]
      .find((detail) => detail.market_id === preview.marketIndex);
    const tier = limits?.code === 200 ? limits.current_taker_fee_tick : undefined;
    accountTakerTicks = Number.isSafeInteger(tier) && (tier as number) >= 0 && (tier as number) <= 1_000_000
      ? tier as number
      : LIGHTER_UNREAD_EXCHANGE_FEE_TICKS.taker;
    levels = book === null ? null : preview.side === "buy" ? book.asks : book.bids;
  } catch (error) {
    logger.warn("lighter.margin_fit.read_failed", {
      environment,
      accountIndex,
      marketIndex: preview.marketIndex,
      reason: error instanceof Error ? error.name : typeof error,
    });
    return;
  }
  if (market === undefined || market.market_type !== "perp") return;

  let fit: LighterOrderMarginFit;
  let closingBase: bigint;
  try {
    closingBase = oppositePositionBase(positionRow, preview.side, market.supported_size_decimals);
    const base = BigInt(preview.baseAmountInteger);
    const increasing = base > closingBase ? base - closingBase : 0n;
    if (increasing === 0n) return;
    const bookLevels = levels === null ? null : bookLevelIntegers(levels, preview.side, market);
    const best = bookLevels?.[0] === undefined ? null : BigInt(bookLevels[0].priceInteger);
    const bound = BigInt(preview.priceInteger);
    fit = assessLighterOrderMarginFit({
      side: preview.side,
      increasingBaseInteger: increasing.toString(),
      closingBaseInteger: closingBase.toString(),
      approvedPriceInteger: preview.priceInteger,
      takesLiquidity: preview.orderType === "market"
        ? true
        : best === null
          ? null
          : preview.side === "buy" ? bound >= best : bound <= best,
      bookLevels,
      markPrice: typeof market.mark_price === "string" ? market.mark_price : null,
      sizeDecimals: market.supported_size_decimals,
      priceDecimals: market.supported_price_decimals,
      initialMarginFraction: resolveLighterInitialMarginFraction({ positionRow, market }).initialMarginFraction,
      exchangeTakerFeePercent: market.taker_fee,
      exchangeAccountTakerFeeTicks: accountTakerTicks,
      vexIntegratorTakerFeeTicks: preview.integratorFees?.integratorTakerFee ?? null,
      availableBalance: available,
    });
  } catch (error) {
    logger.warn("lighter.margin_fit.unassessable", {
      environment,
      accountIndex,
      marketIndex: preview.marketIndex,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (fit.fits) return;

  const settlement = getLighterFundingDeployment(environment).settlementSymbol;
  const sizeDecimals = market.supported_size_decimals;
  const maxBase = BigInt(fit.maxIncreasingBaseInteger) + closingBase;
  const minBase = decimalToLighterInteger(market.min_base_amount, sizeDecimals, "min_base_amount");
  const resize = maxBase < minBase
    ? `Even Lighter's minimum of ${market.min_base_amount} ${market.symbol} does not fit. Add margin first.`
    : `Reduce the size to ${formatLighterIntegerAmount(maxBase, sizeDecimals)} ${market.symbol} or less, or add margin.`;
  const gap = BigInt(fit.markGapUnits) > 0n ? `, ${formatCapitalUnits(fit.markGapUnits)} for filling away from the mark price` : "";
  const freed = BigInt(fit.releasedMarginUnits) > 0n
    ? `, less ${formatCapitalUnits(fit.releasedMarginUnits)} freed by closing the existing ${market.symbol} position`
    : "";
  throw new VexError(
    ErrorCodes.INSUFFICIENT_BALANCE,
    `Lighter would cancel this ${market.symbol} order with no fill: it needs about ${formatCapitalUnits(fit.requiredUnits)} ${settlement} `
    + `(${formatCapitalUnits(fit.initialMarginUnits)} initial margin, ${formatCapitalUnits(fit.feeUnits)} in fees${gap}${freed}), `
    + `but account ${accountIndex} has ${formatCapitalUnits(fit.availableUnits)} ${settlement} available. Nothing was signed. ${resize}`,
  );
}

/**
 * The quick path that keeps an ordinary order free of extra reads: with the
 * account's own margin fraction known, a generous bound on everything the
 * exchange can charge still fits well inside the available balance.
 */
function clearlyFits(
  preview: LighterMarginFitPreview,
  positionRow: LighterAccountPosition | null,
  available: string,
): boolean {
  const imfPercent = Number(positionRow?.initial_margin_fraction);
  const notional = Number(readPreviewField(preview.previewJson, "quoteNotional", "display"));
  const reference = Number(readPreviewField(preview.previewJson, "marketData", "referencePrice"));
  const bound = Number(readPreviewField(preview.previewJson, "price", "display"));
  const balance = Number(available);
  if (![imfPercent, notional, bound, balance].every((value) => Number.isFinite(value) && value > 0)) return false;
  // A sell's own price is a floor, not a bound: it needs the market's price to be bounded.
  const priceScale = preview.side === "buy"
    ? 1
    : Number.isFinite(reference) && reference > 0 ? Math.max(1, reference / bound) : Number.NaN;
  if (!Number.isFinite(priceScale)) return false;
  const worstNotional = notional * priceScale * QUICK_FIT_PRICE_ALLOWANCE;
  return worstNotional * (imfPercent / 100 + QUICK_FIT_EXTRA_FRACTION) <= balance;
}

function readPreviewField(json: Record<string, unknown> | undefined, group: string, field: string): unknown {
  const section = json?.[group];
  return typeof section === "object" && section !== null ? (section as Record<string, unknown>)[field] : undefined;
}

/** The side the order matches against, best price first, at the market's integer scales. */
function bookLevelIntegers(
  orders: readonly LighterSimpleOrder[],
  side: "buy" | "sell",
  market: LighterMarketDetail,
): LighterBookLevelInteger[] {
  return orders
    .map((order) => ({
      priceInteger: decimalToLighterInteger(order.price, market.supported_price_decimals, "book price").toString(),
      sizeInteger: decimalToLighterInteger(
        order.remaining_base_amount,
        market.supported_size_decimals,
        "book size",
        { allowZero: true },
      ).toString(),
    }))
    .sort((left, right) => {
      const difference = BigInt(left.priceInteger) - BigInt(right.priceInteger);
      const ascending = difference < 0n ? -1 : difference > 0n ? 1 : 0;
      return side === "buy" ? ascending : -ascending;
    });
}

/** How much of the order closes an opposite position before it adds exposure. */
function oppositePositionBase(
  row: LighterAccountPosition | null,
  side: "buy" | "sell",
  sizeDecimals: number,
): bigint {
  if (row === null || typeof row.position !== "string") return 0n;
  const opposite = side === "buy" ? row.sign === -1 : row.sign === 1;
  if (!opposite) return 0n;
  // A flat market keeps its row, and its sign, so zero is an ordinary answer here.
  return decimalToLighterInteger(row.position.replace(/^-/, ""), sizeDecimals, "position", { allowZero: true });
}
