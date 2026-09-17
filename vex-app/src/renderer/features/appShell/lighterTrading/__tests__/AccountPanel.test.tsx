import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";
import { TradingBottomPanel } from "../AccountPanel.js";
import { formatRetrievedAt } from "../format.js";

interface MockAccountQuery {
  readonly data:
    | { readonly ok: true; readonly data: LighterTradingAccount }
    | {
        readonly ok: false;
        readonly error: {
          readonly message: string;
          readonly code?: string;
          readonly retryable?: boolean;
        };
      }
    | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly refetch: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  useAccount: vi.fn(),
  useFills: vi.fn(),
  actions: {
    onReviewPosition: vi.fn(),
    onClosePosition: vi.fn(),
    onProtectPosition: vi.fn(),
    onCloseLimit: vi.fn(),
    onOpenMarket: vi.fn(),
    onCancelOrder: vi.fn(),
    onCancelAllOrders: vi.fn(),
    onFund: vi.fn(),
    onConnect: vi.fn(),
    onOpenSettings: vi.fn(),
    onRestoreCloseConfirm: vi.fn(),
  },
}));

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingAccount: mocks.useAccount,
  useLighterTradingFills: mocks.useFills,
}));

const EMPTY_ACCOUNT: LighterTradingAccount = {
  environment: "rhc",
  retrievedAt: 1_787_530_000_000,
  status: "ready",
  unavailableReason: null,
  accountIndex: 42,
  openOrdersAvailable: true,
  openOrdersTruncated: false,
  summary: {
    collateral: "1200.5",
    availableBalance: "800.25",
    unrealizedPnl: "12.75",
  },
  assets: [],
  positions: [],
  marginTerms: [],
  openOrders: [],
};

beforeEach(() => {
  mocks.refetch.mockReset();
  for (const action of Object.values(mocks.actions)) action.mockReset();
  mocks.useAccount.mockReset();
  mocks.useAccount.mockReturnValue(query());
  mocks.useFills.mockReset();
  mocks.useFills.mockReturnValue({ data: undefined, isLoading: true, isFetching: true, refetch: mocks.refetch });
});

describe("TradingBottomPanel", () => {
  it("loads positions by default, keeps the tab order, and wires tab semantics", () => {
    renderPanel();

    expect(mocks.useAccount).toHaveBeenLastCalledWith("rhc", true);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Positions",
      "Open Orders",
      "Trade History",
      "Assets",
    ]);
    const positionsTab = screen.getByRole("tab", { name: /^Positions/ });
    const positionsPanel = screen.getByRole("tabpanel", { name: /^Positions/ });
    expect(positionsTab.getAttribute("aria-selected")).toBe("true");
    expect(positionsTab.getAttribute("aria-controls")).toBe("lit-bottom-panel-positions");
    expect(positionsPanel.id).toBe("lit-bottom-panel-positions");
    expect(positionsPanel.getAttribute("aria-labelledby")).toBe("lit-bottom-tab-positions");

    const ordersTab = screen.getByRole("tab", { name: /^Open Orders/ });
    fireEvent.click(ordersTab);
    expect(ordersTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: /^Open Orders/ }).id).toBe("lit-bottom-panel-orders");
    expect(screen.getByRole("tabpanel", { name: /^Open Orders/ }).getAttribute("aria-labelledby")).toBe("lit-bottom-tab-orders");
  });

  it("keeps the account's risk in the dock header, even folded", () => {
    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: EMPTY_ACCOUNT } }));
    const view = render(panel({ collapsed: true }));
    const strip = screen.getByLabelText("Account risk");
    expect(strip.textContent).toBe("Equity1,213.25Avbl800.25uPnL+12.75 (+3.19%)Margin400.2533%");
    expect(screen.getByRole("meter", { name: "Margin usage" }).getAttribute("aria-valuenow")).toBe("33");
    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: { ...EMPTY_ACCOUNT, status: "unavailable", unavailableReason: "locked_vault", summary: null } } }));
    view.rerender(panel({ collapsed: true }));
    expect(screen.queryByLabelText("Account risk")).toBeNull();
  });

  it("keeps the account read paused while the desk is closed", () => {
    render(panel({ open: false }));
    expect(mocks.useAccount).toHaveBeenLastCalledWith("rhc", false);
  });

  it("renders account loading, provider error, and unavailable states", () => {
    mocks.useAccount.mockReturnValue(query({ isLoading: true, isFetching: true }));
    const view = renderPanel();
    expect(screen.getByText("Loading account…")).toBeTruthy();

    mocks.useAccount.mockReturnValue(query({
      data: { ok: false, error: { message: "Account read timed out" } },
    }));
    view.rerender(panel());
    expect(screen.getByText("Account read timed out")).toBeTruthy();

    mocks.useAccount.mockReturnValue(query({
      data: {
        ok: true,
        data: {
          ...EMPTY_ACCOUNT,
          status: "unavailable",
          unavailableReason: "not_onboarded",
          accountIndex: null,
        },
      },
    }));
    view.rerender(panel());
    // The dock and the ticket say the same two words for the same gap.
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect Lighter" }));
    expect(mocks.actions.onConnect).toHaveBeenCalledTimes(1);
    expect(mocks.actions.onOpenSettings).not.toHaveBeenCalled();
  });

  it("tells the reader WHY the panel is empty, and offers retry only where it helps", () => {
    // A locked vault used to read as a Lighter outage with a retry button.
    mocks.useAccount.mockReturnValue(query({
      data: {
        ok: true,
        data: {
          ...EMPTY_ACCOUNT,
          status: "unavailable",
          unavailableReason: "locked_vault",
          accountIndex: null,
        },
      },
    }));
    const view = renderPanel();
    expect(screen.getByText("Vex is locked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    mocks.useAccount.mockReturnValue(query({
      data: {
        ok: true,
        data: {
          ...EMPTY_ACCOUNT,
          status: "unavailable",
          unavailableReason: "ambiguous_account",
          accountIndex: null,
        },
      },
    }));
    view.rerender(panel());
    expect(screen.getByText("Several Lighter accounts are connected")).toBeTruthy();

    mocks.useAccount.mockReturnValue(query({
      data: {
        ok: false,
        error: {
          code: "wallet.keystore_locked",
          message: "Unlock Vex to read your Lighter account.",
          retryable: false,
        },
      },
    }));
    view.rerender(panel());
    expect(screen.getByText("Unlock Vex to read your Lighter account.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    mocks.useAccount.mockReturnValue(query({
      data: {
        ok: false,
        error: {
          code: "provider.unavailable",
          message: "Live Lighter market data is temporarily unavailable.",
          retryable: true,
        },
      },
    }));
    view.rerender(panel());
    expect(screen.getByText("Lighter is not answering")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("renders empty positions and open orders truthfully", () => {
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: EMPTY_ACCOUNT },
    }));
    renderPanel();

    expect(screen.getByText("No open positions.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Open Orders/ }));
    expect(screen.getByText("No open orders.")).toBeTruthy();
  });

  it("reads fills only on its own tab and renders them from the account's side", () => {
    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: EMPTY_ACCOUNT } }));
    mocks.useFills.mockReturnValue({
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
      data: {
        ok: true,
        data: {
          environment: "rhc",
          retrievedAt: 1_787_530_000_000,
          accountIndex: 42,
          available: true,
          fills: [{
            tradeId: "7",
            marketId: 1,
            symbol: "ETH",
            side: "sell",
            role: "maker",
            type: "liquidation",
            size: "0.5",
            price: "3200.5",
            value: "1600.25",
            realizedPnl: "-12.5",
            timestamp: 1_787_530_000_000,
          }],
        },
      },
    });
    renderPanel();
    expect(mocks.useFills).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /^Trade History/ }));
    expect(mocks.useFills).toHaveBeenLastCalledWith("rhc", true);
    const table = screen.getByRole("table", { name: "Recent Lighter fills" });
    expect(table.textContent).toContain("ETH");
    expect(table.textContent).toContain("Liquidation · Maker");
    expect(table.textContent).toContain("Sell");
    expect(table.textContent).toContain("3,200.5");
    expect(table.textContent).toContain("-12.5");

    mocks.useFills.mockReturnValue({
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
      data: { ok: true, data: { environment: "rhc", retrievedAt: 1, accountIndex: 42, available: false, fills: [] } },
    });
    fireEvent.click(screen.getByRole("tab", { name: /^Assets/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Trade History/ }));
    expect(screen.getByText(/Fills are unavailable/)).toBeTruthy();
  });

  it("renders position, remaining-order, and asset snapshot content", () => {
    const account: LighterTradingAccount = {
      ...EMPTY_ACCOUNT,
      assets: [{
        assetId: 3,
        symbol: "USDG",
        balance: "1200.5",
        available: "800.25",
        marginMode: "enabled",
      }],
      positions: [{
        marketId: 1,
        symbol: "BTC",
        side: "long",
        size: "0.25",
        entryPrice: "64000",
        value: "16000",
        unrealizedPnl: "12.75",
        liquidationPrice: "41000",
        initialMarginFraction: 1000,
        marginMode: "cross",
        allocatedMargin: "1600",
      }],
      openOrders: [{
        orderId: "order-1",
        marketId: 1,
        symbol: "BTC",
        side: "sell",
        type: "limit",
        price: "70000",
        size: "0.25",
        remaining: "0.1",
        filled: "0.15",
        clientOrderId: "client-order-1",
        timeInForce: "good-till-time",
        reduceOnly: false,
        triggerPrice: null,
        triggerStatus: null,
        triggeredAt: null,
        orderExpiry: 1_900_000_000_000,
        status: "open",
        createdAt: 1_787_530_000_000,
      }],
    };
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: account },
    }));
    renderPanel();

    expect(screen.getByRole("tab", { name: /^Positions ?\(1\)$/ })).toBeTruthy();
    expect(screen.getByText("Long · 10x Cross")).toBeTruthy();
    expect(screen.getByText("41,000")).toBeTruthy();
    expect(screen.getByText("Account #42 · " + formatRetrievedAt(EMPTY_ACCOUNT.retrievedAt))).toBeTruthy();
    // Live mark for the desk's market at its price decimals; margin and ROE
    // from the row's own terms.
    expect(screen.getByTitle("Live mark").textContent).toBe("64,100.0");
    expect(screen.getByText("of 16,000")).toBeTruthy();
    expect(screen.getByText("+0.8%")).toBeTruthy();
    // A plain resting limit is not protection: TP / SL stay empty.
    const tpSl = screen.getAllByRole("cell")[7];
    expect(tpSl?.querySelector("b")?.textContent).toBe("--");
    expect(tpSl?.querySelector("small")?.textContent).toBe("--");

    fireEvent.click(screen.getByRole("button", { name: "Review BTC position with Vex" }));
    expect(mocks.actions.onReviewPosition).toHaveBeenCalledWith(account.positions[0]);
    fireEvent.click(screen.getByRole("button", { name: "Close BTC position" }));
    expect(mocks.actions.onClosePosition).toHaveBeenCalledWith(account.positions[0], 1);
    // The row's portion rides along with both close buttons.
    fireEvent.change(screen.getByRole("combobox", { name: "Portion of BTC position to close" }), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Close BTC position" }));
    expect(mocks.actions.onClosePosition).toHaveBeenLastCalledWith(account.positions[0], 0.5);
    fireEvent.click(screen.getByRole("button", { name: "Close BTC position with a limit order" }));
    expect(mocks.actions.onCloseLimit).toHaveBeenCalledWith(account.positions[0], 0.5);
    fireEvent.click(screen.getByRole("button", { name: "Set stop loss and take profit for BTC" }));
    expect(mocks.actions.onProtectPosition).toHaveBeenCalledWith(account.positions[0]);

    fireEvent.click(screen.getByRole("tab", { name: /^Open Orders ?\(1\)$/ }));
    expect(screen.getByText("0.1")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("GTC")).toBeTruthy();
    expect(screen.getByText("Filled 0.15 / 0.25")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel BTC order order-1" }));
    expect(mocks.actions.onCancelOrder).toHaveBeenCalledWith(account.openOrders[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    expect(mocks.actions.onCancelAllOrders).toHaveBeenCalledWith(account.openOrders);

    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
    expect(screen.getByText("USDG")).toBeTruthy();
    expect(screen.getByText("Collateral").nextElementSibling?.textContent).toBe("1,200.5 USDG");
    expect(screen.getByText("Available").nextElementSibling?.textContent).toBe("800.25 USDG");
    expect(screen.getByText("Unrealized PnL").nextElementSibling?.textContent).toBe("12.75 USDG");
    expect(screen.getByText(/800\.25 available/)).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "Margin in use" });
    expect(meter.getAttribute("aria-valuenow")).toBe("33");
    expect(meter.getAttribute("data-level")).toBe("low");
    expect(screen.getByText("33.3%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(mocks.actions.onFund).toHaveBeenCalledWith("deposit");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(mocks.actions.onFund).toHaveBeenCalledWith("withdraw");
  });

  it("explains when open orders cannot be derived", () => {
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: { ...EMPTY_ACCOUNT, openOrdersAvailable: false } },
    }));
    renderPanel();

    const ordersTab = screen.getByRole("tab", { name: /^Open Orders$/ });
    expect(ordersTab.querySelector("i")).toBeNull();
    fireEvent.click(ordersTab);
    expect(screen.getByText(/Open orders are unavailable: unlock your vault/)).toBeTruthy();
  });

  it("does not blame the vault when the orders read itself failed", () => {
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: { ...EMPTY_ACCOUNT, openOrdersAvailable: false, openOrdersUnavailableReason: "read_failed" } },
    }));
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: /^Open Orders$/ }));
    expect(screen.getByText(/could not be loaded from Lighter/)).toBeTruthy();
    expect(screen.queryByText(/unlock your vault/)).toBeNull();
  });

  it("refreshes the account on demand without hiding existing rows", () => {
    const account: LighterTradingAccount = {
      ...EMPTY_ACCOUNT,
      openOrders: [limitOrder({ orderId: "resting-1" })],
    };
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: account },
      isFetching: true,
    }));
    const view = renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: /^Open Orders ?\(1\)$/ }));
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    expect(screen.getByText("Limit")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);

    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: account } }));
    view.rerender(panel());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("tells the reader when Market close skips its card and offers the way back", () => {
    // The note only matters next to a row that has a Market close button.
    const account: LighterTradingAccount = {
      ...EMPTY_ACCOUNT,
      positions: [{
        marketId: 1,
        symbol: "BTC",
        side: "long",
        size: "0.25",
        entryPrice: "64000",
        value: "16000",
        unrealizedPnl: "12.75",
        liquidationPrice: "41000",
        initialMarginFraction: 1000,
        marginMode: "cross",
        allocatedMargin: "1600",
      }],
    };
    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: account } }));
    const view = render(panel());
    expect(screen.queryByRole("note")).toBeNull();

    view.rerender(panel({ closeConfirmSkipped: true }));
    expect(screen.getByRole("note").textContent).toContain("Market close sends without confirmation.");
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(mocks.actions.onRestoreCloseConfirm).toHaveBeenCalledOnce();
  });

  it("shows every resting limit variant and discloses truncated results", () => {
    const account: LighterTradingAccount = {
      ...EMPTY_ACCOUNT,
      openOrdersTruncated: true,
      openOrders: [
        limitOrder({
          orderId: "limit-order",
          type: "limit",
          timeInForce: "post-only",
        }),
        limitOrder({
          orderId: "stop-order",
          clientOrderId: null,
          type: "stop-loss-limit",
          timeInForce: "good-till-time",
          reduceOnly: true,
          triggerPrice: "62500",
          triggerStatus: "pending",
        }),
        limitOrder({
          orderId: "take-profit-order",
          type: "take-profit-limit",
          timeInForce: "immediate-or-cancel",
          triggerPrice: "72000",
          triggerStatus: "triggered",
          triggeredAt: 1_900_000_000_000,
          orderExpiry: null,
        }),
      ],
    };
    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: account } }));
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: /^Open Orders ?\(3\+\)$/ }));

    expect(screen.getByText("Limit")).toBeTruthy();
    expect(screen.getByText("Stop-loss limit")).toBeTruthy();
    expect(screen.getByText("Take-profit limit")).toBeTruthy();
    expect(screen.getByText("Post-Only")).toBeTruthy();
    expect(screen.getByText("GTC · Reduce only")).toBeTruthy();
    expect(screen.getByText("IOC")).toBeTruthy();
    expect(screen.getByText("Trigger 62,500")).toBeTruthy();
    expect(screen.getByText("Trigger 72,000")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText(/Triggered/)).toBeTruthy();
    expect(screen.getByText("Showing a partial active-order list (up to 200).")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Open Lighter orders" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Market", "Side", "Order", "Price", "Remaining", "Status", "Actions",
    ]);
  });
});

function query(overrides: Partial<MockAccountQuery> = {}): MockAccountQuery {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    refetch: mocks.refetch,
    ...overrides,
  };
}

function limitOrder(overrides: Partial<LighterTradingAccount["openOrders"][number]> = {}): LighterTradingAccount["openOrders"][number] {
  return {
    orderId: "order-1",
    clientOrderId: "client-order-1",
    marketId: 1,
    symbol: "BTC",
    side: "sell",
    type: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    price: "70000",
    triggerPrice: null,
    triggerStatus: null,
    triggeredAt: null,
    size: "0.25",
    filled: "0.15",
    remaining: "0.1",
    orderExpiry: 1_900_000_000_000,
    status: "open",
    createdAt: 1_787_530_000_000,
    ...overrides,
  };
}

function renderPanel(): ReturnType<typeof render> {
  return render(panel());
}

function panel({ open = true, collapsed = false, closeConfirmSkipped = false }: { readonly open?: boolean; readonly collapsed?: boolean; readonly closeConfirmSkipped?: boolean } = {}) {
  return (
    <TradingBottomPanel
      environment="rhc"
      open={open}
      collapsed={collapsed}
      onToggleCollapse={() => {}}
      activeMarketId={1}
      activeMarkPrice={64_100}
      activePriceDecimals={1}
      closeConfirmSkipped={closeConfirmSkipped}
      actions={mocks.actions}
    />
  );
}
