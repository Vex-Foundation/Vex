import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { DEFAULT_LIGHTER_LAYOUT, LIGHTER_BOOK_COLUMN_MIN, LIGHTER_STACK_BELOW } from "../desk-preferences.js";

const mocks = vi.hoisted(() => ({ useLighterDesk: vi.fn() }));

vi.mock("../useLighterDesk.js", () => ({ useLighterDesk: mocks.useLighterDesk }));
vi.mock("../MarketBar.js", () => ({
  MarketBar: ({ onAskVex }: { onAskVex: (() => void) | null }) => (
    <div data-testid="market-bar">
      {onAskVex === null ? null : <button type="button" onClick={onAskVex}>Ask Vex</button>}
    </div>
  ),
  streamStatusLabel: (status: string) => status,
}));
vi.mock("../MarketChart.js", () => ({
  MarketChart: (props: { toolbarStart?: ReactNode; toolbarEnd?: ReactNode }) => <div data-testid="market-chart">{props.toolbarStart}{props.toolbarEnd}</div>,
}));
vi.mock("../MarketPicker.js", () => ({ MarketPicker: () => <div data-testid="market-picker" /> }));
vi.mock("../OrderBook.js", () => ({
  MarketBookPanel: ({ splitter, heading }: { splitter?: ReactNode; heading?: ReactNode }) => (
    <div data-testid="order-book">{splitter}{heading}</div>
  ),
  TradesPanel: ({ splitter, heading }: { splitter?: ReactNode; heading?: ReactNode }) => (
    <div data-testid="trades">{splitter}{heading}</div>
  ),
}));
vi.mock("../TradeTicket.js", () => ({ TradeTicket: () => <div data-testid="trade-ticket" /> }));
vi.mock("../ApprovalCard.js", () => ({ ApprovalCard: () => <div data-testid="approval-card" /> }));
vi.mock("../../ApprovalCard.js", () => ({
  ApprovalCard: ({ summary }: { summary: { id: string } }) => <div data-testid="approval-card">{summary.id}</div>,
}));
vi.mock("../AccountPanel.js", () => ({
  TradingBottomPanel: ({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) => (
    <button type="button" onClick={onToggleCollapse}>{collapsed ? "Expand dock" : "Collapse dock"}</button>
  ),
}));

import { LighterCenter } from "../LighterCenter.js";

const market = {
  marketId: 1,
  symbol: "BTC",
  marketType: "perp",
  decimals: { price: 1, size: 4 },
} as unknown as LighterTradingMarket;

function desk(overrides: Record<string, unknown> = {}) {
  const marketList = { retrievedAt: 0, markets: [market] };
  return {
    activeSessionId: "s1",
    environment: "rhc",
    resolution: "5m",
    setResolution: vi.fn(),
    marketsQuery: { data: { ok: true, data: marketList }, isLoading: false, isFetching: false, refetch: vi.fn() },
    marketList,
    market,
    selectMarket: vi.fn(),
    marketPickerOpen: false,
    setMarketPickerOpen: vi.fn(),
    chartExpanded: false,
    setChartExpanded: vi.fn(),
    snapshotQuery: { isError: false, data: undefined, refetch: vi.fn() },
    snapshot: null,
    candleStream: { candles: [], status: "live", receivedAt: null },
    publicMarketStream: { stats: null, statsStatus: "live", statsReceivedAt: null, trades: [], bookStatus: "live", tradesStatus: "live" },
    book: { asks: [], bids: [] },
    lastPrice: null,
    dataFresh: true,
    available: null,
    settlementSymbol: "USDG",
    margin: null,
    approvals: [],
    focusApprovalId: null,
    ticketPrefill: null,
    pricePick: null,
    setPricePick: vi.fn(),
    handoffError: null,
    submitting: false,
    deskOutcome: null,
    submitDraft: vi.fn(),
    onApprovalResolved: vi.fn(),
    askVex: vi.fn(),
    openTradingSettings: vi.fn(),
    accountActions: {},
    ...overrides,
  };
}

describe("LighterCenter", () => {
  let bodyWidth = 1200;
  beforeEach(() => {
    // jsdom has no layout: the desk body measures 1200×900 and the ticket's content 400.
    bodyWidth = 1200;
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {}
      observe(element: Element): void {
        const height = element.classList.contains("lit-ticket-content") ? 400 : 900;
        this.callback([{ contentRect: { width: bodyWidth, height } }]);
      }
      disconnect(): void {}
    });
    useLighterAnalysisStore.getState().saveDesk({ layout: DEFAULT_LIGHTER_LAYOUT });
  });

  it("offers a retry only when the market list error says one can help", () => {
    const refetch = vi.fn();
    mocks.useLighterDesk.mockReturnValue(desk({
      marketList: null,
      marketsQuery: {
        data: { ok: false, error: { code: "provider.unavailable", message: "Lighter timed out.", retryable: true } },
        isLoading: false,
        isFetching: false,
        refetch,
      },
    }));
    const { unmount } = render(<LighterCenter />);
    expect(screen.getByRole("alert").textContent).toContain("Lighter is not answering");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount();

    mocks.useLighterDesk.mockReturnValue(desk({
      marketList: null,
      marketsQuery: {
        data: { ok: false, error: { code: "validation.invalid_input", message: "Bad scope.", retryable: false } },
        isLoading: false,
        isFetching: false,
        refetch,
      },
    }));
    render(<LighterCenter />);
    expect(screen.getByRole("alert").textContent).toContain("Markets unavailable");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a loading state until the market list and a market resolve", () => {
    mocks.useLighterDesk.mockReturnValue(desk({ marketList: null, market: null, marketsQuery: { data: undefined, isLoading: true, isFetching: true, refetch: vi.fn() } }));
    const { unmount } = render(<LighterCenter />);
    expect(screen.getByRole("status").textContent).toContain("Loading live Lighter markets…");
    unmount();

    mocks.useLighterDesk.mockReturnValue(desk({ market: null }));
    render(<LighterCenter />);
    expect(screen.getByRole("status").textContent).toContain("Choosing a market…");
  });

  it("lays out chart, ticket over book and the dock with three named splitters", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    render(<LighterCenter />);
    expect(screen.getByTestId("market-chart")).toBeTruthy();
    expect(screen.getByTestId("trade-ticket")).toBeTruthy();
    expect(screen.getByTestId("order-book")).toBeTruthy();
    expect(screen.getByTestId("trades")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Order ticket" })).toBeTruthy();
    expect(screen.getAllByRole("separator").map((node) => node.getAttribute("aria-label"))).toEqual([
      "Resize the order book column",
      "Resize the trades panel",
      "Resize the order ticket column",
      "Resize the account dock",
    ]);
    expect(screen.getByRole("group", { name: "Chart interval" }).querySelectorAll("button")).toHaveLength(8);
  });

  it("stacks the ticket over the book with book/trades tabs when the desk is narrow", () => {
    bodyWidth = LIGHTER_STACK_BELOW - 1;
    mocks.useLighterDesk.mockReturnValue(desk());
    const { container } = render(<LighterCenter />);
    expect(container.querySelector(".lit-desk-upper[data-stacked]")).not.toBeNull();
    expect(screen.getAllByRole("separator").map((node) => node.getAttribute("aria-label"))).toEqual([
      "Resize the order ticket column",
      "Resize the account dock",
    ]);
    const column = container.querySelector(".lit-book-column");
    expect(column?.getAttribute("data-tab")).toBe("book");
    fireEvent.click(screen.getAllByRole("tab", { name: "Trades" })[0]!);
    expect(column?.getAttribute("data-tab")).toBe("trades");
  });

  it("pops the desk's own cards in a dialog and leaves the agent's to the chat rail", () => {
    mocks.useLighterDesk.mockReturnValue(desk({
      approvals: [{ id: "a1", origin: "desk" }, { id: "a2", origin: "agent" }, { id: "a3", origin: "desk" }],
      focusApprovalId: "a3",
    }));
    const { container } = render(<LighterCenter />);
    expect(screen.getByTestId("trade-ticket")).toBeTruthy();
    const dialog = container.querySelector("dialog[data-vex-area=lighter-desk-approval]");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("Approve order");
    expect(screen.getAllByTestId("approval-card").map((node) => node.textContent)).toEqual(["a1", "a3"]);
  });

  it("keeps the desk's dialog closed while only the agent's cards are pending", () => {
    mocks.useLighterDesk.mockReturnValue(desk({ approvals: [{ id: "a2", origin: "agent" }] }));
    const { container } = render(<LighterCenter />);
    expect(container.querySelector("dialog[data-vex-area=lighter-desk-approval]")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("routes the market bar's Ask Vex and ⌘K to the desk, closing the market picker first", () => {
    const current = desk();
    mocks.useLighterDesk.mockReturnValue(current);
    render(<LighterCenter />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(current.askVex).toHaveBeenCalledTimes(1);
    expect(current.setMarketPickerOpen).toHaveBeenCalledWith(false);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(current.askVex).toHaveBeenCalledTimes(2);
    // Shift/Alt chords belong to something else.
    fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
    expect(current.askVex).toHaveBeenCalledTimes(2);
  });

  it("collapses the expanded chart on Escape unless a layer above already took the key", () => {
    const collapsed = desk();
    mocks.useLighterDesk.mockReturnValue(collapsed);
    const { unmount } = render(<LighterCenter />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(collapsed.setChartExpanded).not.toHaveBeenCalled();
    unmount();

    const expanded = desk({ chartExpanded: true });
    mocks.useLighterDesk.mockReturnValue(expanded);
    render(<LighterCenter />);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(expanded.setChartExpanded).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(expanded.setChartExpanded).toHaveBeenCalledWith(false);
  });

  it("persists splitter steps and dock collapse through the desk preferences", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    render(<LighterCenter />);
    const column = screen.getByRole("separator", { name: "Resize the order book column" });
    expect(column.getAttribute("aria-valuenow")).toBe(String(Math.round(1200 * DEFAULT_LIGHTER_LAYOUT.bookShare)));
    fireEvent.keyDown(column, { key: "Home" });
    expect(column.getAttribute("aria-valuenow")).toBe(String(LIGHTER_BOOK_COLUMN_MIN));
    // The pixel step persists as a share of the measured desk width.
    expect(useLighterAnalysisStore.getState().desk.layout.bookShare).toBeCloseTo(LIGHTER_BOOK_COLUMN_MIN / 1200);

    fireEvent.click(screen.getByRole("button", { name: "Collapse dock" }));
    expect(screen.getByRole("button", { name: "Expand dock" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize the account dock" })).toBeNull();
    expect(useLighterAnalysisStore.getState().desk.layout).toMatchObject({ bookShare: LIGHTER_BOOK_COLUMN_MIN / 1200, bottomCollapsed: true });
  });
});
