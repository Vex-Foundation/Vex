import { useEffect, useMemo, useState } from "react";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { bestBookPrice, type LighterOrderBookData } from "./book-model.js";
import { compareDecimalStrings, isPositiveDecimal, toDecimal } from "./decimal.js";
import { formatDecimalString, marketSymbols } from "./format.js";
import {
  DEFAULT_LIMIT_TIME_IN_FORCE,
  DEFAULT_ORDER_EXPIRY_MINUTES,
  DEFAULT_RISK_PERCENT,
  DEFAULT_SLIPPAGE_PERCENT,
  IOC_PREVIEW_EXPIRY_MINUTES,
  PROTECTION_BOUND_PERCENT,
  SIZE_DECIMALS_FALLBACK,
  estimatedLiquidationPrice,
  hardBoundLabel,
  isPositionProtectionMode,
  isTriggerLimitMode,
  marginCost,
  maxBaseSize,
  riskBaseSize,
  slippageBound,
  type LimitTimeInForce,
  type TicketMargin,
  type TradeDraft,
  type TradeOrderMode,
  type TradeProtection,
  type TradeSide,
  type TradeTicketPrefill,
  type TradeTicketPricePick,
} from "./ticket-model.js";

export type SizeMode = "qty" | "risk";

export interface TradeTicketFormInput {
  readonly market: LighterTradingMarket;
  readonly book: LighterOrderBookData;
  readonly lastPrice: number | null;
  readonly available: string | null;
  /** Account equity (collateral plus open PnL) that Risk mode sizes against; null without an account. */
  readonly equity: number | null;
  readonly margin: TicketMargin | null;
  readonly dataFresh: boolean;
  readonly prefill?: TradeTicketPrefill | null;
  readonly pricePick?: TradeTicketPricePick | null;
}

/**
 * Every input, derived number and validation the order ticket shows. The
 * component only lays this out; nothing here talks to the agent.
 */
export function useTradeTicketForm({
  market,
  book,
  lastPrice,
  available,
  equity,
  margin,
  dataFresh,
  prefill,
  pricePick,
}: TradeTicketFormInput) {
  const [mode, setMode] = useState<TradeOrderMode>("market");
  const [side, setSide] = useState<TradeSide>("buy");
  const [sizeUnit, setSizeUnit] = useState<"base" | "quote">("base");
  const [sizeInput, setSizeInput] = useState("");
  const [sizePercent, setSizePercent] = useState<number | null>(null);
  const [sizeMode, setSizeMode] = useState<SizeMode>("qty");
  const [riskPercent, setRiskPercent] = useState(DEFAULT_RISK_PERCENT);
  const [slippagePercent, setSlippagePercent] = useState(DEFAULT_SLIPPAGE_PERCENT);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitTimeInForce, setLimitTimeInForce] = useState<LimitTimeInForce>(DEFAULT_LIMIT_TIME_IN_FORCE);
  const [orderExpiryOffsetMinutes, setOrderExpiryOffsetMinutes] = useState(DEFAULT_ORDER_EXPIRY_MINUTES);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [triggerBound, setTriggerBound] = useState("");
  const [stopLossTriggerPrice, setStopLossTriggerPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [takeProfitTriggerPrice, setTakeProfitTriggerPrice] = useState("");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [protectOpen, setProtectOpen] = useState(false);

  const protective = isPositionProtectionMode(mode);
  const triggerLimit = isTriggerLimitMode(mode);
  const perp = market.marketType === "perp";
  const symbols = marketSymbols(market.symbol, market.marketType);
  const sizeDecimals = market.decimals.size ?? SIZE_DECIMALS_FALLBACK;
  const priceDecimals = market.decimals.price;
  const suggestedPrice = side === "buy"
    ? bestBookPrice(book.asks, "ask")
    : bestBookPrice(book.bids, "bid");
  const referencePrice = useMemo(() => {
    const fromBook = suggestedPrice === null ? Number.NaN : Number(suggestedPrice);
    if (Number.isFinite(fromBook) && fromBook > 0) return fromBook;
    return lastPrice !== null && lastPrice > 0 ? lastPrice : null;
  }, [lastPrice, suggestedPrice]);
  const availableNumber = available === null ? null : Number(available);
  const canSizeFromBalance = availableNumber !== null
    && Number.isFinite(availableNumber)
    && availableNumber > 0
    && referencePrice !== null;

  // Risk mode is for opening perp orders whose stop-loss can be attached.
  const canSizeByRisk = perp && !protective && (mode === "market" || mode === "limit");
  const riskMode = canSizeByRisk && sizeMode === "risk";
  /** Risk mode: the size that loses `riskPercent` of equity at the stop, or why there is none yet. */
  const riskSizing = useMemo((): { readonly baseAmount: string; readonly riskAmount: number } | { readonly reason: string } => {
    if (equity === null || !(equity > 0)) return { reason: "Connect Lighter to size by risk." };
    if (!isPositiveDecimal(riskPercent)) return { reason: "Enter the percent of equity to risk." };
    if (!protectOpen || !isPositiveDecimal(stopLossTriggerPrice)) return { reason: "Enter a stop-loss trigger first." };
    const entry = mode === "limit" ? (isPositiveDecimal(limitPrice) ? Number(limitPrice) : null) : referencePrice;
    if (entry === null) return { reason: mode === "limit" ? "Enter a limit price first." : "A live price is required to size by risk." };
    const size = riskBaseSize(equity, Number(riskPercent), entry, Number(stopLossTriggerPrice));
    // Floor to the size step: rounding up would risk more than asked.
    const step = 10 ** sizeDecimals;
    const amount = size === null ? null : toDecimal(Math.floor(size * step) / step, sizeDecimals);
    if (amount === null || !isPositiveDecimal(amount)) return { reason: "The stop-loss trigger must sit away from the entry price." };
    return { baseAmount: amount, riskAmount: (equity * Number(riskPercent)) / 100 };
  }, [equity, limitPrice, mode, protectOpen, referencePrice, riskPercent, sizeDecimals, stopLossTriggerPrice]);

  const baseAmount = useMemo(() => {
    if (riskMode) return "baseAmount" in riskSizing ? riskSizing.baseAmount : "";
    if (sizeUnit === "base") return sizeInput;
    if (!isPositiveDecimal(sizeInput) || referencePrice === null) return "";
    return toDecimal(Number(sizeInput) / referencePrice, sizeDecimals) ?? "";
  }, [referencePrice, riskMode, riskSizing, sizeDecimals, sizeInput, sizeUnit]);
  const worstPrice = useMemo(
    () => slippageBound(suggestedPrice, slippagePercent, side, priceDecimals),
    [priceDecimals, side, slippagePercent, suggestedPrice],
  );

  const limitPriceBookStatus = useMemo(() => {
    if (mode !== "limit" || suggestedPrice === null) return null;
    const comparison = compareDecimalStrings(limitPrice, suggestedPrice);
    if (comparison === null) return null;
    const marketable = side === "buy" ? comparison >= 0 : comparison <= 0;
    return marketable ? "marketable" : "resting";
  }, [limitPrice, mode, side, suggestedPrice]);
  const limitPriceGuidance = useMemo(() => {
    if (limitPriceBookStatus === null || suggestedPrice === null) {
      return "Exact price you are willing to trade at.";
    }
    const marketContext = `Best ${side === "buy" ? "ask" : "bid"} ${formatDecimalString(suggestedPrice)}:`;
    if (limitPriceBookStatus === "resting") {
      return limitTimeInForce === "immediate-or-cancel"
        ? `${marketContext} not marketable, IOC would cancel.`
        : `${marketContext} rests until the market reaches it.`;
    }
    if (limitTimeInForce === "post-only") {
      return `${marketContext} this price crosses the book, so Post-Only cannot be reviewed.`;
    }
    return `${marketContext} fills immediately${limitTimeInForce === "immediate-or-cancel" ? ", remainder cancels." : ", remainder stays open."}`;
  }, [limitPriceBookStatus, limitTimeInForce, side, suggestedPrice]);

  const selectMode = (nextMode: TradeOrderMode): void => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setLimitTimeInForce(DEFAULT_LIMIT_TIME_IN_FORCE);
  };

  /** Max openable size: leveraged for perps, plain quote balance for spot. */
  const maxSize = useMemo(() => {
    if (!canSizeFromBalance || availableNumber === null || referencePrice === null) return null;
    const size = margin === null
      ? availableNumber / referencePrice
      : maxBaseSize(availableNumber, margin.initialMarginFraction, referencePrice);
    return toDecimal(size, sizeDecimals);
  }, [availableNumber, canSizeFromBalance, margin, referencePrice, sizeDecimals]);

  const applySizePercent = (percent: number): void => {
    if (maxSize === null || referencePrice === null) return;
    setSizePercent(percent);
    if (percent === 0) { setSizeInput(""); return; }
    const base = (Number(maxSize) * percent) / 100;
    setSizeInput(sizeUnit === "quote"
      ? toDecimal(base * referencePrice, 2) ?? ""
      : toDecimal(base, sizeDecimals) ?? "");
  };

  const editSize = (value: string): void => {
    setSizeInput(value);
    setSizePercent(null);
  };

  /** Risk needs a stop to size against, so choosing it opens the TP/SL section. */
  const selectSizeMode = (next: SizeMode): void => {
    if (next === sizeMode) return;
    setSizeMode(next);
    setSizeInput("");
    setSizePercent(null);
    if (next === "risk") setProtectOpen(true);
  };

  const toggleSizeUnit = (): void => {
    setSizeUnit((current) => (current === "base" ? "quote" : "base"));
    setSizeInput("");
    setSizePercent(null);
  };

  useEffect(() => {
    setMode("market");
    setSide("buy");
    setSizeInput("");
    setSizePercent(null);
    setLimitPrice("");
    setLimitTimeInForce(DEFAULT_LIMIT_TIME_IN_FORCE);
    setOrderExpiryOffsetMinutes(DEFAULT_ORDER_EXPIRY_MINUTES);
    setTriggerPrice("");
    setTriggerBound("");
    setStopLossTriggerPrice("");
    setStopLossPrice("");
    setTakeProfitTriggerPrice("");
    setTakeProfitPrice("");
    setReduceOnly(false);
    setProtectOpen(false);
  }, [market.marketId]);

  useEffect(() => {
    if (market.marketType === "spot" && protective) setMode("market");
  }, [market.marketType, protective]);

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    setMode(prefill.mode);
    setSide(prefill.side);
    setSizeUnit("base");
    setSizeMode("qty");
    setSizeInput(prefill.baseAmount);
    setSizePercent(null);
    setReduceOnly(prefill.reduceOnly);
    if (prefill.price !== undefined) {
      if (prefill.mode === "limit" || isTriggerLimitMode(prefill.mode)) setLimitPrice(prefill.price);
      else setTriggerBound(prefill.price);
    }
    if (prefill.triggerPrice !== undefined) setTriggerPrice(prefill.triggerPrice);
    if (prefill.timeInForce !== undefined) setLimitTimeInForce(prefill.timeInForce);
    if (prefill.expiryMinutes !== undefined) setOrderExpiryOffsetMinutes(prefill.expiryMinutes);
    if (prefill.protection !== undefined) {
      setStopLossTriggerPrice(prefill.protection.stopLoss?.triggerPrice ?? "");
      setStopLossPrice(prefill.protection.stopLoss?.price ?? "");
      setTakeProfitTriggerPrice(prefill.protection.takeProfit?.triggerPrice ?? "");
      setTakeProfitPrice(prefill.protection.takeProfit?.price ?? "");
    }
  }, [prefill]);

  useEffect(() => {
    if (pricePick === null || pricePick === undefined) return;
    if (pricePick.side !== undefined) setSide(pricePick.side);
    if (pricePick.kind === "limit") {
      setMode("limit");
      setLimitTimeInForce(DEFAULT_LIMIT_TIME_IN_FORCE);
      setLimitPrice(pricePick.price);
      return;
    }
    // The pick's own scope is what it lands on: the ticket reads its state at
    // pick time, so the effect only depends on the pick.
    setProtectFromPick(pricePick.price);
  }, [pricePick]);

  function setProtectFromPick(price: string): void {
    if (!perp) return;
    if (mode === "stop-loss" || mode === "take-profit" || triggerLimit) {
      setTriggerPrice(price);
      return;
    }
    // Which leg a trigger belongs to follows from where it sits against the
    // entry: a long's stop sits below, its take profit above; shorts invert.
    const entry = referencePrice;
    const exposureLong = mode === "oco" ? side === "sell" : side === "buy";
    const below = entry !== null && Number(price) < entry;
    const isStop = exposureLong ? below : !below;
    if (mode !== "oco") setProtectOpen(true);
    if (isStop) setStopLossTriggerPrice(price);
    else setTakeProfitTriggerPrice(price);
  }

  const activePrice = mode === "limit" || triggerLimit
    ? limitPrice
    : mode === "stop-loss" || mode === "take-profit"
      ? triggerPrice
      : null;
  const valuationPrice = activePrice !== null && isPositiveDecimal(activePrice)
    ? Number(activePrice)
    : referencePrice;
  const orderValue = isPositiveDecimal(baseAmount) && valuationPrice !== null
    ? Number(baseAmount) * valuationPrice
    : null;
  const feeRate = (mode === "limit" || triggerLimit) && limitTimeInForce === "post-only"
    ? { rate: market.fees.maker, enabled: market.fees.makerEnabled, label: "Maker" }
    : { rate: market.fees.taker, enabled: market.fees.takerEnabled, label: "Taker" };
  const estimatedFee = orderValue !== null && feeRate.enabled && Number.isFinite(Number(feeRate.rate))
    ? (orderValue * Number(feeRate.rate)) / 100
    : null;
  const cost = orderValue !== null && margin !== null ? marginCost(orderValue, margin.initialMarginFraction) : null;
  const liquidationEstimate = margin !== null && valuationPrice !== null && !protective
    ? estimatedLiquidationPrice(valuationPrice, side, margin)
    : null;

  // Attached protection: the close side is opposite the entry; bounds sit 1% past each trigger.
  const protectionActive = perp && !protective && protectOpen
    && (stopLossTriggerPrice.length > 0 || takeProfitTriggerPrice.length > 0);
  const closeSide: TradeSide = side === "buy" ? "sell" : "buy";
  const protection = useMemo<TradeProtection | null>(() => {
    if (!protectionActive) return null;
    const leg = (trigger: string) => {
      if (!isPositiveDecimal(trigger)) return null;
      const price = slippageBound(trigger, PROTECTION_BOUND_PERCENT, closeSide, priceDecimals);
      return price === null ? null : { triggerPrice: trigger, price };
    };
    return { stopLoss: leg(stopLossTriggerPrice), takeProfit: leg(takeProfitTriggerPrice) };
  }, [closeSide, priceDecimals, protectionActive, stopLossTriggerPrice, takeProfitTriggerPrice]);

  const protectionValidation = useMemo(() => {
    if (!protectionActive || valuationPrice === null) return null;
    const long = side === "buy";
    if (stopLossTriggerPrice.length > 0) {
      if (!isPositiveDecimal(stopLossTriggerPrice)) return "Enter a valid stop-loss trigger price.";
      const stop = Number(stopLossTriggerPrice);
      if (long ? stop >= valuationPrice : stop <= valuationPrice) {
        return `Stop-loss trigger must be ${long ? "below" : "above"} the entry price.`;
      }
    }
    if (takeProfitTriggerPrice.length > 0) {
      if (!isPositiveDecimal(takeProfitTriggerPrice)) return "Enter a valid take-profit trigger price.";
      const target = Number(takeProfitTriggerPrice);
      if (long ? target <= valuationPrice : target >= valuationPrice) {
        return `Take-profit trigger must be ${long ? "above" : "below"} the entry price.`;
      }
    }
    return null;
  }, [protectionActive, side, stopLossTriggerPrice, takeProfitTriggerPrice, valuationPrice]);

  const validation = useMemo(() => {
    if (!dataFresh) return "Live market data is delayed. Wait for a fresh snapshot before review.";
    if (market.status !== "active") return "This market is inactive.";
    if (protective && !perp) return "Position protection is available only for perpetual markets.";
    if (!isPositiveDecimal(baseAmount)) {
      if (riskMode) return "reason" in riskSizing ? riskSizing.reason : "Enter a size greater than zero.";
      return sizeUnit === "quote" && isPositiveDecimal(sizeInput)
        ? "A live price is required to convert the quote size."
        : "Enter a size greater than zero.";
    }
    if ((compareDecimalStrings(baseAmount, market.minBaseAmount) ?? 0) < 0) {
      return `Minimum size is ${market.minBaseAmount} ${symbols.base}.`;
    }
    if (mode === "oco") {
      if (![stopLossTriggerPrice, stopLossPrice, takeProfitTriggerPrice, takeProfitPrice].every(isPositiveDecimal)) {
        return "Enter all four stop-loss and take-profit prices.";
      }
      return null;
    }
    if (mode === "stop-loss" || mode === "take-profit") {
      if (!isPositiveDecimal(triggerPrice)) return "Enter an exact trigger price.";
      if (!isPositiveDecimal(triggerBound)) return `Enter a valid ${hardBoundLabel(side).toLowerCase()}.`;
      return null;
    }
    if (triggerLimit) {
      if (!isPositiveDecimal(triggerPrice)) return "Enter an exact trigger price.";
      if (!isPositiveDecimal(limitPrice)) return "Enter a valid limit price.";
      return null;
    }
    if (mode === "limit") {
      if (!isPositiveDecimal(limitPrice)) return "Enter a valid limit price.";
      if (limitTimeInForce === "post-only") {
        const comparison = suggestedPrice === null ? null : compareDecimalStrings(limitPrice, suggestedPrice);
        if (comparison === null) return "A fresh opposite-side price is required for maker-only review.";
        const crosses = side === "buy" ? comparison >= 0 : comparison <= 0;
        if (crosses) return `Maker-only ${side} price must stay ${side === "buy" ? "below the best ask" : "above the best bid"}.`;
      }
      return protectionValidation;
    }
    if (worstPrice === null) return "A live inside price is required to bound a market order.";
    return protectionValidation;
  }, [
    baseAmount,
    dataFresh,
    limitPrice,
    limitTimeInForce,
    market.minBaseAmount,
    market.status,
    mode,
    perp,
    protective,
    protectionValidation,
    riskMode,
    riskSizing,
    side,
    sizeInput,
    sizeUnit,
    stopLossPrice,
    stopLossTriggerPrice,
    suggestedPrice,
    symbols.base,
    takeProfitPrice,
    takeProfitTriggerPrice,
    triggerBound,
    triggerLimit,
    triggerPrice,
    worstPrice,
  ]);

  const buildDraft = (): TradeDraft | null => {
    if (validation !== null) return null;
    if (mode === "oco") {
      return { mode, side, baseAmount, stopLossTriggerPrice, stopLossPrice, takeProfitTriggerPrice, takeProfitPrice };
    }
    if (mode === "stop-loss" || mode === "take-profit") {
      return { mode, side, baseAmount, triggerPrice, worstPrice: triggerBound, reduceOnly: true };
    }
    if (triggerLimit) {
      return { mode, side, baseAmount, triggerPrice, limitPrice, timeInForce: limitTimeInForce, orderExpiryOffsetMinutes, reduceOnly: true };
    }
    if (mode === "limit") {
      return {
        mode,
        side,
        baseAmount,
        limitPrice,
        timeInForce: limitTimeInForce,
        orderExpiryOffsetMinutes: limitTimeInForce === "immediate-or-cancel"
          ? IOC_PREVIEW_EXPIRY_MINUTES
          : orderExpiryOffsetMinutes,
        reduceOnly,
        protection,
      };
    }
    if (worstPrice === null) return null;
    return { mode, side, baseAmount, worstPrice, reduceOnly, protection };
  };

  return {
    mode, selectMode,
    side, setSide,
    sizeUnit, toggleSizeUnit,
    sizeInput, editSize,
    sizePercent, applySizePercent, canSizeFromBalance,
    sizeMode, selectSizeMode, canSizeByRisk, riskMode, riskPercent, setRiskPercent, riskSizing,
    slippagePercent, setSlippagePercent,
    limitPrice, setLimitPrice,
    limitTimeInForce, setLimitTimeInForce,
    orderExpiryOffsetMinutes, setOrderExpiryOffsetMinutes,
    triggerPrice, setTriggerPrice,
    triggerBound, setTriggerBound,
    stopLossTriggerPrice, setStopLossTriggerPrice,
    stopLossPrice, setStopLossPrice,
    takeProfitTriggerPrice, setTakeProfitTriggerPrice,
    takeProfitPrice, setTakeProfitPrice,
    reduceOnly, setReduceOnly,
    protectOpen, setProtectOpen,
    protective, triggerLimit, perp, symbols,
    suggestedPrice, referencePrice, baseAmount, worstPrice,
    limitPriceBookStatus, limitPriceGuidance,
    maxSize, orderValue, feeRate, estimatedFee, cost, liquidationEstimate,
    protection, closeSide,
    validation, buildDraft,
  };
}

export type TradeTicketForm = ReturnType<typeof useTradeTicketForm>;
