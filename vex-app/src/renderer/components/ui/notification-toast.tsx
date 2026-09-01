/**
 * THE TOAST STACK - the model's transient surface.
 *
 * Up to three notifications on the same dark plate the single transient toast
 * used, stacked top-center, longest-waiting first. Three differences from the
 * slot it generalizes, all of them model-owned rather than markup-owned:
 *
 *  - dismissal TIMING lives in the model (`PURGE_MS` per severity), not in a
 *    stylesheet delay that a component timer had to be kept equal to. The
 *    sheet still owns the enter and exit ANIMATION, and `TOAST_EXIT_MS` is the
 *    one constant both sides share.
 *  - hovering a toast, or focusing anything inside it, pauses its purge: a
 *    message the user is reading does not vanish under them.
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
  // Plate-local capsules, matching `sticky-toast.tsx`: the Button primitive's
  // fills flip with the theme and would paint ink-on-ink on this dark plate.
  primary:
    "h-7 rounded-full bg-accent-primary px-3 text-[12px] font-medium text-ink-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40",
  secondary:
    "vex-toast-sticky-ghost h-7 rounded-full px-2.5 text-[12px] text-ink-on-chrome disabled:cursor-not-allowed disabled:opacity-40",
};

function NotificationToast({ item }: { readonly item: NotificationView }): JSX.Element {
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
        <span className="min-w-0 flex-1 text-[13px] leading-[19px]">
          {item.message}
        </span>
        <button
          type="button"
          aria-label={`Dismiss notification: ${item.message}`}
          onClick={() => {
            notifications.close(item.id);
          }}
          className="vex-toast-sticky-ghost -mr-1 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-on-chrome"
        >
          <IconClose size={12} />
        </button>
      </div>
      {item.actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {item.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.run === null}
              title={action.unavailableReason ?? undefined}
              onClick={() => {
                action.run?.();
                // Primary closes on run, secondary keeps the notification
                // open (VS Code's action split).
                if (action.rank === "primary") notifications.close(item.id);
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

/**
 * @param legacyToastVisible - the pre-model transient slot (`lib/toast.ts`) is
 * on screen, so the stack moves below it instead of painting over it. Removed
 * with that slot in B2.2.
 */
export function NotificationToastStack({
  legacyToastVisible,
}: {
  readonly legacyToastVisible: boolean;
}): ReactPortal | null {
  const snapshot = useSyncExternalStore(
    (listener) => notifications.subscribe(listener),
    () => notifications.getSnapshot(),
  );
  if (snapshot.toasts.length === 0) return null;
  return createPortal(
    <div
      className="vex-notification-stack"
      data-legacy-offset={legacyToastVisible ? "true" : "false"}
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
