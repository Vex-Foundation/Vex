import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
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
  decimals: { size: 4, price: 2, quote: 6 },
  margin: null,
} as unknown as LighterTradingMarket;

const prepareDeskAction = vi.fn();
const approve = vi.fn();
const funnelStep = vi.fn(async () => ({ ok: true, data: { recorded: false } }));

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({ data: { ok: true, data: { retrievedAt: 0, markets: [MARKET] } } }),
  useLighterTradingSnapshot: () => ({ data: undefined, refetch: vi.fn() }),
  useLighterTradingAccount: () => ({ data: undefined }),
  useLighterTradingFills: () => ({ data: undefined }),
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
    vi.stubGlobal("window", Object.assign(window, { vex: { lighterTrading: { prepareDeskAction }, approvals: { approve }, telemetry: { funnelStep } } }));
    useUiStore.setState({ activeSessionId: "s1", createSessionOpen: false });
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7, skipCloseConfirm: false });
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

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow); });
    expect(prepareDeskAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: "close", marketId: 7 } }));

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

  it("reports the card's outcome and loads protection as the follow-up only for its own card", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result } = renderDesk();
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: { triggerPrice: "3500", price: "3465" } };
    await act(async () => { result.current.submitDraft({ ...ENTRY, protection }); });

    // Another card (the agent's) resolving says nothing on the ticket and is not the desk's approve.
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "someone-else" })); });
    expect(result.current.deskOutcome).toBeNull();
    expect(funnelStep).not.toHaveBeenCalledWith(expect.objectContaining({ step: "desk_approve" }));

    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-1" })); });
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_approve", environment: "rhc" });
    expect(result.current.deskOutcome).toEqual({
      tone: "ok",
      text: "Order sent. Protection is loaded below; send it once the entry fills.",
    });
    expect(result.current.ticketPrefill).toMatchObject({ mode: "oco", side: "sell", baseAmount: "0.5", reduceOnly: true, protection });

    // The card is spent: a second resolution for the same id is ignored.
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-1", executionStatus: "failed" })); });
    expect(result.current.deskOutcome?.tone).toBe("ok");
  });

  it("shows the tool's own words on failure and a caution when the outcome is unknown", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-3" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow); });
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-3", executionStatus: "failed", toolOutput: "Position already closed." })); });
    expect(result.current.deskOutcome).toEqual({ tone: "error", text: "Position already closed." });

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    expect(result.current.deskOutcome).toBeNull();
    act(() => { result.current.onApprovalResolved("approved", resolved({ id: "ap-3", executionStatus: "indeterminate" })); });
    expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Outcome unknown. Check the account panel before retrying." });

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    act(() => { result.current.onApprovalResolved("rejected", resolved({ id: "ap-3", status: "rejected", executionStatus: null })); });
    expect(result.current.deskOutcome).toBeNull();
  });

  describe("Don't ask again for Market close", () => {
    const POSITION = { marketId: 7, side: "long", size: "0.25" } as LighterPositionRow;

    it("answers the close card itself before the pending list is pulled, and reports its outcome", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-9" } });
      approve.mockResolvedValue({ ok: true, data: resolved({ id: "ap-9" }) });
      const { result, invalidate } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(POSITION); });

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

      await act(async () => { result.current.accountActions.onClosePosition(POSITION); });
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
