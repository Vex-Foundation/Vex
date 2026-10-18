/**
 * THE NOTIFICATION CENTER - the title bar's "what did I miss?", the
 * "Notices · N" pill and its panel (docs/design/R3-MINIMAL.md sections 3 and
 * 12). The pill exists only while notices exist; the panel is a flat paper
 * popover with a 1.5px ink frame, 420 wide, 12 from the column's right edge
 * and 6 under the title bar. A row's state is its fill (the ink cross for a
 * failure, the ink hatch for a warning), never a colour.
 *
 * WHY IT LIVES HERE and not in `components/ui/`: it is not a primitive. It
 * reads the window's notification model directly, it is mounted exactly once
 * by `RunningHead` above the mode dispatch, and it sits in the same cluster
 * as "Needs you", whose anchored-panel chrome it shares. A primitive would
 * have to take all of that as props from its single caller, which is
 * ceremony, not a boundary.
 *
 * Chrome is the repo-native anchored panel (`components/ui/select-menu.tsx`):
 * no portal, no inline style, outside
 * pointerdown and Escape close, focus moved into the panel on open and
 * restored to the trigger on close.
 *
 * It reports its own bound. The model retains `HISTORY_CAP` notifications and
 * evicts oldest-first; the footer states how many were evicted, because a user
 * who cannot see that a bound exists cannot know a signal is missing.
 *
 * B2.2 folded the separate system-error pill into this list: session-less
 * engine failures are notifications now, so they announce once, are bounded
 * with a stated cap and are re-readable here instead of sitting silently in a
 * popover of their own.
 *
 * Approvals are deliberately still their own surface ("Needs you"). An
 * approval is an authority decision with a per-row commit path, not a message
 * to read, and its live subscription is no business of this list.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
} from "react";
import { LineBell } from "../../components/icons/line/index.js";
import { Swatch } from "../../components/ui/swatch.js";
import { formatClock } from "../../lib/format.js";
import { notifications } from "../../lib/notifications/index.js";
import type {
  NotificationSeverity,
  NotificationView,
} from "../../lib/notifications/types.js";

/** Highest severity present, carried on the pill as `data-severity`. */
const SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

function peakSeverity(
  items: readonly NotificationView[],
): NotificationSeverity {
  let peak: NotificationSeverity = "info";
  for (const item of items) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[peak]) peak = item.severity;
  }
  return peak;
}

/** Local HH:MM of a notification's epoch-ms stamp; `null` for a bad stamp. */
function noticeTime(createdAt: number): string | null {
  return Number.isFinite(createdAt) ? formatClock(new Date(createdAt).toISOString()) : null;
}

function NotificationRow({ item }: { readonly item: NotificationView }): JSX.Element {
  const time = noticeTime(item.createdAt);
  const unavailable = item.actions[0]?.unavailableReason ?? null;
  return (
    <li
      data-vex-area="notification-row"
      data-severity={item.severity}
      className="vex-tb-notice"
    >
      <span className="vex-tb-notice__mark">
        {/* A failure is the ink cross, a warning the ink hatch; an info row
         * has no state to draw. */}
        {item.severity === "info" ? null : (
          <Swatch state={item.severity === "error" ? "error" : "concerned"} />
        )}
      </span>
      <div className="min-w-0">
        {/* Provenance never disappears: the source names who raised it, the
         * title (when there is one) names the event. */}
        <p className="vex-tb-notice__scope">
          <span className="min-w-0 truncate">{item.source}</span>
          {time === null ? null : <span className="vex-tb-count">{time}</span>}
        </p>
        {item.title === null ? null : (
          <p className="vex-tb-notice__title">{item.title}</p>
        )}
        <p className="vex-tb-notice__text">{item.message}</p>
        {item.actions.length > 0 || item.dismissible ? (
          <div className="vex-tb-notice__actions">
            {item.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                disabled={action.run === null || action.disabled}
                data-rank={action.rank}
                onClick={() => {
                  action.run?.();
                  if (action.rank === "primary") notifications.close(item.id, "action");
                }}
                className="vex-tb-notice__action"
              >
                {action.label}
              </button>
            ))}
            {/* Non-dismissible rows are the producer's to clear (the model
             * refuses a user close for them); a button that would be refused
             * is worse than no button. */}
            {item.dismissible ? (
              <button
                type="button"
                aria-label={`Dismiss notification: ${item.title ?? item.message}`}
                onClick={() => {
                  notifications.close(item.id, "user");
                }}
                className="vex-tb-notice__dismiss"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
        {/* Honest inertness: the producing surface is gone, and the row says
         * so rather than offering a control that quietly does nothing. */}
        {unavailable === null ? null : (
          <p className="vex-tb-notice__gone">{`No longer available - ${unavailable}`}</p>
        )}
      </div>
    </li>
  );
}

export function NotificationCenter(): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    (listener) => notifications.subscribe(listener),
    () => notifications.getSnapshot(),
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const closePanel = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect((): void => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // An empty popover left hanging after the user cleared the list is clutter.
  useEffect((): void => {
    if (snapshot.items.length === 0 && open) setOpen(false);
  }, [snapshot.items.length, open]);

  // Nothing to say: the pill exists only while notices exist.
  if (snapshot.items.length === 0) return null;

  const count = snapshot.items.length;
  const severity = peakSeverity(snapshot.items);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePanel();
    }
  };

  // The root is NOT a positioning box: the panel anchors to the title bar
  // (12 from its right edge, 6 under it), not to the pill.
  return (
    <div ref={rootRef} className="vex-tb-notices" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-vex-area="notification-center-badge"
        data-severity={severity}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${String(count)} ${count === 1 ? "notification" : "notifications"}`}
        onClick={() => {
          if (open) closePanel();
          else setOpen(true);
        }}
        className="vex-tb-pill"
      >
        <LineBell />
        <span>Notices · </span>
        <span className="vex-tb-count">{count}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          data-vex-area="notification-center-panel"
          tabIndex={-1}
          className="vex-tb-pop vex-tb-pop--notices vex-no-drag"
        >
          <div className="vex-tb-pop__bar">
            <span>Notices</span>
            <span className="vex-tb-count">{count}</span>
            <span className="vex-tb-pop__hint">Esc closes</span>
          </div>
          <ul className="vex-tb-pop__list">
            {snapshot.items.map((item) => (
              <NotificationRow key={item.id} item={item} />
            ))}
          </ul>
          {snapshot.droppedFromHistory > 0 ? (
            <p
              data-vex-area="notification-center-dropped"
              className="vex-tb-pop__foot"
            >
              {`${String(snapshot.droppedFromHistory)} older ${
                snapshot.droppedFromHistory === 1 ? "notification" : "notifications"
              } dropped by the retention cap`}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
