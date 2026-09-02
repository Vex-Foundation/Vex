import { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import {
  bestBookPrice,
  type LighterOrderBookData,
} from "./OrderBook.js";

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

const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

interface TradeDraftBase {
  readonly side: TradeSide;
  readonly baseAmount: string;
}

export type TradeDraft =
  | (TradeDraftBase & {
      readonly mode: "market";
      readonly worstPrice: string;
      readonly reduceOnly: boolean;
    })
  | (TradeDraftBase & {
      readonly mode: "limit";
      readonly limitPrice: string;
      readonly timeInForce: LimitTimeInForce;
      readonly orderExpiryOffsetMinutes: number;
      readonly reduceOnly: boolean;
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

const MODE_LABELS: Readonly<Record<TradeOrderMode, string>> = {
  market: "Market",
  limit: "Limit",
  "stop-loss": "Stop loss",
  "stop-loss-limit": "Stop-loss limit",
  "take-profit": "Take profit",
  "take-profit-limit": "Take-profit limit",
  oco: "SL + TP",
};

const LIMIT_TIME_IN_FORCE_LABELS: Readonly<Record<LimitTimeInForce, string>> = {
  "immediate-or-cancel": "Immediate only",
  "good-till-time": "Keep open",
  "post-only": "Maker only",
};

const ORDER_EXPIRY_OPTIONS = [
  { minutes: 10, label: "10 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1_440, label: "1 day" },
  { minutes: 10_080, label: "7 days" },
  { minutes: 43_200, label: "30 days" },
] as const;

const DEFAULT_ORDER_EXPIRY_MINUTES = 1_440;
const IOC_PREVIEW_EXPIRY_MINUTES = 30;
const DEFAULT_LIMIT_TIME_IN_FORCE: LimitTimeInForce = "good-till-time";

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

export function buildLighterReviewMessage(input: {
  readonly environment: "core" | "rhc";
  readonly market: LighterTradingMarket;
  readonly draft: TradeDraft;
}): string {
  const common = exactScope(input);
  if (input.draft.mode === "oco") {
    return [
      "Review this exact native Lighter stop-loss plus take-profit protection as a preview only. Do not place or submit it.",
      ...common,
      `stopLossTriggerPrice=${input.draft.stopLossTriggerPrice}`,
      `stopLossPrice=${input.draft.stopLossPrice}`,
      `takeProfitTriggerPrice=${input.draft.takeProfitTriggerPrice}`,
      `takeProfitPrice=${input.draft.takeProfitPrice}`,
      "orderExpiryOffsetMinutes=1440",
      "Prepare exactly one native OCO group with two same-size reduce-only children and display one approval card directly.",
      "Nothing may execute without the user's explicit approval on that card.",
    ].join("; ");
  }
  if (input.draft.mode === "limit") {
    const tifInstruction = input.draft.timeInForce === "immediate-or-cancel"
      ? "Order behavior is Immediate only. Any amount that cannot fill immediately at the approved limit price must cancel; do not turn it into a resting order."
      : input.draft.timeInForce === "post-only"
        ? "Order behavior is Maker only. Keep provider-native post-only semantics; do not silently change this to good-till-time or immediate-or-cancel."
        : "Order behavior is Keep open. Keep the order active only until its exact approved expiry unless it fills or is canceled first.";
    return [
      "Review this exact plain Lighter limit order as a preview only. Do not place or submit it.",
      ...common,
      `price=${input.draft.limitPrice}`,
      "orderType=limit",
      `timeInForce=${input.draft.timeInForce}`,
      `reduceOnly=${String(input.draft.reduceOnly)}`,
      `orderExpiryOffsetMinutes=${input.draft.orderExpiryOffsetMinutes}`,
      tifInstruction,
      "Treat price as the exact limit price, not a market-order execution bound.",
      "After the live preview, display the approval card directly. Nothing may execute without the user's explicit approval on that card.",
    ].join("; ");
  }
  if (input.draft.mode === "stop-loss-limit" || input.draft.mode === "take-profit-limit") {
    const tifInstruction = input.draft.timeInForce === "immediate-or-cancel"
      ? "Order behavior is Immediate only. When triggered, fill immediately at the exact limit price and cancel any remainder; keep the positive trigger-order expiry."
      : input.draft.timeInForce === "post-only"
        ? "Order behavior is Maker only. When triggered, keep provider-native post-only semantics; do not judge the dormant order against the current book."
        : "Order behavior is Keep open. When triggered, keep the limit active only until its exact approved expiry unless it fills or is canceled first.";
    return [
      `Review this exact native Lighter ${input.draft.mode} as a preview only. Do not place or submit it.`,
      ...common,
      `price=${input.draft.limitPrice}`,
      `triggerPrice=${input.draft.triggerPrice}`,
      `orderType=${input.draft.mode}`,
      `timeInForce=${input.draft.timeInForce}`,
      "reduceOnly=true",
      `orderExpiryOffsetMinutes=${input.draft.orderExpiryOffsetMinutes}`,
      tifInstruction,
      "Treat price as the exact limit price that becomes active after the trigger, not a market-style worst execution bound.",
      "After the live preview, display the approval card directly. Nothing may execute without the user's explicit approval on that card.",
    ].join("; ");
  }
  if (input.draft.mode === "stop-loss" || input.draft.mode === "take-profit") {
    return [
      `Review this exact Lighter ${MODE_LABELS[input.draft.mode].toLowerCase()} as a preview only. Do not place or submit it.`,
      ...common,
      `price=${input.draft.worstPrice}`,
      `triggerPrice=${input.draft.triggerPrice}`,
      `orderType=${input.draft.mode}`,
      "timeInForce=immediate-or-cancel",
      "reduceOnly=true",
      "orderExpiryOffsetMinutes=1440",
      "After the live preview, display the approval card directly. Nothing may execute without the user's explicit approval on that card.",
    ].join("; ");
  }
  if (input.draft.mode === "market") {
    return [
      "Review this exact Lighter trade as a preview only. Do not place or submit it.",
      ...common,
      `price=${input.draft.worstPrice}`,
      "orderType=market",
      "timeInForce=immediate-or-cancel",
      `reduceOnly=${String(input.draft.reduceOnly)}`,
      "orderExpiryOffsetMinutes=30",
      "After the live preview, display the approval card directly. Nothing may execute without the user's explicit approval on that card.",
    ].join("; ");
  }
  throw new Error("Unsupported Lighter trade draft mode.");
}

function isPositiveDecimal(value: string): boolean {
  return POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

function hardBoundLabel(side: TradeSide): string {
  return side === "buy" ? "Maximum buy price" : "Minimum sell price";
}

function submitLabel(mode: TradeOrderMode): string {
  switch (mode) {
    case "market": return "Review market order";
    case "limit": return "Review limit order";
    case "stop-loss": return "Review stop loss";
    case "stop-loss-limit": return "Review stop-loss limit";
    case "take-profit": return "Review take profit";
    case "take-profit-limit": return "Review take-profit limit";
    case "oco": return "Review SL + TP protection";
  }
}

function isPositionProtectionMode(mode: TradeOrderMode): boolean {
  return mode === "stop-loss"
    || mode === "stop-loss-limit"
    || mode === "take-profit"
    || mode === "take-profit-limit"
    || mode === "oco";
}

function isTriggerLimitMode(
  mode: TradeOrderMode,
): mode is "stop-loss-limit" | "take-profit-limit" {
  return mode === "stop-loss-limit" || mode === "take-profit-limit";
}

function expiryLabel(minutes: number): string {
  return ORDER_EXPIRY_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `${minutes} minutes`;
}

function compareDecimalStrings(left: string, right: string): number | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (leftParts === null || rightParts === null) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInteger = leftParts.integer * (10n ** BigInt(scale - leftParts.scale));
  const rightInteger = rightParts.integer * (10n ** BigInt(scale - rightParts.scale));
  return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
}

function decimalParts(value: string): { readonly integer: bigint; readonly scale: number } | null {
  if (!POSITIVE_DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return {
    integer: BigInt(`${whole}${fraction}`.replace(/^0+(?=\d)/, "")),
    scale: fraction.length,
  };
}

export function TradeTicket({
  market,
  book,
  activeSession,
  dataFresh,
  submitting,
  handoffError,
  hidden,
  onReview,
}: {
  readonly market: LighterTradingMarket;
  readonly book: LighterOrderBookData;
  readonly activeSession: boolean;
  readonly dataFresh: boolean;
  readonly submitting: boolean;
  readonly handoffError?: string | null;
  readonly hidden?: boolean;
  readonly onReview: (draft: TradeDraft) => void;
}): JSX.Element {
  const [mode, setMode] = useState<TradeOrderMode>("market");
  const [side, setSide] = useState<TradeSide>("buy");
  const [baseAmount, setBaseAmount] = useState("");
  const [worstPrice, setWorstPrice] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [limitTimeInForce, setLimitTimeInForce] = useState<LimitTimeInForce | null>(null);
  const [orderExpiryOffsetMinutes, setOrderExpiryOffsetMinutes] = useState(DEFAULT_ORDER_EXPIRY_MINUTES);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [stopLossTriggerPrice, setStopLossTriggerPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [takeProfitTriggerPrice, setTakeProfitTriggerPrice] = useState("");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);

  const protective = isPositionProtectionMode(mode);
  const triggerLimit = isTriggerLimitMode(mode);
  const suggestedPrice = side === "buy"
    ? bestBookPrice(book.asks, "ask")
    : bestBookPrice(book.bids, "bid");
  const limitPriceBookStatus = useMemo(() => {
    if (mode !== "limit" || suggestedPrice === null) return null;
    const comparison = compareDecimalStrings(limitPrice, suggestedPrice);
    if (comparison === null) return null;
    const marketable = side === "buy" ? comparison >= 0 : comparison <= 0;
    return marketable ? "marketable" : "resting";
  }, [limitPrice, mode, side, suggestedPrice]);
  const limitPriceGuidance = useMemo(() => {
    if (limitPriceBookStatus === null || suggestedPrice === null) {
      return "Enter the exact price you are willing to buy or sell at.";
    }
    const oppositeSide = side === "buy" ? "ask" : "bid";
    const marketContext = `At the current best ${oppositeSide} (${suggestedPrice})`;
    if (limitPriceBookStatus === "resting") {
      if (limitTimeInForce === "immediate-or-cancel") {
        return `${marketContext}, this price is not marketable. Immediate only would cancel instead of resting.`;
      }
      if (limitTimeInForce === "post-only") {
        return `${marketContext}, this price can rest as a maker order.`;
      }
      return `${marketContext}, this price can rest until the market reaches it.`;
    }
    if (limitTimeInForce === "post-only") {
      return `${marketContext}, this price crosses the live book, so Maker only cannot be reviewed.`;
    }
    if (limitTimeInForce === "immediate-or-cancel") {
      return `${marketContext}, this price can fill immediately; any remainder cancels.`;
    }
    return `${marketContext}, this price can fill immediately; any unfilled amount stays open.`;
  }, [limitPriceBookStatus, limitTimeInForce, side, suggestedPrice]);

  const selectMode = (nextMode: TradeOrderMode): void => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setLimitTimeInForce(nextMode === "limit" ? DEFAULT_LIMIT_TIME_IN_FORCE : null);
  };

  useEffect(() => {
    if (!priceTouched && mode === "market") setWorstPrice(suggestedPrice ?? "");
  }, [mode, priceTouched, suggestedPrice]);

  useEffect(() => {
    setMode("market");
    setSide("buy");
    setBaseAmount("");
    setWorstPrice("");
    setLimitPrice("");
    setLimitTimeInForce(null);
    setOrderExpiryOffsetMinutes(DEFAULT_ORDER_EXPIRY_MINUTES);
    setTriggerPrice("");
    setStopLossTriggerPrice("");
    setStopLossPrice("");
    setTakeProfitTriggerPrice("");
    setTakeProfitPrice("");
    setReduceOnly(false);
    setPriceTouched(false);
  }, [market.marketId]);

  useEffect(() => {
    if (market.marketType === "spot" && protective) {
      setMode("market");
      setLimitTimeInForce(null);
    }
  }, [market.marketType, mode, protective]);

  useEffect(() => {
    if (mode === "market") setPriceTouched(false);
  }, [mode, side]);

  const validation = useMemo(() => {
    if (!dataFresh) return "Live market data is delayed. Wait for a fresh snapshot before review.";
    if (market.status !== "active") return "This market is inactive.";
    if (protective && market.marketType !== "perp") {
      return "Position protection is available only for perpetual markets.";
    }
    if (!isPositiveDecimal(baseAmount)) return "Enter an exact base size greater than zero.";
    if (mode === "oco") {
      if (![stopLossTriggerPrice, stopLossPrice, takeProfitTriggerPrice, takeProfitPrice].every(isPositiveDecimal)) {
        return "Enter all four stop-loss and take-profit prices.";
      }
      return null;
    }
    if (mode === "stop-loss" || mode === "take-profit") {
      if (!isPositiveDecimal(triggerPrice)) return "Enter an exact trigger price.";
      if (!isPositiveDecimal(worstPrice)) return `Enter a valid ${hardBoundLabel(side).toLowerCase()}.`;
      return null;
    }
    if (triggerLimit) {
      if (!isPositiveDecimal(triggerPrice)) return "Enter an exact trigger price.";
      if (!isPositiveDecimal(limitPrice)) return "Enter a valid limit price.";
      if (limitTimeInForce === null) return "Choose how the triggered limit should behave.";
      return null;
    }
    if (mode === "limit") {
      if (!isPositiveDecimal(limitPrice)) return "Enter a valid limit price.";
      if (limitTimeInForce === null) return "Choose how the limit order should behave.";
      if (limitTimeInForce === "post-only") {
        const comparison = suggestedPrice === null ? null : compareDecimalStrings(limitPrice, suggestedPrice);
        if (comparison === null) return "A fresh opposite-side price is required for maker-only review.";
        const crosses = side === "buy" ? comparison >= 0 : comparison <= 0;
        if (crosses) return `Maker-only ${side} price must stay ${side === "buy" ? "below the best ask" : "above the best bid"}.`;
      }
      return null;
    }
    if (!isPositiveDecimal(worstPrice)) return `Enter a valid ${hardBoundLabel(side).toLowerCase()}.`;
    return null;
  }, [
    baseAmount,
    dataFresh,
    market.marketType,
    market.status,
    mode,
    limitPrice,
    limitTimeInForce,
    protective,
    side,
    suggestedPrice,
    stopLossPrice,
    stopLossTriggerPrice,
    takeProfitPrice,
    takeProfitTriggerPrice,
    triggerPrice,
    triggerLimit,
    worstPrice,
  ]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (validation !== null || submitting) return;
    if (mode === "oco") {
      onReview({
        mode,
        side,
        baseAmount,
        stopLossTriggerPrice,
        stopLossPrice,
        takeProfitTriggerPrice,
        takeProfitPrice,
      });
      return;
    }
    if (mode === "stop-loss" || mode === "take-profit") {
      onReview({ mode, side, baseAmount, triggerPrice, worstPrice, reduceOnly: true });
      return;
    }
    if (mode === "limit") {
      if (limitTimeInForce === null) return;
      onReview({
        mode,
        side,
        baseAmount,
        limitPrice,
        timeInForce: limitTimeInForce,
        orderExpiryOffsetMinutes: limitTimeInForce === "immediate-or-cancel"
          ? IOC_PREVIEW_EXPIRY_MINUTES
          : orderExpiryOffsetMinutes,
        reduceOnly,
      });
      return;
    }
    if (triggerLimit) {
      if (limitTimeInForce === null) return;
      onReview({
        mode,
        side,
        baseAmount,
        triggerPrice,
        limitPrice,
        timeInForce: limitTimeInForce,
        orderExpiryOffsetMinutes,
        reduceOnly: true,
      });
      return;
    }
    onReview({ mode, side, baseAmount, worstPrice, reduceOnly });
  };

  return (
    <div
      className="lit-ticket"
      role="region"
      id="lit-workspace-trade-panel"
      aria-label="Trade ticket"
      hidden={hidden}
    >
      <form onSubmit={onSubmit} className="lit-ticket-form">
        <div className="lit-order-kind-tabs" role="group" aria-label="Order type">
          {(Object.keys(MODE_LABELS) as TradeOrderMode[]).map((item) => {
            const unavailable = market.marketType !== "perp" && isPositionProtectionMode(item);
            return (
              <button
                type="button"
                key={item}
                aria-pressed={mode === item}
                disabled={unavailable}
                title={unavailable ? "Perpetual markets only" : undefined}
                onClick={() => selectMode(item)}
              >
                {MODE_LABELS[item]}
              </button>
            );
          })}
        </div>

        {market.marketType === "spot" ? (
          <p className="lit-ticket-context">Spot supports Market and plain Limit orders here. Position protection requires a perpetual market.</p>
        ) : protective ? (
          <p className="lit-ticket-context">Protection is reduce only and must match a live {market.symbol} position.</p>
        ) : null}

        <div className="lit-side-switch" aria-label={protective ? "Position close side" : "Order side"}>
          <button type="button" data-active={side === "buy" || undefined} data-side="buy" onClick={() => setSide("buy")}>Buy</button>
          <button type="button" data-active={side === "sell" || undefined} data-side="sell" onClick={() => setSide("sell")}>Sell</button>
        </div>

        <label className="lit-field">
          <span>Base size</span>
          <span className="lit-input-shell">
            <input
              value={baseAmount}
              onChange={(event) => setBaseAmount(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              placeholder={market.minBaseAmount}
              aria-label="Base size"
              aria-describedby="lit-size-note"
            />
            <b>{market.symbol}</b>
          </span>
          <small id="lit-size-note">Minimum {market.minBaseAmount}</small>
        </label>

        {mode === "oco" ? (
          <>
            <ProtectionLeg
              label="Stop loss"
              side={side}
              triggerPrice={stopLossTriggerPrice}
              executionPrice={stopLossPrice}
              onTriggerPriceChange={setStopLossTriggerPrice}
              onExecutionPriceChange={setStopLossPrice}
            />
            <ProtectionLeg
              label="Take profit"
              side={side}
              triggerPrice={takeProfitTriggerPrice}
              executionPrice={takeProfitPrice}
              onTriggerPriceChange={setTakeProfitTriggerPrice}
              onExecutionPriceChange={setTakeProfitPrice}
            />
          </>
        ) : mode === "stop-loss" || mode === "take-profit" || triggerLimit ? (
          <ProtectionLeg
            label={MODE_LABELS[mode]}
            side={side}
            triggerPrice={triggerPrice}
            executionPrice={triggerLimit ? limitPrice : worstPrice}
            priceKind={triggerLimit ? "limit" : "bound"}
            onTriggerPriceChange={setTriggerPrice}
            onExecutionPriceChange={(value) => {
              if (triggerLimit) setLimitPrice(value);
              else {
                setPriceTouched(true);
                setWorstPrice(value);
              }
            }}
          />
        ) : mode === "limit" ? (
          <label className="lit-field">
            <span>Limit price</span>
            <span className="lit-input-shell">
              <input
                value={limitPrice}
                onChange={(event) => setLimitPrice(event.currentTarget.value.trim())}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Limit price"
                aria-describedby="lit-limit-price-note"
              />
              <b>Quote</b>
            </span>
            <small id="lit-limit-price-note">{limitPriceGuidance}</small>
          </label>
        ) : (
          <label className="lit-field">
            <span>{hardBoundLabel(side)}</span>
            <span className="lit-input-shell">
              <input
                value={worstPrice}
                onChange={(event) => {
                  setPriceTouched(true);
                  setWorstPrice(event.currentTarget.value.trim());
                }}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby="lit-price-note"
              />
              <b>Quote</b>
            </span>
            <small id="lit-price-note">Defaults to the live best {side === "buy" ? "ask" : "bid"}; this is a hard price bound.</small>
          </label>
        )}

        {mode === "limit" || triggerLimit ? (
          <fieldset className="lit-tif-field" aria-describedby="lit-order-behavior-note">
            <legend>Order behavior</legend>
            <div className="lit-tif-tabs">
              {(Object.keys(LIMIT_TIME_IN_FORCE_LABELS) as LimitTimeInForce[]).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={limitTimeInForce === item}
                  onClick={() => setLimitTimeInForce(item)}
                >
                  {LIMIT_TIME_IN_FORCE_LABELS[item]}
                </button>
              ))}
            </div>
            <small id="lit-order-behavior-note">
              {limitTimeInForce === null
                ? "Choose what should happen to the limit order after it is activated."
                : limitTimeInForce === "immediate-or-cancel"
                ? triggerLimit
                  ? "When triggered, fill immediately at the limit price and cancel any remainder."
                  : "Fill immediately at the limit price; cancel any remainder."
                : limitTimeInForce === "good-till-time"
                  ? triggerLimit
                    ? "When triggered, stay open until filled, canceled, or the selected expiry."
                    : "Unfilled amount stays open until filled, canceled, or the selected expiry."
                  : triggerLimit
                    ? "When triggered, add liquidity only; the current dormant price is not a crossing check."
                    : "Add liquidity only; a price crossing the live book cannot be reviewed."}
            </small>
          </fieldset>
        ) : null}

        {(mode === "limit" && limitTimeInForce !== null && limitTimeInForce !== "immediate-or-cancel") || triggerLimit ? (
          <label className="lit-field">
            <span>Order expiry</span>
            <span className="lit-select-shell">
              <select
                value={String(orderExpiryOffsetMinutes)}
                onChange={(event) => setOrderExpiryOffsetMinutes(Number(event.currentTarget.value))}
                aria-label="Order expiry"
              >
                {ORDER_EXPIRY_OPTIONS.map((option) => (
                  <option key={option.minutes} value={option.minutes}>{option.label}</option>
                ))}
              </select>
            </span>
            <small>Measured from the fresh provider-backed preview.</small>
          </label>
        ) : null}

        {mode === "market" || mode === "limit" ? (
          <label className="lit-check-row">
            <input
              type="checkbox"
              checked={reduceOnly}
              onChange={(event) => setReduceOnly(event.currentTarget.checked)}
            />
            <span>
              <b>Reduce only</b>
              <small>Accepted only when live position evidence proves reduction.</small>
            </span>
          </label>
        ) : null}

        <dl className="lit-ticket-facts">
          <div>
            <dt>Order behavior</dt>
            <dd>{mode === "limit" || triggerLimit ? limitTimeInForce === null ? "Choose" : LIMIT_TIME_IN_FORCE_LABELS[limitTimeInForce] : "Immediate only"}</dd>
          </div>
          <div>
            <dt>{protective || (mode === "limit" && limitTimeInForce !== null && limitTimeInForce !== "immediate-or-cancel") ? "Order expiry" : "Signed order expiry"}</dt>
            <dd>
              {mode === "limit"
                ? limitTimeInForce === null ? "Choose behavior" : limitTimeInForce === "immediate-or-cancel" ? "None (immediate only)" : expiryLabel(orderExpiryOffsetMinutes)
                : triggerLimit ? expiryLabel(orderExpiryOffsetMinutes) : protective ? "24 hours" : "None (immediate only)"}
            </dd>
          </div>
          <div><dt>Market type</dt><dd>{market.marketType === "perp" ? "Perpetual" : "Spot"}</dd></div>
          <div>
            <dt>Execution</dt>
            <dd>
              {mode === "oco"
                ? "Native OCO"
                : triggerLimit
                  ? limitTimeInForce === null ? "Choose behavior" : limitTimeInForce === "post-only" ? "Conditional maker only" : limitTimeInForce === "immediate-or-cancel" ? "Conditional fill or cancel" : "Native trigger limit"
                  : mode === "limit"
                    ? limitTimeInForce === null ? "Choose behavior" : limitTimeInForce === "post-only" ? "Maker only" : limitTimeInForce === "immediate-or-cancel" ? limitPriceBookStatus === "resting" ? "Would cancel now" : "Fill or cancel" : limitPriceBookStatus === "marketable" ? "Can fill now" : limitPriceBookStatus === "resting" ? "Can rest" : "May rest"
                    : protective ? "Reduce only" : "Approval gated"}
            </dd>
          </div>
        </dl>

        <div className="lit-review-note" role="note">
          {activeSession
            ? "Review in chat drafts the exact request. It does not sign or submit an order."
            : "Review opens a Vex session with the exact request. It does not sign or submit an order."}
        </div>
        {handoffError ? <p className="lit-review-error" role="alert">{handoffError}</p> : null}
        {validation !== null ? <p className="lit-validation" role="status">{validation}</p> : null}
        <button className="lit-review-button" type="submit" disabled={validation !== null || submitting}>
          {submitting ? "Opening review…" : submitLabel(mode)}
        </button>
      </form>
    </div>
  );
}

function ProtectionLeg({
  label,
  side,
  triggerPrice,
  executionPrice,
  priceKind = "bound",
  onTriggerPriceChange,
  onExecutionPriceChange,
}: {
  readonly label: string;
  readonly side: TradeSide;
  readonly triggerPrice: string;
  readonly executionPrice: string;
  readonly priceKind?: "bound" | "limit";
  readonly onTriggerPriceChange: (value: string) => void;
  readonly onExecutionPriceChange: (value: string) => void;
}): JSX.Element {
  const id = label.toLocaleLowerCase().replaceAll(" ", "-");
  return (
    <fieldset className="lit-protection-leg">
      <legend>{label}</legend>
      <div className="lit-protection-fields">
        <label className="lit-field">
          <span>Trigger price</span>
          <span className="lit-input-shell">
            <input
              value={triggerPrice}
              onChange={(event) => onTriggerPriceChange(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${label} trigger price`}
            />
            <b>Quote</b>
          </span>
        </label>
        <label className="lit-field">
          <span>{priceKind === "limit" ? "Limit price" : hardBoundLabel(side)}</span>
          <span className="lit-input-shell">
            <input
              value={executionPrice}
              onChange={(event) => onExecutionPriceChange(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${label} ${priceKind === "limit" ? "limit price" : hardBoundLabel(side).toLowerCase()}`}
              aria-describedby={`${id}-bound-note`}
            />
            <b>Quote</b>
          </span>
        </label>
      </div>
      <small id={`${id}-bound-note`}>
        {priceKind === "limit"
          ? "Provider-native limit price activated after the trigger fires."
          : "Hard execution bound after the trigger fires."}
      </small>
    </fieldset>
  );
}
