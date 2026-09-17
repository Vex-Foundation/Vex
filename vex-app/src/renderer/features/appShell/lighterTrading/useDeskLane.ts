import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import type { LighterDeskAction, LighterTradingEnvironment, LighterTradingFill } from "@shared/schemas/lighter-trading.js";
import { usePendingApprovals } from "../../../lib/api/approvals.js";
import { approvalsKeys } from "../../../lib/api/queryKeys.js";
import { selectFreshApprovals } from "../approvals/fresh-approvals.js";
import { invalidateOnApprovalResolve } from "../approvals/invalidate-on-resolve.js";
import { isLighterOrderApproval } from "./desk-approvals.js";
import { fillSentence, fillSince, type AwaitedFill } from "./desk-fill-outcome.js";
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
  skipCloseConfirm: boolean;
  /** Fills on this environment, read to turn "Order sent." into what filled. */
  fills: readonly LighterTradingFill[] | null;
  /** No session yet: the action opens the session creator instead. */
  onNoSession: () => void;
}

/**
 * The desk lane: Close, Cancel and the ticket's Long/Short go to main, main
 * derives the terms and enqueues an approval card, and only Confirm signs
 * (design §7.11). This hook owns that round trip, the card list the dialog
 * shows, and the ticket state the outcome feeds back into.
 */
export function useDeskLane({ activeSessionId, environment, marketId, skipCloseConfirm, fills, onNoSession }: DeskLaneInput) {
  const queryClient = useQueryClient();
  const [ticketPrefill, setTicketPrefill] = useState<TradeTicketPrefill | null>(null);
  const [pricePick, setPricePick] = useState<TradeTicketPricePick | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  // A selector goes to main, main builds the proposal and enqueues the card;
  // the ticket waits while that round trip runs.
  const [submitting, setSubmitting] = useState(false);
  const [deskOutcome, setDeskOutcome] = useState<DeskOutcome | null>(null);
  // Set when a desk order goes out; the first fill on its market since then
  // replaces "Order sent." with what filled.
  const [awaitedFill, setAwaitedFill] = useState<AwaitedFill | null>(null);
  // The last desk card this hook enqueued, so a resolved card can be told
  // apart from one the agent prepared in chat.
  const lastDesk = useRef<{ approvalId: string; action: LighterDeskAction; draft: TradeDraft | null } | null>(null);

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
  }, [marketId, environment]);

  useEffect(() => {
    if (awaitedFill === null || fills === null) return;
    const fill = fillSince(fills, awaitedFill);
    if (fill === null) return;
    setAwaitedFill(null);
    setDeskOutcome({ tone: "ok", text: `${fillSentence(fill)}${awaitedFill.suffix}` });
  }, [awaitedFill, fills]);

  // A desk card resolved. Protection legs ride along as a follow-up prefill:
  // they only make sense once the entry is on the book.
  const onApprovalResolved = (decision: "approved" | "rejected", result: ApprovalActionResult): void => {
    const last = lastDesk.current;
    if (last === null || last.approvalId !== result.id) return;
    lastDesk.current = null;
    if (decision === "rejected") return;
    recordFunnelStep("desk_approve", environment);
    if (result.executionStatus === "succeeded") {
      const now = Date.now();
      const follow = last.draft === null ? null : protectionPrefill(last.draft, now);
      if (follow !== null) setTicketPrefill(follow);
      const suffix = follow === null ? "" : " Protection is loaded below; send it once the entry fills.";
      setDeskOutcome({ tone: "ok", text: `${SENT_TEXT[last.action.kind]}${suffix}` });
      if (last.action.kind !== "cancel") setAwaitedFill({ marketId: last.action.marketId, sentAt: now, suffix });
      return;
    }
    if (result.executionStatus === "indeterminate") {
      setDeskOutcome({ tone: "warn", text: "Outcome unknown. Check the account panel before retrying." });
      return;
    }
    setDeskOutcome({ tone: "error", text: result.toolOutput ?? result.message });
  };

  // "Don't ask again" for Market close: the card still goes through main's
  // prepare -> approve lane; the desk just answers it in the user's stead
  // before the pending list is pulled, so no dialog flashes.
  const approveOnDesk = async (sessionId: string, approvalId: string): Promise<void> => {
    const result = await window.vex.approvals.approve({ id: approvalId });
    await invalidateOnApprovalResolve(queryClient, sessionId);
    if (!result.ok) {
      lastDesk.current = null;
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
    setAwaitedFill(null);
    setSubmitting(true);
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
      lastDesk.current = { approvalId: result.data.approvalId, action, draft };
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
