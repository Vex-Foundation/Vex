/**
 * Pure projection of an `UpdateStatus` onto the NOTIFICATION vocabulary: which
 * statuses notify at all, the title and body copy, the severity, the progress,
 * the action row, whether the user may dismiss it, and what Escape means per
 * state. The impure halves (mutations, snooze state, the handle's lifetime)
 * live in UpdateLayer / UpdateToastSurface.
 *
 * ## B2.2: the sticky slot became a model client
 *
 * This used to build a `StickyToastEntry` for a second, independent
 * bottom-right region with its own store, its own `role`, its own dismiss
 * affordance and its own glyph vocabulary. That region is gone. What the
 * updater needs from a notification surface - stay until I say otherwise,
 * carry an action row, show a progress bar, refuse to be dismissed while the
 * decision is still the user's to make - is exactly what `sticky`,
 * `actions`, `progress` and `dismissible` are, so the update toast is now the
 * model's first sticky client rather than a parallel implementation of it.
 *
 * Two deliberate consequences, both of them the point rather than fallout:
 *
 *  - the ARIA role is gone from here. Announcement belongs to
 *    `NotificationAnnouncer`, which speaks once per model event; the old
 *    `role: critical ? "alert" : "status"` is now carried by SEVERITY, which
 *    is what the announcer routes on (a critical update is a `warning`, and
 *    warnings are announced assertively).
 *  - the download PERCENT left the message. It lives in `progress` alone, so a
 *    tick moves the bar without rewriting the sentence - and therefore without
 *    the announcer speaking a new number every few hundred milliseconds.
 */

import type { UpdateStatus } from "@shared/schemas/updater.js";
import type {
  NotificationActionRank,
  NotificationProgressInput,
  NotificationSeverity,
} from "../../lib/notifications/types.js";

/** The five states that render a toast; `current/checking/idle` render nothing. */
export type ToastableUpdateStatus = Extract<
  UpdateStatus,
  {
    kind:
      | "available"
      | "downloading"
      | "downloaded"
      | "blockedByOperation"
      | "error";
  }
>;

const TOAST_KINDS: ReadonlySet<UpdateStatus["kind"]> = new Set([
  "available",
  "downloading",
  "downloaded",
  "blockedByOperation",
  "error",
]);

export function isToastKind(
  status: UpdateStatus,
): status is ToastableUpdateStatus {
  return TOAST_KINDS.has(status.kind);
}

/** `severity` is a UX-only convention (sanitize.ts), not a security signal. */
export function isCritical(status: ToastableUpdateStatus): boolean {
  return "severity" in status && status.severity === "critical";
}

/** Stable action ids the surface maps back onto mutations. */
export type UpdateToastActionId =
  | "release-notes"
  | "later"
  | "update-now"
  | "cancel"
  | "restart"
  | "try-again"
  | "dismiss-error";

/** One action as the surface will bind it: identity, copy, rank, availability. */
export interface UpdateToastAction {
  readonly id: UpdateToastActionId;
  readonly label: string;
  readonly rank: NotificationActionRank;
  /** A mutation for this toast is already in flight. */
  readonly disabled: boolean;
}

export function titleFor(status: ToastableUpdateStatus): string {
  switch (status.kind) {
    case "available":
      return isCritical(status)
        ? `Critical update - Vex ${status.latestVersion}`
        : `Vex ${status.latestVersion} available`;
    case "downloading":
      return `Downloading Vex ${status.latestVersion}`;
    case "downloaded":
      return "Ready to install";
    case "blockedByOperation": {
      const step = status.blockedAction === "install" ? "Install" : "Download";
      return isCritical(status)
        ? `Critical update - ${step.toLowerCase()} blocked`
        : `${step} blocked`;
    }
    case "error":
      return "Update failed";
  }
}

/**
 * The body sentence. INVARIANT for `downloading`: it carries no percentage.
 * The number is `progressFor`'s, and putting it here too would make every tick
 * a message change, which the announcer would speak.
 */
export function bodyFor(status: ToastableUpdateStatus): string {
  switch (status.kind) {
    case "available":
      return "Downloads the update. You choose when to restart.";
    case "downloading":
      return "Downloading in the background.";
    case "downloaded":
      return `Vex ${status.latestVersion} is ready. Restart to finish installing.`;
    case "blockedByOperation":
      return status.reason;
    case "error":
      return status.message;
  }
}

/**
 * What the announcer routes on, replacing the old ARIA role.
 *
 * A critical update is a `warning` (assertive) where an ordinary one is
 * `info` (polite) - the same split the retired `role: alert | status` made. A
 * BLOCKED step is a warning and not an error: nothing failed, the update is
 * waiting for a financial or destructive operation to finish, which is the
 * updater behaving correctly.
 */
export function severityFor(status: ToastableUpdateStatus): NotificationSeverity {
  switch (status.kind) {
    case "error":
      return "error";
    case "blockedByOperation":
      return "warning";
    case "available":
      return isCritical(status) ? "warning" : "info";
    case "downloading":
    case "downloaded":
      return "info";
  }
}

/** Determinate progress while downloading; nothing in any other state. */
export function progressFor(
  status: ToastableUpdateStatus,
): NotificationProgressInput | null {
  if (status.kind !== "downloading") return null;
  return { total: 100, worked: status.percent };
}

export function actionsFor(
  status: ToastableUpdateStatus,
  busy: boolean,
): readonly UpdateToastAction[] {
  switch (status.kind) {
    case "available": {
      const actions: UpdateToastAction[] = [
        {
          id: "release-notes",
          label: "Release notes",
          rank: "secondary",
          disabled: false,
        },
      ];
      if (!isCritical(status)) {
        actions.push({ id: "later", label: "Later", rank: "secondary", disabled: false });
      }
      actions.push({
        id: "update-now",
        label: "Update now",
        rank: "primary",
        disabled: busy,
      });
      return actions;
    }
    case "downloading":
      return [{ id: "cancel", label: "Cancel", rank: "secondary", disabled: busy }];
    case "downloaded":
      return [
        { id: "later", label: "Later", rank: "secondary", disabled: false },
        {
          id: "restart",
          label: "Restart & install",
          rank: "primary",
          disabled: busy,
        },
      ];
    case "blockedByOperation":
      return [
        { id: "try-again", label: "Try again", rank: "primary", disabled: busy },
      ];
    case "error":
      return [
        {
          id: "release-notes",
          label: "Open download page",
          rank: "secondary",
          disabled: false,
        },
        { id: "try-again", label: "Try again", rank: "primary", disabled: busy },
      ];
  }
}

/**
 * What Escape means per state: snooze a snoozable toast, dismiss an error,
 * nothing for downloading/blocked/critical-available (unchanged semantics
 * from the retired bottom-right card).
 */
export function escapeActionFor(
  status: ToastableUpdateStatus,
): Extract<UpdateToastActionId, "later" | "dismiss-error"> | null {
  if (status.kind === "error") return "dismiss-error";
  if (
    (status.kind === "available" && !isCritical(status)) ||
    status.kind === "downloaded"
  ) {
    return "later";
  }
  return null;
}

/**
 * Whether the USER may remove the toast, and the same question as "does
 * Escape do anything here".
 *
 * They are one rule, not two that happen to agree: a dismissal IS the escape
 * action (snooze, or dismiss-error), so a state with no escape action has no
 * meaning for dismissal either and must not offer the control. Downloading, a
 * blocked step and a critical update are exactly those states - removing their
 * toast would take away the only Cancel / Try again / Update now the user has
 * and leave the operation running unattended.
 */
export function isDismissible(status: ToastableUpdateStatus): boolean {
  return escapeActionFor(status) !== null;
}

/**
 * The identity that decides when a NEW notification is raised rather than the
 * live one updated: the state plus the version it is about. Percent and busy
 * changes stay inside one notification (handle updates); a state change or a
 * newer release replaces it, which is what replays the entrance.
 */
export function toastIdentity(status: ToastableUpdateStatus): string {
  const version = "latestVersion" in status ? status.latestVersion : "";
  return `${status.kind}:${version}`;
}
