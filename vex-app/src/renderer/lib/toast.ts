/**
 * Toast store: two tiny module-level slots the ToastHost subscribes to.
 * `showToast(text, {tone})` replaces the current transient toast (a fresh id
 * restarts the CSS cycle via a React key); the host clears the slot when the
 * toast's timed lifecycle completes. `setStickyToast(entry)` owns the single
 * persistent bottom-right toast: no timer, caller-controlled lifecycle,
 * optional actions/progress - the entry stays generic, and feature vocabulary
 * lives with the feature that sets it.
 *
 * ## Status after B2.1: this is the LEGACY layer
 *
 * `lib/notifications/` is now the owner of app-wide signals - stacking,
 * per-severity dismissal timing, retention, announcement. These two slots stay
 * for one round so that every existing call site keeps working unchanged, and
 * B2.2 migrates them to `notify` and deletes this module.
 *
 *  - `showToast` MIRRORS its message into the model as a center-only entry
 *    (see the note on the function), so nothing shown here is forgotten.
 *  - `setStickyToast` is NOT mirrored. Its entry is a presentation contract -
 *    title, leading glyph, action kinds, a progress bar, a dismiss affordance -
 *    whose one client is `features/updates/UpdateToastSurface.tsx`. Routing it
 *    through the model would mean either teaching the model that presentation
 *    vocabulary or re-rendering the update toast as a generic notification;
 *    the first corrupts the model, the second changes a shipped surface that
 *    this round was told to keep working unchanged. B2.2 owns that migration,
 *    which is where its update-specific semantics belong.
 */

import { notifications } from "./notifications/index.js";
import type { NotificationSeverity } from "./notifications/types.js";

export type ToastTone = "neutral" | "warning" | "error";

export interface ToastEntry {
  /** Per-show sequence; keying the rendered toast by it restarts the cycle. */
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

type Listener = (toast: ToastEntry | null) => void;

let current: ToastEntry | null = null;
let sequence = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

const TONE_SEVERITY: Readonly<Record<ToastTone, NotificationSeverity>> = {
  neutral: "info",
  warning: "warning",
  error: "error",
};

/**
 * Show a toast, replacing any visible one. Copy arrives resolved from the caller.
 *
 * ALSO mirrors the message into the notification model, so a toast the user
 * missed is still readable in the center - the gap this slot could never
 * close, because it holds one message and forgets it four seconds later.
 *
 * The mirror is delivered to the CENTER ONLY: this slot already paints the
 * banner and the banner already carries `role="alert"`, so letting the model
 * toast it or announce it would show it twice and speak it twice.
 *
 * REMOVAL CONDITION: B2.2 migrates these call sites to `notify`, at which
 * point the slot, the mirror and `NotificationDelivery` are deleted together.
 */
export function showToast(
  text: string,
  options?: { readonly tone?: ToastTone },
): void {
  sequence += 1;
  const tone = options?.tone ?? "neutral";
  current = { id: sequence, text, tone };
  emit();
  notifications.notify({
    severity: TONE_SEVERITY[tone],
    scope: { kind: "global" },
    source: "app",
    message: text,
    deliver: { toast: false, announce: false },
  });
}

/** Clear the current toast (the host calls this when the fade completes). */
export function clearToast(id: number): void {
  if (current === null || current.id !== id) return;
  current = null;
  emit();
}

/** Subscribe to toast changes; returns the unsubscribe. */
export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current toast snapshot (for useSyncExternalStore). */
export function getToastSnapshot(): ToastEntry | null {
  return current;
}

export type StickyToastActionKind = "accent" | "ghost" | "link";

export interface StickyToastAction {
  readonly id: string;
  readonly label: string;
  readonly kind: StickyToastActionKind;
  readonly disabled?: boolean;
}

/** Leading mark; the host maps these to glyphs (never feature-specific). */
export type StickyToastIcon = "download" | "dot" | "check" | "warning";

export interface StickyToastEntry {
  /**
   * Caller-chosen identity. The host keys the DOM node by it: a NEW id
   * remounts (entry animation restarts), the SAME id updates in place
   * (a progress tick never replays the slide-in).
   */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly tone: ToastTone;
  readonly icon?: StickyToastIcon;
  /** 0-100 renders a progress bar; absent renders none. */
  readonly progress?: number;
  readonly actions: readonly StickyToastAction[];
  readonly onAction: (actionId: string) => void;
  /** Renders the corner X; label doubles as its accessible name. */
  readonly dismiss?: { readonly label: string; readonly onDismiss: () => void };
  /** ARIA live role; "status" when absent. */
  readonly role?: "alert" | "status";
}

type StickyListener = (entry: StickyToastEntry | null) => void;

let sticky: StickyToastEntry | null = null;
const stickyListeners = new Set<StickyListener>();

function emitSticky(): void {
  for (const listener of stickyListeners) listener(sticky);
}

/** Show or update the persistent toast, replacing any current entry. */
export function setStickyToast(entry: StickyToastEntry): void {
  sticky = entry;
  emitSticky();
}

/** Remove the persistent toast. A stale id (already replaced) is a no-op. */
export function clearStickyToast(id?: string): void {
  if (sticky === null) return;
  if (id !== undefined && sticky.id !== id) return;
  sticky = null;
  emitSticky();
}

/** Subscribe to persistent-toast changes; returns the unsubscribe. */
export function subscribeStickyToast(listener: StickyListener): () => void {
  stickyListeners.add(listener);
  return () => {
    stickyListeners.delete(listener);
  };
}

/** Current persistent-toast snapshot (for useSyncExternalStore). */
export function getStickyToastSnapshot(): StickyToastEntry | null {
  return sticky;
}
