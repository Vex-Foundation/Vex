import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";
import { TradingBottomPanel } from "../AccountPanel.js";

interface MockAccountQuery {
  readonly data:
    | { readonly ok: true; readonly data: LighterTradingAccount }
    | { readonly ok: false; readonly error: { readonly message: string } }
    | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly refetch: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  useAccount: vi.fn(),
}));

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingAccount: mocks.useAccount,
}));

const EMPTY_ACCOUNT: LighterTradingAccount = {
  environment: "rhc",
  retrievedAt: 1_787_530_000_000,
  status: "ready",
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
  openOrders: [],
};

beforeEach(() => {
  mocks.refetch.mockReset();
  mocks.useAccount.mockReset();
  mocks.useAccount.mockReturnValue(query());
});

describe("TradingBottomPanel", () => {
  it("loads positions by default, keeps the requested tab order, and wires tab semantics", () => {
    renderPanel();

    expect(mocks.useAccount).toHaveBeenLastCalledWith("rhc", true);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Positions",
      "Recent trades",
      "Open orders",
      "Assets",
    ]);
    const positionsTab = screen.getByRole("tab", { name: "Positions" });
    const positionsPanel = screen.getByRole("tabpanel", { name: "Positions" });
    expect(positionsTab.getAttribute("aria-controls")).toBe("lit-bottom-panel-positions");
    expect(positionsPanel.id).toBe("lit-bottom-panel-positions");
    expect(positionsPanel.getAttribute("aria-labelledby")).toBe("lit-bottom-tab-positions");

    const tradesTab = screen.getByRole("tab", { name: "Recent trades" });
    fireEvent.click(tradesTab);

    expect(mocks.useAccount).toHaveBeenLastCalledWith("rhc", false);
    const tradesPanel = screen.getByRole("tabpanel", { name: "Recent trades" });
    expect(tradesTab.getAttribute("aria-controls")).toBe("lit-bottom-panel-trades");
    expect(tradesPanel.id).toBe("lit-bottom-panel-trades");
    expect(tradesPanel.getAttribute("aria-labelledby")).toBe("lit-bottom-tab-trades");
    expect(screen.getByText("4200")).toBeTruthy();
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
        data: { ...EMPTY_ACCOUNT, status: "unavailable", accountIndex: null },
      },
    }));
    view.rerender(panel());
    expect(screen.getByText("No Lighter account connected")).toBeTruthy();
  });

  it("renders empty positions and open orders truthfully", () => {
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: EMPTY_ACCOUNT },
    }));
    renderPanel();

    expect(screen.getByText("No open positions.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Open orders" }));
    expect(screen.getByText("No open orders.")).toBeTruthy();
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

    expect(screen.getByText("Long")).toBeTruthy();
    expect(screen.getByText("41,000")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Open orders 1/ }));
    expect(screen.getByText("0.1")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("GTT")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
    expect(screen.getByText("USDG")).toBeTruthy();
    expect(screen.getByText("1,200.5 USDG")).toBeTruthy();
    expect(screen.getByText("800.25 USDG")).toBeTruthy();
  });

  it("refreshes open orders on entry and on demand without hiding existing rows", () => {
    const account: LighterTradingAccount = {
      ...EMPTY_ACCOUNT,
      openOrders: [limitOrder({ orderId: "resting-1" })],
    };
    mocks.useAccount.mockReturnValue(query({
      data: { ok: true, data: account },
      isFetching: true,
    }));
    const view = renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: /Open orders 1/ }));

    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Refreshing open orders…")).toBeTruthy();
    expect(screen.getByText("Limit")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh open orders" }) as HTMLButtonElement).disabled).toBe(true);

    mocks.useAccount.mockReturnValue(query({ data: { ok: true, data: account } }));
    mocks.refetch.mockReset();
    view.rerender(panel());
    fireEvent.click(screen.getByRole("button", { name: "Refresh open orders" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
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

    fireEvent.click(screen.getByRole("tab", { name: /Open orders 3\+/ }));

    expect(screen.getByText("Limit")).toBeTruthy();
    expect(screen.getByText("Stop-loss limit")).toBeTruthy();
    expect(screen.getByText("Take-profit limit")).toBeTruthy();
    expect(screen.getByText("Post only")).toBeTruthy();
    expect(screen.getByText("GTT · Reduce only")).toBeTruthy();
    expect(screen.getByText("IOC")).toBeTruthy();
    expect(screen.getByText("Trigger 62,500")).toBeTruthy();
    expect(screen.getByText("Trigger 72,000")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText(/Triggered/)).toBeTruthy();
    expect(screen.getByText("Showing a partial active-order list (up to 200).")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Open Lighter orders" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Market", "Side", "Order", "Price", "Remaining", "Status",
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

function panel() {
  return (
    <TradingBottomPanel
      trades={[{
        tradeId: "trade-1",
        type: "trade",
        price: "4200",
        size: "0.1",
        usdAmount: "420",
        takerSide: "buy",
        timestamp: 1_787_530_000_000,
      }]}
      symbol="BTC"
      environment="rhc"
      open
      tradesStatus="live"
      tradesReceivedAt={1_787_530_000_000}
    />
  );
}
