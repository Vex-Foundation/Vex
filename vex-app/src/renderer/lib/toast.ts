/**
 * Toast store: two tiny module-level slots the ToastHost subscribes to.
 * `showToast(text, {tone})` replaces the current transient toast (a fresh id
 * restarts the CSS cycle via a React key); the host clears the slot when the
 * toast's timed lifecycle completes. `setStickyToast(entry)` owns the single
 * persistent bottom-right toast: no timer, caller-controlled lifecycle,
 * optional actions/progress - the entry stays generic, and feature vocabulary
 * lives with the feature that sets it.
 */

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

/** Show a toast, replacing any visible one. Copy arrives resolved from the caller. */
export function showToast(
  text: string,
  options?: { readonly tone?: ToastTone },
): void {
  sequence += 1;
  current = { id: sequence, text, tone: options?.tone ?? "neutral" };
  emit();
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
