/**
 * DESK RULE global approvals inbox — the app-wide "awaiting your signature"
 * affordance in the header's right flank.
 *
 * A quiet amber pin badge (`AWAITING <n>`) that opens a right-anchored panel
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
 * Chrome follows the repo-native anchored-panel pattern
 * (`components/ui/select-menu.tsx`): no portals, no inline styles, outside
 * pointerdown + Escape close, focus restored to the trigger on close, and
 * initial focus moved into the panel on open.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
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

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  // Loading (undefined) or an application-level failure → no rows, no badge.
  const rows = useMemo<ReadonlyArray<ApprovalPendingGlobalDto> | null>(() => {
    const data = query.data;
    if (data === undefined || data.ok === false) return null;
    return [...data.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  // Outside pointerdown collapses the panel (no focus restore — the user is
  // deliberately interacting elsewhere). Only wired while open.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // A6: move focus into the panel on open so keyboard users land inside the
  // popover; the root's Escape handler (below) then closes from anywhere within.
  useEffect((): void => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (rows === null || rows.length === 0) return null;

  const count = rows.length;
  const badgeLabel =
    count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);

  // Escape from the trigger OR anywhere inside the panel (keydown bubbles to
  // the root) restores focus to the trigger and closes.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel();
    }
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
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
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Pending approvals"
          data-vex-area="global-approvals-panel"
          tabIndex={-1}
          className="absolute right-0 top-full z-20 mt-1 max-h-[60vh] w-[min(420px,80vw)] overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground focus-visible:outline-none"
        >
          {rows.map((row) => (
            <GlobalApprovalItem
              key={row.id}
              row={row}
              onOpenSession={closePanel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
