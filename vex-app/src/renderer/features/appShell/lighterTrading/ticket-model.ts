import type {
  LighterDeskOrderDraft,
  LighterTradingAccount,
  LighterTradingMarket,
} from "@shared/schemas/lighter-trading.js";
import { wholeLeverageLabelFromFraction } from "./leverage-display.js";
import { toDecimal } from "./decimal.js";

export type TradeSide = "buy" | "sell";
export type LimitTimeInForce = "immediate-or-cancel" | "good-till-time" | "post-only";
export type TradeOrderMode =
  | "market"
  | "limit"
  | "stop-loss"
  | "stop-loss-limit"
  | "take-profit"
  | "take-profit-limit"
  | "oco";

interface TradeDraftBase {
  readonly side: TradeSide;
  readonly baseAmount: string;
}

interface ProtectionLeg {
  readonly triggerPrice: string;
  /** Execution bound on the close side: min sell price for a long, max buy price for a short. */
  readonly price: string;
}

/** Optional stop-loss / take-profit attached to an entry order; prepared only after the entry fills. */
export interface TradeProtection {
  readonly stopLoss: ProtectionLeg | null;
  readonly takeProfit: ProtectionLeg | null;
}

export type TradeDraft =
  | (TradeDraftBase & {
      readonly mode: "market";
      readonly worstPrice: string;
      readonly reduceOnly: boolean;
      readonly protection?: TradeProtection | null;
    })
  | (TradeDraftBase & {
      readonly mode: "limit";
      readonly limitPrice: string;
      readonly timeInForce: LimitTimeInForce;
      readonly orderExpiryOffsetMinutes: number;
      readonly reduceOnly: boolean;
      readonly protection?: TradeProtection | null;
    })
  | (TradeDraftBase & {
      readonly mode: "stop-loss" | "take-profit";
      readonly triggerPrice: string;
      readonly worstPrice: string;
      readonly reduceOnly: true;
    })
  | (TradeDraftBase & {
      readonly mode: "stop-loss-limit" | "take-profit-limit";
      readonly triggerPrice: string;
      readonly limitPrice: string;
      readonly timeInForce: LimitTimeInForce;
      readonly orderExpiryOffsetMinutes: number;
      readonly reduceOnly: true;
    })
  | (TradeDraftBase & {
      readonly mode: "oco";
      readonly stopLossTriggerPrice: string;
      readonly stopLossPrice: string;
      readonly takeProfitTriggerPrice: string;
      readonly takeProfitPrice: string;
    });

export const MODE_LABELS: Readonly<Record<TradeOrderMode, string>> = {
  market: "Market",
  limit: "Limit",
  "stop-loss": "Stop loss",
  "stop-loss-limit": "Stop-loss limit",
  "take-profit": "Take profit",
  "take-profit-limit": "Take-profit limit",
  oco: "SL + TP",
};

/** Exchange register (Binance/Hyperliquid); "GTC" is Lighter's good-till-time, whose expiry the ticket picks. */
export const LIMIT_TIME_IN_FORCE_LABELS: Readonly<Record<LimitTimeInForce, string>> = {
  "good-till-time": "GTC",
  "immediate-or-cancel": "IOC",
  "post-only": "Post-Only",
};

export const LIMIT_TIME_IN_FORCE_NAMES: Readonly<Record<LimitTimeInForce, string>> = {
  "good-till-time": "Good till canceled (until the chosen expiry)",
  "immediate-or-cancel": "Immediate or cancel",
  "post-only": "Post-only (maker)",
};

export const ORDER_EXPIRY_OPTIONS = [
  { minutes: 10, label: "10 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1_440, label: "1 day" },
  { minutes: 10_080, label: "7 days" },
  { minutes: 43_200, label: "30 days" },
] as const;

export const DEFAULT_ORDER_EXPIRY_MINUTES = 1_440;
export const IOC_PREVIEW_EXPIRY_MINUTES = 30;
export const DEFAULT_LIMIT_TIME_IN_FORCE: LimitTimeInForce = "good-till-time";
export const SIZE_DECIMALS_FALLBACK = 6;
export const DEFAULT_SLIPPAGE_PERCENT = "0.5";
export const SLIPPAGE_PRESETS = ["0.1", "0.5", "1"] as const;
/** Attached protection legs execute within this percent of their trigger. */
export const PROTECTION_BOUND_PERCENT = "1";
export const SIZE_PERCENT_PRESETS = [25, 50, 75, 100] as const;
/** Risk mode: the share of account equity a filled stop-loss may cost. */
export const RISK_PERCENT_PRESETS = [0.5, 1, 2] as const;
export const DEFAULT_RISK_PERCENT = "1";

/**
 * Base size for which the stop-loss, filled at its trigger, loses exactly
 * `riskPercent` of `equity`: risk amount over the entry-to-stop distance.
 * Null when any input cannot size an order (no equity, no distance).
 */
export function riskBaseSize(equity: number, riskPercent: number, entryPrice: number, stopPrice: number): number | null {
  const distance = Math.abs(entryPrice - stopPrice);
  if (!(equity > 0) || !(riskPercent > 0) || !(distance > 0)) return null;
  return (equity * riskPercent) / 100 / distance;
}

export function isPositionProtectionMode(mode: TradeOrderMode): boolean {
  return mode !== "market" && mode !== "limit";
}

export function isTriggerLimitMode(mode: TradeOrderMode): mode is "stop-loss-limit" | "take-profit-limit" {
  return mode === "stop-loss-limit" || mode === "take-profit-limit";
}

export function hardBoundLabel(side: TradeSide): string {
  return side === "buy" ? "Maximum buy price" : "Minimum sell price";
}

/**
 * The facts-table form of {@link hardBoundLabel}: fits a half-width column at
 * the ticket's floor; the long form rides on the row as its tooltip.
 */
export function hardBoundShortLabel(side: TradeSide): string {
  return side === "buy" ? "Max Buy" : "Min Sell";
}

export function expiryLabel(minutes: number): string {
  return ORDER_EXPIRY_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `${minutes} minutes`;
}

/** A market bound from a reference price and a slippage percent: buys round up, sells round down. */
export function slippageBound(
  reference: string | null,
  slippagePercent: string,
  side: TradeSide,
  priceDecimals: number,
): string | null {
  const price = reference === null ? Number.NaN : Number(reference);
  const percent = Number(slippagePercent);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(percent) || percent < 0) return null;
  const scale = 10 ** priceDecimals;
  const raw = price * (side === "buy" ? 1 + percent / 100 : 1 - percent / 100) * scale;
  const rounded = side === "buy" ? Math.ceil(raw - 1e-9) : Math.floor(raw + 1e-9);
  return toDecimal(rounded / scale, priceDecimals);
}

export function sideLabel(side: TradeSide, marketType: "perp" | "spot", protective: boolean): string {
  if (protective || marketType === "spot") return side === "buy" ? "Buy" : "Sell";
  return side === "buy" ? "Long" : "Short";
}

/* ---------------------------------------------------------------------------
 * Margin
 * ------------------------------------------------------------------------- */

/** Margin terms the ticket prices an order against, on Lighter's 10000 scale (10000 = 1x). */
export interface TicketMargin {
  readonly initialMarginFraction: number;
  readonly maintenanceMarginFraction: number | null;
  readonly marginMode: "cross" | "isolated";
  /** The account's own terms for the market win over the market default. */
  readonly source: "account" | "market";
}

/** Mirrors main's `currentTerms`: the account's terms for the market, else the market default with cross margin. */
export function resolveTicketMargin(
  market: LighterTradingMarket,
  marginTerms: LighterTradingAccount["marginTerms"] | null,
): TicketMargin | null {
  if (market.marketType !== "perp") return null;
  const maintenance = market.margin?.maintenanceMarginFraction ?? null;
  const term = marginTerms?.find((row) => row.marketId === market.marketId) ?? null;
  if (term !== null) {
    return {
      initialMarginFraction: term.initialMarginFraction,
      maintenanceMarginFraction: maintenance,
      marginMode: term.marginMode ?? "cross",
      source: "account",
    };
  }
  if (market.margin === null || market.margin === undefined) return null;
  return {
    initialMarginFraction: market.margin.defaultInitialMarginFraction,
    maintenanceMarginFraction: maintenance,
    marginMode: "cross",
    source: "market",
  };
}

export function leverageLabel(initialMarginFraction: number): string {
  return wholeLeverageLabelFromFraction(initialMarginFraction);
}

/** Collateral an order of this notional locks up. */
export function marginCost(notional: number, initialMarginFraction: number): number {
  return (notional * initialMarginFraction) / 10_000;
}

/**
 * Vex's integrator fee as a FRACTION of notional, from the percent string the
 * market projection carries. An absent or unreadable value is zero, never a
 * guess: the projection reports null only where no collector is configured.
 */
export function integratorFeeFraction(percent: string | null | undefined): number {
  if (percent === null || percent === undefined) return 0;
  const value = Number(percent);
  return Number.isFinite(value) && value > 0 ? value / 100 : 0;
}

/**
 * The exchange's own fee as a FRACTION of notional: the larger of the market's
 * published fee and THIS account's tier (Lighter fee ticks, hundredths of a
 * basis point). The tier applies even where the market fee reads 0: a Robinhood
 * Chain Premium account pays 0.035% taker there.
 */
export function exchangeFeeFraction(
  marketPercent: string,
  marketEnabled: boolean,
  accountTicks: number | null,
): number {
  const market = Number(marketPercent);
  const marketFraction = marketEnabled && Number.isFinite(market) && market > 0 ? market / 100 : 0;
  const accountFraction = accountTicks !== null && Number.isFinite(accountTicks) && accountTicks > 0
    ? accountTicks / 1_000_000
    : 0;
  return Math.max(marketFraction, accountFraction);
}

/**
 * The average price a matching order fills at when it walks `levels` (best
 * first), never past its own bound; size beyond the visible depth fills at the
 * bound.
 */
export function averageFillPrice(
  levels: readonly { readonly price: string; readonly size: string }[],
  size: number,
  bound: number,
  side: TradeSide,
): number {
  if (!(size > 0)) return bound;
  let remaining = size;
  let notional = 0;
  const reachable = levels
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0 && (side === "buy" ? level.price <= bound : level.price >= bound))
    .sort((left, right) => (side === "buy" ? left.price - right.price : right.price - left.price));
  for (const level of reachable) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    remaining -= take;
  }
  return (notional + remaining * bound) / size;
}

/**
 * What one unit of base takes out of the available balance under Lighter's own
 * post-trade check, which cancels an order as `canceled-margin-not-allowed`
 * when the account would end below initial margin at the MARK price. An order
 * that matches now also books the gap between its fill and the mark as a loss.
 * Priced a little above the main-process check in
 * `src/tools/lighter/order-margin-fit.ts` (initial margin at the larger of the
 * order's price and the mark), so a 100% ticket order clears that check.
 */
export function marginFitCostPerUnit(input: {
  readonly side: TradeSide;
  /** The order's own price: a market order's bound or the limit price. */
  readonly price: number;
  /** Where a matching order fills; null prices it at the bound. */
  readonly fill: number | null;
  readonly matchesNow: boolean;
  readonly markPrice: number | null;
  readonly initialMarginFraction: number;
  readonly feeFraction: number;
}): number {
  const imf = input.initialMarginFraction / 10_000;
  if (!input.matchesNow) return input.price * (imf + input.feeFraction);
  const mark = input.markPrice !== null && input.markPrice > 0 ? input.markPrice : null;
  if (input.side === "buy") {
    const fill = Math.min(input.fill ?? input.price, input.price);
    const gap = mark === null ? 0 : Math.max(0, fill - mark);
    return Math.max(input.price, mark ?? 0) * imf + input.price * input.feeFraction + gap;
  }
  // A sell's price is a floor: it trades at the bid or better and is margined at the mark.
  const traded = Math.max(input.fill ?? input.price, input.price);
  const gap = mark === null ? 0 : Math.max(0, mark - traded);
  return Math.max(traded, mark ?? 0) * imf + traded * input.feeFraction + gap;
}

/** Largest base size the available balance can open at this price. */
export function maxBaseSize(available: number, initialMarginFraction: number, price: number): number {
  if (price <= 0) return 0;
  return available / (initialMarginFraction / 10_000) / price;
}

/**
 * Isolated-style liquidation estimate for a fresh position: the price at which
 * the initial margin is eaten down to maintenance. Cross accounts liquidate on
 * the whole portfolio, so this is only ever labeled as an estimate.
 */
export function estimatedLiquidationPrice(entry: number, side: TradeSide, margin: TicketMargin): number | null {
  if (margin.maintenanceMarginFraction === null || entry <= 0) return null;
  const buffer = (margin.initialMarginFraction - margin.maintenanceMarginFraction) / 10_000;
  if (buffer <= 0) return null;
  const price = side === "buy" ? entry * (1 - buffer) : entry * (1 + buffer);
  return price > 0 ? price : null;
}

/* ---------------------------------------------------------------------------
 * Chat messages and the desk lane's wire form
 * ------------------------------------------------------------------------- */

function exactScope(input: {
  readonly environment: "core" | "rhc";
  readonly market: LighterTradingMarket;
  readonly draft: TradeDraft;
}): string[] {
  return [
    `environment=${input.environment}`,
    `marketId=${input.market.marketId}`,
    `marketSymbol=${input.market.symbol}`,
    `marketType=${input.market.marketType}`,
    `side=${input.draft.side}`,
    `baseAmountIn=${input.draft.baseAmount}`,
  ];
}

function draftShape(draft: TradeDraft): readonly string[] {
  switch (draft.mode) {
    case "oco":
      return [`stopLossTriggerPrice=${draft.stopLossTriggerPrice}`, `takeProfitTriggerPrice=${draft.takeProfitTriggerPrice}`];
    case "market":
      return ["orderType=market", `worstPrice=${draft.worstPrice}`, `reduceOnly=${String(draft.reduceOnly)}`];
    case "limit":
      return ["orderType=limit", `price=${draft.limitPrice}`, `timeInForce=${draft.timeInForce}`, `reduceOnly=${String(draft.reduceOnly)}`];
    case "stop-loss":
    case "take-profit":
      return [`orderType=${draft.mode}`, `triggerPrice=${draft.triggerPrice}`, `worstPrice=${draft.worstPrice}`];
    case "stop-loss-limit":
    case "take-profit-limit":
      return [`orderType=${draft.mode}`, `triggerPrice=${draft.triggerPrice}`, `price=${draft.limitPrice}`];
  }
}

/**
 * The ticket's "Ask Vex" line: a second opinion on the drafted order before
 * the trader previews it. A question, not a preparation request, so it
 * carries the draft's facts and forbids preparing anything.
 */
export function buildAskAboutDraftMessage(input: {
  readonly environment: "core" | "rhc";
  readonly market: LighterTradingMarket;
  readonly draft: TradeDraft;
}): string {
  const { draft } = input;
  const shape = draftShape(draft);
  const protection = draft.mode === "market" || draft.mode === "limit" ? draft.protection ?? null : null;
  const legs = protection === null ? [] : [
    ...(protection.stopLoss === null ? [] : [`plannedStopLossTriggerPrice=${protection.stopLoss.triggerPrice}`]),
    ...(protection.takeProfit === null ? [] : [`plannedTakeProfitTriggerPrice=${protection.takeProfit.triggerPrice}`]),
  ];
  return [
    `Before I send it, check the ${MODE_LABELS[draft.mode].toLowerCase()} I have drafted on the Lighter desk: is the entry, size, and protection sound against the current structure, liquidity, and my account risk? Separate observed facts from inference.`,
    ...exactScope(input),
    ...shape,
    ...legs,
    "Do not prepare, place, or submit anything; I will send it from the ticket myself.",
  ].join("; ");
}

/**
 * The draft as the desk lane sends it to main: the order terms only. Attached
 * protection stays on this side of the bridge; it is prepared as its own
 * order once the entry has gone through.
 */
export function toDeskOrderDraft(draft: TradeDraft): LighterDeskOrderDraft {
  switch (draft.mode) {
    case "market":
      return { mode: "market", side: draft.side, baseAmount: draft.baseAmount, worstPrice: draft.worstPrice, reduceOnly: draft.reduceOnly };
    case "limit":
      return {
        mode: "limit",
        side: draft.side,
        baseAmount: draft.baseAmount,
        limitPrice: draft.limitPrice,
        timeInForce: draft.timeInForce,
        orderExpiryOffsetMinutes: draft.orderExpiryOffsetMinutes,
        reduceOnly: draft.reduceOnly,
      };
    case "stop-loss":
    case "take-profit":
      return { mode: draft.mode, side: draft.side, baseAmount: draft.baseAmount, triggerPrice: draft.triggerPrice, worstPrice: draft.worstPrice, reduceOnly: true };
    case "stop-loss-limit":
    case "take-profit-limit":
      return {
        mode: draft.mode,
        side: draft.side,
        baseAmount: draft.baseAmount,
        triggerPrice: draft.triggerPrice,
        limitPrice: draft.limitPrice,
        timeInForce: draft.timeInForce,
        orderExpiryOffsetMinutes: draft.orderExpiryOffsetMinutes,
        reduceOnly: true,
      };
    case "oco":
      return {
        mode: "oco",
        side: draft.side,
        baseAmount: draft.baseAmount,
        stopLossTriggerPrice: draft.stopLossTriggerPrice,
        stopLossPrice: draft.stopLossPrice,
        takeProfitTriggerPrice: draft.takeProfitTriggerPrice,
        takeProfitPrice: draft.takeProfitPrice,
      };
  }
}

/**
 * The protection a filled entry asked for, as the ticket's next draft: the
 * opposite side, the entry's size, one leg or both.
 */
export function protectionPrefill(
  draft: TradeDraft,
  key: number,
  filledBaseAmount: string = draft.baseAmount,
): TradeTicketPrefill | null {
  if (draft.mode !== "market" && draft.mode !== "limit") return null;
  const protection = draft.protection ?? null;
  if (protection === null || (protection.stopLoss === null && protection.takeProfit === null)) return null;
  const base = { key, side: draft.side === "buy" ? "sell" : "buy", baseAmount: filledBaseAmount, reduceOnly: true } as const;
  if (protection.stopLoss !== null && protection.takeProfit !== null) {
    return { ...base, mode: "oco", protection };
  }
  const leg = protection.stopLoss ?? protection.takeProfit;
  if (leg === null) return null;
  return {
    ...base,
    mode: protection.stopLoss !== null ? "stop-loss" : "take-profit",
    triggerPrice: leg.triggerPrice,
    price: leg.price,
  };
}

/** What the ticket footer says after a desk card resolves. */
export type DeskOutcome = { readonly tone: "ok" | "warn" | "error"; readonly text: string };

export interface TradeTicketPrefill {
  /** Changes on every request so the same position can be prefilled twice. */
  readonly key: number;
  readonly mode: TradeOrderMode;
  readonly side: TradeSide;
  readonly baseAmount: string;
  readonly reduceOnly: boolean;
  /** Limit price for limit and trigger-limit modes; the hard execution bound for market triggers. */
  readonly price?: string;
  readonly triggerPrice?: string;
  readonly timeInForce?: LimitTimeInForce;
  readonly expiryMinutes?: number;
  /** Both legs of an OCO prefill; single-leg protection uses `triggerPrice` and `price`. */
  readonly protection?: TradeProtection;
}

export interface TradeTicketPricePick {
  readonly key: number;
  readonly price: string;
  /** A plain click loads a limit price; a shift-click loads a protection trigger. */
  readonly kind: "limit" | "trigger";
  /** A chart drag also picks the side: below the last price buys, above it sells. */
  readonly side?: TradeSide;
}
