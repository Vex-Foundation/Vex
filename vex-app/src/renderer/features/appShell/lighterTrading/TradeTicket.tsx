import { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import {
  bestBookPrice,
  type LighterOrderBookData,
} from "./OrderBook.js";

export type TradeSide = "buy" | "sell";
export type TradeOrderMode = "market" | "stop-loss" | "take-profit" | "oco";

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
      readonly mode: "stop-loss" | "take-profit";
      readonly triggerPrice: string;
      readonly worstPrice: string;
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
  "stop-loss": "Stop loss",
  "take-profit": "Take profit",
  oco: "SL + TP",
};

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

function isPositiveDecimal(value: string): boolean {
  return POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

function hardBoundLabel(side: TradeSide): string {
  return side === "buy" ? "Maximum buy price" : "Minimum sell price";
}

function submitLabel(mode: TradeOrderMode): string {
  switch (mode) {
    case "market": return "Review market order";
    case "stop-loss": return "Review stop loss";
    case "take-profit": return "Review take profit";
    case "oco": return "Review SL + TP protection";
  }
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
  const [triggerPrice, setTriggerPrice] = useState("");
  const [stopLossTriggerPrice, setStopLossTriggerPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [takeProfitTriggerPrice, setTakeProfitTriggerPrice] = useState("");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);

  const protective = mode !== "market";
  const suggestedPrice = side === "buy"
    ? bestBookPrice(book.asks, "ask")
    : bestBookPrice(book.bids, "bid");

  useEffect(() => {
    if (!priceTouched && mode === "market") setWorstPrice(suggestedPrice ?? "");
  }, [mode, priceTouched, suggestedPrice]);

  useEffect(() => {
    setMode("market");
    setSide("buy");
    setBaseAmount("");
    setWorstPrice("");
    setTriggerPrice("");
    setStopLossTriggerPrice("");
    setStopLossPrice("");
    setTakeProfitTriggerPrice("");
    setTakeProfitPrice("");
    setReduceOnly(false);
    setPriceTouched(false);
  }, [market.marketId]);

  useEffect(() => {
    if (market.marketType === "spot" && mode !== "market") setMode("market");
  }, [market.marketType, mode]);

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
    if (!isPositiveDecimal(worstPrice)) return `Enter a valid ${hardBoundLabel(side).toLowerCase()}.`;
    return null;
  }, [
    baseAmount,
    dataFresh,
    market.marketType,
    market.status,
    mode,
    protective,
    side,
    stopLossPrice,
    stopLossTriggerPrice,
    takeProfitPrice,
    takeProfitTriggerPrice,
    triggerPrice,
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
            const unavailable = market.marketType !== "perp" && item !== "market";
            return (
              <button
                type="button"
                key={item}
                aria-pressed={mode === item}
                disabled={unavailable}
                title={unavailable ? "Perpetual markets only" : undefined}
                onClick={() => setMode(item)}
              >
                {MODE_LABELS[item]}
              </button>
            );
          })}
        </div>

        {market.marketType === "spot" ? (
          <p className="lit-ticket-context">Spot supports Market IOC here. Position protection requires a perpetual market.</p>
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
              worstPrice={stopLossPrice}
              onTriggerPriceChange={setStopLossTriggerPrice}
              onWorstPriceChange={setStopLossPrice}
            />
            <ProtectionLeg
              label="Take profit"
              side={side}
              triggerPrice={takeProfitTriggerPrice}
              worstPrice={takeProfitPrice}
              onTriggerPriceChange={setTakeProfitTriggerPrice}
              onWorstPriceChange={setTakeProfitPrice}
            />
          </>
        ) : mode === "stop-loss" || mode === "take-profit" ? (
          <ProtectionLeg
            label={MODE_LABELS[mode]}
            side={side}
            triggerPrice={triggerPrice}
            worstPrice={worstPrice}
            onTriggerPriceChange={setTriggerPrice}
            onWorstPriceChange={(value) => {
              setPriceTouched(true);
              setWorstPrice(value);
            }}
          />
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

        {mode === "market" ? (
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
          <div><dt>Time in force</dt><dd>Immediate or cancel</dd></div>
          <div><dt>Preview expiry</dt><dd>{protective ? "24 hours" : "30 minutes"}</dd></div>
          <div><dt>Market type</dt><dd>{market.marketType === "perp" ? "Perpetual" : "Spot"}</dd></div>
          <div><dt>Execution</dt><dd>{mode === "oco" ? "Native OCO" : protective ? "Reduce only" : "Approval gated"}</dd></div>
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
  worstPrice,
  onTriggerPriceChange,
  onWorstPriceChange,
}: {
  readonly label: string;
  readonly side: TradeSide;
  readonly triggerPrice: string;
  readonly worstPrice: string;
  readonly onTriggerPriceChange: (value: string) => void;
  readonly onWorstPriceChange: (value: string) => void;
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
          <span>{hardBoundLabel(side)}</span>
          <span className="lit-input-shell">
            <input
              value={worstPrice}
              onChange={(event) => onWorstPriceChange(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${label} ${hardBoundLabel(side).toLowerCase()}`}
              aria-describedby={`${id}-bound-note`}
            />
            <b>Quote</b>
          </span>
        </label>
      </div>
      <small id={`${id}-bound-note`}>Hard execution bound after the trigger fires.</small>
    </fieldset>
  );
}
