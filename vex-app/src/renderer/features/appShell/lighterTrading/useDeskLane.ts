import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import type {
  LighterDeskAction,
  LighterDeskPrepareProgressEvent,
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
  type DeskOrderExecution,
} from "./desk-fill-outcome.js";
import { isPositiveDecimal } from "./decimal.js";
import type { LighterPositionRow, OrderCancelStage, PositionCloseStage } from "./account-model.js";
import { recordFunnelStep } from "./funnel.js";
import {
  protectionPrefill,
  type DeskOutcome,
  type TradeDraft,
  type TradeTicketPrefill,
  type TradeTicketPricePick,
} from "./ticket-model.js";

/**
 * How long past a desk card's own expiry the lane waits before asking what
 * became of it, so an approval clicked in its last second is already marked
 * approved when the lane looks.
 */
const DESK_CARD_EXPIRY_GRACE_MS = 5_000;

/** Fallback poll only; the live sync pushes new approvals the moment they enqueue. */
const APPROVALS_REFETCH_INTERVAL_MS = 60_000;

/**
 * With `APPROVAL_DISPATCH_BACKGROUND` on, an approve answers `dispatching` and
 * its outcome arrives on `EV.approvals.dispatch`. An event can be missed (a
 * reloaded window, a payload dropped at the preload gate), so a card still
 * waiting this long asks main for its durable status. It never re-sends.
 */
const DISPATCH_OUTCOME_FALLBACK_MS = 90_000;

/**
 * The ticket's own Long/Short, Close and Cancel - never the account-setup
 * modal's deposit/key/fee chain, which has its own auto-approve driver
 * (`useLighterAccountSetup`) and never reaches this lane's approval dialog.
 */
type DeskLaneAction = Extract<LighterDeskAction, { kind: "order" | "close" | "cancel" | "cancel_all" }>;

function closeDisposition(output: string | undefined): "closed" | "partially_closed" | "not_closed" | "sequencer_pending" | "ambiguous" | null {
  if (output === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object" || !("source" in parsed) || parsed.source !== "vex_lighter_position_close") return null;
    if (!("status" in parsed)) return null;
    const status = parsed.status;
    return status === "closed" || status === "partially_closed" || status === "not_closed"
      || status === "sequencer_pending" || status === "ambiguous" ? status : null;
  } catch {
    return null;
  }
}

function cancelDisposition(output: string | undefined): "canceled" | "sequencer_pending" | "ambiguous" | null {
  if (output === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object" || !("source" in parsed) || parsed.source !== "vex_lighter_order_cancel") return null;
    if (!("status" in parsed)) return null;
    return parsed.status === "canceled" || parsed.status === "sequencer_pending" || parsed.status === "ambiguous"
      ? parsed.status : null;
  } catch {
    return null;
  }
}

function cancelAllDisposition(output: string | undefined): "cancel_all_completed" | "sequencer_pending" | "ambiguous" | null {
  if (output === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object" || !("source" in parsed) || parsed.source !== "vex_lighter_order_cancel_all"
      || !("status" in parsed)) return null;
    return parsed.status === "cancel_all_completed" || parsed.status === "sequencer_pending" || parsed.status === "ambiguous"
      ? parsed.status : null;
  } catch {
    return null;
  }
}

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
  readonly marketId: number | null;
}

interface PendingDeskAction {
  readonly action: DeskLaneAction;
  readonly draft: TradeDraft | null;
  readonly scope: DeskScope;
  readonly symbol: string | null;
  readonly closeKey: string | null;
  readonly cancelKey: string | null;
  readonly cancelAllKey: string | null;
}

interface PendingClose {
  readonly sessionId: string;
  readonly environment: LighterTradingEnvironment;
  readonly accountIndex: number | null;
  readonly marketId: number;
  readonly side: LighterPositionRow["side"];
  readonly sizeBefore: string;
  readonly startedAt: number;
  readonly stage: PositionCloseStage;
  readonly orderId: string | null;
  readonly orderSeen: boolean;
}

interface PendingCancel {
  readonly sessionId: string;
  readonly environment: LighterTradingEnvironment;
  readonly accountIndex: number | null;
  readonly marketId: number;
  readonly orderId: string;
  /** Refreshed when the approval resolves, so an earlier snapshot cannot settle it. */
  readonly startedAt: number;
  readonly stage: OrderCancelStage;
}

interface PendingCancelAll {
  readonly sessionId: string;
  readonly environment: LighterTradingEnvironment;
  readonly accountIndex: number | null;
  readonly startedAt: number;
  readonly stage: OrderCancelStage;
  /** Canonical approval identities; null until the card's main-authored facts arrive. */
  readonly orderKeys: readonly string[] | null;
}

function sameCancelAllScope(pending: PendingCancelAll, sessionId: string | null, environment: LighterTradingEnvironment, accountIndex: number | null): boolean {
  return pending.sessionId === sessionId && pending.environment === environment && pending.accountIndex === accountIndex;
}

function closeRowKey(marketId: number, side: LighterPositionRow["side"]): string {
  return `${marketId}-${side}`;
}

function closeAttemptKey(input: Pick<PendingClose, "sessionId" | "environment" | "accountIndex" | "marketId" | "side">): string {
  const accountScope = input.accountIndex === null ? `session:${input.sessionId}` : `account:${input.accountIndex}`;
  return `${input.environment}:${accountScope}:${closeRowKey(input.marketId, input.side)}`;
}

function cancelRowKey(marketId: number, orderId: string): string {
  return `${marketId}:${orderId}`;
}

function cancelAttemptKey(input: Pick<PendingCancel, "sessionId" | "environment" | "accountIndex" | "marketId" | "orderId">): string {
  const accountScope = input.accountIndex === null ? `session:${input.sessionId}` : `account:${input.accountIndex}`;
  return `${input.environment}:${accountScope}:${cancelRowKey(input.marketId, input.orderId)}`;
}

interface AwaitedProviderOrder {
  readonly orderId: string;
  readonly draft: TradeDraft | null;
  readonly scope: DeskScope;
  readonly symbol: string | null;
  readonly closeKey: string | null;
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

function canceledOrderMessage(order: DeskOrderExecution): string {
  const status = order.providerOrderStatus?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const reason = status === "canceled-margin-not-allowed"
    ? " Lighter did not allow the margin for this order."
    : status === "canceled-expired"
      ? " The order expired before it could fill."
      : "";
  return `${orderLabel(order.orderId)} was canceled with no fill.${reason} This order did not open a position. Check Positions and Trade History before placing another order.`;
}

/**
 * The refusal itself, without the plumbing the agent lane wraps around it: a
 * margin or capital refusal at approval time reached the ticket as "Lighter
 * order preview was created, but its approval card could not be prepared
 * (INSUFFICIENT_BALANCE - ...)".
 */
function unwrapApprovalPreparationFailure(message: string): string {
  const wrapped = /^Lighter order preview was created, but its approval card could not be prepared \((.*)\)$/s.exec(message.trim());
  if (wrapped === null) return message;
  const inner = wrapped[1] ?? "";
  // The agent's failure text leads with the error code: "CODE - detail" or "CODE: hint - detail".
  const coded = /^[A-Z][A-Z0-9_]+(?::[^\n]*?)? - (.+)$/s.exec(inner);
  return coded?.[1] ?? inner;
}

/**
 * Preparing a card only reads from Lighter. When those reads could not reach
 * it (a timeout, a network failure or a 5xx), nothing was prepared or sent;
 * the ticket says so instead of showing "LIGHTER_API_ERROR: ... fetch failed".
 */
const PREPARE_UNREACHABLE = /^Lighter [a-z -]+ unavailable \((?:LIGHTER_TIMEOUT|LIGHTER_API_ERROR)\b/;

function deskFailureMessage(rawMessage: string): string {
  if (PREPARE_UNREACHABLE.test(rawMessage.trim())) {
    return "Couldn't reach Lighter, so nothing was prepared or sent. Check your connection and try again.";
  }
  const message = unwrapApprovalPreparationFailure(rawMessage);
  // Execution has already tried to clear the earlier action by the time this
  // arrives, and the background repair keeps trying: nothing is asked of the
  // trader but a later retry.
  return /unresolved local reservation|previous Lighter nonce remains unresolved|Run lighter\.order\.status|A live Lighter .* action already exists|previous Lighter action .*(still being checked|still holds this account's nonce)/i.test(message)
    ? "A previous Lighter action is still settling. No new order was placed. Vex clears it automatically; try again shortly."
    : message;
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
  const [prepareStage, setPrepareStage] = useState<LighterDeskPrepareProgressEvent["stage"] | "opening_approval" | null>(null);
  const [deskOutcome, setDeskOutcome] = useState<DeskOutcome | null>(null);
  const [awaitedOrder, setAwaitedOrder] = useState<AwaitedProviderOrder | null>(null);
  // More than one desk card may be awaiting a decision at the same time.
  const pendingDesk = useRef<Map<string, PendingDeskAction>>(new Map());
  const closeAttempts = useRef<Map<string, PendingClose>>(new Map());
  const [pendingCloses, setPendingCloses] = useState<ReadonlyMap<string, PendingClose>>(() => new Map());
  const cancelAttempts = useRef<Map<string, PendingCancel>>(new Map());
  const [pendingCancels, setPendingCancels] = useState<ReadonlyMap<string, PendingCancel>>(() => new Map());
  const cancelAllAttempts = useRef<Map<string, PendingCancelAll>>(new Map());
  const [pendingCancelAlls, setPendingCancelAlls] = useState<ReadonlyMap<string, PendingCancelAll>>(() => new Map());
  const updateCancelAll = (key: string, update: PendingCancelAll | null): void => {
    const next = new Map(cancelAllAttempts.current);
    if (update === null) next.delete(key);
    else next.set(key, update);
    cancelAllAttempts.current = next;
    setPendingCancelAlls(next);
  };
  const setCancelAllStage = (key: string | null, stage: OrderCancelStage): void => {
    if (key === null) return;
    const current = cancelAllAttempts.current.get(key);
    if (current !== undefined) updateCancelAll(key, { ...current, stage, startedAt: Date.now() });
  };
  const clearCancelAll = (key: string | null): void => {
    if (key !== null && cancelAllAttempts.current.has(key)) updateCancelAll(key, null);
  };
  const updateClose = (key: string, update: PendingClose | null): void => {
    const next = new Map(closeAttempts.current);
    if (update === null) next.delete(key);
    else next.set(key, update);
    closeAttempts.current = next;
    setPendingCloses(next);
  };
  const setCloseStage = (key: string | null, stage: PositionCloseStage, orderId: string | null = null): void => {
    if (key === null) return;
    const current = closeAttempts.current.get(key);
    if (current !== undefined) updateClose(key, { ...current, stage, orderId });
  };
  const clearClose = (key: string | null): void => {
    if (key !== null && closeAttempts.current.has(key)) updateClose(key, null);
  };
  const updateCancel = (key: string, update: PendingCancel | null): void => {
    const next = new Map(cancelAttempts.current);
    if (update === null) next.delete(key);
    else next.set(key, update);
    cancelAttempts.current = next;
    setPendingCancels(next);
  };
  const setCancelStage = (key: string | null, stage: OrderCancelStage): void => {
    if (key === null) return;
    const current = cancelAttempts.current.get(key);
    if (current !== undefined) updateCancel(key, { ...current, stage, startedAt: Date.now() });
  };
  const clearCancel = (key: string | null): void => {
    if (key !== null && cancelAttempts.current.has(key)) updateCancel(key, null);
  };
  const currentAccountIndex = account?.environment === environment ? account.accountIndex : null;
  const currentScope = useRef({ sessionId: activeSessionId, environment, marketId, accountIndex: currentAccountIndex });
  currentScope.current = { sessionId: activeSessionId, environment, marketId, accountIndex: currentAccountIndex };
  const pendingScopeIsCurrent = (pending: PendingDeskAction): boolean => {
    if (pending.action.kind === "cancel_all") {
      const attempt = pending.cancelAllKey === null ? undefined : cancelAllAttempts.current.get(pending.cancelAllKey);
      return attempt !== undefined && sameCancelAllScope(attempt, currentScope.current.sessionId, currentScope.current.environment, currentScope.current.accountIndex);
    }
    return pending.action.kind === "cancel"
      ? pending.scope.sessionId === currentScope.current.sessionId && pending.scope.environment === currentScope.current.environment
      : sameDeskScope(pending.scope, currentScope.current);
  };

  const approvalsQuery = usePendingApprovals(activeSessionId, {
    refetchInterval: APPROVALS_REFETCH_INTERVAL_MS,
  });
  const approvals = useMemo(() => {
    if (approvalsQuery.data?.ok !== true) return [];
    return approvalsQuery.data.data.filter(isLighterOrderApproval);
  }, [approvalsQuery.data]);
  useEffect(() => {
    for (const approval of approvals) {
      const pending = pendingDesk.current.get(approval.id);
      if (pending?.action.kind !== "cancel_all" || pending.cancelAllKey === null) continue;
      const current = cancelAllAttempts.current.get(pending.cancelAllKey);
      const args = approval.preview?.criticalArgs;
      if (current === undefined || args === undefined || args.environment !== pending.scope.environment
        || typeof args.accountIndex !== "number" || !Number.isSafeInteger(args.accountIndex) || args.accountIndex < 0
        || typeof args.orderIdentities !== "string") continue;
      const orderKeys = args.orderIdentities.split(",");
      if (orderKeys.length === 0 || orderKeys.length !== args.orderCount
        || new Set(orderKeys).size !== orderKeys.length
        || orderKeys.some((key) => !/^(?:0|[1-9][0-9]*):[1-9][0-9]*$/.test(key))) continue;
      if (current.accountIndex === args.accountIndex && current.orderKeys?.join(",") === args.orderIdentities) continue;
      updateCancelAll(pending.cancelAllKey, { ...current, accountIndex: args.accountIndex, orderKeys });
    }
  }, [approvals, pendingCancelAlls]);
  const seenApprovalIds = useRef<Set<string>>(new Set());
  const focusApprovalId = useMemo(
    () => selectFreshApprovals(approvals, seenApprovalIds.current)[0]?.id ?? null,
    [approvals],
  );
  useEffect(() => {
    seenApprovalIds.current = new Set(approvals.map((row) => row.id));
  }, [approvals]);

  // A card that times out is neither approved nor rejected by the trader, so
  // the dialog never reports it, and the row it locked stayed on "Awaiting
  // approval" for good (2026-09-24). Once a desk card's own expiry has passed,
  // or it has left the pending list, ask what became of it: a card nobody
  // approved releases its row; an approved one is executing and reports
  // through onApprovalResolved as before.
  const deskCardExpiry = useRef(new Map<string, number>());
  const [deskCardCheck, setDeskCardCheck] = useState(0);
  useEffect(() => {
    if (approvalsQuery.data?.ok !== true) return undefined;
    const listed = new Set(approvals.map((row) => row.id));
    for (const row of approvals) {
      const expiresAtMs = row.expiresAt === null ? Number.NaN : Date.parse(row.expiresAt);
      if (pendingDesk.current.has(row.id) && Number.isFinite(expiresAtMs)) deskCardExpiry.current.set(row.id, expiresAtMs);
    }
    const now = Date.now();
    let nextCheckAt = Number.POSITIVE_INFINITY;
    let stale = false;
    for (const id of pendingDesk.current.keys()) {
      const expiresAtMs = deskCardExpiry.current.get(id);
      if (expiresAtMs === undefined) continue;
      const dueAt = expiresAtMs + DESK_CARD_EXPIRY_GRACE_MS;
      if (listed.has(id) && now < dueAt) {
        nextCheckAt = Math.min(nextCheckAt, dueAt);
        continue;
      }
      void window.vex.approvals.get({ id }).then((result) => {
        if (stale || !result.ok || result.data === null) return;
        const card = result.data;
        const expired = card.decisionReason === "expired_ttl" || (card.status === "pending" && Date.now() >= dueAt);
        if (card.status === "approved" || !expired) return;
        const pending = pendingDesk.current.get(id);
        if (pending === undefined) return;
        pendingDesk.current.delete(id);
        deskCardExpiry.current.delete(id);
        const scopeIsCurrent = pendingScopeIsCurrent(pending);
        clearClose(pending.closeKey);
        clearCancel(pending.cancelKey);
        clearCancelAll(pending.cancelAllKey);
        const request = pending.action.kind === "close" ? "close" : pending.action.kind === "cancel_all" ? "cancel-all" : pending.action.kind === "cancel" ? "cancel" : "order";
        if (pending.action.kind !== "cancel_all" || scopeIsCurrent) setDeskOutcome({ tone: "warn", text: `The ${request} request expired before it was approved. Nothing was sent.` });
      }, () => undefined);
    }
    const timer = Number.isFinite(nextCheckAt)
      ? setTimeout(() => setDeskCardCheck((count) => count + 1), Math.max(0, nextCheckAt - now))
      : undefined;
    return () => {
      stale = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [approvals, approvalsQuery.data, deskCardCheck, pendingCancelAlls]);

  useEffect(() => {
    setHandoffError(null);
    setDeskOutcome(null);
    setTicketPrefill(null);
    setPricePick(null);
    setAwaitedOrder(null);
  }, [activeSessionId, marketId, environment]);

  // A sent close is not a flat position. Only a fresh account snapshot that
  // shows the exact position reduced/absent, or a finished resting order,
  // releases its row for another close.
  useEffect(() => {
    if (account === null || account.status === "unavailable" || activeSessionId === null) return;
    for (const [key, close] of closeAttempts.current) {
      if ((close.accountIndex === null && close.sessionId !== activeSessionId) || close.environment !== environment
        || close.accountIndex !== account.accountIndex || account.retrievedAt <= close.startedAt) continue;
      if (close.stage === "preparing" || close.stage === "approval") continue;
      const position = account.positions.find((row) => row.marketId === close.marketId && row.side === close.side);
      if (position === undefined) {
        updateClose(key, null);
        setDeskOutcome({ tone: "ok", text: "Position closed." });
        continue;
      }
      const orderStillOpen = close.orderId !== null && account.openOrders.some((order) => (
        order.marketId === close.marketId && order.orderId === close.orderId
      ));
      if (orderStillOpen && !close.orderSeen) updateClose(key, { ...close, orderSeen: true });
      if (close.stage === "resting" && close.orderSeen && account.openOrdersAvailable && !account.openOrdersTruncated && !orderStillOpen) {
        updateClose(key, null);
        if (Math.abs(Number(position.size)) < Math.abs(Number(close.sizeBefore))) {
          setDeskOutcome({ tone: "ok", text: "Position reduced." });
        }
        continue;
      }
      if (!orderStillOpen && Math.abs(Number(position.size)) < Math.abs(Number(close.sizeBefore))) {
        updateClose(key, null);
        setDeskOutcome({ tone: "ok", text: "Position reduced." });
      }
    }
  }, [account, activeSessionId, environment]);

  // Account-wide acceptance alone cannot prove that every order was canceled.
  // Wait for a complete, newer provider snapshot in the exact initiating scope.
  useEffect(() => {
    if (account === null || account.environment !== environment || account.status === "unavailable" || !account.openOrdersAvailable
      || account.openOrdersTruncated) return;
    for (const [key, cancelAll] of cancelAllAttempts.current) {
      if (!sameCancelAllScope(cancelAll, activeSessionId, environment, account.accountIndex)
        || cancelAll.stage === "preparing" || cancelAll.stage === "approval"
        || account.retrievedAt <= cancelAll.startedAt) continue;
      if (cancelAll.orderKeys === null ? account.openOrders.length !== 0
        : account.openOrders.some((order) => cancelAll.orderKeys?.includes(cancelRowKey(order.marketId, order.orderId)))) continue;
      updateCancelAll(key, null);
      setDeskOutcome({ tone: "ok", text: "Requested orders are no longer open. Check Trade History for any fills before cancellation." });
    }
  }, [account, activeSessionId, environment, pendingCancelAlls]);

  // A successful cancel response is not enough to remove a row from a cached
  // account view. Only a newer, complete provider order list can release it.
  useEffect(() => {
    if (account === null || account.status === "unavailable" || activeSessionId === null
      || !account.openOrdersAvailable || account.openOrdersTruncated) return;
    for (const [key, cancel] of cancelAttempts.current) {
      if ((cancel.accountIndex === null && cancel.sessionId !== activeSessionId)
        || cancel.environment !== environment || cancel.accountIndex !== account.accountIndex
        || cancel.stage === "preparing" || cancel.stage === "approval"
        || account.retrievedAt <= cancel.startedAt) continue;
      if (account.openOrders.some((order) => order.marketId === cancel.marketId && order.orderId === cancel.orderId)) continue;
      updateCancel(key, null);
      setDeskOutcome(cancel.stage === "checking"
        ? { tone: "ok", text: "Order canceled." }
        : { tone: "warn", text: "Order is no longer open. Check Trade History for any fill." });
    }
  }, [account, activeSessionId, environment]);

  const closingPositions = useMemo(() => {
    const rows = new Map<string, PositionCloseStage>();
    if (activeSessionId === null || account === null || account.status === "unavailable") return rows;
    for (const close of pendingCloses.values()) {
      if ((close.accountIndex !== null || close.sessionId === activeSessionId)
        && close.environment === environment && close.accountIndex === account.accountIndex) {
        rows.set(closeRowKey(close.marketId, close.side), close.stage);
      }
    }
    return rows;
  }, [account, activeSessionId, environment, pendingCloses]);

  const cancellingOrders = useMemo(() => {
    const rows = new Map<string, OrderCancelStage>();
    if (activeSessionId === null || account === null || account.status === "unavailable") return rows;
    for (const cancel of pendingCancels.values()) {
      if ((cancel.accountIndex !== null || cancel.sessionId === activeSessionId)
        && cancel.environment === environment && cancel.accountIndex === account.accountIndex) {
        rows.set(cancelRowKey(cancel.marketId, cancel.orderId), cancel.stage);
      }
    }
    for (const cancelAll of pendingCancelAlls.values()) {
      if (account.environment !== environment || !sameCancelAllScope(cancelAll, activeSessionId, environment, account.accountIndex)) continue;
      for (const order of account.openOrders) {
        const key = cancelRowKey(order.marketId, order.orderId);
        if (cancelAll.orderKeys === null || cancelAll.orderKeys.includes(key)) rows.set(key, cancelAll.stage);
      }
    }
    return rows;
  }, [account, activeSessionId, environment, pendingCancels, pendingCancelAlls]);
  const cancelAllPending = account !== null && account.environment === environment && [...pendingCancelAlls.values()].some((pending) => (
    sameCancelAllScope(pending, activeSessionId, environment, account.accountIndex)
  ));

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
    if (awaitedOrder === null || awaitedOrder.scope.marketId === null || fills === null) return;
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
    if (awaitedOrder.closeKey !== null && filledSize === null
      && closeAttempts.current.get(awaitedOrder.closeKey)?.orderSeen !== true) return;
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
      if (awaitedOrder.closeKey !== null) setCloseStage(awaitedOrder.closeKey, "checking", awaitedOrder.orderId);
      else finishFilledOrder({
        draft: awaitedOrder.draft,
        size: filledSize,
        symbol,
        averagePrice: exactFills.length === 1 ? exactFills[0]?.price ?? null : null,
        closedAfterPartial: true,
      });
      return;
    }
    clearClose(awaitedOrder.closeKey);
    setDeskOutcome({
      tone: "warn",
      text: "The order is no longer open and no fill was returned. Check order history before retrying.",
    });
  }, [account, awaitedOrder, fills, finishFilledOrder]);

  // Background approve (K-2 B2): approvals answered `dispatching`, waiting for
  // their outcome event, with the fallback check each one has scheduled.
  const dispatchFallbacks = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clearDispatchFallback = (approvalId: string): void => {
    const timer = dispatchFallbacks.current.get(approvalId);
    if (timer !== undefined) clearTimeout(timer);
    dispatchFallbacks.current.delete(approvalId);
  };
  const scheduleDispatchFallback = (approvalId: string): void => {
    clearDispatchFallback(approvalId);
    dispatchFallbacks.current.set(approvalId, setTimeout(() => {
      dispatchFallbacks.current.delete(approvalId);
      if (!pendingDesk.current.has(approvalId)) return;
      void window.vex.approvals.get({ id: approvalId }).then((read) => {
        if (!pendingDesk.current.has(approvalId)) return;
        const status = read.ok ? read.data?.executionStatus ?? null : null;
        if (status === "succeeded" || status === "failed" || status === "indeterminate") {
          // The outcome event never came, so the tool's own words are not here
          // to read. The durable row says the dispatch ended; the one honest
          // thing to tell the trader is to check before acting again.
          resolvedRef.current("approved", {
            id: approvalId,
            status: "approved",
            resolvedAt: null,
            runtimeOutcome: "stopped",
            executionStatus: "indeterminate",
            missionRunId: null,
            cached: true,
            message: "Outcome not received.",
          });
          return;
        }
        scheduleDispatchFallback(approvalId);
      }, () => scheduleDispatchFallback(approvalId));
    }, DISPATCH_OUTCOME_FALLBACK_MS));
  };
  useEffect(() => () => {
    for (const timer of dispatchFallbacks.current.values()) clearTimeout(timer);
    dispatchFallbacks.current.clear();
  }, []);

  // A desk card resolved. Protection remains a separate approval, and it is
  // loaded only after the provider proves the amount that actually filled.
  const onApprovalResolved = (decision: "approved" | "rejected", result: ApprovalActionResult): void => {
    const pending = pendingDesk.current.get(result.id);
    if (pending === undefined) return;
    if (decision === "approved" && result.executionStatus === "dispatching") {
      // The slot is claimed and the order is going out; its outcome follows
      // as an event and lands back here through the same handler. The card
      // stays tracked until then, so its row stays locked.
      scheduleDispatchFallback(result.id);
      const dispatchingScopeIsCurrent = pendingScopeIsCurrent(pending);
      if (dispatchingScopeIsCurrent) setDeskOutcome({ tone: "warn", text: "Approved. Sending to Lighter..." });
      return;
    }
    clearDispatchFallback(result.id);
    pendingDesk.current.delete(result.id);
    deskCardExpiry.current.delete(result.id);
    if (decision === "rejected") {
      clearClose(pending.closeKey);
      clearCancel(pending.cancelKey);
      clearCancelAll(pending.cancelAllKey);
      recordFunnelStep("desk_approval_rejected", pending.scope.environment);
      return;
    }
    recordFunnelStep("desk_approve", pending.scope.environment);
    const scopeIsCurrent = pendingScopeIsCurrent(pending);
    if (result.executionStatus === "succeeded") {
      if (pending.action.kind !== "order") {
        if (pending.action.kind === "cancel_all") {
          const disposition = cancelAllDisposition(result.toolOutput);
          setCancelAllStage(pending.cancelAllKey, disposition === "cancel_all_completed" ? "checking" : "uncertain");
          void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] });
          if (scopeIsCurrent) setDeskOutcome({ tone: "warn", text: disposition === "cancel_all_completed"
            ? "Cancellation confirmed. Refreshing the requested order list..."
            : disposition === "sequencer_pending"
              ? "Cancellation accepted and still confirming on Lighter. Wait for order status before retrying."
              : "Cancel-all outcome is uncertain. Wait for the account's order status before retrying." });
          return;
        }
        if (pending.action.kind === "close") {
          const disposition = closeDisposition(result.toolOutput);
          if (disposition === "not_closed") {
            clearClose(pending.closeKey);
            if (scopeIsCurrent) setDeskOutcome({ tone: "warn", text: "The close did not fill. The position remains open; check it before trying again." });
            return;
          }
          setCloseStage(pending.closeKey, disposition === "sequencer_pending" || disposition === "ambiguous" || disposition === null
            ? "uncertain" : "checking");
          void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] });
          return;
        }
        if (pending.action.kind === "cancel") {
          const disposition = cancelDisposition(result.toolOutput);
          setCancelStage(pending.cancelKey, disposition === "canceled" ? "checking" : "uncertain");
          void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] });
          if (scopeIsCurrent) setDeskOutcome(disposition === "canceled"
            ? { tone: "warn", text: "Cancel confirmed. Refreshing the open order list…" }
            : { tone: "warn", text: "Cancel outcome is uncertain. Wait for order status before retrying." });
          return;
        }
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
        setCloseStage(pending.closeKey, "uncertain");
        recordFunnelStep("desk_order_unknown", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome(hasAttachedProtection(pending.draft)
          ? { tone: "warn", text: "Order submitted, but its fill state could not be verified. Open Orders below before adding protection or retrying." }
          : { tone: "ok", text: "Order sent." });
        return;
      }
      if (execution.state === "ambiguous") {
        setCloseStage(pending.closeKey, "uncertain");
        recordFunnelStep("desk_order_unknown", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({ tone: "warn", text: "Order outcome is uncertain. Open Orders below and refresh before retrying." });
        return;
      }
      if (execution.state === "sequencer_pending") {
        setCloseStage(pending.closeKey, "checking", execution.orderId);
        recordFunnelStep("desk_order_accepted", pending.scope.environment);
        if (!scopeIsCurrent) return;
        if (execution.orderId !== null) {
          setAwaitedOrder({
            orderId: execution.orderId,
            draft: pending.draft,
            scope: pending.scope,
            symbol: pending.symbol,
            closeKey: pending.closeKey,
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
        clearClose(pending.closeKey);
        recordFunnelStep("desk_order_rejected", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({
          tone: "error",
          text: `${orderLabel(execution.orderId)} was rejected by Lighter. Review size, price, and market limits before editing the ticket.`,
        });
        return;
      }
      if (execution.state === "canceled") {
        clearClose(pending.closeKey);
        recordFunnelStep("desk_order_canceled", pending.scope.environment);
        if (!scopeIsCurrent) return;
        setDeskOutcome({
          tone: "warn",
          text: canceledOrderMessage(execution),
        });
        return;
      }
      recordFunnelStep("desk_order_accepted", pending.scope.environment);
      setCloseStage(pending.closeKey, execution.state === "open" || execution.state === "partially_filled" && execution.source === "active_order"
        ? "resting" : "checking", execution.orderId);
      if (pending.closeKey !== null) {
        void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] });
      }
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
        if (pending.closeKey === null) finishFilledOrder({
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
          closeKey: pending.closeKey,
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
      setCloseStage(pending.closeKey, "uncertain");
      setCancelStage(pending.cancelKey, "uncertain");
      setCancelAllStage(pending.cancelAllKey, "uncertain");
      if (pending.cancelKey !== null || pending.cancelAllKey !== null) {
        void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", pending.scope.environment] });
      }
      if (pending.action.kind === "order") recordFunnelStep("desk_order_unknown", pending.scope.environment);
      if (!scopeIsCurrent) return;
      setDeskOutcome({ tone: "warn", text: pending.action.kind === "cancel_all"
        ? "Cancel-all outcome is uncertain. Wait for the account's order status before retrying."
        : pending.action.kind === "cancel"
        ? "Cancel outcome is uncertain. Wait for order status before retrying."
        : "Outcome unknown. Open Orders below and refresh before retrying." });
      return;
    }
    if (pending.action.kind === "order") recordFunnelStep("desk_order_rejected", pending.scope.environment);
    clearClose(pending.closeKey);
    clearCancel(pending.cancelKey);
    clearCancelAll(pending.cancelAllKey);
    if (!scopeIsCurrent) return;
    setDeskOutcome({ tone: "error", text: deskFailureMessage(result.toolOutput ?? result.message) });
  };

  const resolvedRef = useRef(onApprovalResolved);
  resolvedRef.current = onApprovalResolved;

  // A failed decision the desk itself must report: the card that would have
  // shown it is gone (auto-approved, or answered `dispatching`).
  const failDeskApproval = (approvalId: string, message: string): void => {
    clearDispatchFallback(approvalId);
    const pending = pendingDesk.current.get(approvalId);
    const scopeIsCurrent = pending === undefined || pending.action.kind !== "cancel_all" || pendingScopeIsCurrent(pending);
    pendingDesk.current.delete(approvalId);
    clearClose(pending?.closeKey ?? null);
    clearCancel(pending?.cancelKey ?? null);
    clearCancelAll(pending?.cancelAllKey ?? null);
    if (scopeIsCurrent) setHandoffError(message);
  };
  const failRef = useRef(failDeskApproval);
  failRef.current = failDeskApproval;

  // The background approve's outcome (`EV.approvals.dispatch`). Silent while
  // the switch is off. Only cards this desk is tracking are touched, and a
  // card is settled once: whichever of the event and the reply comes second
  // finds nothing left to settle.
  useEffect(() => {
    const off = window.vex.approvals.onDispatchEvent?.((event) => {
      if (event.phase === "dispatching") return;
      const pending = pendingDesk.current.get(event.approvalId);
      if (pending === undefined) return;
      if (event.phase === "settled") resolvedRef.current("approved", event.result);
      else failRef.current(event.approvalId, event.message);
      void invalidateOnApprovalResolve(queryClient, pending.scope.sessionId);
    });
    return () => off?.();
  }, [queryClient]);

  // "Don't ask again" for Market close: the card still goes through main's
  // prepare -> approve lane; the desk just answers it in the user's stead
  // before the pending list is pulled, so no dialog flashes. The outcome is
  // shown from the reply itself; the five-query refresh follows in the
  // background instead of standing between the reply and the ticket.
  const approveOnDesk = async (sessionId: string, approvalId: string): Promise<void> => {
    const result = await window.vex.approvals.approve({ id: approvalId });
    void invalidateOnApprovalResolve(queryClient, sessionId);
    if (!result.ok) {
      failDeskApproval(approvalId, result.error.message);
      return;
    }
    onApprovalResolved("approved", result.data);
  };

  const prepareOnDesk = async (action: DeskLaneAction, draft: TradeDraft | null, closePosition: LighterPositionRow | null = null): Promise<void> => {
    if (activeSessionId === null) {
      onNoSession();
      return;
    }
    const accountIndex = account?.accountIndex ?? null;
    if ((action.kind === "cancel" || action.kind === "cancel_all")
      && [...cancelAllAttempts.current.values()].some((pending) => sameCancelAllScope(pending, activeSessionId, environment, accountIndex))) return;
    if (action.kind === "cancel_all" && [...cancelAttempts.current.values()].some((pending) => (
      pending.sessionId === activeSessionId && pending.environment === environment && pending.accountIndex === accountIndex
    ))) return;
    const cancelAllKey = action.kind === "cancel_all" ? `${environment}:${activeSessionId}:${accountIndex}` : null;
    if (cancelAllKey !== null) updateCancelAll(cancelAllKey, {
      sessionId: activeSessionId, environment, accountIndex, startedAt: Date.now(), stage: "preparing", orderKeys: null,
    });
    const close = closePosition === null ? null : {
      sessionId: activeSessionId,
      environment,
      accountIndex: account?.accountIndex ?? null,
      marketId: closePosition.marketId,
      side: closePosition.side,
      sizeBefore: closePosition.size,
      startedAt: Date.now(),
      stage: "preparing" as const,
      orderId: null,
      orderSeen: false,
    };
    const closeKey = close === null ? null : closeAttemptKey(close);
    if (closeKey !== null) {
      if (closeAttempts.current.has(closeKey)) return;
      updateClose(closeKey, close);
    }
    const cancel = action.kind !== "cancel" ? null : {
      sessionId: activeSessionId,
      environment,
      accountIndex: account?.accountIndex ?? null,
      marketId: action.marketId,
      orderId: action.orderId,
      startedAt: Date.now(),
      stage: "preparing" as const,
    };
    const cancelKey = cancel === null ? null : cancelAttemptKey(cancel);
    if (cancelKey !== null) {
      if (cancelAttempts.current.has(cancelKey)) return;
      updateCancel(cancelKey, cancel);
    }
    setHandoffError(null);
    setDeskOutcome(null);
    setAwaitedOrder(null);
    setSubmitting(true);
    setPrepareStage("checking_account");
    const progressId = crypto.randomUUID();
    const offProgress = window.vex.lighterTrading.onDeskPrepareProgress?.((event) => {
      if (event.progressId === progressId) setPrepareStage(event.stage);
    });
    const scope: DeskScope = {
      sessionId: activeSessionId,
      environment,
      marketId: action.kind === "cancel_all" ? null : action.marketId,
    };
    let enqueued = false;
    try {
      const result = await window.vex.lighterTrading.prepareDeskAction({ sessionId: activeSessionId, environment, action, progressId });
      if (!result.ok) {
        setHandoffError(result.error.message);
        return;
      }
      if (result.data.kind === "refused") {
        setHandoffError(deskFailureMessage(result.data.reason));
        return;
      }
      setPrepareStage("opening_approval");
      pendingDesk.current.set(result.data.approvalId, {
        action,
        draft,
        scope,
        symbol: action.kind !== "cancel_all" && action.marketId === marketId ? marketSymbol : null,
        closeKey,
        cancelKey,
        cancelAllKey,
      });
      enqueued = true;
      setCloseStage(closeKey, "approval");
      setCancelStage(cancelKey, "approval");
      setCancelAllStage(cancelAllKey, "approval");
      recordFunnelStep("desk_card", environment);
      if (action.kind === "close" && skipCloseConfirm) {
        await approveOnDesk(activeSessionId, result.data.approvalId);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: approvalsKeys.pending(activeSessionId) });
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : "Could not prepare the Lighter action.");
    } finally {
      if (!enqueued) clearClose(closeKey);
      if (!enqueued) clearCancel(cancelKey);
      if (!enqueued) clearCancelAll(cancelAllKey);
      offProgress?.();
      setPrepareStage(null);
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
    prepareStage,
    deskOutcome,
    clearDeskFeedback: () => {
      setHandoffError(null);
      setDeskOutcome(null);
    },
    closingPositions,
    cancellingOrders,
    cancelAllPending,
    prepareOnDesk,
    onApprovalResolved,
  };
}

export type DeskLane = ReturnType<typeof useDeskLane>;
