/**
 * THE APP-WIDE APPROVALS' SYNC (docs/design/R3-MINIMAL.md sections 3 and 8).
 * The count and the list are "Needs you · N" (`features/vex/NeedsYouControl.tsx`)
 * and the cards a Review key opens are the Needs you page
 * (`screens/NeedsYouScreen.tsx`), so what stays here is what has no control of
 * its own: `GlobalApprovalsSync` keeps the app-wide inbox fresh and owns the
 * cross-mode announcement. It renders nothing and is mounted ONCE by the
 * title bar (`RunningHead`), above the mode dispatch: preload allows one
 * subscriber per event kind per window, so a second mount across a mode
 * switch would silently lose the live sync.
 *
 * Freshness: push first. `useMissionUpdateLiveSync` invalidates `pendingAll`
 * on `approval_enqueued` (chat and mission sessions alike) and
 * `useGlobalApprovalsLiveSync` adds any session's control-state transition.
 * The poll is the dropped-event net: 60s idle, 15s while the Needs you page is
 * open (the page observes the same query with the faster interval, and the
 * query refetches on the shortest interval any observer asks for).
 */

import { useMemo } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";
import {
  useGlobalApprovalsLiveSync,
  usePendingApprovalsAll,
} from "../../lib/api/approvals.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useCrossModeApprovalToast } from "./approvals/useCrossModeApprovalToast.js";

/**
 * Idle fallback poll. The app-wide read opens a short-lived pg client per
 * tick, and `approval_enqueued` already invalidates the list, so the count no
 * longer depends on this tick to appear; it is the net for a dropped event.
 */
export const IDLE_POLL_MS = 60_000;
/** While the Needs you page is open the user is looking at live cards: a faster net. */
export const REVIEW_OPEN_POLL_MS = 15_000;

/** The pending rows of a read, newest first; `null` while unread or failed. */
export function pendingRowsOf(
  data: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined,
): ReadonlyArray<ApprovalPendingGlobalDto> | null {
  if (data === undefined || !data.ok) return null;
  // NEWEST FIRST: the row a user just caused is the one they came for.
  return [...data.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The live sync and the cross-mode announcement, with no pixels. Mount it
 * once, above the mode dispatch.
 */
export function GlobalApprovalsSync(): null {
  useGlobalApprovalsLiveSync();
  const query = usePendingApprovalsAll({ refetchInterval: IDLE_POLL_MS });
  const rows = useMemo(() => pendingRowsOf(query.data), [query.data]);
  // The cross-mode announcement (B4c) lives here, above the mode dispatch,
  // so the observation survives a mode switch instead of resetting with the
  // shell that switched.
  const runtimeMode = useUiStore((state) => state.runtimeMode);
  useCrossModeApprovalToast(rows, runtimeMode);
  return null;
}
