import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { DEFAULT_LIGHTER_LAYOUT, LIGHTER_BOTTOM_MIN, LIGHTER_STACK_BELOW, deskBookHeight } from "../desk-preferences.js";

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
  MarketSelectKey: ({ onOpen }: { onOpen: () => void }) => (
    <button type="button" data-testid="zen-market-key" onClick={onOpen} />
  ),
  MarketLastPrice: () => <span data-testid="zen-last-price" />,
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
import { setDeskReviewSlot } from "../desk-review-slot.js";

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

  it("stands the chart over the book beside the ticket, with the dock's one splitter (H3-DESKTOP.md section 4.9)", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    const { container } = renderCenter(<LighterCenter />);
    expect(screen.getByTestId("market-chart")).toBeTruthy();
    expect(screen.getByTestId("trade-ticket")).toBeTruthy();
    expect(screen.getByTestId("order-book")).toBeTruthy();
    expect(screen.getByTestId("trades")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Order ticket" })).toBeTruthy();
    // The ticket's width is the sheet's fixed column; only the dock resizes.
    expect(screen.getAllByRole("separator").map((node) => node.getAttribute("aria-label"))).toEqual([
      "Resize the account dock",
    ]);
    const upper = container.querySelector<HTMLElement>(".lit-desk-upper");
    expect(upper?.style.gridTemplateColumns).toBe("");
    // The chart over the book, the book as high as its rows (jsdom's window
    // is 768 high: four levels a side).
    const main = container.querySelector<HTMLElement>(".lit-desk-main");
    expect(main?.parentElement).toBe(upper);
    expect(main?.style.gridTemplateRows).toBe(`minmax(0, 1fr) ${String(deskBookHeight(4))}px`);
    expect(container.querySelector(".lit-book-column")?.getAttribute("data-book-rows")).toBe("4");
    expect(screen.getByRole("group", { name: "Chart interval" }).querySelectorAll("button")).toHaveLength(8);
  });

  it("keeps bids beside asks under the chart at every width, with Trades as a tab", () => {
    for (const width of [900, LIGHTER_STACK_BELOW + 200]) {
      bodyWidth = width;
      mocks.useLighterDesk.mockReturnValue(desk());
      const { container, unmount } = renderCenter(<LighterCenter />);
      expect(screen.getByTestId("order-book").getAttribute("data-view")).toBe("split");
      const column = container.querySelector(".lit-book-column");
      expect(column?.getAttribute("data-tab")).toBe("book");
      const tradesTab = screen.getAllByRole("tab", { name: "Trades" })[0];
      if (!tradesTab) throw new Error("trades tab missing");
      fireEvent.click(tradesTab);
      expect(column?.getAttribute("data-tab")).toBe("trades");
      unmount();
    }
  });

  it("shows the desk's own cards in the ticket's place and leaves the agent's to the chat rail", () => {
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

  it("stands the review in the ticket's own column while it shows, and returns the ticket after", () => {
    // The real ticket keeps a slot beside its form; the mocked one does not,
    // so the slot is provided here, as the ticket would.
    const slot = document.createElement("div");
    document.body.append(slot);
    setDeskReviewSlot(slot);
    try {
      mocks.useLighterDesk.mockReturnValue(desk({
        approvals: [
          { id: "a1", origin: "desk", preview: { namespace: "lighter", toolName: "order.create", criticalArgs: {} } },
        ],
        focusApprovalId: "a1",
      }));
      const queryClient = new QueryClient();
      const { container, rerender } = render(<LighterCenter />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      });
      const upper = (): HTMLElement | null => container.querySelector<HTMLElement>(".lit-desk-upper");
      // The review takes the ticket's 340 column (lighter-desk.css): nothing
      // about the columns changes while it shows, so the card's box is the
      // ticket's.
      expect(upper()?.hasAttribute("data-ticket-review")).toBe(true);
      expect(upper()?.style.gridTemplateColumns).toBe("");
      mocks.useLighterDesk.mockReturnValue(desk({ approvals: [] }));
      rerender(<LighterCenter />);
      expect(upper()?.hasAttribute("data-ticket-review")).toBe(false);
      expect(useLighterAnalysisStore.getState().desk.layout.ticketShare).toBe(
        DEFAULT_LIGHTER_LAYOUT.ticketShare,
      );
    } finally {
      setDeskReviewSlot(null);
      slot.remove();
    }
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
    expect(root?.getAttribute("data-zen-mode")).toBe("true");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(openZenAssistant).toHaveBeenCalledTimes(1);
    expect(current.askVex).toHaveBeenCalledWith(false);
  });

  it("makes the chart's toolbar Zen's row: the market and its price, the intervals, Ask Vex, the fold key, Exit Zen", () => {
    // docs/design/H3-DESKTOP.md section 4.9, the approved `lighter-zen` plate.
    mocks.useLighterDesk.mockReturnValue(desk());
    const zen = {
      controlsOpen: false,
      assistantOpen: false,
      onToggleControls: vi.fn(),
      onToggleAssistant: vi.fn(),
      onExit: vi.fn(),
    };
    const { container, rerender } = renderCenter(<LighterCenter zenMode zenControls={zen} />);
    const root = container.querySelector('[data-vex-area="lighter-desk"]');
    // Zen opens folded, as before H3.
    expect(root?.getAttribute("data-zen-controls")).toBe("closed");
    const chart = screen.getByTestId("market-chart");
    const order = Array.from(chart.querySelectorAll("[data-testid], [aria-label]")).map(
      (node) => node.getAttribute("data-testid") ?? node.getAttribute("aria-label"),
    );
    expect(order.slice(0, 3)).toEqual(["zen-market-key", "zen-last-price", "Chart interval"]);
    expect(order.slice(-3)).toEqual(["Ask Vex", "Show Zen controls", "Exit Zen Mode"]);
    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    expect(zen.onToggleControls).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen Mode" }));
    expect(zen.onExit).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <LighterCenter zenMode zenControls={{ ...zen, controlsOpen: true, assistantOpen: true }} />
      </QueryClientProvider>,
    );
    const shown = container.querySelector('[data-vex-area="lighter-desk"]');
    expect(shown?.getAttribute("data-zen-controls")).toBe("open");
    expect(screen.getByRole("button", { name: "Hide Zen controls" }).getAttribute("aria-expanded")).toBe("true");
    const ask = screen.getByRole("button", { name: "Close Vex" });
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ask);
    expect(zen.onToggleAssistant).toHaveBeenCalledTimes(1);
    // The market key opens the picker, which hangs from Zen's row.
    fireEvent.click(screen.getByTestId("zen-market-key"));
    expect(mocks.useLighterDesk.mock.results.at(-1)?.value.setMarketPickerOpen).toHaveBeenCalled();
  });

  it("off Zen draws none of Zen's row", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    const { container } = renderCenter(<LighterCenter />);
    expect(container.querySelector('[data-vex-area="lighter-desk"]')?.hasAttribute("data-zen-controls")).toBe(false);
    expect(screen.queryByTestId("zen-market-key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Exit Zen Mode" })).toBeNull();
  });

  it("closes the market picker first on Escape in Zen, so Zen's own key skips the press", () => {
    const current = desk({ marketPickerOpen: true });
    mocks.useLighterDesk.mockReturnValue(current);
    renderCenter(<LighterCenter zenMode />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(current.setMarketPickerOpen).toHaveBeenCalledWith(false);
  });

  it("leaves Escape alone on the desk while the picker is open: the picker keeps its own", () => {
    const current = desk({ marketPickerOpen: true });
    mocks.useLighterDesk.mockReturnValue(current);
    renderCenter(<LighterCenter />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
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

  it("persists the dock's splitter steps and its collapse through the desk preferences", () => {
    mocks.useLighterDesk.mockReturnValue(desk());
    renderCenter(<LighterCenter />);
    const seam = screen.getByRole("separator", { name: "Resize the account dock" });
    fireEvent.keyDown(seam, { key: "Home" });
    expect(seam.getAttribute("aria-valuenow")).toBe(String(LIGHTER_BOTTOM_MIN));
    // The pixel step persists as a share of the measured desk height.
    expect(useLighterAnalysisStore.getState().desk.layout.bottomShare).toBeCloseTo(LIGHTER_BOTTOM_MIN / 900);

    fireEvent.click(screen.getByRole("button", { name: "Collapse dock" }));
    expect(screen.getByRole("button", { name: "Expand dock" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize the account dock" })).toBeNull();
    expect(useLighterAnalysisStore.getState().desk.layout).toMatchObject({ bottomShare: LIGHTER_BOTTOM_MIN / 900, bottomCollapsed: true });
  });
});
