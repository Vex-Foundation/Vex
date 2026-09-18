import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import type {
  LighterDeskAction,
  LighterTradingAccount,
  LighterTradingEnvironment,
  LighterTradingFills,
} from "@shared/schemas/lighter-trading.js";
import { usePendingApprovals } from "../../../lib/api/approvals.js";
import { approvalsKeys } from "../../../lib/api/queryKeys.js";
import { selectFreshApprovals } from "../approvals/fresh-approvals.js";
import { invalidateOnApprovalResolve } from "../approvals/invalidate-on-resolve.js";
import { isLighterOrderApproval } from "./desk-approvals.js";
import {
  filledAmountSentence,
  fillsForOrder,
  parseDeskOrderExecution,
  totalFillSize,
} from "./desk-fill-outcome.js";
import { isPositiveDecimal } from "./decimal.js";
import { recordFunnelStep } from "./funnel.js";
import {
  protectionPrefill,
  type DeskOutcome,
  type TradeDraft,
  type TradeTicketPrefill,
  type TradeTicketPricePick,
} from "./ticket-model.js";

/** Fallback poll only; the live sync pushes new approvals the moment they enqueue. */
const APPROVALS_REFETCH_INTERVAL_MS = 60_000;

const SENT_TEXT: Record<LighterDeskAction["kind"], string> = {
  order: "Order sent.",
  close: "Close sent.",
  cancel: "Cancel sent.",
};

export interface DeskLaneInput {
  activeSessionId: string | null;
  environment: LighterTradingEnvironment;
  /** The desk's market; a change resets the ticket and any outcome shown for the last one. */
  marketId: number | null;
  marketSymbol: string | null;
  skipCloseConfirm: boolean;
  /** Complete account/order snapshot, used only to know when one exact order leaves the active book. */
  account: LighterTradingAccount | null;
  /** Account fills retain exact order identity, so simultaneous market orders never cross-match. */
  fills: LighterTradingFills | null;
  /** No session yet: the action opens the session creator instead. */
  onNoSession: () => void;
}

interface DeskScope {
  readonly sessionId: string;
  readonly environment: LighterTradingEnvironment;
  readonly marketId: number;
}

interface PendingDeskAction {
  readonly action: LighterDeskAction;
  readonly draft: TradeDraft | null;
  readonly scope: DeskScope;
  readonly symbol: string | null;
}

interface AwaitedProviderOrder {
  readonly orderId: string;
  readonly draft: TradeDraft | null;
  readonly scope: DeskScope;
  readonly symbol: string | null;
  /** Account/fill snapshots older than this approval cannot settle the order. */
  readonly startedAt: number;
}

function sameDeskScope(
  pending: DeskScope,
  current: { readonly sessionId: string | null; readonly environment: LighterTradingEnvironment; readonly marketId: number | null },
): boolean {
  return pending.sessionId === current.sessionId
    && pending.environment === current.environment
    && pending.marketId === current.marketId;
}

function hasAttachedProtection(draft: TradeDraft | null): boolean {
  return draft !== null && protectionPrefill(draft, 0) !== null;
}

function orderLabel(orderId: string | null): string {
  if (orderId === null) return "Order";
  return `Order …${orderId.slice(-8)}`;
}

/**
 * The desk lane: Close, Cancel and the ticket's Long/Short go to main, main
 * derives the terms and enqueues an approval card, and only Confirm signs
 * (design §7.11). This hook owns that round trip, the card list the dialog
 * shows, and the ticket state the outcome feeds back into.
 */
export function useDeskLane({
  activeSessionId,
  environment,
  marketId,
  marketSymbol,
  skipCloseConfirm,
  account,
  fills,
  onNoSession,
}: DeskLaneInput) {
  const queryClient = useQueryClient();
  const [ticketPrefill, setTicketPrefill] = useState<TradeTicketPrefill | null>(null);
  const [pricePick, setPricePick] = useState<TradeTicketPricePick | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  // A selector goes to main, main builds the proposal and enqueues the card;
  // the ticket waits while that round trip runs.
  const [submitting, setSubmitting] = useState(false);
  const [deskOutcome, setDeskOutcome] = useState<DeskOutcome | null>(null);
  const [awaitedOrder, setAwaitedOrder] = useState<AwaitedProviderOrder | null>(null);
  // More than one desk card may be awaiting a decision at the same time.
  const pendingDesk = useRef<Map<string, PendingDeskAction>>(new Map());
  const currentScope = useRef({ sessionId: activeSessionId, environment, marketId });
  currentScope.current = { sessionId: activeSessionId, environment, marketId };

  const approvalsQuery = usePendingApprovals(activeSessionId, {
    refetchInterval: APPROVALS_REFETCH_INTERVAL_MS,
  });
  const approvals = useMemo(() => {
    if (approvalsQuery.data?.ok !== true) return [];
    return approvalsQuery.data.data.filter(isLighterOrderApproval);
  }, [approvalsQuery.data]);
  const seenApprovalIds = useRef<Set<string>>(new Set());
  const focusApprovalId = useMemo(
    () => selectFreshApprovals(approvals, seenApprovalIds.current)[0]?.id ?? null,
    [approvals],
  );
  useEffect(() => {
    seenApprovalIds.current = new Set(approvals.map((row) => row.id));
  }, [approvals]);

  useEffect(() => {
    setHandoffError(null);
    setDeskOutcome(null);
    setTicketPrefill(null);
    setPricePick(null);
    setAwaitedOrder(null);
  }, [activeSessionId, marketId, environment]);

  const finishFilledOrder = useCallback((input: {
    readonly draft: TradeDraft | null;
    readonly size: string;
    readonly symbol: string | null;
    readonly averagePrice: string | null;
    readonly closedAfterPartial?: boolean;
  }): void => {
    const follow = input.draft === null
      ? null
      : protectionPrefill(input.draft, Date.now(), input.size);
    if (follow !== null) setTicketPrefill(follow);
    const fillText = filledAmountSentence(input.size, input.symbol, input.averagePrice);
    const closedText = input.closedAfterPartial === true ? " The entry is no longer open." : "";
    const protectionText = follow === null ? "" : " Protection is loaded for the filled amount.";
    setDeskOutcome({ tone: "ok", text: `${fillText}${closedText}${protectionText}` });
  }, []);

  // An active or account-trade result can settle after the approval call. Wait
  // for snapshots newer than the result, then use only this provider order's
  // fills. This handles full fills and partial-fill-then-cancel without sizing
  // protection from the originally requested amount.
  useEffect(() => {
    if (awaitedOrder === null || fills === null) return;
    const exactFills = fills.available
      ? fillsForOrder(fills.fills, awaitedOrder.scope.marketId, awaitedOrder.orderId)
      : [];
    const filledSize = totalFillSize(exactFills);
    const symbol = exactFills[0]?.symbol ?? awaitedOrder.symbol;
    const stillOpen = account?.openOrders.some((order) => (
      order.marketId === awaitedOrder.scope.marketId && order.orderId === awaitedOrder.orderId
    )) ?? false;
    if (stillOpen) {
      if (filledSize !== null && !fills.truncated) {
        const protectionText = hasAttachedProtection(awaitedOrder.draft)
          ? " Protection will load after the final filled amount is verified."
          : "";
        setDeskOutcome({
          tone: "warn",
          text: `Partially ${filledAmountSentence(filledSize, symbol, null).toLowerCase()} The remainder is still open.${protectionText}`,
        });
      }
      return;
    }
    const accountIsFreshAndComplete = account !== null
      && account.openOrdersAvailable
      && !account.openOrdersTruncated
      && account.retrievedAt >= awaitedOrder.startedAt;
    const fillsAreFresh = fills.available && fills.retrievedAt >= awaitedOrder.startedAt;
    if (!accountIsFreshAndComplete || !fillsAreFresh) return;
    setAwaitedOrder(null);
    if (fills.truncated) {
      setDeskOutcome({
        tone: "warn",
        text: "The order is no longer open, but recent fill history is truncated. Check the position before adding protection.",
      });
      return;
    }
    if (filledSize !== null) {
      recordFunnelStep("desk_order_filled", awaitedOrder.scope.environment);
      finishFilledOrder({
        draft: awaitedOrder.draft,
        size: filledSize,
        symbol,
        averagePrice: exactFills.length === 1 ? exactFills[0]?.price ?? null : null,
        closedAfterPartial: true,
      });
      return;
    }
    setDeskOutcome({
      tone: "warn",
      text: "The order is no longer open and no fill was returned. Check order history before retrying.",
    });
  }, [account, awaitedOrder, fills, finishFilledOrder]);

  // A desk card resolved. Protection remains a separate approval, and it is
  // loaded only after the provider proves the amount that actually filled.
  const onApprovalResolved = (decision: "approved" | "rejected", result: ApprovalActionResult): void => {
    const pending = pendingDesk.current.get(result.id);
    if (pending === undefined) return;
    pendingDesk.current.delete(result.id);
    if (decision === "rejected") {
      recordFunnelStep("desk_approval_rejected", pending.scope.environment);
      return;
    }
    recordFunnelStep("desk_approve", pending.scope.environment);
    const scopeIsCurrent = sameDeskScope(pending.scope, currentScope.current);
    if (result.executionStatus === "succeeded") {
      if (pending.action.kind !== "order") {
        if (!scopeIsCurrent) return;
        setDeskOutcome({ tone: "ok", text: SENT_TEXT[pending.action.kind] });
        return;
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] }),
        queryClient.invalidateQueries({ queryKey: ["lighterTrading", "fills", pending.scope.environment] }),
      ]);
      const execution = parseDeskOrderExecution(
        result.toolOutput,
        pending.scope.environment,
        pending.action.marketId,
      );
      if (execution === null) {
        recordFunnelStep("desk_order_unknown", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome(hasAttachedProtection(pending.draft)
          ? { tone: "warn", text: "Order submitted, but its fill state could not be verified. Open Orders below before adding protection or retrying." }
          : { tone: "ok", text: SENT_TEXT.order });
        return;
      }
      if (execution.state === "ambiguous") {
        recordFunnelStep("desk_order_unknown", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({ tone: "warn", text: "Order outcome is uncertain. Open Orders below and refresh before retrying." });
        return;
      }
      if (execution.state === "sequencer_pending") {
        recordFunnelStep("desk_order_accepted", pending.scope.environment);
        if (!scopeIsCurrent) return;
        if (execution.orderId !== null) {
          setAwaitedOrder({
            orderId: execution.orderId,
            draft: pending.draft,
            scope: pending.scope,
            symbol: pending.symbol,
            startedAt: Date.now(),
          });
        }
        setDeskOutcome({
          tone: "warn",
          text: `${orderLabel(execution.orderId)} was accepted and is still confirming on Lighter. Track it in Orders below; do not retry.`,
        });
        return;
      }
      if (execution.state === "rejected") {
        recordFunnelStep("desk_order_rejected", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({
          tone: "error",
          text: `${orderLabel(execution.orderId)} was rejected by Lighter. Review size, price, and market limits before editing the ticket.`,
        });
        return;
      }
      if (execution.state === "canceled") {
        recordFunnelStep("desk_order_canceled", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({
          tone: "warn",
          text: `${orderLabel(execution.orderId)} was canceled before it filled. Check Orders below before retrying.`,
        });
        return;
      }
      recordFunnelStep("desk_order_accepted", pending.scope.environment);
      if (execution.state === "partially_filled") {
        recordFunnelStep("desk_order_partial", pending.scope.environment);
      } else if (execution.state === "filled") {
        recordFunnelStep("desk_order_filled", pending.scope.environment);
      }
      if (!scopeIsCurrent) return;
      const terminalPartial = execution.state === "partially_filled" && execution.source === "inactive_order";
      if ((execution.state === "filled" || terminalPartial)
        && execution.filledBaseAmount !== null
        && isPositiveDecimal(execution.filledBaseAmount)) {
        finishFilledOrder({
          draft: pending.draft,
          size: execution.filledBaseAmount,
          symbol: pending.symbol,
          averagePrice: execution.averageExecutionPrice,
          closedAfterPartial: terminalPartial,
        });
        return;
      }
      if (execution.orderId !== null) {
        setAwaitedOrder({
          orderId: execution.orderId,
          draft: pending.draft,
          scope: pending.scope,
          symbol: pending.symbol,
          startedAt: Date.now(),
        });
      }
      const protectionText = hasAttachedProtection(pending.draft)
        ? " Protection will load after the final filled amount is verified."
        : "";
      if (execution.state === "open") {
        setDeskOutcome({ tone: "ok", text: `${orderLabel(execution.orderId)} is open on Lighter. Track it in Orders below.${protectionText}` });
        return;
      }
      const observedSize = execution.filledBaseAmount ?? execution.observedTradeSize;
      const partialText = observedSize !== null && isPositiveDecimal(observedSize)
        ? `A ${filledAmountSentence(observedSize, pending.symbol, execution.observedTradePrice).toLowerCase().replace(/^filled/, "fill of")}`
        : "A partial fill was confirmed.";
      setDeskOutcome({ tone: "warn", text: `${partialText} Checking the final order size.${protectionText}` });
      return;
    }
    if (result.executionStatus === "indeterminate") {
      if (pending.action.kind === "order") recordFunnelStep("desk_order_unknown", pending.scope.environment);
      if (!scopeIsCurrent) return;
      setDeskOutcome({ tone: "warn", text: "Outcome unknown. Open Orders below and refresh before retrying." });
      return;
    }
    if (pending.action.kind === "order") recordFunnelStep("desk_order_rejected", pending.scope.environment);
    if (!scopeIsCurrent) return;
    setDeskOutcome({ tone: "error", text: result.toolOutput ?? result.message });
  };

  // "Don't ask again" for Market close: the card still goes through main's
  // prepare -> approve lane; the desk just answers it in the user's stead
  // before the pending list is pulled, so no dialog flashes.
  const approveOnDesk = async (sessionId: string, approvalId: string): Promise<void> => {
    const result = await window.vex.approvals.approve({ id: approvalId });
    await invalidateOnApprovalResolve(queryClient, sessionId);
    if (!result.ok) {
      pendingDesk.current.delete(approvalId);
      setHandoffError(result.error.message);
      return;
    }
    onApprovalResolved("approved", result.data);
  };

  const prepareOnDesk = async (action: LighterDeskAction, draft: TradeDraft | null): Promise<void> => {
    if (activeSessionId === null) {
      onNoSession();
      return;
    }
    setHandoffError(null);
    setDeskOutcome(null);
    setAwaitedOrder(null);
    setSubmitting(true);
    const scope: DeskScope = {
      sessionId: activeSessionId,
      environment,
      marketId: action.marketId,
    };
    try {
      const result = await window.vex.lighterTrading.prepareDeskAction({ sessionId: activeSessionId, environment, action });
      if (!result.ok) {
        setHandoffError(result.error.message);
        return;
      }
      if (result.data.kind === "refused") {
        setHandoffError(result.data.reason);
        return;
      }
      pendingDesk.current.set(result.data.approvalId, {
        action,
        draft,
        scope,
        symbol: action.marketId === marketId ? marketSymbol : null,
      });
      recordFunnelStep("desk_card", environment);
      if (action.kind === "close" && skipCloseConfirm) {
        await approveOnDesk(activeSessionId, result.data.approvalId);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: approvalsKeys.pending(activeSessionId) });
    } finally {
      setSubmitting(false);
    }
  };

  return {
    approvals,
    focusApprovalId,
    ticketPrefill,
    setTicketPrefill,
    pricePick,
    setPricePick,
    handoffError,
    setHandoffError,
    submitting,
    deskOutcome,
    prepareOnDesk,
    onApprovalResolved,
  };
}

export type DeskLane = ReturnType<typeof useDeskLane>;
