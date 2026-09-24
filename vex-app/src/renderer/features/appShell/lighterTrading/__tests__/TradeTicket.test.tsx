import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import type { TicketMargin } from "../ticket-model.js";
import { TradeTicket } from "../TradeTicket.js";

/** The two side buttons' visible names, in order. */
function sideButtons(groupName: string): string[] {
  return within(screen.getByRole("group", { name: groupName })).getAllByRole("button")
    .map((button) => button.querySelector("b")?.textContent ?? "");
}

const PERP: LighterTradingMarket = {
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true, integratorMaker: "0.1", integratorTaker: "0.1" },
  activity24h: { tradesCount: 120, quoteVolume: 1_600_000 },
};

const SPOT: LighterTradingMarket = {
  ...PERP,
  marketId: 2048,
  symbol: "ETH/USDG",
  marketType: "spot",
};

/** 10x cross with a 4% maintenance requirement. */
const MARGIN: TicketMargin = { initialMarginFraction: 1_000, maintenanceMarginFraction: 400, marginMode: "cross", source: "market" };

const BOOK = {
  asks: [{ orderId: "a1", price: "3210.50", size: "4" }],
  bids: [{ orderId: "b1", price: "3199.50", size: "3" }],
};

function renderTicket(overrides: Partial<Parameters<typeof TradeTicket>[0]> = {}): {
  readonly onSend: ReturnType<typeof vi.fn>;
  readonly onConnect: ReturnType<typeof vi.fn>;
  readonly onOpenLeverage: ReturnType<typeof vi.fn>;
  readonly rerender: (next: Partial<Parameters<typeof TradeTicket>[0]>) => void;
} {
  const onSend = vi.fn();
  const onConnect = vi.fn();
  const onOpenLeverage = vi.fn();
  const base = {
    market: PERP,
    book: BOOK,
    lastPrice: 3_205,
    available: "5000",
    equity: 10_000,
    margin: MARGIN,
    settlementSymbol: "USDG",
    activeSession: true,
    dataFresh: true,
    submitting: false,
    onSend,
    onConnect,
    onOpenLeverage,
  };
  const view = render(<TradeTicket {...base} {...overrides} />);
  return {
    onSend,
    onConnect,
    onOpenLeverage,
    rerender: (next) => view.rerender(<TradeTicket {...base} {...overrides} {...next} />),
  };
}

describe("Light it up trade ticket", () => {
  it("shows each successful order notice below the side buttons for twenty seconds", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderTicket({ outcome: { tone: "ok", text: "Close sent." } });
      const actions = screen.getByRole("group", { name: "Order side" });
      const first = document.querySelector(".lit-review-outcome");
      if (!first) throw new Error("expected the first order notice");
      expect(first.querySelector(".lit-review-outcome-text")?.textContent).toBe("Close sent.");
      expect(actions.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(first.querySelector(".lit-review-outcome-timer")).not.toBeNull();

      act(() => { vi.advanceTimersByTime(19_999); });
      expect(document.querySelector(".lit-review-outcome")).not.toBeNull();
      rerender({ outcome: { tone: "ok", text: "Order opened." } });
      act(() => { vi.advanceTimersByTime(1); });
      expect(document.querySelector(".lit-review-outcome")?.textContent).toBe("Order opened.");
      act(() => { vi.advanceTimersByTime(19_998); });
      expect(document.querySelector(".lit-review-outcome")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(document.querySelector(".lit-review-outcome")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows uncertain order outcomes with the same twenty-second countdown", () => {
    vi.useFakeTimers();
    try {
      renderTicket({ outcome: { tone: "warn", text: "Outcome unknown. Check Orders before retrying." } });
      expect(document.querySelector(".lit-review-outcome")?.textContent).toContain("Outcome unknown");
      expect(document.querySelector(".lit-review-outcome-timer")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(document.querySelector(".lit-review-outcome")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the trader dismiss a notice without hiding a later one", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderTicket({ outcome: { tone: "ok", text: "Close sent." } });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(screen.queryByRole("status")).toBeNull();

      rerender({ outcome: { tone: "error", text: "Order unavailable." } });
      expect(screen.getByRole("alert").textContent).toContain("Order unavailable.");
      act(() => { vi.advanceTimersByTime(19_999); });
      expect(screen.getByRole("alert")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("places preview errors below Long and Short, then clears them after twenty seconds", () => {
    vi.useFakeTimers();
    try {
      renderTicket({ handoffError: "Lighter order preview unavailable (fetch failed)" });
      const actions = screen.getByRole("group", { name: "Order side" });
      const notice = screen.getByRole("alert");
      expect(actions.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(notice.textContent).toContain("Lighter order preview unavailable");
      expect(notice.querySelector(".lit-review-outcome-timer")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a new error replace a success without reviving the old success", () => {
    const success = { tone: "ok" as const, text: "Order opened." };
    const { rerender } = renderTicket({ outcome: success });
    expect(screen.getByRole("status").textContent).toContain("Order opened");
    rerender({ handoffError: "Lighter order preview unavailable" });
    expect(screen.getByRole("alert").textContent).toContain("preview unavailable");
    rerender({ handoffError: null });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("times out validation feedback while keeping the disabled action's reason accessible", () => {
    vi.useFakeTimers();
    try {
      renderTicket();
      fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.0005" } });
      const notice = screen.getByRole("status");
      const actions = screen.getByRole("group", { name: "Order side" });
      expect(actions.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(notice.textContent).toContain("Minimum size is 0.001 ETH.");
      expect(notice.querySelector(".lit-review-outcome-timer")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByRole("status")).toBeNull();
      const long = screen.getByRole("button", { name: "Long 0.0005 ETH" });
      expect((long as HTMLButtonElement).disabled).toBe(true);
      expect(long.getAttribute("aria-description")).toBe("Minimum size is 0.001 ETH.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the approval review action available after its timed notice ends", () => {
    vi.useFakeTimers();
    try {
      const onReviewApprovals = vi.fn();
      renderTicket({ pendingApprovalCount: 1, onReviewApprovals });
      const actions = screen.getByRole("group", { name: "Order side" });
      const notice = screen.getByRole("status");
      expect(notice.textContent).toContain("Approval waiting");
      expect(actions.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByRole("status")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Review pending approval" }));
      expect(onReviewApprovals).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps account context and order actions outside the scrolling field body", () => {
    renderTicket();
    const ticket = document.querySelector<HTMLFormElement>("form.lit-ticket");
    if (ticket === null) throw new Error("ticket missing");
    expect(Array.from(ticket.children).map((node) => node.className)).toEqual([
      "lit-ticket-meta",
      "lit-ticket-body",
      "lit-ticket-footer",
    ]);
    expect(ticket.querySelector(".lit-ticket-meta")?.parentElement).toBe(ticket);
    expect(ticket.querySelector(".lit-side-actions")?.parentElement?.className).toBe("lit-ticket-footer");
    expect(screen.getByText("Price click → Limit · Shift-click → Trigger")).toBeTruthy();
  });

  it("collapses to one truthful setup block while no account is onboarded", () => {
    const { onConnect, onOpenLeverage, rerender } = renderTicket({ available: null, accountGap: "not_onboarded" });
    expect(screen.queryAllByRole("button", { name: /^(Long|Short|Buy|Sell)\b/ })).toHaveLength(0);
    // No form of dashes: no size field, no order type tabs, just the way in.
    expect(screen.queryByLabelText("Size")).toBeNull();
    expect(screen.queryByRole("button", { name: "Limit" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Lighter setup");
    // Steps are listed even before the checklist read lands, without a status mark.
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(["First deposit", "Trading key", "Fee approval"]);
    fireEvent.click(screen.getByRole("button", { name: "Set up Lighter" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onOpenLeverage).not.toHaveBeenCalled();

    // Once read, each step carries where the wallet stands.
    rerender({ checklist: {
      deposit: "done",
      key: "todo",
      fee: "not_required",
      progress: "action_required",
      detail: "Trading key approval is required.",
      nextAction: "continue_setup",
      updatedAt: "2026-09-18T00:01:00.000Z",
    } });
    const marked = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(marked.map((step) => step.textContent)).toEqual(["First depositDone", "Trading keyTo do", "Fee approvalNot needed"]);
    expect(marked.map((step) => step.getAttribute("data-state"))).toEqual(["done", "todo", "not_required"]);
    expect(screen.getByText("Trading key approval is required.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue setup" })).toBeTruthy();

    // A locked vault is not a missing account: the preview stays, the vault flow unlocks.
    rerender({ accountGap: "locked_vault" });
    expect(screen.getAllByRole("button", { name: /^(Long|Short|Buy|Sell)\b/ })).toHaveLength(2);
  });

  it("offers only Market and Limit, and emits an exact native OCO draft once a position loads one", () => {
    const { onSend, rerender } = renderTicket();

    const orderTypes = screen.getByRole("group", { name: "Order type" });
    expect(within(orderTypes).getByRole("button", { name: "Market", pressed: true })).toBeTruthy();
    expect(within(orderTypes).getByRole("button", { name: "Limit", pressed: false })).toBeTruthy();
    expect(within(orderTypes).getAllByRole("button")).toHaveLength(2);
    expect(within(orderTypes).queryByRole("combobox")).toBeNull();
    expect(sideButtons("Order side")).toEqual(["Long", "Short"]);

    // Protection modes are loaded from the Positions tab or the agent, never picked here.
    rerender({ prefill: { key: 1, mode: "oco", side: "sell", baseAmount: "", reduceOnly: true } });
    expect(within(orderTypes).getByRole("button", { name: "SL + TP", pressed: true })).toBeTruthy();
    expect(sideButtons("Position close side")).toEqual(["Buy", "Sell"]);
    expect(screen.getByText("Reduce only. Sell protects a long, buy protects a short.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Sell/ }));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("Stop loss trigger price"), { target: { value: "2900" } });
    fireEvent.change(screen.getByLabelText("Stop loss minimum sell price"), { target: { value: "2850" } });
    fireEvent.change(screen.getByLabelText("Take profit trigger price"), { target: { value: "3300" } });
    fireEvent.change(screen.getByLabelText("Take profit minimum sell price"), { target: { value: "3250" } });
    expect(screen.getByText("Native OCO")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sell SL + TP 0.1 ETH" }));

    expect(onSend).toHaveBeenCalledWith({
      mode: "oco",
      side: "sell",
      baseAmount: "0.1",
      stopLossTriggerPrice: "2900",
      stopLossPrice: "2850",
      takeProfitTriggerPrice: "3300",
      takeProfitPrice: "3250",
    });
    expect(screen.getByRole("note").textContent).toContain("Nothing signs until you confirm");
  });

  it("keeps a dismissed pending approval recoverable from the ticket", () => {
    const onReviewApprovals = vi.fn();
    renderTicket({ pendingApprovalCount: 1, onReviewApprovals });

    expect(screen.getByText(/Approval waiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review pending approval" }));
    expect(onReviewApprovals).toHaveBeenCalledTimes(1);
  });

  it("bounds a market order from the live inside price and the chosen slippage", () => {
    const { onSend } = renderTicket();

    expect(screen.getByRole("button", { name: "0.5%", pressed: true })).toBeTruthy();
    expect(screen.getByText("Max Buy").nextElementSibling?.textContent).toBe("3,226.56");
    expect(screen.getByRole("button", { name: "Long" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(screen.getByText("Order Value").nextElementSibling?.textContent).toBe("1,613.28 USD");
    expect(screen.getByText("Fee (Taker)").getAttribute("title")).toBe("Taker 0.0003% + Vex 0.1%");
    fireEvent.click(screen.getByRole("button", { name: "Long 0.5 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith({
      mode: "market",
      side: "buy",
      baseAmount: "0.5",
      worstPrice: "3226.56",
      reduceOnly: false,
      protection: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "1%" }));
    expect(screen.getByText("Max Buy").nextElementSibling?.textContent).toBe("3,242.61");

    // The other side's button flips the ticket and previews for that side at once.
    fireEvent.click(screen.getByRole("button", { name: "Short 0.5 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ side: "sell", worstPrice: "3167.5" }));
    expect(screen.getByRole("button", { name: "Short 0.5 ETH" }).getAttribute("type")).toBe("submit");
    fireEvent.change(screen.getByLabelText("Max slippage percent"), { target: { value: "0.5" } });
    expect(screen.getByText("Min Sell").nextElementSibling?.textContent).toBe("3,183.5");
    fireEvent.click(screen.getByLabelText("Reduce-Only"));
    fireEvent.click(screen.getByRole("button", { name: "Short 0.5 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith({
      mode: "market",
      side: "sell",
      baseAmount: "0.5",
      worstPrice: "3183.5",
      reduceOnly: true,
      protection: null,
    });
  });

  it("refuses a market order without a live inside price", () => {
    renderTicket({ book: { asks: [], bids: [] }, lastPrice: null });

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(screen.getByText("Max Buy").nextElementSibling?.textContent).toBe("--");
    expect(screen.getByRole("status").textContent).toBe("A live inside price is required to bound a market order.");
    expect((screen.getByRole("button", { name: "Long 0.5 ETH" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("converts a quote-denominated size and sizes from the leveraged maximum", () => {
    const { onSend } = renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Size unit: ETH. Switch" }));
    fireEvent.change(screen.getByLabelText("Size in quote"), { target: { value: "1000" } });
    expect(screen.getByText("≈ 0.3099 ETH")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Long 0.3099 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ baseAmount: "0.3099" }));

    fireEvent.click(screen.getByRole("button", { name: "Size unit: USD. Switch" }));
    // Max reserves BOTH fee legs, so Vex's 0.1% shrinks it alongside the provider's.
    expect(screen.getByText("Max Size").nextElementSibling?.textContent).toBe("15.3424 ETH");
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("7.6712");
    expect(screen.getByRole("button", { name: "50%", pressed: true })).toBeTruthy();
    expect(screen.getByText("5,000 USDG")).toBeTruthy();
  });

  it("drags the size slider against the maximum and follows a typed size", () => {
    renderTicket();

    const slider = screen.getByRole("slider", { name: "Size as percent of maximum" }) as HTMLInputElement;
    expect(slider.value).toBe("0");
    fireEvent.change(slider, { target: { value: "40" } });
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("6.1369");
    // Typing moves the thumb to the nearest whole percent of the maximum.
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "7.71" } });
    expect(slider.value).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "0%" }));
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("");
    expect(slider.value).toBe("0");
  });

  it("sizes against the account's own fee tier and the mark, and shows the tier it charges", () => {
    renderTicket({ exchangeFees: { makerTicks: 120, takerTicks: 350, source: "account" }, markPrice: 3_200 });

    // 15.3424 without them; the 0.035% tier, the gap between the 3210.50 ask
    // and the 3200 mark, and walking past the ask's 4 ETH all come out of it.
    expect(screen.getByText("Max Size").nextElementSibling?.textContent).toBe("14.3169 ETH");
    expect(screen.getByText("Fee (Taker)").getAttribute("title")).toBe("Taker 0.035% (account tier) + Vex 0.1%");
  });

  it("ignores a mark left over from the previously selected market", () => {
    // A BTC mark still in the stream for the render after switching to ETH.
    renderTicket({ exchangeFees: { makerTicks: 120, takerTicks: 350, source: "account" }, markPrice: 84_000 });

    // Sized as if no mark were known, not collapsed to margin at 84,000.
    expect(screen.getByText("Max Size").nextElementSibling?.textContent).toBe("15.2899 ETH");
  });

  it("disables the size presets when the account balance is unknown", () => {
    renderTicket({ available: null });

    expect((screen.getByRole("button", { name: "25%" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Avbl").nextElementSibling?.textContent).toBe("--");
    expect(screen.getByText("Max Size").nextElementSibling?.textContent).toBe("--");
  });

  it("shows margin cost and an isolated liquidation estimate from the market margin terms", () => {
    renderTicket();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.4" } });
    expect(screen.getByText("Cost").nextElementSibling?.textContent).toBe("129.06 USD");
    expect(screen.getByText("Liq. Price").nextElementSibling?.textContent).toBe("≈ 3,032.97");

    fireEvent.click(screen.getByRole("button", { name: /^Short/ }));
    expect(screen.getByText("Liq. Price").nextElementSibling?.textContent).toBe("≈ 3,374.51");
  });

  it("attaches stop-loss and take-profit triggers to a market entry with bounds one percent past each trigger", () => {
    const { onSend } = renderTicket();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(screen.queryByLabelText("Attached stop-loss trigger price")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "TP/SL" }));
    fireEvent.change(screen.getByLabelText("Attached stop-loss trigger price"), { target: { value: "3300" } });
    expect(screen.getByRole("status").textContent).toBe("Stop-loss trigger must be below the entry price.");
    fireEvent.change(screen.getByLabelText("Attached stop-loss trigger price"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("Attached take-profit trigger price"), { target: { value: "3500" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Sell ≥ 2,970 · 1% bound")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Long 0.5 ETH + TP/SL" }));

    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: "market",
      protection: {
        stopLoss: { triggerPrice: "3000", price: "2970" },
        takeProfit: { triggerPrice: "3500", price: "3465" },
      },
    }));
  });

  it("keeps Reduce-Only and attached TP/SL mutually exclusive", () => {
    renderTicket();

    fireEvent.click(screen.getByRole("checkbox", { name: "TP/SL" }));
    expect((screen.getByRole("checkbox", { name: "Reduce-Only" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText("Attached stop-loss trigger price")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Reduce-Only" }));
    expect((screen.getByRole("checkbox", { name: "TP/SL" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("Attached stop-loss trigger price")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "TP/SL" }));
    expect((screen.getByRole("checkbox", { name: "Reduce-Only" }) as HTMLInputElement).checked).toBe(false);
  });

  it("converts quote size and Max from the selected limit execution price", () => {
    renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "4000" } });
    expect(screen.getByText("Max Size").nextElementSibling?.textContent).toBe("12.3758 ETH");
    fireEvent.click(screen.getByRole("button", { name: "Size unit: ETH. Switch" }));
    fireEvent.change(screen.getByLabelText("Size in quote"), { target: { value: "1000" } });
    expect(screen.getByText("≈ 0.25 ETH")).toBeTruthy();
    expect(screen.getByText("Order Value").nextElementSibling?.textContent).toBe("1,000 USD");
  });

  it("uses the limit price for quote sizing on trigger-limit protection", () => {
    renderTicket({
      prefill: {
        key: 1,
        mode: "stop-loss-limit",
        side: "buy",
        baseAmount: "",
        triggerPrice: "3000",
        price: "4000",
        timeInForce: "good-till-time",
        reduceOnly: true,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Size unit: ETH. Switch" }));
    fireEvent.change(screen.getByLabelText("Size in quote"), { target: { value: "1000" } });
    expect(screen.getByText("≈ 0.25 ETH")).toBeTruthy();
  });

  it("asks Vex about the drafted order as a question, live only once the draft is valid", () => {
    const onAsk = vi.fn();
    const { onSend } = renderTicket({ onAsk });

    const ask = screen.getByRole("button", { name: "Review with Vex" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(ask.disabled).toBe(false);
    fireEvent.click(ask);

    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ mode: "market", side: "buy", baseAmount: "0.5" }));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Review with Vex" })).toBe(ask);
    expect(ask.disabled).toBe(true);
  });

  it("sizes by risk from the attached stop-loss and keeps Risk off without an account", () => {
    const { onSend, rerender } = renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Risk" }));
    expect((screen.getByRole("checkbox", { name: "TP/SL" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Enter a stop-loss trigger first.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Attached stop-loss trigger price"), { target: { value: "3000" } });
    // Market risk uses the approved worst-price bound (3,226.56), so a fill at
    // that bound still loses no more than the selected equity percentage.
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("0.4413");
    expect(screen.getByText("Risks 100 USDG if the stop fills at 3,000.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2%" }));
    expect((screen.getByLabelText("Risk as percent of equity") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("0.8827");
    fireEvent.click(screen.getByRole("button", { name: "Long 0.8827 ETH + TP/SL" }));
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({
      baseAmount: "0.8827",
      protection: expect.objectContaining({ stopLoss: { triggerPrice: "3000", price: "2970" } }),
    }));

    fireEvent.click(screen.getByRole("button", { name: "Qty" }));
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "25%" })).toBeTruthy();

    rerender({ equity: null, available: null });
    expect((screen.getByRole("button", { name: "Risk" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    expect(screen.getByRole("button", { name: "Risk" })).toBeTruthy();
    rerender({ equity: null, available: null, prefill: { key: 1, mode: "stop-loss", side: "sell", baseAmount: "", reduceOnly: true } });
    expect(screen.queryByRole("button", { name: "Risk" })).toBeNull();
  });

  it("defaults a plain limit to keep open for one day and shortens the preview expiry for immediate only", () => {
    const { onSend } = renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    expect(screen.getByRole("button", { name: "GTC", pressed: true })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Order expiry" }) as HTMLSelectElement).value).toBe("1440");
    expect(screen.getByLabelText("Limit price").getAttribute("aria-describedby")).toBe("lit-limit-price-note");
    expect(screen.getByText("Exact price you are willing to trade at. Type it or click the chart.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3100" } });
    expect(screen.getByText("Best ask 3,210.50: rests until the market reaches it.")).toBeTruthy();
    expect(screen.getByText("GTC, rests on the book")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Long 0.25 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith({
      mode: "limit",
      side: "buy",
      baseAmount: "0.25",
      limitPrice: "3100",
      timeInForce: "good-till-time",
      orderExpiryOffsetMinutes: 1_440,
      reduceOnly: false,
      protection: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "IOC" }));
    expect(screen.queryByRole("combobox", { name: "Order expiry" })).toBeNull();
    expect(screen.getByText("Best ask 3,210.50: not marketable, IOC would cancel.")).toBeTruthy();
    expect(screen.getByText("IOC, would cancel now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Long 0.25 ETH" }));
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({
      timeInForce: "immediate-or-cancel",
      orderExpiryOffsetMinutes: 30,
    }));
  });

  it("fills the limit price from the best opposite-side price and explains marketable prices", () => {
    renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Use best ask 3210.50" }));
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3210.50");
    expect(screen.getByText("Best ask 3,210.50: fills immediately, remainder stays open.")).toBeTruthy();
    expect(screen.getByText("GTC, can fill now")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Short/ }));
    expect(screen.getByRole("button", { name: "Use best bid 3199.50" })).toBeTruthy();
    expect(screen.getByText("Best bid 3,199.50: rests until the market reaches it.")).toBeTruthy();
  });

  it("blocks a maker-only limit price that crosses the fresh opposite side", () => {
    renderTicket();

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Post-Only" }));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3300" } });

    expect(screen.getByText("Best ask 3,210.50: this price crosses the book, so Post-Only cannot be reviewed.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Maker-only buy price must stay below the best ask.");
    expect((screen.getByRole("button", { name: "Long 0.25 ETH" }) as HTMLButtonElement).disabled).toBe(true);
    // A disabled provider fee does not make the order free: Vex still takes its own.
    expect(screen.getByText("Fee (Maker)").getAttribute("title")).toBe("Maker Disabled + Vex 0.1%");

    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3200" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Execution").nextElementSibling?.textContent).toBe("Post-Only");
  });

  it("keeps trigger-limit orders reduce only with an explicit behavior and expiry", () => {
    const { onSend } = renderTicket({
      prefill: { key: 1, mode: "stop-loss-limit", side: "buy", baseAmount: "", reduceOnly: true },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Sell/ }));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Stop-loss limit trigger price"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("Stop-loss limit limit price"), { target: { value: "2990" } });
    expect(screen.queryByLabelText("Reduce-Only")).toBeNull();
    expect(screen.getByText("Conditional GTC")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Order expiry" }), { target: { value: "10080" } });
    fireEvent.click(screen.getByRole("button", { name: "Sell Stop-loss limit 0.2 ETH" }));

    expect(onSend).toHaveBeenCalledWith({
      mode: "stop-loss-limit",
      side: "sell",
      baseAmount: "0.2",
      triggerPrice: "3000",
      limitPrice: "2990",
      timeInForce: "good-till-time",
      orderExpiryOffsetMinutes: 10_080,
      reduceOnly: true,
    });
  });

  it("emits a plain stop loss with its trigger and hard execution bound", () => {
    const { onSend } = renderTicket({
      prefill: { key: 1, mode: "stop-loss", side: "buy", baseAmount: "", reduceOnly: true },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Sell/ }));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Stop loss trigger price"), { target: { value: "3000" } });
    expect(screen.getByRole("status").textContent).toBe("Enter a valid minimum sell price.");
    fireEvent.change(screen.getByLabelText("Stop loss minimum sell price"), { target: { value: "2950" } });
    fireEvent.click(screen.getByRole("button", { name: "Sell Stop loss 0.2 ETH" }));

    expect(onSend).toHaveBeenCalledWith({
      mode: "stop-loss",
      side: "sell",
      baseAmount: "0.2",
      triggerPrice: "3000",
      worstPrice: "2950",
      reduceOnly: true,
    });
  });

  it("keeps protection unavailable on spot and uses buy and sell wording", () => {
    const { onSend, onOpenLeverage } = renderTicket({ market: SPOT, settlementSymbol: "USDG", baseAvailable: "1.2345" });

    expect(screen.queryByRole("checkbox", { name: "TP/SL" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Reduce-Only" })).toBeNull();
    expect(sideButtons("Order side")).toEqual(["Buy", "Sell"]);
    expect(screen.queryByRole("button", { name: /Leverage and margin mode/ })).toBeNull();
    expect(onOpenLeverage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(screen.getByText("Order Value").nextElementSibling?.textContent).toBe("1,613.28 USDG");
    expect(screen.queryByText("Cost")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Buy 0.5 ETH" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ mode: "market", side: "buy", reduceOnly: false }));
    fireEvent.click(screen.getByRole("button", { name: /^Sell/ }));
    expect(screen.getByText("Avbl").nextElementSibling?.textContent).toBe("1.2345 ETH");
  });

  it("opens the leverage sheet from the margin chip instead of editing in the ticket", () => {
    const { onOpenLeverage, rerender } = renderTicket();

    const chip = screen.getByRole("button", { name: "Leverage and margin mode" });
    expect(chip.textContent).toBe("Cross · 10x›");
    rerender({ margin: { ...MARGIN, initialMarginFraction: 295 } });
    expect(chip.textContent).toBe("Cross · 34x›");
    fireEvent.click(chip);
    expect(onOpenLeverage).toHaveBeenCalledTimes(1);
  });

  it("switches to a limit at a picked book price and prefills a reduce-only close", () => {
    const { rerender } = renderTicket();

    rerender({ pricePick: { key: 1, price: "3199.50", kind: "limit" } });
    expect(screen.getByRole("button", { name: "Limit", pressed: true })).toBeTruthy();
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3199.50");
    expect(screen.getByRole("button", { name: "GTC", pressed: true })).toBeTruthy();

    // A chart drag above the last price lands as a sell limit.
    rerender({ pricePick: { key: 2, price: "3250.00", kind: "limit", side: "sell" } });
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3250.00");
    expect(screen.getByRole("button", { name: /^Short/ }).getAttribute("data-active")).toBe("true");

    rerender({ prefill: { key: 2, mode: "market", side: "sell", baseAmount: "1.5", reduceOnly: true } });
    expect(screen.getByRole("button", { name: "Market", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Short/ }).getAttribute("data-active")).toBe("true");
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("1.5");
    expect((screen.getByLabelText("Reduce-Only") as HTMLInputElement).checked).toBe(true);

    rerender({ prefill: { key: 3, mode: "oco", side: "sell", baseAmount: "1.5", reduceOnly: false } });
    expect(screen.getByRole("button", { name: "SL + TP", pressed: true })).toBeTruthy();
    expect(screen.getByLabelText("Stop loss trigger price")).toBeTruthy();
  });

  it("fills the limit price from a chart click only while Limit is selected", () => {
    const { rerender } = renderTicket();

    // On Market a chart click is just a click: no switch, no price, no notice.
    rerender({ pricePick: { key: 1, price: "3100.00", kind: "limit", source: "chart" } });
    expect(screen.getByRole("button", { name: "Market", pressed: true })).toBeTruthy();
    expect(screen.queryByLabelText("Limit price")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    // On Limit it fills the price and keeps the trader's side and time in force.
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.click(screen.getByRole("button", { name: /^Short/ }));
    fireEvent.click(screen.getByRole("button", { name: "Post-Only" }));
    rerender({ pricePick: { key: 2, price: "3240.50", kind: "limit", source: "chart" } });
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3240.50");
    expect(screen.getByRole("button", { name: "Post-Only", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Short/ }).getAttribute("data-active")).toBe("true");

    // A later click replaces it; typing still works as before.
    rerender({ pricePick: { key: 3, price: "3260.00", kind: "limit", source: "chart" } });
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3260.00");
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3275" } });
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3275");
  });

  it("loads an agent order preview with its price, time in force, expiry and trigger", () => {
    const { rerender } = renderTicket();

    rerender({
      prefill: {
        key: 1, mode: "limit", side: "buy", baseAmount: "0.5", reduceOnly: false,
        price: "3150", timeInForce: "post-only", expiryMinutes: 240,
      },
    });
    expect(screen.getByRole("button", { name: "Limit", pressed: true })).toBeTruthy();
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("3150");
    expect(screen.getByRole("button", { name: "Post-Only", pressed: true })).toBeTruthy();
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");
    expect((screen.getByLabelText("Reduce-Only") as HTMLInputElement).checked).toBe(false);

    rerender({
      prefill: {
        key: 2, mode: "stop-loss-limit", side: "sell", baseAmount: "0.5", reduceOnly: true,
        price: "3090", triggerPrice: "3100", timeInForce: "good-till-time",
      },
    });
    expect(screen.getByRole("button", { name: "Stop-loss limit", pressed: true })).toBeTruthy();
    expect((screen.getByLabelText("Stop-loss limit trigger price") as HTMLInputElement).value).toBe("3100");
    expect((screen.getByLabelText("Stop-loss limit limit price") as HTMLInputElement).value).toBe("3090");
  });

  it("routes a shift-picked price into the protection leg that matches the exposure", () => {
    const { rerender } = renderTicket();

    rerender({ pricePick: { key: 1, price: "3000", kind: "trigger" } });
    expect(screen.getByRole("button", { name: "Market", pressed: true })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "TP/SL" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Attached stop-loss trigger price") as HTMLInputElement).value).toBe("3000");
    rerender({ pricePick: { key: 2, price: "3400", kind: "trigger" } });
    expect((screen.getByLabelText("Attached take-profit trigger price") as HTMLInputElement).value).toBe("3400");

    rerender({ prefill: { key: 1, mode: "stop-loss", side: "sell", baseAmount: "", reduceOnly: true } });
    rerender({ prefill: { key: 1, mode: "stop-loss", side: "sell", baseAmount: "", reduceOnly: true }, pricePick: { key: 3, price: "3100", kind: "trigger" } });
    expect((screen.getByLabelText("Stop loss trigger price") as HTMLInputElement).value).toBe("3100");
  });

  it("holds review until live data is fresh and surfaces handoff errors", () => {
    const { rerender } = renderTicket({ dataFresh: false });

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.5" } });
    expect(screen.getByRole("status").textContent)
      .toBe("Live market data is delayed. Wait for a fresh snapshot before review.");
    expect((screen.getByRole("button", { name: "Long 0.5 ETH" }) as HTMLButtonElement).disabled).toBe(true);

    rerender({ dataFresh: true, handoffError: "Your current chat draft is preserved." });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Your current chat draft is preserved.");
    expect((screen.getByRole("button", { name: "Long 0.5 ETH" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("enforces the provider minimum size", () => {
    renderTicket();

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "0.0005" } });
    expect(screen.getByRole("status").textContent).toBe("Minimum size is 0.001 ETH.");
    expect((screen.getByLabelText("Size") as HTMLInputElement).placeholder).toBe("0.001");
  });
});
