import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { approvalsKeys } from "../../../../lib/api/queryKeys.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { LighterOpenOrderRow, LighterPositionRow } from "../account-model.js";

const MARKET = {
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 2,
  minBaseAmount: "0.0001",
  minQuoteAmount: "1",
  orderQuoteLimit: "1000000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0", makerEnabled: true, takerEnabled: true, integratorMaker: null, integratorTaker: null },
  activity24h: { tradesCount: null, quoteVolume: null },
  margin: null,
} satisfies LighterTradingMarket;

const prepareDeskAction = vi.fn();
const approve = vi.fn();
const FILL = { tradeId: "t1", orderId: "9001", marketId: 7, symbol: "ETH", side: "buy", role: "taker", type: "trade", size: "0.5", price: "3200", value: null, realizedPnl: null, timestamp: 1 };
const accountData = { value: undefined as unknown };
const fillsData = { value: undefined as unknown };
const funnelStep = vi.fn(async () => ({ ok: true, data: { recorded: false } }));

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({ data: { ok: true, data: { retrievedAt: 0, markets: [MARKET] } } }),
  useLighterTradingSnapshot: () => ({ data: undefined, refetch: vi.fn() }),
  useLighterTradingAccount: () => ({ data: accountData.value }),
  useLighterTradingFills: () => ({ data: fillsData.value }),
  useLighterAccountActivityRefresh: () => undefined,
  useLighterOnboardingChecklist: () => ({ data: undefined }),
}));
vi.mock("../../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: [] } }),
}));
vi.mock("../useLighterCandleStream.js", () => ({
  useLighterCandleStream: () => ({ candles: [], status: "live", receivedAt: null }),
}));
vi.mock("../useLighterPublicMarketStream.js", () => ({
  useLighterPublicMarketStream: () => ({
    status: "live", book: null, stats: null, trades: [], bookReceivedAt: null, bookStatus: "live", tradesStatus: "live",
  }),
}));

import { useLighterDesk } from "../useLighterDesk.js";

const ENTRY = { mode: "market" as const, side: "buy" as const, baseAmount: "0.5", worstPrice: "3226.56", reduceOnly: false };

function resolved(overrides: Partial<ApprovalActionResult>): ApprovalActionResult {
  return {
    id: "ap-1",
    status: "approved",
    resolvedAt: null,
    runtimeOutcome: "resumed",
    executionStatus: "succeeded",
    missionRunId: null,
    cached: false,
    message: "done",
    ...overrides,
  };
}

function providerOrderOutput(input: {
  readonly state: "open" | "partially_filled" | "filled" | "canceled" | "rejected";
  readonly source: "active_order" | "inactive_order" | "account_trade";
  readonly orderId: string;
  readonly providerOrderStatus?: string;
  readonly filledBaseAmount?: string;
  readonly averageExecutionPrice?: string;
  readonly tradeId?: string;
  readonly size?: string;
  readonly price?: string;
}): string {
  return JSON.stringify({
    status: "provider_confirmed",
    environment: "rhc",
    executionState: input.state,
    evidenceSource: input.source,
    providerOrderId: input.orderId,
    ...(input.providerOrderStatus === undefined ? {} : { providerOrderStatus: input.providerOrderStatus }),
    providerEvidence: {
      source: input.source,
      marketIndex: 7,
      orderId: input.orderId,
      ...(input.filledBaseAmount === undefined ? {} : { filledBaseAmount: input.filledBaseAmount }),
      ...(input.averageExecutionPrice === undefined ? {} : { averageExecutionPrice: input.averageExecutionPrice }),
      ...(input.tradeId === undefined ? {} : { tradeId: input.tradeId }),
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.price === undefined ? {} : { price: input.price }),
    },
  });
}

function renderDesk() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, ...renderHook(() => useLighterDesk(), { wrapper }) };
}

describe("desk lane", () => {
  beforeEach(() => {
    prepareDeskAction.mockReset();
    approve.mockReset();
    funnelStep.mockClear();
    accountData.value = undefined;
    fillsData.value = undefined;
    vi.stubGlobal("window", Object.assign(window, { vex: { lighterTrading: { prepareDeskAction }, approvals: { approve }, telemetry: { funnelStep } } }));
    useUiStore.setState({ activeSessionId: "s1", createSessionOpen: false });
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7, skipCloseConfirm: false });
  });

  it("makes the agent visible when the expanded sidebar has squeezed it closed", () => {
    useUiStore.setState({ bookOpen: true, sidebarNarrowExpanded: true });
    const { result } = renderDesk();
    act(() => result.current.askVex());
    expect(useUiStore.getState().bookOpen).toBe(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
    expect(prepareDeskAction).not.toHaveBeenCalled();
  });

  it("opens the agent before creating a session to review a draft", () => {
    useUiStore.setState({ activeSessionId: null, bookOpen: false, sidebarNarrowExpanded: true });
    const { result } = renderDesk();
    act(() => result.current.askAboutDraft(ENTRY));
    expect(useUiStore.getState().bookOpen).toBe(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
    expect(useUiStore.getState().createSessionOpen).toBe(true);
    expect(prepareDeskAction).not.toHaveBeenCalled();
  });

  it("sends only a selector for the drafted order and pulls the pending list once the card is enqueued", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result, invalidate } = renderDesk();

    await act(async () => { result.current.submitDraft({ ...ENTRY, protection: { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null } }); });

    expect(prepareDeskAction).toHaveBeenCalledWith({
      sessionId: "s1",
      environment: "rhc",
      action: { kind: "order", marketId: 7, draft: ENTRY },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalsKeys.pending("s1") });
    expect(result.current.submitting).toBe(false);
    expect(result.current.handoffError).toBeNull();
    // The funnel counts the card once it is enqueued, not on the attempt.
    expect(funnelStep).toHaveBeenCalledTimes(1);
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_card", environment: "rhc" });
  });

  it("routes Close and Cancel rows through the same lane by id", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-2" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow, 1); });
    expect(prepareDeskAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: "close", marketId: 7 } }));

    // A portion is not main's whole-position close: it loads the ticket instead.
    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow, 0.5); });
    expect(prepareDeskAction).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    expect(prepareDeskAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: "cancel", marketId: 7, orderId: "9001" } }));
  });

  it("surfaces a refusal or transport error in the ticket and does not touch the pending list", async () => {
    prepareDeskAction.mockResolvedValueOnce({ ok: true, data: { kind: "refused", reason: "No open position on this market." } });
    const { result, invalidate } = renderDesk();

    await act(async () => { result.current.submitDraft(ENTRY); });
    expect(result.current.handoffError).toBe("No open position on this market.");

    prepareDeskAction.mockResolvedValueOnce({ ok: false, error: { code: "internal.unexpected", message: "Something went wrong." } });
    await act(async () => { result.current.submitDraft(ENTRY); });
    expect(result.current.handoffError).toBe("Something went wrong.");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("opens the session sheet instead of preparing when there is no session", async () => {
    useUiStore.setState({ activeSessionId: null });
    const { result } = renderDesk();

    await act(async () => { result.current.submitDraft(ENTRY); });
    expect(prepareDeskAction).not.toHaveBeenCalled();
    expect(useUiStore.getState().createSessionOpen).toBe(true);
  });

  it("records setup intent before handing onboarding to the active session", () => {
    const { result } = renderDesk();
    act(() => { result.current.connectLighter(); });
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_setup_start", environment: "rhc" });
  });

  it("keeps the visible market when the destination environment lists the same symbol", async () => {
    const { result } = renderDesk();
    act(() => { result.current.selectEnvironment("core"); });

    await waitFor(() => {
      expect(useLighterAnalysisStore.getState().desk).toMatchObject({ environment: "core", marketId: 7 });
    });
  });

  it("reports the card's outcome and loads protection as the follow-up only for its own card", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result } = renderDesk();
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: { triggerPrice: "3500", price: "3465" } };
    await act(async () => { result.current.submitDraft({ ...ENTRY, protection }); });

    // Another card (the agent's) resolving says nothing on the ticket and is not the desk's approve.
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "someone-else" })); });
    expect(result.current.deskOutcome).toBeNull();
    expect(funnelStep).not.toHaveBeenCalledWith(expect.objectContaining({ step: "desk_approve" }));

    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: providerOrderOutput({
        state: "filled",
        source: "inactive_order",
        orderId: "9001",
        filledBaseAmount: "0.2",
        averageExecutionPrice: "3210",
      }),
    })); });
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_approve", environment: "rhc" });
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_order_accepted", environment: "rhc" });
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_order_filled", environment: "rhc" });
    expect(result.current.deskOutcome).toEqual({
      tone: "ok",
      text: "Filled 0.2 ETH at 3,210. Protection is loaded for the filled amount.",
    });
    expect(result.current.ticketPrefill).toMatchObject({ mode: "oco", side: "sell", baseAmount: "0.2", reduceOnly: true, protection });

    // The card is spent: a second resolution for the same id is ignored.
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-1", executionStatus: "failed" })); });
    expect(result.current.deskOutcome?.tone).toBe("ok");
  });

  it("keeps each pending desk card's draft instead of replacing the earlier card", async () => {
    prepareDeskAction
      .mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } })
      .mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-2" } });
    const { result } = renderDesk();
    const firstProtection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null };
    const secondProtection = { stopLoss: null, takeProfit: { triggerPrice: "3600", price: "3564" } };

    await act(async () => { result.current.submitDraft({ ...ENTRY, protection: firstProtection }); });
    await act(async () => { result.current.submitDraft({ ...ENTRY, baseAmount: "0.25", protection: secondProtection }); });

    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: providerOrderOutput({ state: "filled", source: "inactive_order", orderId: "9001", filledBaseAmount: "0.3" }),
    })); });
    expect(result.current.ticketPrefill).toMatchObject({
      mode: "stop-loss", baseAmount: "0.3", triggerPrice: "3000", price: "2970",
    });

    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-2",
      toolOutput: providerOrderOutput({ state: "filled", source: "inactive_order", orderId: "9002", filledBaseAmount: "0.1" }),
    })); });
    expect(result.current.ticketPrefill).toMatchObject({
      mode: "take-profit", baseAmount: "0.1", triggerPrice: "3600", price: "3564",
    });
  });

  it("does not apply an old environment's outcome or protection to the current desk", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-rhc" } });
    const { result } = renderDesk();
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null };
    await act(async () => { result.current.submitDraft({ ...ENTRY, protection }); });

    act(() => { useLighterAnalysisStore.getState().saveDesk({ environment: "core" }); });
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-rhc" })); });

    expect(result.current.ticketPrefill).toBeNull();
    expect(result.current.deskOutcome).toBeNull();
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_approve", environment: "rhc" });
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_order_unknown", environment: "rhc" });
  });

  it("never attributes another same-market order's fill to the approved order", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result, rerender } = renderDesk();
    await act(async () => { result.current.submitDraft(ENTRY); });
    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: providerOrderOutput({ state: "open", source: "active_order", orderId: "9001" }),
    })); });

    const retrievedAt = Date.now() + 10_000;
    fillsData.value = { ok: true, data: {
      available: true,
      truncated: false,
      retrievedAt,
      fills: [{ ...FILL, orderId: "someone-elses-order", tradeId: "someone-elses-fill", timestamp: Date.now() }],
    } };
    accountData.value = { ok: true, data: {
      retrievedAt,
      openOrdersAvailable: true,
      openOrdersTruncated: false,
      summary: null,
      positions: [],
      marginTerms: [],
      openOrders: [],
    } };
    rerender();

    expect(result.current.deskOutcome).toEqual({
      tone: "warn",
      text: "The order is no longer open and no fill was returned. Check order history before retrying.",
    });
  });

  it("waits for an exact order to leave the book, then uses its actual fill total", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const retrievedAt = Date.now() + 10_000;
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null };
    fillsData.value = { ok: true, data: { available: true, truncated: false, retrievedAt, fills: [{ ...FILL, size: "0.2" }, { ...FILL, orderId: "other", tradeId: "someone-elses-fill" }] } };
    accountData.value = { ok: true, data: {
      retrievedAt,
      openOrdersAvailable: true,
      openOrdersTruncated: false,
      summary: null,
      positions: [],
      marginTerms: [],
      openOrders: [{ marketId: 7, orderId: "9001" }],
    } };
    const { result, rerender } = renderDesk();
    await act(async () => { result.current.submitDraft({ ...ENTRY, protection }); });

    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: providerOrderOutput({
        state: "partially_filled",
        source: "account_trade",
        orderId: "9001",
        tradeId: "t1",
        size: "0.2",
        price: "3200",
      }),
    })); });

    expect(result.current.deskOutcome?.text).toContain("remainder is still open");
    expect(result.current.ticketPrefill).toBeNull();
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_order_partial", environment: "rhc" });

    accountData.value = { ok: true, data: {
      retrievedAt: retrievedAt + 1,
      openOrdersAvailable: true,
      openOrdersTruncated: false,
      summary: null,
      positions: [],
      marginTerms: [],
      openOrders: [],
    } };
    rerender();

    expect(result.current.deskOutcome).toEqual({
      tone: "ok",
      text: "Filled 0.2 ETH at 3,200. The entry is no longer open. Protection is loaded for the filled amount.",
    });
    expect(result.current.ticketPrefill).toMatchObject({
      mode: "stop-loss",
      baseAmount: "0.2",
      triggerPrice: "3000",
      price: "2970",
    });
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_order_filled", environment: "rhc" });
  });

  it("keeps tracking a sequencer-pending order by provider id until its exact fill settles", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null };
    const { result, rerender } = renderDesk();
    await act(async () => { result.current.submitDraft({ ...ENTRY, protection }); });

    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: JSON.stringify({
        status: "sequencer_pending",
        environment: "rhc",
        executionState: "sequencer_pending",
        evidenceSource: "not_found",
        providerOrderId: "9001",
      }),
    })); });
    expect(result.current.deskOutcome).toEqual({
      tone: "warn",
      text: "Order …9001 was accepted and is still confirming on Lighter. Track it in Orders below; do not retry.",
    });
    expect(result.current.ticketPrefill).toBeNull();
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_order_accepted", environment: "rhc" });

    const retrievedAt = Date.now() + 10_000;
    fillsData.value = { ok: true, data: {
      available: true,
      truncated: false,
      retrievedAt,
      fills: [{ ...FILL, orderId: "9001", size: "0.2" }],
    } };
    accountData.value = { ok: true, data: {
      retrievedAt,
      openOrdersAvailable: true,
      openOrdersTruncated: false,
      summary: null,
      positions: [],
      marginTerms: [],
      openOrders: [],
    } };
    rerender();

    expect(result.current.deskOutcome).toEqual({
      tone: "ok",
      text: "Filled 0.2 ETH at 3,200. The entry is no longer open. Protection is loaded for the filled amount.",
    });
    expect(result.current.ticketPrefill).toMatchObject({
      mode: "stop-loss",
      baseAmount: "0.2",
      triggerPrice: "3000",
      price: "2970",
    });
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_order_filled", environment: "rhc" });
  });

  it("draws this market's fills only while a position is open on it", () => {
    fillsData.value = { ok: true, data: { fills: [FILL, { ...FILL, tradeId: "t2", marketId: 8 }] } };
    accountData.value = { ok: true, data: { status: "ready", summary: null, positions: [], marginTerms: [], openOrders: [] } };
    expect(renderDesk().result.current.chartFills).toEqual([]);
    accountData.value = { ok: true, data: { status: "ready", summary: null, positions: [{ marketId: 7, side: "long", size: "0.5" }], marginTerms: [], openOrders: [] } };
    expect(renderDesk().result.current.chartFills).toEqual([FILL]);
  });

  it("names the exchange's cancel instead of calling the outcome unknown", async () => {
    // The other half of the "Outcome unknown" report: once the engine stops
    // reporting a stream-confirmed cancel as indeterminate, the desk has the
    // settled state and must say which order ended and how.
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-c" } });
    const { result } = renderDesk();
    await act(async () => { result.current.submitDraft(ENTRY); });
    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-c",
      toolOutput: providerOrderOutput({ state: "canceled", source: "inactive_order", orderId: "9003" }),
    })); });

    expect(result.current.deskOutcome?.tone).toBe("warn");
    expect(result.current.deskOutcome?.text).toContain("9003");
    expect(result.current.deskOutcome?.text).toContain("canceled with no fill");
    expect(result.current.deskOutcome?.text).toContain("did not open a position");
    expect(result.current.deskOutcome?.text).toContain("Positions and Trade History");
    expect(result.current.deskOutcome?.text).not.toContain("Check Orders below");
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_order_canceled", environment: "rhc" });
  });

  it("explains a provider-reported margin cancellation without guessing at other causes", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-margin" } });
    const { result } = renderDesk();
    await act(async () => { result.current.submitDraft(ENTRY); });
    act(() => { result.current.onApprovalResolved("approved", resolved({
      id: "ap-margin",
      toolOutput: providerOrderOutput({
        state: "canceled", source: "inactive_order", orderId: "9004",
        providerOrderStatus: "canceled-margin-not-allowed",
      }),
    })); });

    expect(result.current.deskOutcome?.text).toContain("Lighter did not allow the margin");
  });

  it("shows the tool's own words on failure and a caution when the outcome is unknown", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-3" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow, 1); });
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-3", executionStatus: "failed", toolOutput: "Position already closed." })); });
    expect(result.current.deskOutcome).toEqual({ tone: "error", text: "Position already closed." });

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    expect(result.current.deskOutcome).toBeNull();
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-3", executionStatus: "indeterminate" })); });
    expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Outcome unknown. Open Orders below and refresh before retrying." });

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    act(() => { result.current.onApprovalResolved("rejected", resolved({ id: "ap-3", status: "rejected", executionStatus: null })); });
    expect(result.current.deskOutcome).toBeNull();
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_approval_rejected", environment: "rhc" });
  });

  it("turns a stuck Lighter action into an in-app next step", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-3" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow, 1); });
    act(() => {
      result.current.onApprovalResolved("approved", resolved({
        id: "ap-3",
        executionStatus: "failed",
        toolOutput: "A previous Lighter action on RHC account 42 is still being checked. This order was not signed or submitted.",
      }));
    });

    expect(result.current.deskOutcome?.text).toContain("Ask Vex in chat");
    expect(result.current.deskOutcome?.text).not.toContain("lighter.order.status");
    expect(result.current.deskOutcome?.text).not.toContain("try again");
  });

  describe("Don't ask again for Market close", () => {
    const POSITION = { marketId: 7, side: "long", size: "0.25" } as LighterPositionRow;

    it("answers the close card itself before the pending list is pulled, and reports its outcome", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-9" } });
      approve.mockResolvedValue({ ok: true, data: resolved({ id: "ap-9" }) });
      const { result, invalidate } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(POSITION, 1); });

      // Main still prepared the card; the desk only signed it in the user's stead.
      expect(prepareDeskAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: "close", marketId: 7 } }));
      expect(approve).toHaveBeenCalledWith({ id: "ap-9" });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalsKeys.pending("s1") });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalsKeys.pendingAll() });
      expect(result.current.deskOutcome).toEqual({ tone: "ok", text: "Close sent." });
      expect(result.current.submitting).toBe(false);
      expect(result.current.handoffError).toBeNull();
    });

    it("keeps the card for orders and cancels even while close skips it", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-8" } });
      const { result } = renderDesk();

      await act(async () => { result.current.submitDraft(ENTRY); });
      await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
      expect(approve).not.toHaveBeenCalled();
    });

    it("shows the approve failure on the ticket instead of pretending the close went out", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-7" } });
      approve.mockResolvedValue({ ok: false, error: { code: "approval.not_found", message: "Approval expired." } });
      const { result } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(POSITION, 1); });
      expect(result.current.handoffError).toBe("Approval expired.");
      expect(result.current.deskOutcome).toBeNull();
    });

    it("exposes the preference and its setters to the desk", () => {
      const { result } = renderDesk();
      expect(result.current.skipCloseConfirm).toBe(false);
      act(() => { result.current.setSkipCloseConfirm(true); });
      expect(result.current.skipCloseConfirm).toBe(true);
      act(() => { result.current.accountActions.onRestoreCloseConfirm(); });
      expect(result.current.skipCloseConfirm).toBe(false);
    });
  });
});
