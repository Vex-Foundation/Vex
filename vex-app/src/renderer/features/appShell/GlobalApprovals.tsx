/**
 * THE APP-WIDE APPROVALS, in two parts (docs/design/R3-MINIMAL.md sections 3
 * and 8). The count and the list moved to "Needs you · N"
 * (`features/vex/NeedsYouControl.tsx`), so what stays here is what has no
 * control of its own:
 *
 *   - `GlobalApprovalsSync` keeps the app-wide inbox fresh and owns the
 *     cross-mode announcement. It renders nothing and is mounted ONCE by the
 *     title bar (`RunningHead`), above the mode dispatch: preload allows one
 *     subscriber per event kind per window, so a second mount across a mode
 *     switch would silently lose the live sync.
 *   - `GlobalApprovalsReview` is the card a Review key opens when the card is
 *     not already on screen: the full `ApprovalCard`, reused verbatim through
 *     `GlobalApprovalItem`, so the REAL FUNDS stamp, Reject's first focus and
 *     the two-step confirm for a high-risk action are the inline card's own.
 *     The Needs you list never decides anything; this card does, under the
 *     same rules as everywhere else, and in whichever mode the user is in.
 *
 * Freshness: push first. `useMissionUpdateLiveSync` invalidates `pendingAll`
 * on `approval_enqueued` (chat and mission sessions alike) and
 * `useGlobalApprovalsLiveSync` adds any session's control-state transition.
 * The poll is the dropped-event net: 60s idle, 15s while a review is open
 * (the review observes the same query with the faster interval, and the
 * query refetches on the shortest interval any observer asks for).
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Result } from "@shared/ipc/result.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import {
  useGlobalApprovalsLiveSync,
  usePendingApprovalsAll,
} from "../../lib/api/approvals.js";
import { useUiStore } from "../../stores/uiStore.js";
import { GlobalApprovalItem } from "./GlobalApprovals/GlobalApprovalItem.js";
import { useCrossModeApprovalToast } from "./approvals/useCrossModeApprovalToast.js";

/**
 * Idle fallback poll. The app-wide read opens a short-lived pg client per
 * tick, and `approval_enqueued` already invalidates the list, so the count no
 * longer depends on this tick to appear; it is the net for a dropped event.
 */
export const IDLE_POLL_MS = 60_000;
/** While a review is open the user is looking at a live card: a faster net. */
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

export interface GlobalApprovalsReviewProps {
  /** The approval whose card to show. */
  readonly approvalId: string;
  /** Close the review; the caller returns focus to its own trigger. */
  readonly onClose: () => void;
}

/**
 * The full card of one pending approval, in a dialog over the window. Mount it
 * only while it is open: its query observer is what speeds the poll up.
 *
 * It closes by itself when the approval is no longer pending (decided here,
 * inline, or elsewhere) and when the next read fails, because a card drawn
 * from a list nobody could read is a decision on stale facts. A failed
 * REFETCH that still holds the row keeps it open, as the count keeps its last
 * known value: an approval that may since have resolved is a safe
 * overstatement.
 */
export function GlobalApprovalsReview({
  approvalId,
  onClose,
}: GlobalApprovalsReviewProps): JSX.Element | null {
  const query = usePendingApprovalsAll({ refetchInterval: REVIEW_OPEN_POLL_MS });
  const rows = useMemo(() => pendingRowsOf(query.data), [query.data]);
  const row = rows?.find((candidate) => candidate.id === approvalId) ?? null;

  // `onClose` may be a fresh function on every render; only the edge matters.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const gone = row === null;
  useEffect(() => {
    if (gone) onCloseRef.current();
  }, [gone]);

  if (row === null) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-vex-area="global-approvals-panel"
        backdrop="none"
        className="w-[calc(100vw-3rem)] max-w-3xl"
      >
        <DialogHeader className="sticky top-0 z-10 flex-row items-start justify-between gap-4 border-b border-rule-quiet bg-surface-base pr-6">
          <div>
            <DialogTitle>Pending approvals</DialogTitle>
            <DialogDescription>Review the details before approving an action.</DialogDescription>
          </div>
          <Button
            variant="quiet"
            size="sm"
            onClick={onClose}
            aria-label="Close approval review"
            className="shrink-0"
          >
            Close
          </Button>
        </DialogHeader>
        <DialogBody className="gap-0 px-3 pb-4 pt-0">
          <GlobalApprovalItem row={row} onOpenSession={onClose} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
