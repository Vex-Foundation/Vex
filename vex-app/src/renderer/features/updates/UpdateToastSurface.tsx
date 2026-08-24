/**
 * UpdateToastSurface: binds one toastable `UpdateStatus` to the sticky slot
 * of the global ToastHost. Renders nothing itself - it projects the status
 * through update-toast-model, writes the entry, clears it on unmount, and
 * owns the Escape semantics (snooze / dismiss-error) the retired
 * bottom-right card had.
 */

import { useEffect } from "react";
import { clearStickyToast, setStickyToast } from "../../lib/toast.js";
import {
  buildUpdateToastEntry,
  escapeActionFor,
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

function dispatch(handlers: UpdateToastHandlers, actionId: string): void {
  switch (actionId as UpdateToastActionId) {
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

export function UpdateToastSurface({
  status,
  busy,
  handlers,
}: {
  readonly status: ToastableUpdateStatus;
  readonly busy: boolean;
  readonly handlers: UpdateToastHandlers;
}): null {
  useEffect(() => {
    const entry = buildUpdateToastEntry(status, busy, (actionId) => {
      dispatch(handlers, actionId);
    });
    setStickyToast(entry);
    return () => {
      clearStickyToast(entry.id);
    };
  }, [status, busy, handlers]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const action = escapeActionFor(status);
      if (action === null) return;
      event.preventDefault();
      if (action === "dismiss-error") handlers.onDismissError();
      else handlers.onLater();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [status, handlers]);

  return null;
}
