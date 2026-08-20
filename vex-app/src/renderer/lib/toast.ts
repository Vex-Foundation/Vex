/**
 * Toast store: a tiny module-level slot the ToastHost subscribes to.
 * `showToast(text, {tone})` replaces the current toast (a fresh id restarts
 * the CSS cycle via a React key); the host clears the slot when the toast's
 * timed lifecycle completes.
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
