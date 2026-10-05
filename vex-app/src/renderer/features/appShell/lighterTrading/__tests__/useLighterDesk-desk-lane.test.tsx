import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalActionResult, ApprovalDispatchEvent } from "@shared/schemas/approvals.js";
import type { LighterTradingAccount, LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { approvalsKeys } from "../../../../lib/api/queryKeys.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { LighterOpenOrderRow, LighterPositionRow } from "../account-model.js";
import { useDeskSendIntentStore } from "../desk-send-intent.js";
import type { LighterDeskDeps } from "../useLighterDesk.js";

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
const approvalsData = { value: [] as unknown[] };
let approvalsResponse = { ok: true, data: approvalsData.value };
const approvalGet = vi.fn();
const fillsData = { value: undefined as unknown };
const funnelStep = vi.fn(async () => ({ ok: true, data: { recorded: false } }));
/** Listeners on `EV.approvals.dispatch`; a test emits through `emitDispatch`. */
const dispatchListeners = new Set<(event: ApprovalDispatchEvent) => void>();
const onDispatchEvent = vi.fn((cb: (event: ApprovalDispatchEvent) => void) => {
  dispatchListeners.add(cb);
  return () => { dispatchListeners.delete(cb); };
});
function emitDispatch(event: ApprovalDispatchEvent): void {
  for (const cb of dispatchListeners) cb(event);
}

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({ data: { ok: true, data: { retrievedAt: 0, markets: [MARKET] } } }),
  useLighterTradingSnapshot: () => ({ data: undefined, refetch: vi.fn() }),
  useLighterTradingAccount: () => ({ data: accountData.value }),
  useLighterTradingFills: () => ({ data: fillsData.value }),
  useLighterAccountActivityRefresh: () => undefined,
  useLighterOnboardingChecklist: () => ({ data: undefined }),
}));
vi.mock("../../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => {
    if (approvalsResponse.data !== approvalsData.value) approvalsResponse = { ok: true, data: approvalsData.value };
    return { data: approvalsResponse };
  },
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
const OPEN_POSITION = { marketId: 7, symbol: "ETH", side: "long", size: "0.25" } as LighterPositionRow;

function positionAccount(retrievedAt: number, positions: readonly LighterPositionRow[] = [OPEN_POSITION], openOrders: LighterTradingAccount["openOrders"] = []): LighterTradingAccount {
  return {
    environment: "rhc", retrievedAt, status: "ready", unavailableReason: null, accountIndex: 42,
    summary: null, assets: [], positions: [...positions], marginTerms: [], exchangeFees: null, openOrders,
    openOrdersAvailable: true, openOrdersTruncated: false,
  };
}

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

function renderDesk(deps: LighterDeskDeps = {}) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, ...renderHook(() => useLighterDesk(deps), { wrapper }) };
}

describe("desk lane", () => {
  beforeEach(() => {
    prepareDeskAction.mockReset();
    approve.mockReset();
    funnelStep.mockClear();
    accountData.value = undefined;
    fillsData.value = undefined;
    approvalsData.value = [];
    approvalGet.mockReset();
    dispatchListeners.clear();
    vi.stubGlobal("window", Object.assign(window, { vex: { lighterTrading: { prepareDeskAction }, approvals: { approve, get: approvalGet, onDispatchEvent }, telemetry: { funnelStep } } }));
    useUiStore.setState({ activeSessionId: "s1", createSessionOpen: false, bookOpen: false });
    useDeskSendIntentStore.getState().clearDeskSendIntent();
    useLighterAnalysisStore.getState().saveDesk({ environment: "rhc", marketId: 7, skipCloseConfirm: false });
  });

  describe("account-wide direct cancellation", () => {
    const firstOrder = { marketId: 7, orderId: "9001" } as LighterOpenOrderRow;
    const orders = [
      firstOrder,
      { marketId: 8, orderId: "9002" } as LighterOpenOrderRow,
    ];
    const approval = {
      id: "ap-all", origin: "desk", expiresAt: null,
      preview: { namespace: "lighter", toolName: "order.cancelAll", criticalArgs: {
        environment: "rhc", accountIndex: 42, orderCount: 2, orderIdentities: "7:9001,8:9002",
      } },
    };
    function ready(): void {
      accountData.value = { ok: true, data: positionAccount(Date.now(), [], orders) };
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-all" } });
    }

    it("removes the model roundtrip, deduplicates and preserves explicit confirmation even when close skips it", async () => {
      ready();
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      const { result } = renderDesk();
      await act(async () => {
        result.current.accountActions.onCancelAllOrders(orders);
        result.current.accountActions.onCancelAllOrders(orders);
        result.current.accountActions.onCancelOrder(firstOrder);
      });
      expect(prepareDeskAction).toHaveBeenCalledTimes(1);
      expect(prepareDeskAction).toHaveBeenCalledWith({
        sessionId: "s1", environment: "rhc", action: { kind: "cancel_all" }, progressId: expect.any(String),
      });
      expect([...result.current.cancellingOrders]).toEqual([["7:9001", "approval"], ["8:9002", "approval"]]);
      expect(approve).not.toHaveBeenCalled();
      expect(useDeskSendIntentStore.getState().intent).toBeNull();
      expect(useUiStore.getState().bookOpen).toBe(false);
    });

    it("retains the previous chat handoff when the switch is off", async () => {
      ready();
      const { result } = renderDesk({ directCancelAll: false });
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      expect(prepareDeskAction).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(useDeskSendIntentStore.getState().intent).toMatchObject({
        sessionId: "s1",
        message: "Cancel all 2 of my open Lighter orders across every market with one account-wide cancellation, prepared with lighter__order_cancel_all_prepare.; environment=rhc; Display the approval card directly. Nothing may execute without my explicit approval on that card.",
      });
      expect(useUiStore.getState().bookOpen).toBe(true);
    });

    it("matches canonical facts even when the card arrives before the prepare reply, and does not lock later unrelated orders", async () => {
      ready();
      approvalsData.value = [approval];
      let release: ((value: unknown) => void) | undefined;
      prepareDeskAction.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const { result, rerender } = renderDesk();
      act(() => result.current.accountActions.onCancelAllOrders(orders));
      await act(async () => {
        if (release === undefined) throw new Error("prepare was not started");
        release({ ok: true, data: { kind: "enqueued", approvalId: "ap-all" } });
      });
      const laterOrder = { marketId: 9, orderId: "9003" } as LighterOpenOrderRow;
      accountData.value = { ok: true, data: positionAccount(Date.now(), [], [...orders, laterOrder]) };
      rerender();
      expect(result.current.cancellingOrders.has("9:9003")).toBe(false);
      expect(result.current.cancelAllPending).toBe(true);
      act(() => result.current.onApprovalResolved("approved", resolved({
        id: "ap-all", toolOutput: JSON.stringify({ source: "vex_lighter_order_cancel_all", status: "cancel_all_completed" }),
      })));
      expect(result.current.cancellingOrders.get("7:9001")).toBe("checking");
      expect(result.current.deskOutcome?.text).not.toContain("all orders canceled");
      accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000, [], [laterOrder]) };
      rerender();
      expect(result.current.cancellingOrders.size).toBe(0);
      expect(result.current.cancelAllPending).toBe(false);
      expect(result.current.deskOutcome?.text).toContain("Requested orders are no longer open");
      expect(result.current.deskOutcome?.text).toContain("fills before cancellation");
    });

    it("requires a newer complete provider list in the exact environment, account and initiating session", async () => {
      ready();
      const { result, rerender } = renderDesk();
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      act(() => result.current.onApprovalResolved("approved", resolved({
        id: "ap-all", toolOutput: JSON.stringify({ source: "vex_lighter_order_cancel_all", status: "cancel_all_completed" }),
      })));
      accountData.value = { ok: true, data: positionAccount(0, [], []) };
      rerender();
      accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000, [], orders) };
      rerender();
      expect(result.current.cancellingOrders.size).toBe(2);
      for (const partial of [{ openOrdersTruncated: true }, { openOrdersAvailable: false }]) {
        accountData.value = { ok: true, data: { ...positionAccount(Date.now() + 2_000, [], []), ...partial } };
        rerender();
      }
      accountData.value = { ok: true, data: positionAccount(Date.now() + 3_000, [], orders) };
      rerender();
      expect(result.current.cancellingOrders.size).toBe(2);
      act(() => useUiStore.setState({ activeSessionId: "s2" }));
      accountData.value = { ok: true, data: positionAccount(Date.now() + 4_000, [], []) };
      rerender();
      expect(result.current.deskOutcome).toBeNull();
      accountData.value = { ok: true, data: { ...positionAccount(Date.now() + 5_000, [], []), accountIndex: 43 } };
      act(() => useUiStore.setState({ activeSessionId: "s1" }));
      rerender();
      act(() => useLighterAnalysisStore.getState().saveDesk({ environment: "core" }));
      accountData.value = { ok: true, data: { ...positionAccount(Date.now() + 6_000, [], []), environment: "core" } };
      rerender();
      act(() => useLighterAnalysisStore.getState().saveDesk({ environment: "rhc" }));
      accountData.value = { ok: true, data: positionAccount(Date.now() + 7_000, [], orders) };
      rerender();
      expect(result.current.cancellingOrders.size).toBe(2);
      accountData.value = { ok: true, data: positionAccount(Date.now() + 8_000, [], []) };
      rerender();
      expect(result.current.deskOutcome?.text).toContain("Requested orders are no longer open");
    });

    it.each(["sequencer_pending", "ambiguous"])("keeps %s success uncertain and never offers a replay", async (status) => {
      ready();
      const { result } = renderDesk();
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      act(() => result.current.onApprovalResolved("approved", resolved({
        id: "ap-all", toolOutput: JSON.stringify({ source: "vex_lighter_order_cancel_all", status }),
      })));
      expect(result.current.cancellingOrders.get("7:9001")).toBe("uncertain");
      expect(result.current.deskOutcome?.text).toContain("before retrying");
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      expect(prepareDeskAction).toHaveBeenCalledTimes(1);
    });

    it.each(["rejected", "failed", "indeterminate"] as const)("handles %s with truthful row locks", async (status) => {
      ready();
      const { result } = renderDesk();
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      act(() => result.current.onApprovalResolved(status === "rejected" ? "rejected" : "approved", resolved({
        id: "ap-all", executionStatus: status === "rejected" ? null : status, toolOutput: "Provider refused cancellation.",
      })));
      if (status === "indeterminate") {
        expect(result.current.cancellingOrders.get("7:9001")).toBe("uncertain");
        expect(result.current.deskOutcome?.text).toContain("outcome is uncertain");
      } else {
        expect(result.current.cancellingOrders.size).toBe(0);
        await act(async () => result.current.accountActions.onCancelAllOrders(orders));
        expect(prepareDeskAction).toHaveBeenCalledTimes(2);
      }
    });

    it("releases preparation refusals and thrown errors for a deliberate retry", async () => {
      ready();
      prepareDeskAction.mockResolvedValueOnce({ ok: true, data: { kind: "refused", reason: "No open orders." } })
        .mockRejectedValueOnce(new Error("Preparation unavailable."));
      const { result } = renderDesk();
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      expect(result.current.handoffError).toBe("No open orders.");
      expect(result.current.cancellingOrders.size).toBe(0);
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      expect(result.current.handoffError).toBe("Preparation unavailable.");
      expect(result.current.cancellingOrders.size).toBe(0);
    });

    it("releases an unapproved expired cancel-all card even when its stable query arrived before prepare returned", async () => {
      ready();
      const expiredCard = { ...approval, expiresAt: new Date(Date.now() - 10_000).toISOString() };
      approvalsData.value = [expiredCard];
      approvalGet.mockResolvedValue({ ok: true, data: { ...expiredCard, status: "rejected", decisionReason: "expired_ttl" } });
      const { result } = renderDesk();
      await act(async () => result.current.accountActions.onCancelAllOrders(orders));
      await waitFor(() => expect(result.current.cancelAllPending).toBe(false));
      expect(result.current.cancellingOrders.size).toBe(0);
      expect(result.current.deskOutcome?.text).toBe("The cancel-all request expired before it was approved. Nothing was sent.");
      expect(approve).not.toHaveBeenCalled();
    });
  });

  it("locks only the selected position until a fresh account snapshot proves it closed", async () => {
    accountData.value = { ok: true, data: positionAccount(Date.now()) };
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result, rerender } = renderDesk();

    await act(async () => {
      result.current.accountActions.onClosePosition(OPEN_POSITION, 1);
      result.current.accountActions.onClosePosition(OPEN_POSITION, 1);
    });
    expect(prepareDeskAction).toHaveBeenCalledTimes(1);
    expect(result.current.closingPositions.get("7-long")).toBe("approval");

    act(() => result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: JSON.stringify({ source: "vex_lighter_position_close", status: "closed" }),
    })));
    expect(result.current.closingPositions.get("7-long")).toBe("checking");
    act(() => useUiStore.setState({ activeSessionId: "s2" }));
    expect(result.current.closingPositions.get("7-long")).toBe("checking");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000) };
    rerender();
    expect(result.current.closingPositions.get("7-long")).toBe("checking");

    accountData.value = { ok: true, data: positionAccount(Date.now() + 2_000, []) };
    rerender();
    await waitFor(() => expect(result.current.closingPositions.has("7-long")).toBe(false));
    expect(result.current.deskOutcome).toEqual({ tone: "ok", text: "Position closed." });
  });

  it("locks one cancel through approval until a fresh order list removes that order", async () => {
    const order = { marketId: 7, orderId: "9001" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now(), [], [order]) };
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result, rerender } = renderDesk();

    await act(async () => {
      result.current.accountActions.onCancelOrder(order);
      result.current.accountActions.onCancelOrder(order);
    });
    expect(prepareDeskAction).toHaveBeenCalledTimes(1);
    expect(result.current.cancellingOrders.get("7:9001")).toBe("approval");

    act(() => result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: JSON.stringify({ source: "vex_lighter_order_cancel", status: "canceled" }),
    })));
    expect(result.current.cancellingOrders.get("7:9001")).toBe("checking");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000, [], [order]) };
    rerender();
    expect(result.current.cancellingOrders.get("7:9001")).toBe("checking");

    accountData.value = { ok: true, data: {
      ...positionAccount(Date.now() + 1_500, [], []),
      openOrdersTruncated: true,
    } };
    rerender();
    expect(result.current.cancellingOrders.get("7:9001")).toBe("checking");

    accountData.value = { ok: true, data: positionAccount(Date.now() + 2_000, [], []) };
    rerender();
    await waitFor(() => expect(result.current.cancellingOrders.has("7:9001")).toBe(false));
    expect(result.current.deskOutcome).toEqual({ tone: "ok", text: "Order canceled." });
  });

  it("releases a rejected cancel but retains an uncertain cancel until provider evidence arrives", async () => {
    const order = { marketId: 7, orderId: "9001" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now(), [], [order]) };
    prepareDeskAction.mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } })
      .mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-2" } });
    const { result, rerender } = renderDesk();

    await act(async () => { result.current.accountActions.onCancelOrder(order); });
    act(() => result.current.onApprovalResolved("rejected", resolved({ id: "ap-1", status: "rejected" })));
    expect(result.current.cancellingOrders.has("7:9001")).toBe(false);

    await act(async () => { result.current.accountActions.onCancelOrder(order); });
    act(() => result.current.onApprovalResolved("approved", resolved({ id: "ap-2", executionStatus: "indeterminate" })));
    expect(result.current.cancellingOrders.get("7:9001")).toBe("uncertain");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000, [], [order]) };
    rerender();
    expect(result.current.cancellingOrders.get("7:9001")).toBe("uncertain");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 2_000, [], []) };
    rerender();
    await waitFor(() => expect(result.current.cancellingOrders.has("7:9001")).toBe(false));
    expect(result.current.deskOutcome?.text).toContain("Check Trade History for any fill");
  });

  describe("a desk card that times out", () => {
    const closeCard = (expiresAt: string) => ({
      id: "ap-exp",
      origin: "desk",
      status: "pending",
      decisionReason: null,
      expiresAt,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      preview: { namespace: "lighter", toolName: "position.close", criticalArgs: {} },
    });

    it("releases the close it locked once the card has expired unapproved", async () => {
      // 2026-09-24: the close card expired at 15:47 and the row stayed "Awaiting approval".
      accountData.value = { ok: true, data: positionAccount(Date.now()) };
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-exp" } });
      approvalGet.mockResolvedValue({ ok: true, data: { ...closeCard(new Date(Date.now() - 10_000).toISOString()), status: "rejected", decisionReason: "expired_ttl" } });
      const { result, rerender } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });
      expect(result.current.closingPositions.get("7-long")).toBe("approval");

      approvalsData.value = [closeCard(new Date(Date.now() - 10_000).toISOString())];
      await act(async () => { rerender(); });

      await vi.waitFor(() => expect(result.current.closingPositions.has("7-long")).toBe(false));
      expect(approvalGet).toHaveBeenCalledWith({ id: "ap-exp" });
      expect(result.current.deskOutcome?.text).toBe("The close request expired before it was approved. Nothing was sent.");
    });

    it("keeps the row locked when the card was approved in its last moments", async () => {
      accountData.value = { ok: true, data: positionAccount(Date.now()) };
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-exp" } });
      approvalGet.mockResolvedValue({ ok: true, data: { ...closeCard(new Date(Date.now() - 10_000).toISOString()), status: "approved" } });
      const { result, rerender } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });
      approvalsData.value = [closeCard(new Date(Date.now() - 10_000).toISOString())];
      await act(async () => { rerender(); });

      await vi.waitFor(() => expect(approvalGet).toHaveBeenCalled());
      expect(result.current.closingPositions.get("7-long")).toBe("approval");
    });
  });

  it("unlocks a cancel when preparation is refused", async () => {
    const order = { marketId: 7, orderId: "9001" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now(), [], [order]) };
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "refused", reason: "Order is no longer active." } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onCancelOrder(order); });
    expect(result.current.cancellingOrders.has("7:9001")).toBe(false);
    expect(result.current.handoffError).toBe("Order is no longer active.");
  });

  it("says plainly that nothing was prepared when Lighter could not be reached", async () => {
    // 2026-09-24, Wi-Fi off: the ticket read "Lighter order preview unavailable (LIGHTER_API_ERROR: ... fetch failed)".
    const order = { marketId: 7, orderId: "9003" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now(), [], [order]) };
    prepareDeskAction.mockResolvedValue({
      ok: true,
      data: { kind: "refused", reason: "Lighter order preview unavailable (LIGHTER_API_ERROR: Check network connectivity - fetch failed)" },
    });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onCancelOrder(order); });
    expect(result.current.handoffError).toBe("Couldn't reach Lighter, so nothing was prepared or sent. Check your connection and try again.");
  });

  it("shows a refusal at approval time without the agent lane's wrapper and error code", async () => {
    // Account 31824, 2026-09-24: the margin check's refusal reached the ticket wrapped.
    const refusal = "Lighter would cancel this BTC order with no fill: it needs about 1.135142 USDG, but account 31824 has 0.103463 USDG available. Nothing was signed. Even Lighter's minimum of 0.00020 BTC does not fit. Add margin first.";
    const order = { marketId: 7, orderId: "9002" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now(), [], [order]) };
    prepareDeskAction.mockResolvedValue({
      ok: true,
      data: {
        kind: "refused",
        reason: `Lighter order preview was created, but its approval card could not be prepared (INSUFFICIENT_BALANCE - ${refusal})`,
      },
    });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onCancelOrder(order); });
    expect(result.current.handoffError).toBe(refusal);
  });

  it("unlocks a rejected close and keeps a resting reduce-only limit tied to its position", async () => {
    accountData.value = { ok: true, data: positionAccount(Date.now()) };
    prepareDeskAction.mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } })
      .mockResolvedValueOnce({ ok: true, data: { kind: "enqueued", approvalId: "ap-2" } });
    const { result, rerender } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });
    act(() => result.current.onApprovalResolved("rejected", resolved({ id: "ap-1", status: "rejected" })));
    expect(result.current.closingPositions.has("7-long")).toBe(false);

    await act(async () => { result.current.submitDraft({ mode: "limit", side: "sell", baseAmount: "0.25", limitPrice: "3300", timeInForce: "good-till-time", orderExpiryOffsetMinutes: 60, reduceOnly: true }); });
    expect(result.current.closingPositions.get("7-long")).toBe("approval");
    act(() => result.current.onApprovalResolved("approved", resolved({
      id: "ap-2", toolOutput: providerOrderOutput({ state: "open", source: "active_order", orderId: "9001" }),
    })));
    expect(result.current.closingPositions.get("7-long")).toBe("resting");

    const openOrder = { marketId: 7, orderId: "9001" } as LighterOpenOrderRow;
    accountData.value = { ok: true, data: positionAccount(Date.now() + 1_000) };
    rerender();
    expect(result.current.closingPositions.get("7-long")).toBe("resting");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 2_000, [OPEN_POSITION], [openOrder]) };
    rerender();
    expect(result.current.closingPositions.get("7-long")).toBe("resting");
    accountData.value = { ok: true, data: positionAccount(Date.now() + 3_000) };
    rerender();
    await waitFor(() => expect(result.current.closingPositions.has("7-long")).toBe(false));
  });

  it("releases a close that Lighter confirms did not fill", async () => {
    accountData.value = { ok: true, data: positionAccount(Date.now()) };
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-1" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });
    act(() => result.current.onApprovalResolved("approved", resolved({
      id: "ap-1",
      toolOutput: JSON.stringify({ source: "vex_lighter_position_close", status: "not_closed" }),
    })));

    expect(result.current.closingPositions.has("7-long")).toBe(false);
    expect(result.current.deskOutcome?.tone).toBe("warn");
    expect(result.current.deskOutcome?.text).toContain("did not fill");
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
      progressId: expect.any(String),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalsKeys.pending("s1") });
    expect(result.current.submitting).toBe(false);
    expect(result.current.handoffError).toBeNull();
    // The funnel counts the card once it is enqueued, not on the attempt.
    expect(funnelStep).toHaveBeenCalledTimes(1);
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_card", environment: "rhc" });
  });

  it("shows only progress for its own prepare and clears the stage after the card arrives", async () => {
    let settle: ((value: unknown) => void) | undefined;
    let listener: ((event: { progressId: string; stage: "checking_account" | "checking_market" | "creating_approval" }) => void) | undefined;
    const unsubscribe = vi.fn();
    prepareDeskAction.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    vi.stubGlobal("window", Object.assign(window, {
      vex: { lighterTrading: { prepareDeskAction, onDeskPrepareProgress: (callback: typeof listener) => { listener = callback; return unsubscribe; } }, approvals: { approve }, telemetry: { funnelStep } },
    }));
    const { result } = renderDesk();
    act(() => { result.current.submitDraft(ENTRY); });
    await waitFor(() => expect(result.current.prepareStage).toBe("checking_account"));
    const progressId = prepareDeskAction.mock.calls[0]?.[0]?.progressId as string;
    act(() => { listener?.({ progressId: crypto.randomUUID(), stage: "creating_approval" }); });
    expect(result.current.prepareStage).toBe("checking_account");
    act(() => { listener?.({ progressId, stage: "checking_market" }); });
    expect(result.current.prepareStage).toBe("checking_market");
    act(() => { listener?.({ progressId, stage: "creating_approval" }); });
    expect(result.current.prepareStage).toBe("creating_approval");
    await act(async () => { settle?.({ ok: true, data: { kind: "enqueued", approvalId: "ap-progress" } }); });
    await waitFor(() => expect(result.current.prepareStage).toBeNull());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
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

  it.each(["long", "short"] as const)("makes the partial %s close review step explicit and clears an earlier refusal", async (side) => {
    accountData.value = { ok: true, data: positionAccount(Date.now()) };
    prepareDeskAction.mockResolvedValueOnce({ ok: true, data: {
      kind: "refused", reason: "A live Lighter close action already exists.",
    } });
    const { result } = renderDesk();
    const position = { ...OPEN_POSITION, side, size: "0.1754" };
    await act(async () => result.current.accountActions.onClosePosition(position, 1));
    expect(result.current.handoffError).toContain("still settling");
    await act(async () => result.current.accountActions.onClosePosition(position, 0.75));
    expect(result.current.handoffError).toBeNull();
    expect(result.current.ticketPrefill).toMatchObject({
      mode: "market", side: side === "long" ? "sell" : "buy", baseAmount: "0.1315", reduceOnly: true,
      reviewHint: `75% ${position.symbol} close loaded. Click ${side === "long" ? "Short" : "Long"} to review the reduce-only order.`,
    });
    expect(prepareDeskAction).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
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
    expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Cancel outcome is uncertain. Wait for order status before retrying." });

    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9001" } as LighterOpenOrderRow); });
    expect(prepareDeskAction).toHaveBeenCalledTimes(2);
    await act(async () => { result.current.accountActions.onCancelOrder({ marketId: 7, orderId: "9002" } as LighterOpenOrderRow); });
    act(() => { result.current.onApprovalResolved("rejected", resolved({ id: "ap-3", status: "rejected", executionStatus: null })); });
    expect(result.current.deskOutcome).toBeNull();
    expect(funnelStep).toHaveBeenLastCalledWith({ step: "desk_approval_rejected", environment: "rhc" });
  });

  it("tells the trader a stuck Lighter action clears itself, without a manual step", async () => {
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

    expect(result.current.deskOutcome?.text).toContain("Vex clears it automatically");
    expect(result.current.deskOutcome?.text).not.toContain("Ask Vex in chat");
    expect(result.current.deskOutcome?.text).not.toContain("lighter.order.status");
  });

  it("maps the execution-time refusal wording to the same automatic message", async () => {
    prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-4" } });
    const { result } = renderDesk();

    await act(async () => { result.current.accountActions.onClosePosition({ marketId: 7, side: "long", size: "0.25" } as LighterPositionRow, 1); });
    act(() => {
      result.current.onApprovalResolved("approved", resolved({
        id: "ap-4",
        executionStatus: "failed",
        toolOutput: "A previous Lighter action on RHC account 42 still holds this account's nonce and its outcome is not yet proven. This order was not signed or submitted; Vex clears the blocking reservation automatically. Try again shortly.",
      }));
    });

    expect(result.current.deskOutcome?.text).toBe(
      "A previous Lighter action is still settling. No new order was placed. Vex clears it automatically; try again shortly.",
    );
  });

  describe("background approve (APPROVAL_DISPATCH_BACKGROUND)", () => {
    const AT = "2026-10-03T09:00:00.000Z";

    async function enqueueOrder(result: { current: ReturnType<typeof useLighterDesk> }, approvalId: string): Promise<void> {
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId } });
      await act(async () => { result.current.submitDraft(ENTRY); });
    }

    it("a dispatching reply keeps the card tracked and says it is sending, then the event settles it like the awaited reply", async () => {
      const { result } = renderDesk();
      await enqueueOrder(result, "ap-bg1");

      act(() => result.current.onApprovalResolved("approved", resolved({ id: "ap-bg1", executionStatus: "dispatching" })));
      expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Approved. Sending to Lighter..." });

      act(() => emitDispatch({
        phase: "settled",
        approvalId: "ap-bg1",
        occurredAt: AT,
        result: resolved({ id: "ap-bg1", toolOutput: providerOrderOutput({ state: "open", source: "active_order", orderId: "123456789" }) }),
      }));
      expect(result.current.deskOutcome).toEqual({ tone: "ok", text: "Order …23456789 is open on Lighter. Track it in Orders below." });
      // The approve is counted once, when the outcome lands.
      expect(funnelStep.mock.calls.filter((call) => JSON.stringify(call).includes("desk_approve"))).toHaveLength(1);
    });

    it("an event that beats the reply settles the card once; the late reply finds nothing to settle", async () => {
      const { result } = renderDesk();
      await enqueueOrder(result, "ap-bg2");

      act(() => emitDispatch({
        phase: "settled",
        approvalId: "ap-bg2",
        occurredAt: AT,
        result: resolved({ id: "ap-bg2", executionStatus: "indeterminate" }),
      }));
      expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Outcome unknown. Open Orders below and refresh before retrying." });
      act(() => result.current.onApprovalResolved("approved", resolved({ id: "ap-bg2", executionStatus: "dispatching" })));
      expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Outcome unknown. Open Orders below and refresh before retrying." });
    });

    it("a failed event reports on the ticket and releases the row, exactly like a failed awaited approve", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      accountData.value = { ok: true, data: positionAccount(Date.now()) };
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-bg3" } });
      approve.mockResolvedValue({ ok: true, data: resolved({ id: "ap-bg3", executionStatus: "dispatching" }) });
      const { result } = renderDesk();

      await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });
      expect(result.current.closingPositions.get("7-long")).toBe("approval");

      act(() => emitDispatch({ phase: "failed", approvalId: "ap-bg3", occurredAt: AT, message: "Tool execution failed after approval." }));
      expect(result.current.handoffError).toBe("Tool execution failed after approval.");
      expect(result.current.closingPositions.has("7-long")).toBe(false);
    });

    it("ignores events for cards it is not tracking", async () => {
      const { result } = renderDesk();
      act(() => emitDispatch({ phase: "failed", approvalId: "someone-else", occurredAt: AT, message: "nope" }));
      expect(result.current.handoffError).toBeNull();
      expect(result.current.deskOutcome).toBeNull();
    });

    it("a missed event falls back to the durable status and says only that the outcome is unknown", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderDesk();
        await enqueueOrder(result, "ap-bg4");
        approvalGet.mockResolvedValue({ ok: true, data: { executionStatus: "succeeded", status: "approved" } });

        act(() => result.current.onApprovalResolved("approved", resolved({ id: "ap-bg4", executionStatus: "dispatching" })));
        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });

        expect(approvalGet).toHaveBeenCalledWith({ id: "ap-bg4" });
        expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Outcome unknown. Open Orders below and refresh before retrying." });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps waiting while the durable row is still dispatching", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderDesk();
        await enqueueOrder(result, "ap-bg5");
        approvalGet.mockResolvedValue({ ok: true, data: { executionStatus: "dispatching", status: "approved" } });

        act(() => result.current.onApprovalResolved("approved", resolved({ id: "ap-bg5", executionStatus: "dispatching" })));
        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
        expect(result.current.deskOutcome).toEqual({ tone: "warn", text: "Approved. Sending to Lighter..." });

        act(() => emitDispatch({
          phase: "settled",
          approvalId: "ap-bg5",
          occurredAt: AT,
          result: resolved({ id: "ap-bg5", executionStatus: "failed", toolOutput: "Order rejected: too small." }),
        }));
        expect(result.current.deskOutcome).toEqual({ tone: "error", text: "Order rejected: too small." });
      } finally {
        vi.useRealTimers();
      }
    });
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
      expect(result.current.deskOutcome).toBeNull();
      expect(result.current.submitting).toBe(false);
      expect(result.current.handoffError).toBeNull();
    });

    it("shows the close outcome from the approve reply without waiting on the query refresh", async () => {
      useLighterAnalysisStore.getState().saveDesk({ skipCloseConfirm: true });
      accountData.value = { ok: true, data: positionAccount(Date.now(), [OPEN_POSITION]) };
      prepareDeskAction.mockResolvedValue({ ok: true, data: { kind: "enqueued", approvalId: "ap-6" } });
      approve.mockResolvedValue({ ok: true, data: resolved({
        id: "ap-6",
        toolOutput: JSON.stringify({ source: "vex_lighter_position_close", status: "closed" }),
      }) });
      const { result, invalidate } = renderDesk();
      // A refresh that never settles: the outcome must not wait on it.
      invalidate.mockReturnValue(new Promise<void>(() => undefined));

      await act(async () => { result.current.accountActions.onClosePosition(OPEN_POSITION, 1); });

      expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalsKeys.pending("s1") });
      expect(result.current.closingPositions.get("7-long")).toBe("checking");
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
