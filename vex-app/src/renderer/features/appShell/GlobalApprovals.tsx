/**
 * DESK RULE global approvals inbox — the app-wide "awaiting your signature"
 * affordance in the header's right flank.
 *
 * A quiet amber pin badge (`AWAITING <n>`) that opens a centered review dialog
 * listing EVERY pending approval across all sessions. The badge renders
 * `null` when nothing is pending (so the flank stays empty when idle) and also
 * when the query is loading or errored (A4 — the inline `ApprovalsRegion`
 * still surfaces errors for the active session; the global badge stays silent
 * rather than showing a broken count).
 *
 * Freshness: push first — `useMissionUpdateLiveSync` invalidates `pendingAll`
 * on `approval_enqueued`, which is emitted post-commit for chat AND mission
 * sessions alike, and `useGlobalApprovalsLiveSync` adds any session's
 * control-state transition. The two-tier poll (faster while the panel is open,
 * slower while idle) is now the dropped-event fallback, not the primary net.
 *
 * Cross-mode toast (B4c): this component also owns the one-shot announcement
 * for an approval raised in the mode the user is NOT looking at - see
 * `approvals/useCrossModeApprovalToast.ts` for why the memory lives above the
 * mode dispatch rather than in either shell.
 *
 * Uses the shared native dialog for viewport placement, focus containment,
 * Escape dismissal, and the app's existing modal styling.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from "../../components/ui/dialog.js";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import {
  useGlobalApprovalsLiveSync,
  usePendingApprovalsAll,
} from "../../lib/api/approvals.js";
import { GlobalApprovalItem } from "./GlobalApprovals/GlobalApprovalItem.js";
import { useCrossModeApprovalToast } from "./approvals/useCrossModeApprovalToast.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * Idle fallback poll — the app-wide read opens a short-lived pg client per
 * tick. Slowed 15s → 60s: `useMissionUpdateLiveSync` invalidates `pendingAll`
 * on `approval_enqueued`, so the badge no longer depends on this tick to
 * appear. Retained as the net for a dropped event.
 */
const IDLE_POLL_MS = 60_000;
/**
 * While the panel is OPEN the user is looking at a live list, so it keeps a
 * faster cadence than the idle net (5s → 15s). Still slower than before the
 * push existed, and still not the primary freshness path.
 */
const PANEL_OPEN_POLL_MS = 15_000;
/** LIMIT 100 in SQL; the badge collapses anything past this to "99+". */
const MAX_BADGE_COUNT = 99;

export function GlobalApprovals(): JSX.Element | null {
  useGlobalApprovalsLiveSync();
  const [open, setOpen] = useState(false);
  const query = usePendingApprovalsAll({
    refetchInterval: open ? PANEL_OPEN_POLL_MS : IDLE_POLL_MS,
  });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  // Loading (undefined) or an application-level failure → no rows, no badge.
  const rows = useMemo<ReadonlyArray<ApprovalPendingGlobalDto> | null>(() => {
    const data = query.data;
    if (data === undefined || data.ok === false) return null;
    // NEWEST FIRST. The panel is an inbox and the row a user just caused is
    // the one they came for, so it leads - and it is therefore also the row
    // whose Reject the shared dialog focuses through its named autofocus
    // target, so focus lands on the newest card's safer action.
    return [...data.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [query.data]);

  // The cross-mode announcement (B4c). Owned HERE, above the mode dispatch:
  // this component is mounted exactly once for the frame (`ShellStatusStrip`)
  // and already holds the app-wide list, so the observation survives a mode
  // switch instead of resetting with the shell that switched. Declared before
  // the early return below - the badge hides when nothing is pending, and a
  // hook may not.
  const runtimeMode = useUiStore((state) => state.runtimeMode);
  useCrossModeApprovalToast(rows, runtimeMode);

  const closePanel = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (rows?.length === 0) setOpen(false);
  }, [rows]);

  if (rows === null || rows.length === 0) return null;

  const count = rows.length;
  const badgeLabel =
    count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        data-vex-area="global-approvals-badge"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${count} pending ${
          count === 1 ? "approval" : "approvals"
        } awaiting your signature`}
        onClick={() => (open ? closePanel() : setOpen(true))}
        className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--vex-pin-border)] bg-[var(--vex-pin-fill)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-pin)] hover:bg-[var(--vex-pin-fill-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        AWAITING {badgeLabel}
      </button>
      <Dialog open={open} onOpenChange={(next) => next ? setOpen(true) : closePanel()}>
        <DialogContent
          id={panelId}
          data-vex-area="global-approvals-panel"
          className="w-[calc(100vw-3rem)] max-w-3xl"
        >
          <DialogHeader className="sticky top-0 z-10 flex-row items-start justify-between gap-4 bg-surface-2 pr-6">
            <div>
              <DialogTitle>Pending approvals</DialogTitle>
              <DialogDescription>Review the details before approving an action.</DialogDescription>
            </div>
            <button
              type="button"
              onClick={closePanel}
              aria-label="Close approval review"
              className="shrink-0 rounded-md px-3 py-2 text-sm text-ink-secondary hover:bg-surface-3 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
            >
              Close
            </button>
          </DialogHeader>
          <DialogBody className="gap-0 px-3 pb-4 pt-0">
            {rows.map((row) => (
              <GlobalApprovalItem key={row.id} row={row} onOpenSession={closePanel} />
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
