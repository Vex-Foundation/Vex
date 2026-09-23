import { useEffect, useState, type CSSProperties, type FormEvent, type JSX } from "react";
import type {
  LighterDeskPrepareProgressEvent,
  LighterOnboardingChecklist,
  LighterTradingAccountUnavailableReason,
  LighterTradingMarket,
} from "@shared/schemas/lighter-trading.js";
import { VexMark } from "../../../components/common/VexMark.js";
import type { LighterOrderBookData } from "./book-model.js";
import { isPositiveDecimal } from "./decimal.js";
import { NO_VALUE, formatDecimalString, formatNumber, formatProviderPercent } from "./format.js";
import {
  LIMIT_TIME_IN_FORCE_LABELS,
  LIMIT_TIME_IN_FORCE_NAMES,
  MODE_LABELS,
  ORDER_EXPIRY_OPTIONS,
  PROTECTION_BOUND_PERCENT,
  RISK_PERCENT_PRESETS,
  SIZE_PERCENT_PRESETS,
  SLIPPAGE_PRESETS,
  hardBoundLabel,
  hardBoundShortLabel,
  leverageLabel,
  sideLabel,
  type DeskOutcome,
  type LimitTimeInForce,
  type TicketMargin,
  type TradeDraft,
  type TradeSide,
  type TradeTicketPrefill,
  type TradeTicketPricePick,
} from "./ticket-model.js";
import { useTradeTicketForm, type TradeTicketForm } from "./useTradeTicketForm.js";

const ONBOARDING_STEPS = [
  ["deposit", "First deposit"],
  ["key", "Trading key"],
  ["fee", "Fee approval"],
] as const;

const STEP_STATE_TEXT = { done: "Done", todo: "To do", not_required: "Not needed" } as const;
const SETUP_ACTION_TEXT: Readonly<Record<LighterOnboardingChecklist["nextAction"], string>> = {
  start_setup: "Set up Lighter",
  continue_setup: "Continue setup",
  check_status: "Check setup",
  none: "Setup complete",
};

export function TradeTicket({
  market,
  book,
  lastPrice,
  available,
  baseAvailable,
  equity,
  margin,
  settlementSymbol,
  accountGap = null,
  checklist = null,
  activeSession,
  dataFresh,
  submitting,
  prepareStage = null,
  handoffError,
  outcome = null,
  prefill,
  pricePick,
  onSend,
  onAsk,
  onConnect,
  onOpenLeverage,
  pendingApprovalCount = 0,
  onReviewApprovals,
}: {
  readonly market: LighterTradingMarket;
  readonly book: LighterOrderBookData;
  readonly lastPrice: number | null;
  /** Settlement balance the account can still commit, when the account read succeeded. */
  readonly available: string | null;
  /** Spot base inventory available to sell, when the account read succeeded. */
  readonly baseAvailable?: string | null;
  /** Account equity Risk mode sizes against; null without an account. */
  readonly equity: number | null;
  /** Margin terms for this market; null for spot or when Lighter reported none. */
  readonly margin: TicketMargin | null;
  readonly settlementSymbol: string;
  /** Why there is no account to trade from; the ticket offers setup instead of Long/Short. */
  readonly accountGap?: LighterTradingAccountUnavailableReason | null;
  /** Where the session's wallet stands on the three onboarding steps; null until read. */
  readonly checklist?: LighterOnboardingChecklist | null;
  readonly activeSession: boolean;
  readonly dataFresh: boolean;
  /** True while main derives the terms and enqueues the approval card. */
  readonly submitting: boolean;
  readonly prepareStage?: LighterDeskPrepareProgressEvent["stage"] | "opening_approval" | null;
  readonly handoffError?: string | null;
  /** What the last desk card came to, once it resolved. */
  readonly outcome?: DeskOutcome | null;
  readonly prefill?: TradeTicketPrefill | null;
  /** A price clicked in the book or tape: a limit price, or a protection trigger on shift-click. */
  readonly pricePick?: TradeTicketPricePick | null;
  /** Long/Short: main builds the proposal from this draft and the approval card takes over. */
  readonly onSend: (draft: TradeDraft) => void;
  /** Sends the drafted order to Vex as a question; nothing is prepared. */
  readonly onAsk?: (draft: TradeDraft) => void;
  /** Starts the onboarding chat: first deposit, trading key, fee approval. */
  readonly onConnect: () => void;
  /** Opens the leverage sheet for this market over the desk. */
  readonly onOpenLeverage: () => void;
  /** Desk approvals that still require a decision, including a dismissed modal. */
  readonly pendingApprovalCount?: number;
  readonly onReviewApprovals?: () => void;
}): JSX.Element {
  const form = useTradeTicketForm({ market, book, lastPrice, available, baseAvailable, equity, margin, dataFresh, prefill, pricePick });
  const { mode, side, protective, triggerLimit, perp, symbols } = form;
  const availableForSide = market.marketType === "spot" && side === "sell" ? (baseAvailable ?? null) : available;
  const availableSymbol = market.marketType === "spot" && side === "sell" ? symbols.base : settlementSymbol;
  // A fresh ticket is incomplete, not wrong: problems show once a field changes.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if ((prefill ?? null) !== null || (pricePick ?? null) !== null) setTouched(true);
  }, [prefill, pricePick]);
  const problem = touched ? form.validation : null;
  // The inactive side's button is an order for that side: flip the side, then
  // review once the form has re-derived its prices for it.
  const [pendingSide, setPendingSide] = useState<TradeSide | null>(null);
  useEffect(() => {
    if (pendingSide === null || pendingSide !== side) return;
    setPendingSide(null);
    setTouched(true);
    const draft = form.buildDraft();
    if (draft !== null) onSend(draft);
    // form.buildDraft is rebuilt every render; the side flip is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSide, side]);
  const priceDigits = { minimumFractionDigits: Math.min(market.decimals.price, 2), maximumFractionDigits: market.decimals.price };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const draft = form.buildDraft();
    if (draft !== null) onSend(draft);
  };

  const quote = (value: number | null, digits = 2): string => value === null
    ? NO_VALUE
    : `${formatNumber(value, { maximumFractionDigits: digits })} ${symbols.quote}`;

  // No account yet: the ticket is one sentence and the way in, not a form of
  // dashes. The chart and book keep working; the dock says the same words.
  if (accountGap === "not_onboarded") {
    const setupAction = checklist?.nextAction ?? "start_setup";
    return (
      <form className="lit-ticket" aria-label="Order ticket" data-gate="not-connected" data-setup-progress={checklist?.progress} onSubmit={(event) => event.preventDefault()}>
        <div className="lit-ticket-connect" role="status" aria-live="polite">
          <b>Lighter setup</b>
          <span>{checklist?.detail ?? "Vex checks your account, then guides each required approval in the chat."}</span>
          <ol className="lit-ticket-steps" aria-label="Setup steps">
            {ONBOARDING_STEPS.map(([key, label]) => {
              const state = checklist?.[key] ?? "pending";
              return (
                <li key={key} data-state={state}>
                  <span>{label}</span>
                  {state !== "pending" ? <em>{STEP_STATE_TEXT[state]}</em> : null}
                </li>
              );
            })}
          </ol>
          <button type="button" className="lit-review-button" onClick={onConnect} disabled={setupAction === "none"}>
            {SETUP_ACTION_TEXT[setupAction]}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      onChange={() => setTouched(true)}
      className="lit-ticket"
      aria-label="Order ticket"
      data-side={side}
      data-mode={mode}
    >
      {/* Account context and submit actions stay fixed. Only the variable-height
          order fields scroll when the stacked desk is short. */}
      <div className="lit-ticket-meta">
        {perp ? (
          <button
            type="button"
            className="lit-margin-chip"
            title="Change leverage and margin mode"
            aria-label="Leverage and margin mode"
            onClick={onOpenLeverage}
          >
            {margin === null
              ? "Leverage"
              : `${margin.marginMode === "cross" ? "Cross" : "Isolated"} · ${leverageLabel(margin.initialMarginFraction)}`}
            <i aria-hidden="true">›</i>
          </button>
        ) : null}
        <span className="lit-ticket-available">
          <small>Avbl</small>
          <b>{availableForSide === null ? NO_VALUE : `${formatDecimalString(availableForSide)} ${availableSymbol}`}</b>
        </span>
      </div>

      <div className="lit-ticket-body">

        <div className="lit-order-type-controls" role="group" aria-label="Order type">
          {(["market", "limit"] as const).map((item) => (
            <button type="button" key={item} aria-pressed={mode === item} onClick={() => form.selectMode(item)}>
              {MODE_LABELS[item]}
            </button>
          ))}
          {/* Protection modes are not picked here: entries attach TP/SL below, and
              a position's stop and take profit load from the Positions tab or the
              agent. The loaded mode shows as a third, already-pressed tab. */}
          {protective ? (
            <button type="button" aria-pressed="true" title="Loaded from a position or the agent">
              {MODE_LABELS[mode]}
            </button>
          ) : null}
        </div>
        <p
          className="lit-ticket-book-hint"
          title="Click a book or trade price for Limit. Shift-click for Trigger."
        >
          Price click → Limit · Shift-click → Trigger
        </p>

        {protective ? (
          <p className="lit-ticket-context">Reduce only. Sell protects a long, buy protects a short.</p>
        ) : null}

        {mode === "market" ? null : mode === "oco" ? (
          <>
            <ProtectionLeg
              label="Stop loss"
              side={side}
              triggerPrice={form.stopLossTriggerPrice}
              executionPrice={form.stopLossPrice}
              onTriggerPriceChange={form.setStopLossTriggerPrice}
              onExecutionPriceChange={form.setStopLossPrice}
            />
            <ProtectionLeg
              label="Take profit"
              side={side}
              triggerPrice={form.takeProfitTriggerPrice}
              executionPrice={form.takeProfitPrice}
              onTriggerPriceChange={form.setTakeProfitTriggerPrice}
              onExecutionPriceChange={form.setTakeProfitPrice}
            />
          </>
        ) : mode === "stop-loss" || mode === "take-profit" || triggerLimit ? (
          <ProtectionLeg
            label={MODE_LABELS[mode]}
            side={side}
            triggerPrice={form.triggerPrice}
            executionPrice={triggerLimit ? form.limitPrice : form.triggerBound}
            priceKind={triggerLimit ? "limit" : "bound"}
            onTriggerPriceChange={form.setTriggerPrice}
            onExecutionPriceChange={triggerLimit ? form.setLimitPrice : form.setTriggerBound}
          />
        ) : (
          <label className="lit-field">
            <span>Limit price</span>
            <span className="lit-input-shell">
              <input
                value={form.limitPrice}
                onChange={(event) => form.setLimitPrice(event.currentTarget.value.trim())}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Limit price"
                aria-describedby="lit-limit-price-note"
              />
              {form.suggestedPrice === null ? (
                <b>{symbols.quote}</b>
              ) : (
                <button
                  type="button"
                  className="lit-price-chip"
                  onClick={() => form.setLimitPrice(form.suggestedPrice ?? "")}
                  aria-label={`Use best ${side === "buy" ? "ask" : "bid"} ${form.suggestedPrice}`}
                >
                  {side === "buy" ? "Ask" : "Bid"}
                </button>
              )}
            </span>
            <small id="lit-limit-price-note">{form.limitPriceGuidance}</small>
          </label>
        )}

        <div className="lit-field lit-size-field" data-size-mode={form.riskMode ? "risk" : "qty"}>
          <span>
            Size
            {form.canSizeByRisk ? (
              // Qty types a size; Risk derives it from the stop-loss so a filled
              // stop costs a set share of equity (needs an account to read).
              <span className="lit-size-mode" role="group" aria-label="Size by">
                <button type="button" aria-pressed={!form.riskMode} onClick={() => form.selectSizeMode("qty")}>Qty</button>
                <button
                  type="button"
                  aria-pressed={form.riskMode}
                  disabled={equity === null}
                  title={equity === null ? "Set up Lighter to size by risk" : "Size from the stop-loss: risk a share of equity"}
                  onClick={() => form.selectSizeMode("risk")}
                >
                  Risk
                </button>
              </span>
            ) : null}
          </span>
          {form.riskMode ? (
            <>
              <span className="lit-input-shell">
                <input
                  value={form.riskPercent}
                  onChange={(event) => form.setRiskPercent(event.currentTarget.value.trim())}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="1"
                  aria-label="Risk as percent of equity"
                  aria-describedby="lit-size-note"
                />
                <b>% of equity</b>
              </span>
              <span className="lit-size-presets" role="group" aria-label="Risk presets">
                {RISK_PERCENT_PRESETS.map((percent) => (
                  <button
                    type="button"
                    key={percent}
                    aria-pressed={Number(form.riskPercent) === percent}
                    onClick={() => form.setRiskPercent(String(percent))}
                  >
                    {percent}%
                  </button>
                ))}
              </span>
              <span className="lit-input-shell lit-input-shell--readout">
                <input readOnly value={isPositiveDecimal(form.baseAmount) ? formatDecimalString(form.baseAmount) : ""} placeholder="0" aria-label="Size" />
                <b>{symbols.base}</b>
              </span>
              <small id="lit-size-note">
                {"riskAmount" in form.riskSizing
                  ? `Risks ${formatNumber(form.riskSizing.riskAmount)} ${settlementSymbol} if the stop fills at ${formatDecimalString(form.stopLossTriggerPrice)}.`
                  : form.riskSizing.reason}
              </small>
            </>
          ) : (
            <>
              <span className="lit-input-shell">
                <input
                  value={form.sizeInput}
                  onChange={(event) => form.editSize(event.currentTarget.value.trim())}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={form.sizeUnit === "base" ? market.minBaseAmount : "0"}
                  aria-label={form.sizeUnit === "base" ? "Size" : "Size in quote"}
                  aria-describedby={form.sizeUnit === "quote" ? "lit-size-note" : undefined}
                />
                <button
                  type="button"
                  className="lit-unit-toggle"
                  aria-label={`Size unit: ${form.sizeUnit === "base" ? symbols.base : symbols.quote}. Switch`}
                  onClick={form.toggleSizeUnit}
                >
                  {form.sizeUnit === "base" ? symbols.base : symbols.quote} ⇄
                </button>
              </span>
              <SizeSlider form={form} />
              {form.sizeUnit === "quote" && isPositiveDecimal(form.baseAmount) ? (
                <small id="lit-size-note">≈ {formatDecimalString(form.baseAmount)} {symbols.base}</small>
              ) : null}
            </>
          )}
        </div>

        {mode === "market" ? <SlippageField form={form} /> : null}

        {mode === "limit" || triggerLimit ? (
          <fieldset className="lit-tif-field">
            <legend>Time in Force</legend>
            <div className="lit-tif-tabs">
              {(Object.keys(LIMIT_TIME_IN_FORCE_LABELS) as LimitTimeInForce[]).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={form.limitTimeInForce === item}
                  title={LIMIT_TIME_IN_FORCE_NAMES[item]}
                  onClick={() => form.setLimitTimeInForce(item)}
                >
                  {LIMIT_TIME_IN_FORCE_LABELS[item]}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {mode === "market" || mode === "limit" || triggerLimit ? (
          <div className="lit-ticket-options">
            {perp && !protective ? (
              <span className="lit-check-group">
                <label className="lit-check-row">
                  <input
                    type="checkbox"
                    checked={form.reduceOnly}
                    onChange={(event) => form.setReduceOnly(event.currentTarget.checked)}
                  />
                  <span>Reduce-Only</span>
                </label>
                {perp ? (
                  <label className="lit-check-row">
                    <input
                      type="checkbox"
                      checked={form.protectOpen}
                      onChange={(event) => form.setProtectOpen(event.currentTarget.checked)}
                    />
                    <span>TP/SL</span>
                  </label>
                ) : null}
              </span>
            ) : null}
            {(mode === "limit" && form.limitTimeInForce !== "immediate-or-cancel") || triggerLimit ? (
              <label className="lit-expiry">
                <span>Expires</span>
                <select
                  value={String(form.orderExpiryOffsetMinutes)}
                  onChange={(event) => form.setOrderExpiryOffsetMinutes(Number(event.currentTarget.value))}
                  aria-label="Order expiry"
                >
                  {ORDER_EXPIRY_OPTIONS.map((option) => (
                    <option key={option.minutes} value={option.minutes}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        {perp && !protective && form.protectOpen ? <ProtectSection form={form} /> : null}

        {/* The facts close the scrolling body: only the side buttons stay
            pinned, so a short panel never hides the price and size fields. */}
        <dl className="lit-ticket-facts">
          <div>
            <dt>Order Value</dt>
            <dd>{quote(form.orderValue)}</dd>
          </div>
          {perp ? (
            <>
              <div>
                <dt>Cost</dt>
                <dd>{quote(form.cost)}</dd>
              </div>
              <div>
                <dt>Max Size</dt>
                <dd>{form.maxSize === null ? NO_VALUE : `${formatDecimalString(form.maxSize)} ${symbols.base}`}</dd>
              </div>
              <div>
                <dt>Liq. Price</dt>
                <dd title="Isolated-style estimate for this order alone; cross accounts liquidate on the whole portfolio.">
                  {form.liquidationEstimate === null ? NO_VALUE : `≈ ${formatNumber(form.liquidationEstimate, priceDigits)}`}
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt title={feeBreakdownTitle(form.feeRate)}>Fee ({form.feeRate.label})</dt>
            <dd>{form.estimatedFee === null ? NO_VALUE : `≈ ${quote(form.estimatedFee, 4)}`}</dd>
          </div>
          {mode === "market" ? (
            <div>
              <dt title={hardBoundLabel(side)}>{hardBoundShortLabel(side)}</dt>
              <dd>{form.worstPrice === null ? NO_VALUE : formatDecimalString(form.worstPrice)}</dd>
            </div>
          ) : (
            <div>
              <dt>Execution</dt>
              <dd>{executionLabel(form)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="lit-ticket-footer">
        {pendingApprovalCount > 0 ? (
          <div className="lit-ticket-approval-waiting" role="status">
            <span><b>Approval waiting</b><small>{pendingApprovalCount === 1 ? "1 action needs a decision" : `${String(pendingApprovalCount)} actions need a decision`}</small></span>
            {onReviewApprovals === undefined ? null : (
              <button type="button" onClick={onReviewApprovals}>Review</button>
            )}
          </div>
        ) : null}
        {handoffError ? <p className="lit-review-error" role="alert">{handoffError}</p> : null}
        {outcome !== null && handoffError == null ? (
          <p className="lit-review-outcome" data-tone={outcome.tone} role="status">{outcome.text}</p>
        ) : null}
        {problem !== null ? <p className="lit-validation" role="status">{problem}</p> : null}
        {onAsk === undefined ? null : (
          <button
            type="button"
            className="lit-ask-draft"
            disabled={submitting || form.validation !== null}
            title={form.validation ?? "Ask Vex to review this draft before placing an order"}
            onClick={() => {
              setTouched(true);
              const draft = form.buildDraft();
              if (draft !== null) onAsk(draft);
            }}
          >
            <VexMark size={14} /> Review with Vex
          </button>
        )}
        <div className="lit-side-actions" role="group" aria-label={protective ? "Position close side" : "Order side"}>
          {(["buy", "sell"] as const).map((item) => {
            const active = item === side;
            const detail = submitDetail(form);
            return (
              <button
                key={item}
                className="lit-review-button"
                type={active ? "submit" : "button"}
                data-side={item}
                data-active={active || undefined}
                aria-label={`${sideLabel(item, market.marketType, protective)}${detail}`}
                disabled={submitting || (active && form.validation !== null)}
                onClick={active ? undefined : () => { form.setSide(item); setPendingSide(item); }}
              >
                <b>{sideLabel(item, market.marketType, protective)}</b>
                <small>{submitting && active ? (
                  prepareStage === "checking_account" ? "Checking account…"
                    : prepareStage === "checking_market" ? "Checking live price…"
                      : prepareStage === "creating_approval" ? "Creating approval…"
                        : prepareStage === "opening_approval" ? "Opening approval…" : "Preparing…"
                ) : detail.trim() || MODE_LABELS[form.mode]}</small>
              </button>
            );
          })}
        </div>
        {problem === null ? (
          <p className="lit-review-note" role="note">
            <span>
              {activeSession
                ? "Nothing signs until you confirm."
                : "Opens Vex first. Nothing signs until you confirm."}
            </span>
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Both fee legs, named. The estimate beside this label is their SUM, and a
 * single percent under it read as the whole charge - which on a deployment
 * whose provider fee is zero made Vex's own fee look like it did not exist.
 */
function feeBreakdownTitle(fee: TradeTicketForm["feeRate"]): string {
  const provider = `${fee.label} ${formatProviderPercent(fee.rate, fee.enabled)}`;
  return fee.integrator === null
    ? provider
    : `${provider} + Vex ${formatProviderPercent(fee.integrator)}`;
}

/** What follows the side in a side button's name: the mode for protection, the size, and any attached TP/SL. */
function submitDetail(form: TradeTicketForm): string {
  const size = isPositiveDecimal(form.baseAmount) ? ` ${formatDecimalString(form.baseAmount)} ${form.symbols.base}` : "";
  if (form.protective) return ` ${MODE_LABELS[form.mode]}${size}`;
  const withProtection = form.protection !== null && (form.protection.stopLoss !== null || form.protection.takeProfit !== null);
  return `${size}${withProtection ? " + TP/SL" : ""}`;
}

function executionLabel(form: TradeTicketForm): string {
  const { mode, limitTimeInForce, limitPriceBookStatus } = form;
  if (mode === "oco") return "Native OCO";
  if (form.triggerLimit) {
    return `Conditional ${LIMIT_TIME_IN_FORCE_LABELS[limitTimeInForce]}`;
  }
  if (mode === "limit") {
    if (limitTimeInForce === "post-only") return "Post-Only";
    if (limitTimeInForce === "immediate-or-cancel") return limitPriceBookStatus === "resting" ? "IOC, would cancel now" : "IOC, fills now";
    return limitPriceBookStatus === "marketable" ? "GTC, can fill now" : "GTC, rests on the book";
  }
  return form.protective ? "Reduce only, 24 hour expiry" : "IOC";
}

function SlippageField({ form }: { readonly form: TradeTicketForm }): JSX.Element {
  return (
    <div className="lit-field lit-slippage-field">
      <span title="Maximum allowed slippage">Slippage</span>
      <span className="lit-slippage-controls" role="group" aria-label="Max slippage">
        {SLIPPAGE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset}
            aria-pressed={form.slippagePercent === preset}
            onClick={() => form.setSlippagePercent(preset)}
          >
            {preset}%
          </button>
        ))}
        <span className="lit-input-shell lit-slippage-input">
          <input
            value={form.slippagePercent}
            onChange={(event) => form.setSlippagePercent(event.currentTarget.value.trim())}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Max slippage percent"
          />
          <b>%</b>
        </span>
      </span>
    </div>
  );
}

/** Optional take-profit / stop-loss attached to a market or limit entry, shown while TP/SL is checked. */
/** Size as a share of the maximum: a slider with the quarter ticks as buttons. */
function SizeSlider({ form }: { readonly form: TradeTicketForm }): JSX.Element {
  const disabled = form.maxSize === null;
  // A typed size moves the thumb too; a preset or drag pins it exactly.
  const percent = form.sizePercent ?? (
    !disabled && isPositiveDecimal(form.baseAmount)
      ? Math.min(100, Math.max(0, Math.round((Number(form.baseAmount) / Number(form.maxSize)) * 100)))
      : 0
  );
  return (
    <div className="lit-size-slider" style={{ "--lit-size-fill": `${percent}%` } as CSSProperties}>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        disabled={disabled}
        aria-label="Size as percent of maximum"
        aria-valuetext={`${percent}%`}
        onChange={(event) => form.applySizePercent(Number(event.currentTarget.value))}
      />
      <span className="lit-size-presets" role="group" aria-label="Size presets">
        {[0, ...SIZE_PERCENT_PRESETS].map((tick) => (
          <button
            type="button"
            key={tick}
            aria-pressed={form.sizePercent === tick}
            disabled={disabled}
            onClick={() => form.applySizePercent(tick)}
          >
            {tick}%
          </button>
        ))}
      </span>
    </div>
  );
}

function ProtectSection({ form }: { readonly form: TradeTicketForm }): JSX.Element {
  const boundNote = (leg: { readonly price: string } | null): string => leg === null
    ? "Shift-click a book price to load it"
    : `${form.closeSide === "sell" ? "Sell ≥" : "Buy ≤"} ${formatDecimalString(leg.price)} · ${PROTECTION_BOUND_PERCENT}% bound`;
  return (
    <div className="lit-protect" role="group" aria-label="Take profit and stop loss">
      <label className="lit-protect-row">
        <span>Take Profit</span>
        <span className="lit-input-shell">
          <input
            value={form.takeProfitTriggerPrice}
            onChange={(event) => form.setTakeProfitTriggerPrice(event.currentTarget.value.trim())}
            inputMode="decimal"
            autoComplete="off"
            placeholder="Trigger"
            aria-label="Attached take-profit trigger price"
          />
          <b>{form.symbols.quote}</b>
        </span>
        <small>{boundNote(form.protection?.takeProfit ?? null)}</small>
      </label>
      <label className="lit-protect-row">
        <span>Stop Loss</span>
        <span className="lit-input-shell">
          <input
            value={form.stopLossTriggerPrice}
            onChange={(event) => form.setStopLossTriggerPrice(event.currentTarget.value.trim())}
            inputMode="decimal"
            autoComplete="off"
            placeholder="Trigger"
            aria-label="Attached stop-loss trigger price"
          />
          <b>{form.symbols.quote}</b>
        </span>
        <small>{boundNote(form.protection?.stopLoss ?? null)}</small>
      </label>
      <p className="lit-protect-note">Prepared as a separate approval once this entry fills.</p>
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
  return (
    <fieldset className="lit-protection-leg">
      <legend>{label}</legend>
      <div className="lit-protection-fields">
        <label className="lit-field">
          <span>Trigger</span>
          <span className="lit-input-shell">
            <input
              value={triggerPrice}
              onChange={(event) => onTriggerPriceChange(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${label} trigger price`}
            />
          </span>
        </label>
        <label className="lit-field">
          <span>{priceKind === "limit" ? "Limit" : side === "buy" ? "Max price" : "Min price"}</span>
          <span className="lit-input-shell">
            <input
              value={executionPrice}
              onChange={(event) => onExecutionPriceChange(event.currentTarget.value.trim())}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${label} ${priceKind === "limit" ? "limit price" : hardBoundLabel(side).toLowerCase()}`}
            />
          </span>
        </label>
      </div>
    </fieldset>
  );
}
