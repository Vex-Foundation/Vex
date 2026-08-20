/**
 * Pure projection of an `UpdateStatus` onto the generic sticky-toast entry:
 * which statuses toast at all, the title/body copy, the leading mark, the
 * action row, the ARIA role, and what Escape means per state. The impure
 * halves (mutations, snooze state, store writes) live in UpdateLayer /
 * UpdateToastSurface.
 */

import type { UpdateStatus } from "@shared/schemas/updater.js";
import type {
  StickyToastAction,
  StickyToastEntry,
  StickyToastIcon,
  ToastTone,
} from "../../lib/toast.js";

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

export function bodyFor(status: ToastableUpdateStatus): string {
  switch (status.kind) {
    case "available":
      return "Downloads the update. You choose when to restart.";
    case "downloading":
      return `${Math.round(status.percent)}% complete.`;
    case "downloaded":
      return `Vex ${status.latestVersion} is ready. Restart to finish installing.`;
    case "blockedByOperation":
      return status.reason;
    case "error":
      return status.message;
  }
}

function iconFor(status: ToastableUpdateStatus): StickyToastIcon {
  switch (status.kind) {
    case "downloading":
      return "dot";
    case "downloaded":
      return "check";
    case "blockedByOperation":
    case "error":
      return "warning";
    case "available":
      return "download";
  }
}

function toneFor(status: ToastableUpdateStatus): ToastTone {
  return status.kind === "blockedByOperation" || status.kind === "error"
    ? "error"
    : "neutral";
}

function actionsFor(
  status: ToastableUpdateStatus,
  busy: boolean,
): readonly StickyToastAction[] {
  switch (status.kind) {
    case "available": {
      const actions: StickyToastAction[] = [
        { id: "release-notes", label: "Release notes", kind: "link" },
      ];
      if (!isCritical(status)) {
        actions.push({ id: "later", label: "Later", kind: "ghost" });
      }
      actions.push({
        id: "update-now",
        label: "Update now",
        kind: "accent",
        disabled: busy,
      });
      return actions;
    }
    case "downloading":
      return [{ id: "cancel", label: "Cancel", kind: "ghost", disabled: busy }];
    case "downloaded":
      return [
        { id: "later", label: "Later", kind: "ghost" },
        {
          id: "restart",
          label: "Restart & install",
          kind: "accent",
          disabled: busy,
        },
      ];
    case "blockedByOperation":
      return [
        { id: "try-again", label: "Try again", kind: "accent", disabled: busy },
      ];
    case "error":
      return [
        { id: "release-notes", label: "Open download page", kind: "link" },
        { id: "try-again", label: "Try again", kind: "accent", disabled: busy },
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
 * Build the sticky entry for one status. `id` is the status kind: state
 * changes remount (entrance replays), progress ticks update in place.
 */
export function buildUpdateToastEntry(
  status: ToastableUpdateStatus,
  busy: boolean,
  onAction: (actionId: string) => void,
): StickyToastEntry {
  const critical = isCritical(status);
  const summary =
    status.kind === "available" && status.summary !== undefined
      ? ` ${status.summary}`
      : "";
  return {
    id: `update-${status.kind}`,
    title: titleFor(status),
    text: `${bodyFor(status)}${summary}`,
    tone: toneFor(status),
    icon: iconFor(status),
    ...(status.kind === "downloading" ? { progress: status.percent } : {}),
    actions: actionsFor(status, busy),
    onAction,
    ...(status.kind === "error"
      ? {
          dismiss: {
            label: "Dismiss update notification",
            onDismiss: () => onAction("dismiss-error"),
          },
        }
      : {}),
    role: critical ? "alert" : "status",
  };
}
