import { useState, type JSX } from "react";
import type {
  LighterTradingAccount,
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { useLighterTradingAccount } from "../../../lib/api/lighter-trading.js";
import { formatDecimalString, formatRetrievedAt } from "./format.js";

type BottomTab = "trades" | "positions" | "orders" | "assets";

const ACCOUNT_TABS: readonly BottomTab[] = ["positions", "trades", "orders", "assets"];
const TAB_LABEL: Record<BottomTab, string> = {
  trades: "Recent trades",
  positions: "Positions",
  orders: "Open orders",
  assets: "Assets",
};

function num(value: string | null): string {
  return formatDecimalString(value);
}

function signedTone(value: string | null): "positive" | "negative" | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return undefined;
  return parsed > 0 ? "positive" : "negative";
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
  if (normalized === "ioc" || normalized === "immediate-or-cancel") return "Immediate only";
  if (normalized === "gtt" || normalized === "good-till-time") return "Keep open";
  if (normalized === "post-only" || normalized === "postonly") return "Maker only";
  return value === null || value === undefined ? null : providerLabel(value);
}

function providerLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) return "—";
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

export function TradingBottomPanel({
  trades,
  symbol,
  environment,
  open,
  tradesStatus,
  tradesReceivedAt,
}: {
  readonly trades: LighterTradingSnapshot["trades"];
  readonly symbol: string;
  readonly environment: LighterTradingEnvironment;
  readonly open: boolean;
  readonly tradesStatus?: LighterTradingCandleConnectionStatus;
  readonly tradesReceivedAt?: number | null;
}): JSX.Element {
  const [tab, setTab] = useState<BottomTab>("positions");
  // Account tabs use the existing read-only account snapshot. The public tape
  // still needs no account authorization when it is the active view.
  const accountTabActive = tab !== "trades";
  const accountQuery = useLighterTradingAccount(environment, open && accountTabActive);
  const account = accountQuery.data?.ok === true ? accountQuery.data.data : null;
  const activeTabId = `lit-bottom-tab-${tab}`;
  const activePanelId = `lit-bottom-panel-${tab}`;

  const status = tab === "trades"
    ? tradesReceivedAt === null || tradesReceivedAt === undefined
      ? "REST snapshot"
      : `${tradesStatus === "live" ? "Live provider tape" : "Tape delayed"} · ${formatRetrievedAt(tradesReceivedAt)}`
    : tab === "orders" && accountQuery.isFetching && !accountQuery.isLoading
      ? "Refreshing open orders…"
      : account === null
      ? "Account"
      : account.status === "unavailable"
        ? "No account"
        : `Account #${account.accountIndex ?? "—"} · Snapshot ${formatRetrievedAt(account.retrievedAt)}`;

  return (
    <section className="lit-panel lit-bottom-panel" aria-labelledby={activeTabId}>
      <header className="lit-panel-header lit-bottom-header">
        <div className="lit-bottom-tabs" role="tablist" aria-label="Account and market tape">
          {ACCOUNT_TABS.map((item) => (
            <button
              type="button"
              key={item}
              role="tab"
              id={`lit-bottom-tab-${item}`}
              aria-controls={`lit-bottom-panel-${item}`}
              aria-selected={item === tab}
              tabIndex={item === tab ? 0 : -1}
              onClick={() => {
                setTab(item);
                if (item === "orders") void accountQuery.refetch();
              }}
            >
              {TAB_LABEL[item]}
              {item === "positions" && account !== null && account.positions.length > 0
                ? ` ${account.positions.length}`
                : item === "orders" && account !== null && account.openOrders.length > 0
                  ? ` ${account.openOrders.length}${account.openOrdersTruncated ? "+" : ""}`
                  : ""}
            </button>
          ))}
        </div>
        <div className="lit-account-refresh">
          <span role="status" aria-live="polite">{status}</span>
          {tab === "orders" ? (
            <button
              type="button"
              className="lit-account-refresh-button"
              aria-label="Refresh open orders"
              aria-busy={accountQuery.isFetching}
              disabled={accountQuery.isFetching}
              onClick={() => void accountQuery.refetch()}
            >
              Refresh
            </button>
          ) : null}
        </div>
      </header>
      <div
        className="lit-bottom-tabpanel"
        role="tabpanel"
        id={activePanelId}
        aria-labelledby={activeTabId}
        tabIndex={0}
      >
        {tab === "trades" ? (
          <RecentTradesTab trades={trades} symbol={symbol} />
        ) : accountQuery.isLoading ? (
          <p className="lit-book-empty">Loading account…</p>
        ) : accountQuery.data?.ok === false ? (
          <p className="lit-book-empty">{accountQuery.data.error.message}</p>
        ) : account === null || account.status === "unavailable" ? (
          <AccountUnavailable />
        ) : tab === "positions" ? (
          <PositionsTab account={account} />
        ) : tab === "orders" ? (
          <OpenOrdersTab account={account} />
        ) : (
          <AssetsTab account={account} />
        )}
      </div>
    </section>
  );
}

function AccountUnavailable(): JSX.Element {
  return (
    <div className="lit-account-empty" role="status">
      <b>No Lighter account connected</b>
      <span>
        Onboard a Lighter trading key and unlock your vault to see
        positions, open orders, and balances here.
      </span>
    </div>
  );
}

function RecentTradesTab({ trades, symbol }: {
  readonly trades: LighterTradingSnapshot["trades"];
  readonly symbol: string;
}): JSX.Element {
  if (trades.length === 0) {
    return <p className="lit-book-empty">No recent trades returned.</p>;
  }
  return (
    <>
      <div className="lit-trades-columns" aria-hidden="true">
        <span>Side</span><span>Price</span><span>Size {symbol}</span><span>Time</span>
      </div>
      <div className="lit-trades-list">
        {trades.slice(0, 30).map((trade) => (
          <div key={trade.tradeId} data-side={trade.takerSide}>
            <span>{trade.takerSide === "buy" ? "Buy" : "Sell"}</span>
            <b>{trade.price}</b>
            <span>{trade.size}</span>
            <time dateTime={new Date(trade.timestamp >= 1_000_000_000_000 ? trade.timestamp : trade.timestamp * 1_000).toISOString()}>
              {formatRetrievedAt(trade.timestamp >= 1_000_000_000_000 ? trade.timestamp : trade.timestamp * 1_000)}
            </time>
          </div>
        ))}
      </div>
    </>
  );
}

function PositionsTab({ account }: { readonly account: LighterTradingAccount }): JSX.Element {
  if (account.positions.length === 0) {
    return <p className="lit-book-empty">No open positions.</p>;
  }
  return (
    <div className="lit-account-table lit-positions">
      <div className="lit-account-columns" aria-hidden="true">
        <span>Market</span><span>Side</span><span>Size</span><span>Entry</span>
        <span>Value</span><span>uPnL</span><span>Liq. price</span>
      </div>
      <div className="lit-account-rows">
        {account.positions.map((position) => (
          <div className="lit-account-row" key={`${position.marketId}-${position.side}`}>
            <b>{position.symbol}</b>
            <span data-tone={position.side === "long" ? "positive" : "negative"}>
              {position.side === "long" ? "Long" : "Short"}
            </span>
            <span>{num(position.size)}</span>
            <span>{num(position.entryPrice)}</span>
            <span>{num(position.value)}</span>
            <span data-tone={signedTone(position.unrealizedPnl)}>{num(position.unrealizedPnl)}</span>
            <span>{num(position.liquidationPrice)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OpenOrdersTab({ account }: { readonly account: LighterTradingAccount }): JSX.Element {
  if (!account.openOrdersAvailable) {
    return (
      <p className="lit-book-empty">
        Open orders are unavailable — unlock your vault so a read-only
        authorization can be derived.
      </p>
    );
  }
  if (account.openOrders.length === 0) {
    return <p className="lit-book-empty">No open orders.</p>;
  }
  return (
    <>
      {account.openOrdersTruncated ? (
        <p className="lit-open-orders-note" role="status">
          Showing a partial active-order list (up to 200).
        </p>
      ) : null}
      <div className="lit-account-table lit-open-orders" role="table" aria-label="Open Lighter orders">
        <div className="lit-account-columns" role="row">
          <span role="columnheader">Market</span><span role="columnheader">Side</span>
          <span role="columnheader">Order</span><span role="columnheader">Price</span>
          <span role="columnheader">Remaining</span><span role="columnheader">Status</span>
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
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function AssetsTab({ account }: { readonly account: LighterTradingAccount }): JSX.Element {
  const summary = account.summary;
  const settlementSymbol = account.environment === "core" ? "USDC" : "USDG";
  return (
    <div className="lit-account-assets">
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
      <p className="lit-asset-section">Account</p>
      <AssetRow label="Collateral" value={summary === null ? "—" : num(summary.collateral)} suffix={settlementSymbol} />
      <AssetRow label="Available balance" value={summary === null ? "—" : num(summary.availableBalance)} suffix={settlementSymbol} />
      <AssetRow
        label="Unrealized PnL"
        value={summary === null ? "—" : num(summary.unrealizedPnl)}
        suffix={settlementSymbol}
        tone={signedTone(summary?.unrealizedPnl ?? null)}
      />
      <AssetRow label="Open positions" value={String(account.positions.length)} />
      <AssetRow
        label="Open orders"
        value={account.openOrdersAvailable
          ? `${account.openOrders.length}${account.openOrdersTruncated ? "+" : ""}`
          : "—"}
      />
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
      <b data-tone={tone}>{value === "—" || suffix === undefined ? value : `${value} ${suffix}`}</b>
    </div>
  );
}
