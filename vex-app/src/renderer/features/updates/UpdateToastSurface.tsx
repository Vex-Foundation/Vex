/**
 * UpdateToastSurface: the updater's binding to the notification model.
 *
 * Renders nothing itself. It owns ONE notification for as long as a toastable
 * status is on screen: raising it, updating it in place as the download
 * progresses, dispatching its actions, interpreting a user dismissal, and
 * closing it on unmount.
 *
 * ## Why a handle and not a re-raise per render
 *
 * `UpdateLayer` hands a NEW status object on every progress tick and a new
 * `handlers` object whenever the status changes. Re-raising on each of those
 * would replay the entrance animation several times a second and make the
 * announcer speak the message again every time. So the identity that raises a
 * notification is `toastIdentity` (state + version), and everything that moves
 * inside one state - the percent, the in-flight disabling of a button - is a
 * handle update. `status` and `handlers` are read through refs precisely so
 * they cannot become effect dependencies by accident.
 *
 * ## What a close MEANS
 *
 * The model reports WHY a notification closed, and this surface acts on
 * exactly one reason. `"user"` is a real gesture and carries the state's
 * escape semantics with it (snooze an available or downloaded update, dismiss
 * an error), which is what keeps "press X" and "press Escape" the same
 * decision. Every other reason - this surface's own cleanup, a primary action
 * closing itself, a replacement, an eviction - must NOT snooze anything, and
 * before the model reported reasons there was no way to tell them apart.
 */

import { useEffect, useRef } from "react";
import { notify } from "../../lib/notifications/index.js";
import type {
  NotificationActionInput,
  NotificationHandle,
} from "../../lib/notifications/types.js";
import {
  actionsFor,
  bodyFor,
  escapeActionFor,
  isDismissible,
  progressFor,
  severityFor,
  titleFor,
  toastIdentity,
  type ToastableUpdateStatus,
  type UpdateToastActionId,
} from "./update-toast-model.js";

export interface UpdateToastHandlers {
  readonly onLater: () => void;
  readonly onUpdateNow: () => void;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
  readonly onTryAgain: () => void;
  readonly onReleaseNotes: () => void;
  readonly onDismissError: () => void;
}

/**
 * One stable id for the whole updater. A second update notification cannot
 * exist: the status is a single state machine, so a raising while one is live
 * IS that one, moved to its next state.
 */
export const UPDATE_NOTIFICATION_ID = "vex.updater";

function dispatch(handlers: UpdateToastHandlers, actionId: UpdateToastActionId): void {
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

function toActionInputs(
  status: ToastableUpdateStatus,
  busy: boolean,
  handlersRef: { readonly current: UpdateToastHandlers },
): readonly NotificationActionInput[] {
  return actionsFor(status, busy).map((action) => ({
    id: action.id,
    label: action.label,
    rank: action.rank,
    disabled: action.disabled,
    // Reading the handlers through the ref at CLICK time, not at build time:
    // the row is rebuilt on every tick and a captured handler would be the one
    // that existed when that tick rendered.
    run: () => {
      dispatch(handlersRef.current, action.id);
    },
  }));
}

export function UpdateToastSurface({
  status,
  busy,
  handlers,
}: {
  readonly status: ToastableUpdateStatus;
  readonly busy: boolean;
  readonly handlers: UpdateToastHandlers;
}): null {
  const statusRef = useRef(status);
  statusRef.current = status;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const handleRef = useRef<NotificationHandle | null>(null);

  const identity = toastIdentity(status);

  useEffect(() => {
    const current = statusRef.current;
    const progress = progressFor(current);
    const handle = notify({
      id: UPDATE_NOTIFICATION_ID,
      severity: severityFor(current),
      scope: { kind: "global" },
      source: "updater",
      title: titleFor(current),
      message: bodyFor(current),
      actions: toActionInputs(current, busyRef.current, handlersRef),
      ...(progress === null ? {} : { progress }),
      sticky: true,
      dismissible: isDismissible(current),
    });
    handleRef.current = handle;
    const offClose = handle.onDidClose((reason) => {
      handleRef.current = null;
      if (reason !== "user") return;
      const escape = escapeActionFor(statusRef.current);
      if (escape !== null) dispatch(handlersRef.current, escape);
    });
    return () => {
      // Unsubscribe BEFORE closing: this close is the surface's own teardown,
      // and running the user-dismissal branch for it would snooze an update
      // the user never touched.
      offClose();
      handle.close();
      handleRef.current = null;
    };
  }, [identity]);

  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    // Each of these is a no-op when the value has not changed, which is what
    // keeps a percent tick from re-announcing the sentence.
    handle.updateSeverity(severityFor(status));
    handle.updateMessage(bodyFor(status));
    const progress = progressFor(status);
    if (progress !== null) handle.updateProgress(progress);
    handle.updateActions(toActionInputs(status, busy, handlersRef));
  }, [status, busy]);

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

  return null;
}
