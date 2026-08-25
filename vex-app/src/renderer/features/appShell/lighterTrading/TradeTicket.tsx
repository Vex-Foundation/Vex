import { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import type {
  LighterTradingMarket,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { bestBookPrice } from "./OrderBook.js";

export type TradeSide = "buy" | "sell";

const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface TradeDraft {
  readonly side: TradeSide;
  readonly baseAmount: string;
  readonly worstPrice: string;
  readonly reduceOnly: boolean;
}

export function buildLighterReviewMessage(input: {
  readonly environment: "core" | "rhc";
  readonly market: LighterTradingMarket;
  readonly draft: TradeDraft;
}): string {
  return [
    "Review this exact Lighter trade as a preview only. Do not place or submit it.",
    `environment=${input.environment}`,
    `marketId=${input.market.marketId}`,
    `marketSymbol=${input.market.symbol}`,
    `side=${input.draft.side}`,
    `baseAmountIn=${input.draft.baseAmount}`,
    `price=${input.draft.worstPrice}`,
    "orderType=market",
    "timeInForce=immediate-or-cancel",
    `reduceOnly=${String(input.draft.reduceOnly)}`,
    "orderExpiryOffsetMinutes=30",
    "After the live preview, display the approval card directly. Nothing may execute without the user's explicit approval on that card.",
  ].join("; ");
}

export function TradeTicket({
  market,
  snapshot,
  activeSession,
  dataFresh,
  submitting,
  onReview,
}: {
  readonly market: LighterTradingMarket;
  readonly snapshot: LighterTradingSnapshot;
  readonly activeSession: boolean;
  readonly dataFresh: boolean;
  readonly submitting: boolean;
  readonly onReview: (draft: TradeDraft) => void;
}): JSX.Element {
  const [side, setSide] = useState<TradeSide>("buy");
  const [baseAmount, setBaseAmount] = useState("");
  const [worstPrice, setWorstPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);

  const suggestedPrice = side === "buy"
    ? bestBookPrice(snapshot.book.asks, "ask")
    : bestBookPrice(snapshot.book.bids, "bid");

  useEffect(() => {
    if (!priceTouched) setWorstPrice(suggestedPrice ?? "");
  }, [priceTouched, suggestedPrice]);

  useEffect(() => {
    setBaseAmount("");
    setReduceOnly(false);
    setPriceTouched(false);
  }, [market.marketId]);

  useEffect(() => {
    setPriceTouched(false);
  }, [side]);

  const validation = useMemo(() => {
    if (!activeSession) return "Open a session to review this order.";
    if (!dataFresh) return "Live market data is delayed. Wait for a fresh snapshot before review.";
    if (market.status !== "active") return "This market is inactive.";
    if (!POSITIVE_DECIMAL.test(baseAmount) || Number(baseAmount) <= 0) {
      return "Enter an exact base size greater than zero.";
    }
    if (!POSITIVE_DECIMAL.test(worstPrice) || Number(worstPrice) <= 0) {
      return `Enter a valid ${side === "buy" ? "maximum buy" : "minimum sell"} price.`;
    }
    return null;
  }, [activeSession, baseAmount, dataFresh, market.status, side, worstPrice]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (validation !== null || submitting) return;
    onReview({ side, baseAmount, worstPrice, reduceOnly });
  };

  return (
    <section className="lit-panel lit-ticket" aria-labelledby="lit-ticket-title">
      <header className="lit-panel-header">
        <h3 id="lit-ticket-title">Market IOC</h3>
        <span>Approval gated</span>
      </header>
      <form onSubmit={onSubmit} className="lit-ticket-form">
        <div className="lit-side-switch" aria-label="Order side">
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
              aria-describedby="lit-size-note"
            />
            <b>{market.symbol}</b>
          </span>
          <small id="lit-size-note">Minimum {market.minBaseAmount}</small>
        </label>

        <label className="lit-field">
          <span>{side === "buy" ? "Maximum buy price" : "Minimum sell price"}</span>
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

        <dl className="lit-ticket-facts">
          <div><dt>Time in force</dt><dd>Immediate or cancel</dd></div>
          <div><dt>Preview expiry</dt><dd>30 minutes</dd></div>
          <div><dt>Market type</dt><dd>{market.marketType === "perp" ? "Perpetual" : "Spot"}</dd></div>
          <div><dt>Taker fee</dt><dd>{market.fees.taker}</dd></div>
        </dl>

        <div className="lit-review-note" role="note">
          Review creates a live-data preview in chat. It does not sign, submit, or execute an order.
        </div>
        {validation !== null ? <p className="lit-validation" role="status">{validation}</p> : null}
        <button className="lit-review-button" type="submit" disabled={validation !== null || submitting}>
          {submitting ? "Opening review…" : "Review order"}
        </button>
      </form>
    </section>
  );
}
