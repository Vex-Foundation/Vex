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
}

const mocks = vi.hoisted(() => ({
  useAccount: vi.fn((_environment: string, _enabled: boolean): MockAccountQuery => ({
    data: undefined,
    isLoading: false,
  })),
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
  mocks.useAccount.mockReset();
  mocks.useAccount.mockReturnValue({ data: undefined, isLoading: false });
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
    mocks.useAccount.mockReturnValue({ data: undefined, isLoading: true });
    const view = renderPanel();
    expect(screen.getByText("Loading account…")).toBeTruthy();

    mocks.useAccount.mockReturnValue({
      data: { ok: false, error: { message: "Account read timed out" } },
      isLoading: false,
    });
    view.rerender(panel());
    expect(screen.getByText("Account read timed out")).toBeTruthy();

    mocks.useAccount.mockReturnValue({
      data: {
        ok: true,
        data: { ...EMPTY_ACCOUNT, status: "unavailable", accountIndex: null },
      },
      isLoading: false,
    });
    view.rerender(panel());
    expect(screen.getByText("No Lighter account connected")).toBeTruthy();
  });

  it("renders empty positions and open orders truthfully", () => {
    mocks.useAccount.mockReturnValue({
      data: { ok: true, data: EMPTY_ACCOUNT },
      isLoading: false,
    });
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
        status: "open",
        createdAt: 1_787_530_000_000,
      }],
    };
    mocks.useAccount.mockReturnValue({
      data: { ok: true, data: account },
      isLoading: false,
    });
    renderPanel();

    expect(screen.getByText("Long")).toBeTruthy();
    expect(screen.getByText("41,000")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Open orders 1/ }));
    expect(screen.getByText("0.1")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
    expect(screen.getByText("USDG")).toBeTruthy();
    expect(screen.getByText("1,200.5 USDG")).toBeTruthy();
    expect(screen.getByText("800.25 USDG")).toBeTruthy();
  });
});

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
