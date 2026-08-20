/**
 * Cancelable delayed close for pointer-dismissed popups (HoverCard,
 * hover-closing Menu). Both float free of their anchor, so the pointer must
 * cross ground belonging to neither on the way in; closing on the first
 * pointerleave would make the popup unreachable.
 */

import { useCallback, useEffect, useRef } from "react";

/** Grace covering the anchor->popup gap at a hand's travel speed. */
export const POINTER_GRACE_MS = 200;

export interface PointerGrace {
  /** Schedule the close POINTER_GRACE_MS from now, replacing any pending one. */
  readonly arm: () => void;
  /** Abort a pending close (the pointer came back). */
  readonly cancel: () => void;
}

/**
 * Delay a pointer-dismissed popup's close so the pointer can cross the gap.
 * `close` is read at fire time, so callers may pass a fresh closure each
 * render. A pending close is dropped on unmount.
 */
export function usePointerGrace(close: () => void): PointerGrace {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  const cancel = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const arm = useCallback(() => {
    cancel();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      closeRef.current();
    }, POINTER_GRACE_MS);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return { arm, cancel };
}
