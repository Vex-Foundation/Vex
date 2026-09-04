/**
 * PUBLIC GATE for the notification subsystem.
 *
 * Producers import `notify` from here and nothing else; the surfaces import
 * `notifications` (the one model for the window) plus the types. The model
 * class itself is exported for tests, which own their own instance rather than
 * mutating the window's.
 *
 * ONE model per window, module-level, for the same reason
 * `useCrossModeApprovalToast`'s memory is module-level: the toast stack, the
 * center and the announcer are three separate mounts that must agree on one
 * list, and a React-context-scoped model would fork the moment two shells
 * mounted their own provider across a mode switch.
 */

import { NotificationsModel } from "./notification-model.js";
import type { NotificationHandle, NotificationInput } from "./types.js";

export {
  HISTORY_CAP,
  MAX_VISIBLE_TOASTS,
  NotificationsModel,
  PURGE_MS,
  TOAST_EXIT_MS,
  isSticky,
} from "./notification-model.js";
export type * from "./types.js";

/** The window's notification model. */
export const notifications = new NotificationsModel();

/**
 * Raise a notification. The returned handle is the ONLY way to update or close
 * it, and its `disposeActions` is what a producing surface calls on unmount.
 */
export function notify(input: NotificationInput): NotificationHandle {
  return notifications.notify(input);
}
