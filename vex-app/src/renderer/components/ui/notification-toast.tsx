/**
 * THE TOAST STACK - the model's ONE transient surface.
 *
 * Up to three notifications as flat paper panels with an ink rule, stacked
 * top centre, longest-waiting first (docs/design/R3-MINIMAL.md section 12).
 * Severity is the frame and the fill, never a hue: info has no swatch, a
 * warning takes the concerned fill (ink hatch) and a 1.5px frame, a failure
 * the error cross, a 1.5px frame and a hatch band. Since B2.2 this is the only floating toast region in
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
import { IconClose } from "../icons/index.js";
import { Swatch } from "./swatch.js";
import { notifications } from "../../lib/notifications/index.js";
import type { NotificationView } from "../../lib/notifications/types.js";

const ACTION_CLASS: Readonly<Record<"primary" | "secondary", string>> = {
  // The toast sits on paper, so the actions use the app's own two registers:
  // the small blue key (32 high, 0 12, 13 / 500, the night edge) and the
  // blue word link (13.5 / 500).
  primary:
    "h-8 border border-button-accent-edge bg-button-accent px-3 text-[13px] font-medium text-ink-on-button-accent transition-colors hover:bg-button-accent-hover focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed disabled:border-dotted disabled:border-accent-primary disabled:bg-transparent disabled:text-accent-primary",
  secondary:
    "vex-notification-ghost h-8 px-1 text-[13.5px] font-medium text-accent-primary hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-ink-tertiary",
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
      <div className="flex items-start gap-2.5">
        {item.severity === "info" ? null : (
          <span className="vex-notification-toast-icon" aria-hidden>
            <Swatch state={item.severity === "error" ? "error" : "concerned"} size={10} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {item.title === null ? null : (
            <p className="text-[14px] font-medium leading-[20px]">{item.title}</p>
          )}
          <p
            className={
              item.title === null
                ? "text-[14px] leading-[20px]"
                : "mt-0.5 text-[13px] leading-[1.45] text-ink-secondary"
            }
          >
            {item.message}
          </p>
          {percent === null ? null : (
            <div
              className="vex-notification-track mt-2 h-0.5 w-full overflow-hidden"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* The only inline style: CSSOM width write, CSP-safe per
               * MOTION-POLICY.md. */}
              <div
                className="h-full bg-accent-primary"
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
            className="vex-notification-ghost -mr-1 grid h-6 w-6 shrink-0 place-items-center text-ink-tertiary hover:text-ink-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            <IconClose size={14} />
          </button>
        ) : null}
      </div>
      {item.actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
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
