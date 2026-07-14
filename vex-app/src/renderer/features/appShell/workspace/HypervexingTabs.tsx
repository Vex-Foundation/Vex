/**
 * Bottom registers v2 (design spec §13.9) — the venue's bottom-panel order:
 * Balances · Positions · Open Orders · TWAP · Trade History · Funding History
 * · Order History · Portfolio. Positions reuses the run-1
 * `HyperliquidPositionsBlock`; Balances renders the venue-confirmed account
 * DTO; Portfolio renders the wallet's real balance lines. Registers without a
 * renderer DTO yet render an honest empty state with a one-tap "Ask Vex"
 * action instead of fabricated rows.
 */

import { useState, type JSX, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { Result } from "@shared/ipc/result.js";
import type {
  HyperliquidAccountDto,
  HyperliquidFundingHistoryDto,
  HyperliquidOpenOrdersDto,
  HyperliquidOrderHistoryDto,
  HyperliquidTradeHistoryDto,
  HyperliquidTwapHistoryDto,
} from "@shared/schemas/hyperliquid.js";
import { HyperliquidPositionsBlock } from "../book/HyperliquidPositionsBlock.js";
import { usePortfolio } from "../../../lib/api/portfolio.js";
import {
  useHyperliquidFundingHistory,
  useHyperliquidOpenOrders,
  useHyperliquidOrderHistory,
  useHyperliquidTradeHistory,
  useHyperliquidTwapHistory,
} from "../../../lib/api/hyperliquid.js";
import { useSubmitChat } from "../../../lib/api/chat.js";
import { cn } from "../../../lib/utils.js";
import type { UseQueryResult } from "@tanstack/react-query";

type WorkspaceTab =
  | "balances"
  | "positions"
  | "openOrders"
  | "twap"
  | "tradeHistory"
  | "fundingHistory"
  | "orderHistory"
  | "portfolio";

const TABS: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
  { id: "balances", label: "Balances" },
  { id: "positions", label: "Positions" },
  { id: "openOrders", label: "Open Orders" },
  { id: "twap", label: "TWAP" },
  { id: "tradeHistory", label: "Trade History" },
  { id: "fundingHistory", label: "Funding History" },
  { id: "orderHistory", label: "Order History" },
  { id: "portfolio", label: "Portfolio" },
];

/** Register asks routed to the copilot — the agent owns venue history reads. */
const REGISTER_ASKS: Readonly<
  Record<
    Exclude<WorkspaceTab, "balances" | "positions" | "portfolio">,
    { readonly caption: string; readonly ask: string }
  >
> = {
  openOrders: {
    caption: "No working orders.",
    ask: "Show my Hyperliquid open orders.",
  },
  twap: {
    caption: "No TWAP history yet.",
    ask: "Show my Hyperliquid TWAP history.",
  },
  tradeHistory: {
    caption: "No fills yet.",
    ask: "Show my recent Hyperliquid fills.",
  },
  fundingHistory: {
    caption: "No funding payments yet.",
    ask: "Show my recent Hyperliquid funding payments.",
  },
  orderHistory: {
    caption: "No order history yet.",
    ask: "Show my recent Hyperliquid order history.",
  },
};

function usdValue(value: string | null | undefined): string {
  if (value == null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function BalancesPane({
  account,
  sessionId,
}: {
  readonly account: HyperliquidAccountDto | null;
  readonly sessionId: string | null;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="grid max-w-[560px] grid-cols-[1fr_auto_auto] items-baseline gap-x-6 gap-y-1 font-mono text-[11px] tabular-nums">
        <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">Asset</span>
        <span className="text-right text-[9px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">Total</span>
        <span className="text-right text-[9px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">Withdrawable</span>
        <span className="text-[var(--vex-text)]">USDC · Perps</span>
        <span className="text-right text-[var(--vex-text-2)]">{usdValue(account?.equityUsd)}</span>
        <span className="text-right text-[var(--vex-text-2)]">{usdValue(account?.withdrawableUsd)}</span>
      </div>
      <AskVexEmpty
        caption="Spot balances live with the agent."
        ask="Show my Hyperliquid spot balances."
        sessionId={sessionId}
      />
      <p className="text-[10px] text-[var(--vex-text-3)]">
        Deposits: native USDC via Bridge2 on Arbitrum One (min 5 USDC). Withdrawals carry a 1 USDC venue fee.
      </p>
    </div>
  );
}

function AskVexEmpty({
  caption,
  ask,
  sessionId,
}: {
  readonly caption: string;
  readonly ask: string;
  readonly sessionId: string | null;
}): JSX.Element {
  const submit = useSubmitChat();
  return (
    <div className="flex items-baseline gap-3">
      <p className="text-[11px] text-[var(--vex-text-3)]">{caption}</p>
      <button
        type="button"
        disabled={sessionId === null || submit.isPending}
        onClick={() => sessionId !== null && submit.mutate({ sessionId, message: ask })}
        className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-accent-text)] underline-offset-2 hover:underline disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        {submit.isPending ? "Asking…" : "Ask Vex"}
      </button>
    </div>
  );
}

function usdLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function PortfolioPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = usePortfolio(sessionId);
  if (query.isLoading) {
    return <p className="text-[11px] text-[var(--vex-text-3)]">Loading portfolio…</p>;
  }
  const dto = query.data?.ok ? query.data.data : null;
  if (dto === null) {
    return (
      <p className="text-[11px] text-[var(--vex-warn-text)]">
        Portfolio unavailable right now.
      </p>
    );
  }
  const lines = dto.tokens.slice(0, 10);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
          Wallet total
        </span>
        <span className="font-mono text-[15px] font-semibold tabular-nums text-[var(--vex-text)]">
          {usdLabel(dto.liveTotalUsd)}
        </span>
      </div>
      {lines.length === 0 ? (
        <p className="text-[11px] text-[var(--vex-text-3)]">No priced holdings yet.</p>
      ) : (
        <ul className="flex flex-col">
          {lines.map((token, index) => (
            <li
              key={`${token.chainId ?? "x"}:${token.symbol ?? index}`}
              className="flex h-7 items-center gap-3 font-mono text-[11px] tabular-nums"
            >
              <span className="min-w-0 flex-1 truncate text-[var(--vex-text)]">
                {token.symbol ?? "(unpriced token)"}
              </span>
              <span className="text-[var(--vex-text-3)]">
                {token.amount === null ? "" : token.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}
              </span>
              <span className="w-24 text-right text-[var(--vex-text-2)]">
                {usdLabel(token.balanceUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RegisterColumn {
  readonly key: string;
  readonly label: string;
  readonly align?: "right";
}

interface RegisterRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, ReactNode>>;
}

function gridTemplate(columns: readonly RegisterColumn[]): string {
  return columns
    .map((column) => (column.align === "right" ? "minmax(64px,auto)" : "minmax(56px,1fr)"))
    .join(" ");
}

function RegisterTable({
  columns,
  rows,
}: {
  readonly columns: readonly RegisterColumn[];
  readonly rows: readonly RegisterRow[];
}): JSX.Element {
  const template = gridTemplate(columns);
  return (
    <div className="min-h-0 overflow-x-auto">
      <div role="table" className="min-w-[520px] font-mono text-[11px] tabular-nums">
        <div role="row" className="grid gap-x-4 border-b border-[var(--vex-line)] pb-1" style={{ gridTemplateColumns: template }}>
          {columns.map((column) => (
            <span
              key={column.key}
              role="columnheader"
              className={cn(
                "text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]",
                column.align === "right" && "text-right",
              )}
            >
              {column.label}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div role="row" key={row.id} className="grid h-7 items-center gap-x-4" style={{ gridTemplateColumns: template }}>
            {columns.map((column) => (
              <span
                key={column.key}
                className={cn(
                  "truncate",
                  column.align === "right" ? "text-right text-[var(--vex-text-2)]" : "text-[var(--vex-text)]",
                )}
              >
                {row.cells[column.key]}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TruncationNote({ count }: { readonly count: number }): JSX.Element | null {
  if (count < 100) return null;
  return <p className="mt-1 text-[9px] text-[var(--vex-text-3)]">Showing the latest 100 rows.</p>;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sideCell(side: "buy" | "sell"): JSX.Element {
  return (
    <span className={side === "buy" ? "text-[var(--vex-buy-text,var(--vex-text))]" : "text-[var(--vex-sell-text,var(--vex-text-2))]"}>
      {side === "buy" ? "Buy" : "Sell"}
    </span>
  );
}

/**
 * Renders a register's data table, or the retained Ask Vex fallback for the
 * loading / error / empty states. `render` runs only with an ok, non-empty DTO.
 */
function RegisterPane<T>({
  query,
  sessionId,
  emptyKey,
  render,
}: {
  readonly query: UseQueryResult<Result<readonly T[]>>;
  readonly sessionId: string | null;
  readonly emptyKey: keyof typeof REGISTER_ASKS;
  readonly render: (rows: readonly T[]) => JSX.Element;
}): JSX.Element {
  const empty = REGISTER_ASKS[emptyKey];
  if (query.isLoading) {
    return <p className="text-[11px] text-[var(--vex-text-3)]">Loading…</p>;
  }
  const result = query.data;
  if (result === undefined || !result.ok) {
    return <AskVexEmpty caption={`${empty.caption.replace(/\.$/, "")} — unavailable right now.`} ask={empty.ask} sessionId={sessionId} />;
  }
  if (result.data.length === 0) {
    return <AskVexEmpty caption={empty.caption} ask={empty.ask} sessionId={sessionId} />;
  }
  return render(result.data);
}

const OPEN_ORDER_COLUMNS: readonly RegisterColumn[] = [
  { key: "coin", label: "Coin" },
  { key: "side", label: "Side" },
  { key: "sz", label: "Size", align: "right" },
  { key: "limitPx", label: "Limit", align: "right" },
  { key: "type", label: "Type" },
  { key: "time", label: "Placed", align: "right" },
];

function OpenOrdersPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useHyperliquidOpenOrders(sessionId);
  return (
    <RegisterPane<HyperliquidOpenOrdersDto[number]>
      query={query}
      sessionId={sessionId}
      emptyKey="openOrders"
      render={(rows) => (
        <div className="flex min-h-0 flex-col">
          <RegisterTable
            columns={OPEN_ORDER_COLUMNS}
            rows={rows.map((row, index) => ({
              id: `${row.oid}:${index}`,
              cells: {
                coin: row.coin,
                side: sideCell(row.side),
                sz: row.sz,
                limitPx: row.limitPx,
                type: row.reduceOnly ? `${row.orderType ?? "—"} · reduce` : row.orderType ?? "—",
                time: fmtTime(row.timestampMs),
              },
            }))}
          />
          <TruncationNote count={rows.length} />
        </div>
      )}
    />
  );
}

const FILL_COLUMNS: readonly RegisterColumn[] = [
  { key: "coin", label: "Coin" },
  { key: "side", label: "Side" },
  { key: "px", label: "Price", align: "right" },
  { key: "sz", label: "Size", align: "right" },
  { key: "pnl", label: "PnL", align: "right" },
  { key: "fee", label: "Fee", align: "right" },
  { key: "time", label: "Time", align: "right" },
];

function TwapHistoryPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useHyperliquidTwapHistory(sessionId);
  return (
    <RegisterPane<HyperliquidTwapHistoryDto[number]>
      query={query}
      sessionId={sessionId}
      emptyKey="twap"
      render={(rows) => (
        <div className="flex min-h-0 flex-col gap-1.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">
            TWAP history — executed slices
          </p>
          <RegisterTable
            columns={FILL_COLUMNS}
            rows={rows.map((row, index) => ({
              id: `${row.twapId}:${row.timeMs}:${index}`,
              cells: {
                coin: row.coin,
                side: sideCell(row.side),
                px: row.px,
                sz: row.sz,
                pnl: row.closedPnl,
                fee: row.fee,
                time: fmtTime(row.timeMs),
              },
            }))}
          />
          <TruncationNote count={rows.length} />
        </div>
      )}
    />
  );
}

function TradeHistoryPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useHyperliquidTradeHistory(sessionId);
  return (
    <RegisterPane<HyperliquidTradeHistoryDto[number]>
      query={query}
      sessionId={sessionId}
      emptyKey="tradeHistory"
      render={(rows) => (
        <div className="flex min-h-0 flex-col">
          <RegisterTable
            columns={FILL_COLUMNS}
            rows={rows.map((row, index) => ({
              id: `${row.oid}:${row.timeMs}:${index}`,
              cells: {
                coin: row.coin,
                side: sideCell(row.side),
                px: row.px,
                sz: row.sz,
                pnl: row.closedPnl,
                fee: row.fee,
                time: fmtTime(row.timeMs),
              },
            }))}
          />
          <TruncationNote count={rows.length} />
        </div>
      )}
    />
  );
}

const FUNDING_COLUMNS: readonly RegisterColumn[] = [
  { key: "coin", label: "Coin" },
  { key: "usdc", label: "Payment", align: "right" },
  { key: "rate", label: "Rate", align: "right" },
  { key: "szi", label: "Position", align: "right" },
  { key: "time", label: "Time", align: "right" },
];

function FundingHistoryPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useHyperliquidFundingHistory(sessionId);
  return (
    <RegisterPane<HyperliquidFundingHistoryDto[number]>
      query={query}
      sessionId={sessionId}
      emptyKey="fundingHistory"
      render={(rows) => (
        <div className="flex min-h-0 flex-col">
          <RegisterTable
            columns={FUNDING_COLUMNS}
            rows={rows.map((row, index) => ({
              id: `${row.coin}:${row.timeMs}:${index}`,
              cells: {
                coin: row.coin,
                usdc: row.usdc,
                rate: row.fundingRate,
                szi: row.szi,
                time: fmtTime(row.timeMs),
              },
            }))}
          />
          <TruncationNote count={rows.length} />
        </div>
      )}
    />
  );
}

const ORDER_HISTORY_COLUMNS: readonly RegisterColumn[] = [
  { key: "coin", label: "Coin" },
  { key: "side", label: "Side" },
  { key: "sz", label: "Size", align: "right" },
  { key: "limitPx", label: "Limit", align: "right" },
  { key: "status", label: "Status" },
  { key: "time", label: "Updated", align: "right" },
];

function OrderHistoryPane({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useHyperliquidOrderHistory(sessionId);
  return (
    <RegisterPane<HyperliquidOrderHistoryDto[number]>
      query={query}
      sessionId={sessionId}
      emptyKey="orderHistory"
      render={(rows) => (
        <div className="flex min-h-0 flex-col">
          <RegisterTable
            columns={ORDER_HISTORY_COLUMNS}
            rows={rows.map((row, index) => ({
              id: `${row.oid}:${row.statusTimeMs}:${index}`,
              cells: {
                coin: row.coin,
                side: sideCell(row.side),
                sz: row.sz,
                limitPx: row.limitPx ?? "—",
                status: row.status,
                time: fmtTime(row.statusTimeMs),
              },
            }))}
          />
          <TruncationNote count={rows.length} />
        </div>
      )}
    />
  );
}

function RegisterView({ tab, sessionId }: { readonly tab: WorkspaceTab; readonly sessionId: string | null }): JSX.Element {
  switch (tab) {
    case "openOrders":
      return <OpenOrdersPane sessionId={sessionId} />;
    case "twap":
      return <TwapHistoryPane sessionId={sessionId} />;
    case "tradeHistory":
      return <TradeHistoryPane sessionId={sessionId} />;
    case "fundingHistory":
      return <FundingHistoryPane sessionId={sessionId} />;
    case "orderHistory":
      return <OrderHistoryPane sessionId={sessionId} />;
    default:
      return <AskVexEmpty caption="No data." ask="Show my Hyperliquid account." sessionId={sessionId} />;
  }
}

export function HypervexingTabs({
  sessionId,
  positionCount,
  account,
}: {
  readonly sessionId: string | null;
  readonly positionCount: number;
  readonly account: HyperliquidAccountDto | null;
}): JSX.Element {
  const [active, setActive] = useState<WorkspaceTab>("positions");
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-[var(--vex-line)] px-4">
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              aria-current={isActive}
              className={cn(
                "relative h-9 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
                isActive
                  ? "text-[var(--vex-accent-text)]"
                  : "text-[var(--vex-text-3)] hover:text-[var(--vex-text-2)]",
              )}
            >
              {tab.label}
              {tab.id === "positions" && positionCount > 0 ? (
                <span className="ml-1 text-[var(--vex-text-2)]">{positionCount}</span>
              ) : null}
              {isActive ? (
                <motion.span
                  aria-hidden
                  layoutId="hv-tab-underline"
                  transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
                  className="absolute -bottom-px left-0 h-0.5 w-full bg-[var(--vex-accent)]"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={active}
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="min-h-0"
          >
            {active === "positions" ? (
              sessionId === null ? (
                <p className="text-[11px] text-[var(--vex-text-3)]">No open positions.</p>
              ) : (
                <HyperliquidPositionsBlock sessionId={sessionId} />
              )
            ) : active === "balances" ? (
              <BalancesPane account={account} sessionId={sessionId} />
            ) : active === "portfolio" ? (
              <PortfolioPane sessionId={sessionId} />
            ) : (
              <RegisterView tab={active} sessionId={sessionId} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
