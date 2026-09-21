import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { DEFAULT_LIGHTER_LAYOUT, LIGHTER_BOOK_COLUMN_MIN, LIGHTER_STACK_BELOW } from "../desk-preferences.js";

// The always-mounted account-setup modal reads `useQueryClient()` even while
// closed (see LighterAccountSetupModal.js), so every render needs a provider
// - the app itself has one at the root; this test tree otherwise would not.
function renderCenter(...args: Parameters<typeof render>) {
  const queryClient = new QueryClient();
  return render(<QueryClientProvider client={queryClient}>{args[0]}</QueryClientProvider>, args[1]);
}

const mocks = vi.hoisted(() => ({ useLighterDesk: vi.fn() }));

vi.mock("../useLighterDesk.js", () => ({ useLighterDesk: mocks.useLighterDesk }));
vi.mock("../MarketBar.js", () => ({
  MarketBar: () => <div data-testid="market-bar" />,
  streamStatusLabel: (status: string) => status,
}));
vi.mock("../MarketChart.js", () => ({
  MarketChart: (props: { toolbarStart?: ReactNode; toolbarEnd?: ReactNode }) => <div data-testid="market-chart">{props.toolbarStart}{props.toolbarEnd}</div>,
}));
vi.mock("../MarketPicker.js", () => ({ MarketPicker: () => <div data-testid="market-picker" /> }));
vi.mock("../OrderBook.js", () => ({
  MarketBookPanel: ({ splitter, heading, preferredView }: { splitter?: ReactNode; heading?: ReactNode; preferredView?: string }) => (
    <div data-testid="order-book" data-view={preferredView}>{splitter}{heading}</div>
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
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 2,
  minBaseAmount: "0.0001",
  minQuoteAmount: "1",
  orderQuoteLimit: "1000000",
  decimals: { price: 1, size: 4, quote: 2 },
  fees: { maker: "0", taker: "0", makerEnabled: true, takerEnabled: true, integratorMaker: null, integratorTaker: null },
  activity24h: { tradesCount: null, quoteVolume: null },
} satisfies LighterTradingMarket;

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
    setupModalOpen: false,
    closeLighterSetup: vi.fn(),
    onLighterSetupDone: vi.fn(),
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

  it("keys the desk theme to the selected Lighter environment", () => {
    mocks.useLighterDesk.mockReturnValue(desk({ environment: "rhc" }));
    const rhc = renderCenter(<LighterCenter />);
    expect(
      rhc.container.querySelector('[data-vex-area="lighter-desk"]')?.getAttribute("data-lighter-environment"),
    ).toBe("rhc");
    rhc.unmount();

    mocks.useLighterDesk.mockReturnValue(desk({ environment: "core", settlementSymbol: "USDC" }));
    const core = renderCenter(<LighterCenter />);
    expect(
      core.container.querySelector('[data-vex-area="lighter-desk"]')?.getAttribute("data-lighter-environment"),
    ).toBe("core");
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
    const { unmount } = renderCenter(<LighterCenter />);
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
    renderCenter(<LighterCenter />);
    expect(screen.getByRole("alert").textContent).toContain("Markets unavailable");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a loading state until the market list and a market resolve", () => {
    mocks.useLighterDesk.mockReturnValue(desk({ marketList: null, market: null, marketsQuery: { data: undefined, isLoading: true, isFetching: true, refetch: vi.fn() } }));
    const { unmount } = renderCenter(<LighterCenter />);
    expect(screen.getByRole("status").textContent).toContain("Loading live Lighter markets…");
    unmount();

    mocks.useLighterDesk.mockReturnValue(desk({ market: null }));
    renderCenter(<LighterCenter />);
    expect(screen.getByRole("status").textContent).toContain("Choosing a market…");
  });

  it("lays out chart, market depth and ticket with four named splitters on a wide desk", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    renderCenter(<LighterCenter />);
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

  it("keeps the ticket at full height and tabs market depth below the chart on a compact desk", () => {
    bodyWidth = LIGHTER_STACK_BELOW - 1;
    mocks.useLighterDesk.mockReturnValue(desk());
    const { container } = renderCenter(<LighterCenter />);
    const upper = container.querySelector<HTMLElement>(".lit-desk-upper[data-stacked]");
    expect(upper).not.toBeNull();
    expect(upper?.style.gridTemplateRows).toBe("minmax(0, 1fr) 240px");
    expect(screen.getByTestId("order-book").getAttribute("data-view")).toBe("split");
    expect(screen.getAllByRole("separator").map((node) => node.getAttribute("aria-label"))).toEqual([
      "Resize chart and market depth",
      "Resize the order ticket column",
      "Resize the account dock",
    ]);
    const column = container.querySelector(".lit-book-column");
    expect(column?.getAttribute("data-tab")).toBe("book");
    const tradesTab = screen.getAllByRole("tab", { name: "Trades" })[0];
    if (!tradesTab) throw new Error("trades tab missing");
    fireEvent.click(tradesTab);
    expect(column?.getAttribute("data-tab")).toBe("trades");
  });

  it("resizes compact market depth without changing ticket or wide-layout proportions", () => {
    bodyWidth = 900;
    mocks.useLighterDesk.mockReturnValue(desk());
    renderCenter(<LighterCenter />);
    const seam = screen.getByRole("separator", { name: "Resize chart and market depth" });
    fireEvent.keyDown(seam, { key: "ArrowUp" });
    const saved = useLighterAnalysisStore.getState().desk.layout;
    expect(saved.compactBookShare).toBeCloseTo(216 / 719);
    expect(saved.ticketShare).toBe(DEFAULT_LIGHTER_LAYOUT.ticketShare);
    expect(saved.tradesShare).toBe(DEFAULT_LIGHTER_LAYOUT.tradesShare);
    fireEvent.doubleClick(seam);
    expect(useLighterAnalysisStore.getState().desk.layout.compactBookShare).toBeCloseTo(240 / 719);
  });

  it("pops the desk's own cards in a dialog and leaves the agent's to the chat rail", () => {
    mocks.useLighterDesk.mockReturnValue(desk({
      approvals: [
        { id: "a1", origin: "desk", preview: { namespace: "lighter", toolName: "order.create", criticalArgs: {} } },
        { id: "a2", origin: "agent", preview: { namespace: "lighter", toolName: "order.create", criticalArgs: {} } },
        { id: "a3", origin: "desk", preview: { namespace: "lighter", toolName: "order.create", criticalArgs: {} } },
      ],
      focusApprovalId: "a3",
    }));
    const { container } = renderCenter(<LighterCenter />);
    expect(screen.getByTestId("trade-ticket")).toBeTruthy();
    const dialog = container.querySelector("dialog[data-vex-area=lighter-desk-approval]");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("Review order");
    expect(screen.getAllByTestId("approval-card").map((node) => node.textContent)).toEqual(["a1", "a3"]);
  });

  it("keeps the desk's dialog closed while only the agent's cards are pending", () => {
    mocks.useLighterDesk.mockReturnValue(desk({ approvals: [{ id: "a2", origin: "agent" }] }));
    const { container } = renderCenter(<LighterCenter />);
    expect(container.querySelector("dialog[data-vex-area=lighter-desk-approval]")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("opens Vex with the keyboard without repeating an Ask button on the chart", () => {
    const current = desk();
    mocks.useLighterDesk.mockReturnValue(current);
    renderCenter(<LighterCenter />);
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(current.askVex).toHaveBeenCalledWith(true);
    expect(current.setMarketPickerOpen).toHaveBeenCalledWith(false);
    fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
    expect(current.askVex).toHaveBeenCalledTimes(1);
  });

  it("turns the resident chart into the Zen canvas and opens Vex without restoring the rail", () => {
    const current = desk();
    const openZenAssistant = vi.fn();
    mocks.useLighterDesk.mockReturnValue(current);
    const { container } = renderCenter(
      <LighterCenter zenMode onOpenZenAssistant={openZenAssistant} />,
    );

    const root = container.querySelector('[data-vex-area="lighter-desk"]');
    expect(root?.getAttribute("data-chart-expanded")).toBe("true");
    expect(root?.getAttribute("data-zen-mode")).toBe("true");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(openZenAssistant).toHaveBeenCalledTimes(1);
    expect(current.askVex).toHaveBeenCalledWith(false);
  });

  it("keeps environment setup visible above the Zen chart", () => {
    mocks.useLighterDesk.mockReturnValue(desk({
      environment: "core",
      settlementSymbol: "USDC",
      setupModalOpen: true,
    }));
    const { container } = renderCenter(<LighterCenter zenMode />);

    const dialog = container.querySelector<HTMLDialogElement>(
      'dialog[data-vex-area="lighter-account-setup"]',
    );
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.getAttribute("data-lighter-environment")).toBe("core");
    expect(dialog?.closest(".lit-desk-body")).toBeNull();
    expect(dialog?.closest('[data-vex-area="lighter-desk"]')).not.toBeNull();
  });

  it("persists splitter steps and dock collapse through the desk preferences", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    renderCenter(<LighterCenter />);
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
