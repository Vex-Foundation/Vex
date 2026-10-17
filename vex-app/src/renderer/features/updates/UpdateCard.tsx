/**
 * UpdateCard: the updater's one surface (docs/design/R3-MINIMAL.md sections 4
 * and 12). A flat card in the left sidebar above the account row: the update
 * icon and the state's own sentence, a muted line, and the action row. It
 * replaces the sticky toast of the notification stack; what each state offers,
 * what Escape means and what a snooze covers are unchanged and still come from
 * `update-toast-model.ts`.
 *
 *   available   Later, Update now, Release notes (a critical one has no Later)
 *   downloading the quiet bar with its percent, Cancel
 *   downloaded  Later, Restart & install
 *   blocked     the reason, Try again
 *   error       the message, Open download page, Try again, Dismiss
 *
 * A critical update and a failure take the 1.5px ink frame. There is no
 * veil, no shadow and no dismiss control for a state whose only way out is
 * its own button: an update the user has not finished deciding about is never
 * removable by a stray click.
 *
 * ## Announcement
 *
 * The card owns its own live region (`useLiveAnnouncer`): the title and the
 * sentence are spoken once per state, severity routed as the stack's
 * announcer routed them (a critical update is assertive, an ordinary one
 * polite). A progress tick moves the bar and the percent and never speaks.
 *
 * ## Where it stands
 *
 * In the sidebar's slot (`update-card-slot.ts`) when one is mounted; else a
 * floating card in the lower left corner of the window (the pre-shell screens,
 * the rail), above the boot overlay so a critical update stays visible over
 * the wake.
 */

import { createPortal } from "react-dom";
import { useEffect, useRef, type ReactPortal } from "react";
import { Button } from "../../components/ui/button.js";
import { LineUpdate } from "../../components/icons/line/index.js";
import { useLiveAnnouncer } from "../../components/ui/live-region.js";
import {
  actionsFor,
  bodyFor,
  escapeActionFor,
  isCritical,
  progressFor,
  severityFor,
  titleFor,
  toastIdentity,
  type ToastableUpdateStatus,
  type UpdateToastActionId,
} from "./update-toast-model.js";
import { useUpdateCardSlot } from "./update-card-slot.js";

export interface UpdateCardHandlers {
  readonly onLater: () => void;
  readonly onUpdateNow: () => void;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
  readonly onTryAgain: () => void;
  readonly onReleaseNotes: () => void;
  readonly onDismissError: () => void;
}

function dispatch(handlers: UpdateCardHandlers, actionId: UpdateToastActionId): void {
  switch (actionId) {
    case "release-notes":
      handlers.onReleaseNotes();
      return;
    case "later":
      handlers.onLater();
      return;
    case "update-now":
      handlers.onUpdateNow();
      return;
    case "cancel":
      handlers.onCancel();
      return;
    case "restart":
      handlers.onRestart();
      return;
    case "try-again":
      handlers.onTryAgain();
      return;
    case "dismiss-error":
      handlers.onDismissError();
      return;
  }
}

/** What the screen reader hears: the title names the event, then the sentence. */
function spokenText(status: ToastableUpdateStatus): string {
  return `${titleFor(status)}. ${bodyFor(status)}`;
}

export function UpdateCard({
  status,
  busy,
  handlers,
}: {
  readonly status: ToastableUpdateStatus;
  readonly busy: boolean;
  readonly handlers: UpdateCardHandlers;
}): ReactPortal {
  const slot = useUpdateCardSlot();
  const announcer = useLiveAnnouncer();
  const announceRef = useRef(announcer.announce);
  announceRef.current = announcer.announce;
  const statusRef = useRef(status);
  statusRef.current = status;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Once per state and sentence: a percent tick changes neither.
  const identity = toastIdentity(status);
  const body = bodyFor(status);
  useEffect(() => {
    const current = statusRef.current;
    const severity = severityFor(current);
    announceRef.current(severity, spokenText(current));
  }, [identity, body]);

  // Escape keeps its per-state meaning: snooze, dismiss the error, or nothing.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const action = escapeActionFor(statusRef.current);
      if (action === null) return;
      event.preventDefault();
      dispatch(handlersRef.current, action);
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  const progress = progressFor(status);
  const percent =
    progress === null || progress.total === undefined || progress.total <= 0
      ? null
      : Math.min(
          100,
          Math.max(0, Math.round(((progress.worked ?? 0) / progress.total) * 100)),
        );
  const title = titleFor(status);
  const actions = actionsFor(status, busy);
  // "Release notes" is a link beside the keys on an available update; on a
  // failure the same action is the named key "Open download page".
  const asLink = (id: UpdateToastActionId): boolean =>
    id === "release-notes" && status.kind === "available";
  const keys = actions.filter((action) => !asLink(action.id));
  const link = actions.find((action) => asLink(action.id));

  const card = (
    <section
      className="vex-upd"
      aria-label="Update"
      data-vex-area="update-card"
      data-state={status.kind}
      data-heavy={isCritical(status) || status.kind === "error" ? "" : undefined}
      data-floating={slot === null ? "" : undefined}
    >
      <div className="vex-upd__head">
        <LineUpdate size={16} className="vex-upd__icon" />
        <p className="vex-upd__title">{title}</p>
      </div>
      <p className="vex-upd__body">{body}</p>
      {percent === null ? null : (
        <>
          <div
            className="vex-upd__bar"
            role="progressbar"
            aria-label={title}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {/* The only inline style: a CSSOM width write, CSP-safe
             * (MOTION-POLICY.md). */}
            <i style={{ width: `${percent}%` }} />
          </div>
          <p className="vex-upd__pct vex-num">{`${percent}%`}</p>
        </>
      )}
      <div className="vex-upd__row">
        {keys.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.rank === "primary" ? "primary" : "quiet"}
            disabled={action.disabled}
            onClick={() => {
              dispatch(handlersRef.current, action.id);
            }}
          >
            {action.label}
          </Button>
        ))}
        {status.kind === "error" ? (
          <Button
            size="sm"
            variant="bare"
            onClick={() => {
              dispatch(handlersRef.current, "dismiss-error");
            }}
          >
            Dismiss
          </Button>
        ) : null}
        {link === undefined ? null : (
          <button
            type="button"
            className="vex-upd__link"
            disabled={link.disabled}
            onClick={() => {
              dispatch(handlersRef.current, link.id);
            }}
          >
            {link.label}
          </button>
        )}
      </div>
      {announcer.region}
    </section>
  );
  return createPortal(card, slot ?? document.body);
}
