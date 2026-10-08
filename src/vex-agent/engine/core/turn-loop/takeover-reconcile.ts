/**
 * Reconcile-before-dispatch for a runner that TOOK OVER a session (S-1).
 *
 * A takeover means the previous runner's lease expired while it was still
 * alive or had just died. Whatever it had in flight - a signed transfer, an
 * approved dispatch, a protocol order - keeps its DURABLE record (wallet /
 * transaction / wrap intents, approval intents, protocol executions, Lighter
 * onboarding intents), but its tool result may never have reached the
 * transcript: after the takeover the old runner's fenced write affects zero
 * rows. The new runner's model therefore cannot see that the action happened,
 * and the one thing it must not do is issue it again.
 *
 * What already exists, and is NOT repeated here:
 *   - Every money path is one-shot at the intent level (`consumeIfPending`,
 *     the approval dispatch-slot CAS), so the SAME intent can never be
 *     replayed by anyone.
 *   - The approval lifecycle reconciler (`approval-runtime/reconcile.ts`) is
 *     the durable floor for approvals; it is lease-aware and waits while a live
 *     lease exists, then settles `dispatching` rows as `indeterminate` - never
 *     re-dispatching.
 *   - Wallet / transaction / wrap repair lanes settle `broadcast_unconfirmed`
 *     outcomes from the chain; Recover's money gate refuses to resume over an
 *     unproven outcome.
 *
 * What was missing: nothing told the NEW runner, before its first inference
 * and dispatch, that unresolved money state exists - so a model reading a
 * transcript without the old result could re-issue an equivalent NEW action.
 * This step reads the same fail-closed gate the compaction cutover uses
 * (`getUnresolvedMoneyStateForSession`) and, when anything is unresolved,
 * appends one internal engine notice (fenced on the new claim) naming the
 * unresolved KINDS and instructing the model to check status before acting.
 * It reads and informs; it never dispatches, replays or settles anything.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import {
  getUnresolvedMoneyStateForSession,
  type MoneyStateReason,
} from "@vex-agent/db/repos/approval-intents/money-state.js";
import type { Message, MessageMetadata } from "@vex-agent/db/repos/messages.js";
import { appendMessagesUnderLease } from "@vex-agent/engine/events/index.js";
import logger from "@utils/logger.js";
import type { RunnerLeaseGuard } from "../../runtime/lease-guard.js";

export const TAKEOVER_RECONCILE_MESSAGE_TYPE = "lease_takeover_reconcile";

/** `unknown` = the gate could not be read; treated as unresolved (fail closed). */
export type TakeoverUnresolvedKind = MoneyStateReason["kind"] | "unknown";

export interface TakeoverReconcileResult {
  readonly clear: boolean;
  readonly kinds: readonly TakeoverUnresolvedKind[];
  /** Whether the notice row committed (false when clear, or the fence refused). */
  readonly noticeWritten: boolean;
}

export function takeoverNoticeText(kinds: readonly TakeoverUnresolvedKind[]): string {
  return [
    "[Engine: runner_takeover - this session was taken over from a previous runner whose lease expired.",
    `Actions it had in flight may be unresolved (${kinds.join(", ")}), and their results may be missing from this transcript.`,
    "Do NOT repeat any fund-moving action.",
    "Check the status of earlier actions first (wallet activity, approvals, open orders or positions) and reconcile before acting.]",
  ].join(" ");
}

export async function reconcileAfterTakeover(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly leaseGuard: RunnerLeaseGuard;
  /** MUTATED: the notice is pushed so the first inference sees it. */
  readonly liveMessages: Message[];
}): Promise<TakeoverReconcileResult> {
  let kinds: TakeoverUnresolvedKind[];
  try {
    const state = await withTransaction((client) =>
      getUnresolvedMoneyStateForSession(client, args.sessionId));
    kinds = state.clear ? [] : [...new Set(state.reasons.map((r) => r.kind))].sort();
  } catch (err) {
    logger.warn("runtime.lease.takeover_reconcile_read_failed", {
      sessionId: args.sessionId,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    kinds = ["unknown"];
  }

  logger.warn("runtime.lease.takeover_reconcile", {
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    clear: kinds.length === 0,
    kinds,
  });
  if (kinds.length === 0) return { clear: true, kinds, noticeWritten: false };

  const content = takeoverNoticeText(kinds);
  const metadata: MessageMetadata = {
    source: "engine",
    messageType: TAKEOVER_RECONCILE_MESSAGE_TYPE,
    visibility: "internal",
    payload: { unresolvedKinds: kinds },
  };
  const msg: Message = { role: "system", content, timestamp: new Date().toISOString() };
  const written = await appendMessagesUnderLease(
    args.sessionId,
    [{ msg, metadata }],
    args.leaseGuard,
    "takeover_notice",
  );
  // Pushed even when the fence refused: the loop ends on `lease_lost` at its
  // next check, before this tape is sent anywhere.
  args.liveMessages.push({ ...msg, metadata });
  return { clear: false, kinds, noticeWritten: written !== null };
}
