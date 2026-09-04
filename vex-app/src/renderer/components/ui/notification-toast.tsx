/**
 * THE TOAST STACK - the model's ONE transient surface.
 *
 * Up to three notifications on the dark chrome plate, stacked top-center,
 * longest-waiting first. Since B2.2 this is the only floating toast region in
 * the app: the pre-model single slot and the separate bottom-right sticky card
 * were folded into it, so one owner answers "what is on screen", one cap
 * bounds it and one report ("+N more") covers everything it did not fit.
 *
 * Model-owned rather than markup-owned:
 *
 *  - dismissal TIMING lives in the model (`PURGE_MS` per severity), not in a
 *    stylesheet delay that a component timer had to be kept equal to. The
 *    sheet still owns the enter and exit ANIMATION, and `TOAST_EXIT_MS` is the
 *    one constant both sides share.
 *  - hovering a toast, or focusing anything inside it, pauses its purge: a
 *    message the user is reading does not vanish under them.
 *  - a STICKY notification never purges at all, which is what lets a long-
 *    running operation (the updater) own a row for as long as it runs.
 *  - what does not fit is NOT dropped. It waits in the center, and this region
 *    reports the count, because a bound that does not report is a silent cut.
 *
 * No live role here (`role="alert"` is deliberately absent): announcement
 * belongs to `NotificationAnnouncer`, which speaks once per model event
 * whether or not this component ever painted.
 */

import { useSyncExternalStore, type JSX, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import { IconClose, IconWarning } from "../icons/index.js";
import { notifications } from "../../lib/notifications/index.js";
import type { NotificationView } from "../../lib/notifications/types.js";

const ACTION_CLASS: Readonly<Record<"primary" | "secondary", string>> = {
  // Plate-local capsules: the Button primitive's fills flip with the theme and
  // would paint ink-on-ink on this theme-invariant dark plate.
  primary:
    "h-7 rounded-full bg-accent-primary px-3 text-[12px] font-medium text-ink-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40",
  secondary:
    "vex-notification-ghost h-7 rounded-full px-2.5 text-[12px] text-ink-on-chrome disabled:cursor-not-allowed disabled:opacity-40",
};

/**
 * Determinate progress as a percentage, or `null` when the operation is
 * indeterminate or finished. Clamped, because the bar is 0-100 and a provider
 * that reports 103% must not paint past the track.
 */
function progressPercent(item: NotificationView): number | null {
  const progress = item.progress;
  if (progress === null || progress.done || progress.total === null) return null;
  if (progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.worked / progress.total) * 100)));
}

function NotificationToast({ item }: { readonly item: NotificationView }): JSX.Element {
  const percent = progressPercent(item);
  return (
    <div
      className="vex-notification-toast"
      data-severity={item.severity}
      data-phase={item.toastPhase}
      data-vex-area="notification-toast"
      // See base.css: opting out of the reduced-motion catch-all so the exit
      // fade this component's removal is timed against actually runs.
      data-vex-motion-opacity=""
      onMouseEnter={() => {
        notifications.setToastInteraction(item.id, { hovered: true });
      }}
      onMouseLeave={() => {
        notifications.setToastInteraction(item.id, { hovered: false });
      }}
      // React's onFocus/onBlur are focusin/focusout, so a control anywhere
      // inside the toast pauses it, not just the container itself.
      onFocus={() => {
        notifications.setToastInteraction(item.id, { focused: true });
      }}
      onBlur={() => {
        notifications.setToastInteraction(item.id, { focused: false });
      }}
    >
      <div className="flex items-start gap-2">
        {item.severity === "info" ? null : (
          <span className="vex-notification-toast-icon" aria-hidden>
            <IconWarning size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {item.title === null ? null : (
            <p className="vex-micro-label uppercase">{item.title}</p>
          )}
          <p
            className={
              item.title === null
                ? "text-[13px] leading-[19px]"
                : "mt-1 text-[12px] leading-[18px]"
            }
          >
            {item.message}
          </p>
          {percent === null ? null : (
            <div
              className="vex-notification-track mt-2 h-1.5 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* The only inline style: CSSOM width write, CSP-safe per
               * MOTION-POLICY.md. */}
              <div
                className="h-full bg-accent-primary transition-[width] duration-150 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
        {/* A non-dismissible notification IS the controls for an operation the
         * user has not finished deciding about; the model refuses a user close
         * for it, and offering a button that would be refused is worse than
         * offering none. */}
        {item.dismissible ? (
          <button
            type="button"
            aria-label={`Dismiss notification: ${item.title ?? item.message}`}
            onClick={() => {
              notifications.close(item.id, "user");
            }}
            className="vex-notification-ghost -mr-1 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-on-chrome"
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </div>
      {item.actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {item.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.run === null || action.disabled}
              title={action.unavailableReason ?? undefined}
              onClick={() => {
                action.run?.();
                // Primary closes on run, secondary keeps the notification
                // open (VS Code's action split).
                if (action.rank === "primary") notifications.close(item.id, "action");
              }}
              className={ACTION_CLASS[action.rank]}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NotificationToastStack(): ReactPortal | null {
  const snapshot = useSyncExternalStore(
    (listener) => notifications.subscribe(listener),
    () => notifications.getSnapshot(),
  );
  if (snapshot.toasts.length === 0) return null;
  return createPortal(
    <div
      className="vex-notification-stack"
      data-vex-area="notification-stack"
      role="region"
      aria-label="Notifications"
    >
      {snapshot.toasts.map((item) => (
        <NotificationToast key={item.id} item={item} />
      ))}
      {snapshot.overflowCount > 0 ? (
        <p className="vex-notification-stack-overflow">
          {`+${snapshot.overflowCount} more in the notification center`}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
