import { useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import type {
  LighterTradingAccount,
  LighterTradingAccountUnavailableReason,
  LighterTradingEnvironment,
  LighterTradingFill,
} from "@shared/schemas/lighter-trading.js";
import { IconChevronDown, IconChevronUp } from "../../../components/icons/index.js";
import { useLighterTradingAccount, useLighterTradingFills } from "../../../lib/api/lighter-trading.js";
import { accountRisk, marginUsage, positionMetrics, positionProtection, type ClosePortion, type LighterOpenOrderRow, type LighterPositionRow, type PositionCloseStage } from "./account-model.js";
import { ClosePositionPopover } from "./ClosePositionPopover.js";
import { NO_VALUE, formatDecimalString, formatNumber, formatPrice, formatRetrievedAt } from "./format.js";
import { wholeLeverageDisplay } from "./leverage-display.js";
import { useUiStore } from "../../../stores/uiStore.js";

type BottomTab = "positions" | "orders" | "fills" | "balances";

const ACCOUNT_TABS: readonly BottomTab[] = ["positions", "orders", "fills", "balances"];
const TAB_LABEL: Record<BottomTab, string> = {
  positions: "Positions",
  orders: "Open Orders",
  fills: "Trade History",
  balances: "Assets",
};

export type { LighterOpenOrderRow, LighterPositionRow } from "./account-model.js";

function num(value: string | null): string {
  return formatDecimalString(value);
}

function signedTone(value: string | number | null): "positive" | "negative" | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return undefined;
  return parsed > 0 ? "positive" : "negative";
}

function signedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_VALUE;
  return `${value > 0 ? "+" : ""}${formatNumber(value * 100, { maximumFractionDigits: 2 })}%`;
}

function leverageText(leverage: number | null, marginMode: "cross" | "isolated" | null): string {
  if (leverage === null) return NO_VALUE;
  const label = `${wholeLeverageDisplay(leverage)}x`;
  return marginMode === null ? label : `${label} ${marginMode === "cross" ? "Cross" : "Isolated"}`;
}

function orderTypeLabel(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-") ?? "";
  if (normalized === "limit") return "Limit";
  if (normalized === "stop-loss-limit" || normalized === "stop-limit") return "Stop-loss limit";
  if (normalized === "take-profit-limit") return "Take-profit limit";
  return providerLabel(value);
}

function timeInForceLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-") ?? "";
  if (normalized === "ioc" || normalized === "immediate-or-cancel") return "IOC";
  if (normalized === "gtt" || normalized === "good-till-time") return "GTC";
  if (normalized === "post-only" || normalized === "postonly") return "Post-Only";
  return value === null || value === undefined ? null : providerLabel(value);
}

function providerLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) return NO_VALUE;
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function shortOrderId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function orderTimestampDetails(value: number | null): { readonly label: string; readonly iso: string } | null {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) return null;
  const timestamp = value >= 1_000_000_000_000 ? value : value * 1_000;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    label: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date),
    iso: date.toISOString(),
  };
}
function tabCount(account: LighterTradingAccount | null, tab: BottomTab): number | null {
  if (account === null || account.status === "unavailable") return null;
  if (tab === "positions") return account.positions.length;
  if (tab === "orders") return account.openOrdersAvailable ? account.openOrders.length : null;
  return null;
}

export interface AccountActions {
  /** Asks the trading session to review this position; nothing is prepared. */
  readonly onReviewPosition: (position: LighterPositionRow) => void;
  /** Closes this portion of the position at market, reduce-only; the whole position goes straight to its card. */
  readonly onClosePosition: (position: LighterPositionRow, portion: ClosePortion) => void;
  /** Prefills the ticket with an OCO stop-loss and take-profit for this position. */
  readonly onProtectPosition: (position: LighterPositionRow) => void;
  /** Prefills the ticket with a reduce-only limit close of this portion of the position at the mark. */
  readonly onCloseLimit: (position: LighterPositionRow, portion: ClosePortion) => void;
  /** Puts this position's market on the desk. */
  readonly onOpenMarket: (position: LighterPositionRow) => void;
  /** Asks the trading session to cancel one resting order. */
  readonly onCancelOrder: (order: LighterOpenOrderRow) => void;
  /** Asks the trading session to cancel every resting order in the account. */
  readonly onCancelAllOrders: (orders: readonly LighterOpenOrderRow[]) => void;
  /** Brings the Market close approval card back after "Don't ask again". */
  readonly onRestoreCloseConfirm: () => void;
  /** Asks the trading session to walk through a deposit or withdrawal. */
  readonly onFund: (kind: "deposit" | "withdraw") => void;
  /** Asks the trading session to set the account up: deposit, key, fees. */
  readonly onConnect: () => void;
  /** Opens the Lighter section of Settings, where connected accounts are managed. */
  readonly onOpenSettings: (event?: { readonly currentTarget: EventTarget | null }) => void;
}

export function TradingBottomPanel({
  environment,
  open,
  collapsed,
  onToggleCollapse,
  activeMarketId,
  activeMarkPrice,
  activePriceDecimals,
  closeConfirmSkipped,
  closingPositions,
  actions,
}: {
  readonly environment: LighterTradingEnvironment;
  readonly open: boolean;
  /** Collapsed keeps only the tab strip; picking a tab expands the dock again. */
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  /** The desk's market and its live mark, so that one position row reads live. */
  readonly activeMarketId: number | null;
  readonly activeMarkPrice: number | null;
  /** The desk market's price decimals, so its live mark renders at the exchange tick. */
  readonly activePriceDecimals: number | null;
  /** Market close sends without its approval card; the positions table says so. */
  readonly closeConfirmSkipped: boolean;
  readonly closingPositions: ReadonlyMap<string, PositionCloseStage>;
  readonly actions: AccountActions;
}): JSX.Element {
  const [tab, setTab] = useState<BottomTab>("positions");
  const sessionId = useUiStore((state) => state.activeSessionId);
  const accountQuery = useLighterTradingAccount(environment, open, sessionId);
  const openUnlock = useUiStore((state) => state.openUnlock);
  const account = accountQuery.data?.ok === true ? accountQuery.data.data : null;
  const activeTabId = `lit-bottom-tab-${tab}`;
  const activePanelId = `lit-bottom-panel-${tab}`;

  const status = accountQuery.isFetching && !accountQuery.isLoading
    ? "Refreshing…"
    : account === null
      ? null
      : account.status === "unavailable"
        ? account.unavailableReason === "locked_vault"
          ? "Locked"
          : account.unavailableReason === "ambiguous_account"
            ? "Several accounts"
            : "Not connected"
        : `Account #${account.accountIndex ?? NO_VALUE} · ${formatRetrievedAt(account.retrievedAt)}`;

  return (
    <section className="lit-panel lit-bottom-panel" aria-labelledby={activeTabId} data-collapsed={collapsed || undefined}>
      <header className="lit-panel-header lit-bottom-header">
        <div className="lit-bottom-tabs" role="tablist" aria-label="Account">
          {ACCOUNT_TABS.map((item) => {
            const count = tabCount(account, item);
            return (
              <button
                type="button"
                key={item}
                role="tab"
                id={`lit-bottom-tab-${item}`}
                aria-controls={`lit-bottom-panel-${item}`}
                aria-selected={item === tab}
                tabIndex={item === tab ? 0 : -1}
                onKeyDown={(event) => {
                  const index = ACCOUNT_TABS.indexOf(item);
                  const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? (index + 1) % ACCOUNT_TABS.length
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? (index - 1 + ACCOUNT_TABS.length) % ACCOUNT_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? ACCOUNT_TABS.length - 1
                          : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  const nextTab = ACCOUNT_TABS.at(nextIndex);
                  if (nextTab === undefined) return;
                  setTab(nextTab);
                  if (collapsed) onToggleCollapse();
                  window.requestAnimationFrame(() => document.getElementById(`lit-bottom-tab-${nextTab}`)?.focus());
                }}
                onClick={() => {
                  setTab(item);
                  if (collapsed) onToggleCollapse();
                }}
              >
                {TAB_LABEL[item]}
                {count === null ? null : <i>({count}{item === "orders" && account?.openOrdersTruncated ? "+" : ""})</i>}
              </button>
            );
          })}
        </div>
        {account !== null && account.status !== "unavailable" ? <RiskStrip account={account} /> : null}
        <div className="lit-bottom-status">
          {status === null ? null : <span role="status" aria-live="polite">{status}</span>}
          <button
            type="button"
            className="lit-account-refresh-button"
            onClick={() => { void accountQuery.refetch(); }}
            disabled={accountQuery.isFetching}
            aria-busy={accountQuery.isFetching}
          >
            Refresh
          </button>
          <button
            type="button"
            className="lit-bottom-collapse"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={activePanelId}
            aria-label={collapsed ? "Expand the account dock" : "Collapse the account dock"}
          >
            {collapsed ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
          </button>
        </div>
      </header>
      {collapsed ? null : (
      <div className="lit-bottom-body" role="tabpanel" id={activePanelId} aria-labelledby={activeTabId}>
        {accountQuery.isLoading ? (
          <p className="lit-book-empty">Loading account…</p>
        ) : accountQuery.data?.ok === false ? (
          <AccountReadFailed
            error={accountQuery.data.error}
            onRetry={() => { void accountQuery.refetch(); }}
            retrying={accountQuery.isFetching}
          />
        ) : account === null ? (
          <AccountUnavailable reason={null} onConnect={actions.onConnect} onOpenSettings={actions.onOpenSettings} onUnlock={() => openUnlock("appShell")} />
        ) : account.status === "unavailable" ? (
          <AccountUnavailable reason={account.unavailableReason} onConnect={actions.onConnect} onOpenSettings={actions.onOpenSettings} onUnlock={() => openUnlock("appShell")} />
        ) : tab === "positions" ? (
          <PositionsTab account={account} activeMarketId={activeMarketId} activeMarkPrice={activeMarkPrice} activePriceDecimals={activePriceDecimals} closeConfirmSkipped={closeConfirmSkipped} closingPositions={closingPositions} actions={actions} />
        ) : tab === "orders" ? (
          <OpenOrdersTab account={account} actions={actions} />
        ) : tab === "fills" ? (
          <FillsTab environment={environment} />
        ) : (
          <BalancesTab account={account} onFund={actions.onFund} />
        )}
      </div>
      )}
    </section>
  );
}

/**
 * The account's risk at a glance, in the dock header so it stays in view
 * even with the dock folded: equity, what is free to trade, open PnL over the
 * margin holding it, and how much of the collateral is committed.
 */
function RiskStrip({ account }: { readonly account: LighterTradingAccount }): JSX.Element {
  const risk = accountRisk(account.summary);
  const money = (value: number | null): string => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const settlement = account.environment === "core" ? "USDC" : "USDG";
  const pnl = risk.unrealizedPnl;
  return (
    <dl className="lit-risk-strip" aria-label="Account risk">
      <div><dt>Equity</dt><dd>{money(risk.equity)} {settlement}</dd></div>
      <div><dt>Avbl</dt><dd>{money(risk.available)} {settlement}</dd></div>
      <div>
        <dt>uPnL</dt>
        <dd data-tone={signedTone(pnl)}>
          {pnl === null ? NO_VALUE : `${pnl > 0 ? "+" : ""}${money(pnl)} ${settlement}`}
          {risk.roe === null ? null : <i> ({signedPercent(risk.roe)})</i>}
        </dd>
      </div>
      <div>
        <dt>Margin</dt>
        <dd>
          {money(risk.marginUsed)} {settlement}
          {risk.usage === null ? null : (
            <span
              className="lit-margin-usage-bar"
              role="meter"
              aria-label="Margin usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(risk.usage * 100)}
              data-level={risk.usage >= 0.8 ? "high" : risk.usage >= 0.5 ? "mid" : "low"}
            >
              <i style={{ width: `${risk.usage * 100}%` }} />
            </span>
          )}
          {risk.usage === null ? null : <i>{formatNumber(risk.usage * 100, { maximumFractionDigits: 0 })}%</i>}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The read SUCCEEDED and there is nothing to show. Each reason gets its own
 * remediation because they need different actions from the person: one is an
 * unlock, one is onboarding, one is a choice Vex refuses to make for them.
 * A null reason is the pre-first-answer state, not a fourth reason.
 */
function AccountUnavailable({ reason, onConnect, onOpenSettings, onUnlock }: {
  readonly reason: LighterTradingAccountUnavailableReason | null;
  readonly onConnect: () => void;
  readonly onOpenSettings: (event?: { readonly currentTarget: EventTarget | null }) => void;
  readonly onUnlock: () => void;
}): JSX.Element {
  const copy = reason === "locked_vault"
    ? {
        title: "Vex is locked",
        detail: "Unlock Vex to see positions, open orders, and balances for your Lighter account.",
      }
    : reason === "ambiguous_account"
      ? {
          title: "Several Lighter accounts are connected",
          detail: "Vex will not pick one for you. Forget the connections you do not want in Settings, then reopen this panel.",
        }
      : {
          title: "Not connected",
          detail: "Set up your Lighter account in one step: first deposit, trading key, and fee approval, all from a single confirmation.",
        };
  return (
    <div className="lit-account-empty" role="status">
      <b>{copy.title}</b>
      <span>{copy.detail}</span>
      {/* Unlocking is the vault's flow; too many accounts is fixed in Settings;
          setup opens the account-setup modal, which runs the deposit -> key ->
          fee chain from one confirmation (no chat, no per-step approval). */}
      {reason === "locked_vault" ? (
        <button type="button" className="lit-account-empty-action" onClick={onUnlock}>Unlock Vex</button>
      ) : reason === "ambiguous_account" ? (
        <button type="button" className="lit-account-empty-action" onClick={onOpenSettings}>Open Settings</button>
      ) : (
        <button type="button" className="lit-account-empty-action" onClick={onConnect}>Set up Lighter</button>
      )}
    </div>
  );
}

/**
 * The read FAILED. Retry is offered only where the error says a retry can
 * help, so a locked vault never shows a button that cannot work.
 */
function AccountReadFailed({ error, onRetry, retrying }: {
  readonly error: VexError;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}): JSX.Element {
  return (
    <div className="lit-account-empty" role="alert">
      <b>{error.code === "provider.unavailable" ? "Lighter is not answering" : "Account unavailable"}</b>
      <span>{error.message}</span>
      {error.retryable ? (
        <button
          type="button"
          className="lit-account-refresh-button"
          onClick={onRetry}
          aria-busy={retrying}
          disabled={retrying}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}


function PositionsTab({ account, activeMarketId, activeMarkPrice, activePriceDecimals, closeConfirmSkipped, closingPositions, actions }: {
  readonly account: LighterTradingAccount;
  readonly activeMarketId: number | null;
  readonly activeMarkPrice: number | null;
  readonly activePriceDecimals: number | null;
  readonly closeConfirmSkipped: boolean;
  readonly closingPositions: ReadonlyMap<string, PositionCloseStage>;
  readonly actions: AccountActions;
}): JSX.Element {
  // How much of each row the Limit and Market buttons close; whole by default.
  if (account.positions.length === 0) {
    return <p className="lit-book-empty">No open positions.</p>;
  }
  return (
    <>
    {closeConfirmSkipped ? (
      <p className="lit-positions-note" role="note">
        Market close sends without confirmation.
        <button type="button" onClick={actions.onRestoreCloseConfirm}>Ask again</button>
      </p>
    ) : null}
    <div className="lit-account-table lit-positions" role="table" aria-label="Open Lighter positions">
      <div className="lit-account-columns" role="row">
        <span role="columnheader">Market</span><span role="columnheader">Size</span>
        <span role="columnheader">Entry</span><span role="columnheader">Mark</span>
        <span role="columnheader">Liq.</span><span role="columnheader">Margin</span>
        <span role="columnheader">uPnL (ROE)</span><span role="columnheader">TP / SL</span>
        <span role="columnheader">Actions</span>
      </div>
      <div className="lit-account-rows" role="rowgroup">
        {account.positions.map((position) => {
          const live = position.marketId === activeMarketId ? activeMarkPrice : null;
          const metrics = positionMetrics(position, live);
          const protection = positionProtection(position, account.openOrders);
          const rowKey = `${position.marketId}-${position.side}`;
          const closeStage = closingPositions.get(rowKey) ?? null;
          const closeLabel = closeStage === "preparing" ? "Preparing close"
            : closeStage === "approval" ? "Awaiting approval"
              : closeStage === "resting" ? "Close order open"
                : closeStage === "uncertain" ? "Checking close status"
                  : "Confirming close";
          return (
            <div className="lit-account-row" role="row" key={rowKey} data-close-pending={closeStage === null ? undefined : ""} aria-busy={closeStage !== null && closeStage !== "resting"}>
              <span className="lit-order-cell" role="cell">
                <button
                  type="button"
                  className="lit-market-link"
                  onClick={() => actions.onOpenMarket(position)}
                  aria-current={position.marketId === activeMarketId ? "true" : undefined}
                  aria-label={`Open ${position.symbol} on the desk`}
                >
                  {position.symbol}
                </button>
                <small data-tone={position.side === "long" ? "positive" : "negative"}>
                  {position.side === "long" ? "Long" : "Short"} · {leverageText(metrics.leverage, position.marginMode)}
                </small>
                {closeStage !== null ? (
                  <small className="lit-position-close-status" role="status">
                    {closeStage === "resting" ? null : <span className="lit-position-close-spinner" aria-hidden="true" />}
                    {closeLabel}
                  </small>
                ) : null}
              </span>
              <span role="cell">{num(position.size)}</span>
              <span role="cell">{num(position.entryPrice)}</span>
              <span role="cell" title={live === null ? "From the last account snapshot" : "Live mark"}>{formatPrice(metrics.mark, live === null ? undefined : activePriceDecimals ?? undefined)}</span>
              <span role="cell">{num(position.liquidationPrice)}</span>
              <span className="lit-order-cell" role="cell">
                <b>{formatPrice(metrics.margin)}</b>
                <small>of {num(position.value)}</small>
              </span>
              <span className="lit-order-cell" role="cell" data-tone={signedTone(position.unrealizedPnl)}>
                <b>{num(position.unrealizedPnl)}</b>
                <small>{signedPercent(metrics.roe)}</small>
              </span>
              <span className="lit-order-cell" role="cell">
                <b>{protection.takeProfit === null ? NO_VALUE : num(protection.takeProfit.triggerPrice)}</b>
                <small>{protection.stopLoss === null ? NO_VALUE : num(protection.stopLoss.triggerPrice)}</small>
              </span>
              <span role="cell" className="lit-row-actions">
                <button type="button" onClick={() => actions.onReviewPosition(position)} aria-label={`Review ${position.symbol} position with Vex`}>
                  Ask
                </button>
                <button type="button" onClick={() => actions.onProtectPosition(position)} aria-label={`Set stop loss and take profit for ${position.symbol}`}>
                  Protect
                </button>
                <ClosePositionPopover
                  position={position}
                  disabled={closeStage !== null}
                  onCloseLimit={(chosen) => actions.onCloseLimit(position, chosen)}
                  onCloseMarket={(chosen) => actions.onClosePosition(position, chosen)}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}

function OpenOrdersTab({ account, actions }: {
  readonly account: LighterTradingAccount;
  readonly actions: AccountActions;
}): JSX.Element {
  if (!account.openOrdersAvailable) {
    return (
      <p className="lit-book-empty">
        {account.openOrdersUnavailableReason === "read_failed"
          ? "Open orders could not be loaded from Lighter. They will retry on the next refresh."
          : "Open orders are unavailable: unlock your vault so a read-only authorization can be derived."}
      </p>
    );
  }
  if (account.openOrders.length === 0) {
    return <p className="lit-book-empty">No open orders.</p>;
  }
  return (
    <>
      <div className="lit-open-orders-toolbar">
        {account.openOrdersTruncated ? (
          <p className="lit-open-orders-note" role="status">
            Showing a partial active-order list (up to 200).
          </p>
        ) : null}
        <button type="button" className="lit-cancel-all" onClick={() => actions.onCancelAllOrders(account.openOrders)}>
          Cancel all
        </button>
      </div>
      <div className="lit-account-table lit-open-orders" role="table" aria-label="Open Lighter orders">
        <div className="lit-account-columns" role="row">
          <span role="columnheader">Market</span><span role="columnheader">Side</span>
          <span role="columnheader">Order</span><span role="columnheader">Price</span>
          <span role="columnheader">Remaining</span><span role="columnheader">Status</span>
          <span role="columnheader">Actions</span>
        </div>
        <div className="lit-account-rows" role="rowgroup">
          {account.openOrders.map((order) => {
            const tif = timeInForceLabel(order.timeInForce);
            const expiry = orderTimestampDetails(order.orderExpiry);
            const triggeredAt = orderTimestampDetails(order.triggeredAt);
            const identityTitle = order.clientOrderId === null
              ? `Order ${order.orderId}`
              : `Order ${order.orderId} · Client ${order.clientOrderId}`;
            return (
              <div
                className="lit-account-row"
                role="row"
                key={`${account.environment}:${account.accountIndex}:${order.marketId}:${order.orderId}`}
              >
                <span className="lit-order-cell" role="cell">
                  <b>{order.symbol}</b>
                  <small title={identityTitle}>Order {shortOrderId(order.orderId)}</small>
                </span>
                <span role="cell" data-tone={order.side === "buy" ? "positive" : "negative"}>
                  {order.side === "buy" ? "Buy" : "Sell"}
                </span>
                <span className="lit-order-cell" role="cell">
                  <b>{orderTypeLabel(order.type)}</b>
                  {tif !== null || order.reduceOnly === true ? (
                    <small>{[tif, order.reduceOnly === true ? "Reduce only" : null].filter(Boolean).join(" · ")}</small>
                  ) : null}
                </span>
                <span className="lit-order-cell" role="cell">
                  <b>{num(order.price)}</b>
                  {order.triggerPrice === null ? null : <small>Trigger {num(order.triggerPrice)}</small>}
                </span>
                <span className="lit-order-cell" role="cell">
                  <b>{num(order.remaining)}</b>
                  <small>{order.filled === null ? `Size ${num(order.size)}` : `Filled ${num(order.filled)} / ${num(order.size)}`}</small>
                </span>
                <span className="lit-order-cell" role="cell">
                  <b>{providerLabel(order.status)}</b>
                  {order.triggerStatus === null ? null : (
                    <small>
                      {providerLabel(order.triggerStatus)}
                      {triggeredAt === null ? null : <> · <time dateTime={triggeredAt.iso}>{triggeredAt.label}</time></>}
                    </small>
                  )}
                  {expiry === null ? null : <time dateTime={expiry.iso}>Expires {expiry.label}</time>}
                </span>
                <span role="cell" className="lit-row-actions">
                  <button type="button" data-danger onClick={() => actions.onCancelOrder(order)} aria-label={`Cancel ${order.symbol} order ${shortOrderId(order.orderId)}`}>
                    Cancel
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function fillTypeLabel(fill: LighterTradingFill): string | null {
  const parts = [
    fill.type === "trade" ? null : providerLabel(fill.type),
    fill.role === "maker" ? "Maker" : "Taker",
  ].filter(Boolean);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Its own read: fills are a history, so they load only when the tab is open. */
function FillsTab({ environment }: {
  readonly environment: LighterTradingEnvironment;
}): JSX.Element {
  const sessionId = useUiStore((state) => state.activeSessionId);
  const fillsQuery = useLighterTradingFills(environment, true, sessionId);
  if (fillsQuery.isLoading) {
    return <p className="lit-book-empty">Loading fills…</p>;
  }
  if (fillsQuery.data?.ok === false) {
    return (
      <AccountReadFailed
        error={fillsQuery.data.error}
        onRetry={() => { void fillsQuery.refetch(); }}
        retrying={fillsQuery.isFetching}
      />
    );
  }
  const fills = fillsQuery.data?.ok === true ? fillsQuery.data.data : null;
  if (fills === null) return <p className="lit-book-empty">Loading fills…</p>;
  if (!fills.available) {
    return (
      <p className="lit-book-empty">
        Fills are unavailable: unlock your vault so a read-only
        authorization can be derived.
      </p>
    );
  }
  if (fills.fills.length === 0) {
    return <p className="lit-book-empty">No fills yet.</p>;
  }
  return (
    <>
      {fills.truncated ? (
        <p className="lit-fills-note" role="note">Showing the most recent fills; older activity is not loaded.</p>
      ) : null}
      <div className="lit-account-table lit-fills" role="table" aria-label="Recent Lighter fills">
        <div className="lit-account-columns" role="row">
          <span role="columnheader">Time</span><span role="columnheader">Market</span>
          <span role="columnheader">Side</span><span role="columnheader">Price</span>
          <span role="columnheader">Size</span><span role="columnheader">Value</span>
          <span role="columnheader">Realized PnL</span>
        </div>
        <div className="lit-account-rows" role="rowgroup">
          {fills.fills.map((fill) => {
            const when = orderTimestampDetails(fill.timestamp);
            const detail = fillTypeLabel(fill);
            return (
              <div className="lit-account-row" role="row" key={`${fills.environment}:${fills.accountIndex}:${fill.tradeId}`}>
                <span role="cell">
                  {when === null ? NO_VALUE : <time dateTime={when.iso}>{when.label}</time>}
                </span>
                <span className="lit-order-cell" role="cell">
                  <b>{fill.symbol}</b>
                  {detail === null ? null : <small>{detail}</small>}
                </span>
                <span role="cell" data-tone={fill.side === "buy" ? "positive" : "negative"}>
                  {fill.side === "buy" ? "Buy" : "Sell"}
                </span>
                <span role="cell">{num(fill.price)}</span>
                <span role="cell">{num(fill.size)}</span>
                <span role="cell">{num(fill.value)}</span>
                <span role="cell" data-tone={signedTone(fill.realizedPnl)}>{num(fill.realizedPnl)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function BalancesTab({ account, onFund }: {
  readonly account: LighterTradingAccount;
  readonly onFund: AccountActions["onFund"];
}): JSX.Element {
  const summary = account.summary;
  const settlementSymbol = account.environment === "core" ? "USDC" : "USDG";
  const usage = marginUsage(summary);
  return (
    <div className="lit-account-balances">
      <div className="lit-balance-summary">
        <AssetRow label="Collateral" value={summary === null ? NO_VALUE : num(summary.collateral)} suffix={settlementSymbol} />
        <AssetRow label="Available" value={summary === null ? NO_VALUE : num(summary.availableBalance)} suffix={settlementSymbol} />
        <AssetRow
          label="Unrealized PnL"
          value={summary === null ? NO_VALUE : num(summary.unrealizedPnl)}
          suffix={settlementSymbol}
          tone={signedTone(summary?.unrealizedPnl ?? null)}
        />
      </div>
      <div className="lit-margin-usage">
        <div className="lit-margin-usage-head">
          <span>Margin in use</span>
          <b>{usage === null ? NO_VALUE : formatNumber(usage * 100, { maximumFractionDigits: 1 }) + "%"}</b>
        </div>
        <div
          className="lit-margin-usage-bar"
          role="meter"
          aria-label="Margin in use"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usage === null ? undefined : Math.round(usage * 100)}
          data-level={usage === null ? undefined : usage >= 0.8 ? "high" : usage >= 0.5 ? "mid" : "low"}
        >
          <i style={{ width: `${(usage ?? 0) * 100}%` }} />
        </div>
      </div>
      <div className="lit-fund-actions">
        <button type="button" onClick={() => onFund("deposit")}>Deposit</button>
        <button type="button" onClick={() => onFund("withdraw")}>Withdrawal help</button>
        <small>Deposits require approval. Withdrawal help explains how to finish on Lighter.</small>
      </div>
      <p className="lit-asset-section">Token balances</p>
      {account.assets.length === 0 ? (
        <p className="lit-asset-note">No token balances in this account.</p>
      ) : (
        account.assets.map((asset) => (
          <div className="lit-asset-row" key={asset.assetId}>
            <span>{asset.symbol}</span>
            <b>
              {num(asset.balance)}
              {asset.available !== null && asset.available !== asset.balance ? (
                <small> · {num(asset.available)} available</small>
              ) : null}
            </b>
          </div>
        ))
      )}
    </div>
  );
}

function AssetRow({ label, value, suffix, tone }: {
  readonly label: string;
  readonly value: string;
  readonly suffix?: string;
  readonly tone?: "positive" | "negative";
}): JSX.Element {
  return (
    <div className="lit-asset-row">
      <span>{label}</span>
      <b data-tone={tone}>{value === NO_VALUE || suffix === undefined ? value : `${value} ${suffix}`}</b>
    </div>
  );
}
