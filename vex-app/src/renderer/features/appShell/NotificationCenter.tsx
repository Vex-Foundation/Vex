/**
 * THE NOTIFICATION CENTER - the header flank's "what did I miss?".
 *
 * WHY IT LIVES HERE and not in `components/ui/`: it is not a primitive. It
 * reads the window's notification model directly, it is mounted exactly once
 * by `ShellStatusStrip` above the mode dispatch, and it sits in the same flank
 * as `GlobalErrorBanner` and `GlobalApprovals`, whose anchored-panel chrome it
 * generalizes. A primitive would have to take all of that as props from its
 * single caller, which is ceremony, not a boundary.
 *
 * Chrome is the repo-native anchored panel (`components/ui/select-menu.tsx`,
 * as both flank neighbours use it): no portal, no inline style, outside
 * pointerdown and Escape close, focus moved into the panel on open and
 * restored to the trigger on close.
 *
 * It reports its own bound. The model retains `HISTORY_CAP` notifications and
 * evicts oldest-first; the footer states how many were evicted, because a user
 * who cannot see that a bound exists cannot know a signal is missing.
 *
 * B2.2 migrates `GlobalErrorBanner` and `GlobalApprovals` into this list. They
 * are deliberately untouched here: both own live subscriptions and per-row
 * authority surfaces that move as their own change, not as a side effect of
 * this one.
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
import { cn } from "../../lib/utils.js";
import { notifications } from "../../lib/notifications/index.js";
import type {
  NotificationSeverity,
  NotificationView,
} from "../../lib/notifications/types.js";

/** Highest severity present drives the pill's tint. */
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

function NotificationRow({ item }: { readonly item: NotificationView }): JSX.Element {
  return (
    <li
      data-vex-area="notification-row"
      data-severity={item.severity}
      className="border-b border-[var(--vex-rule)] px-3 py-2 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "vex-micro font-medium uppercase",
            item.severity === "error"
              ? "text-danger"
              : item.severity === "warning"
                ? "text-[var(--vex-alias-state-warn)]"
                : "text-[var(--vex-text-2)]",
          )}
        >
          {item.source}
        </p>
        <button
          type="button"
          aria-label={`Dismiss notification: ${item.message}`}
          onClick={() => {
            notifications.close(item.id);
          }}
          className="vex-micro text-[var(--vex-text-3)] transition-colors hover:text-danger"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--vex-text-1)]">{item.message}</p>
      {item.actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.run === null}
              onClick={() => {
                action.run?.();
                if (action.rank === "primary") notifications.close(item.id);
              }}
              className="vex-micro rounded-[3px] border border-[var(--vex-rule)] px-1.5 py-0.5 text-[var(--vex-text-1)] transition-colors hover:border-[var(--vex-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
          {/* Honest inertness: the producing surface is gone, and the row says
           * so rather than offering a control that quietly does nothing. */}
          {item.actions[0]?.unavailableReason !== null &&
          item.actions[0]?.unavailableReason !== undefined ? (
            <span className="vex-micro text-[var(--vex-text-3)]">
              {`No longer available - ${item.actions[0].unavailableReason}`}
            </span>
          ) : null}
        </div>
      ) : null}
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
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
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

  // Nothing to say - the flank stays empty, as both neighbours do when idle.
  if (snapshot.items.length === 0) return null;

  const count = snapshot.items.length;
  const severity = peakSeverity(snapshot.items);

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
        data-vex-area="notification-center-badge"
        data-severity={severity}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${count} ${count === 1 ? "notification" : "notifications"}`}
        onClick={() => (open ? closePanel() : setOpen(true))}
        className={cn(
          "inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5",
          "font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
          severity === "error"
            ? "border-[var(--vex-rule)] bg-danger-wash text-danger hover:border-danger"
            : "border-[var(--vex-rule)] text-[var(--vex-text-2)] hover:border-[var(--vex-accent)]",
        )}
      >
        NOTICES {count}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          data-vex-area="notification-center-panel"
          tabIndex={-1}
          className={cn(
            "absolute right-0 top-full z-20 mt-1 w-[min(420px,80vw)]",
            "rounded-lg border border-border bg-popover text-popover-foreground",
            "focus-visible:outline-none",
          )}
        >
          <ul className="max-h-[60vh] overflow-y-auto">
            {snapshot.items.map((item) => (
              <NotificationRow key={item.id} item={item} />
            ))}
          </ul>
          {snapshot.droppedFromHistory > 0 ? (
            <p
              data-vex-area="notification-center-dropped"
              className="border-t border-[var(--vex-rule)] px-3 py-2 vex-micro text-[var(--vex-text-3)]"
            >
              {`${snapshot.droppedFromHistory} older ${
                snapshot.droppedFromHistory === 1 ? "notification" : "notifications"
              } dropped by the retention cap`}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
