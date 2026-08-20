/**
 * Pointer-driven quiet scrollbars for a column: returns whether the column's
 * scrollbars should be REBOUND AWAY (quiet = pointer elsewhere). The caller
 * applies the quiet flag by re-binding the --vex-scrollbar-thumb pair to
 * transparent on its own container (scrollbars.css indirection), so the bar
 * reveals without reflow.
 *
 * Leaving is decided by the column's BOX (a document pointermove probe), not
 * DOM containment: portaled menus and fixed overlays rendered as descendants
 * would swallow `pointerleave` and leave the bars drawn over a column nobody
 * is pointing at. The element's own leave stays wired as the one signal
 * geometry cannot give — a pointer that leaves the window emits no further
 * moves. The bars linger for LINGER_MS after the pointer leaves so crossing
 * the column edge does not blink them out.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** How long the bars stay drawn after the pointer leaves the column. */
export const SCROLLBAR_LINGER_MS = 2000;

export function useQuietScrollbars(
  columnRef: RefObject<HTMLElement | null>,
): {
  readonly quiet: boolean;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
} {
  const [pointerInside, setPointerInside] = useState(false);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return;
    lingerTimer.current = setTimeout(() => {
      lingerTimer.current = undefined;
      setPointerInside(false);
    }, SCROLLBAR_LINGER_MS);
  };
  const cancelLinger = (): void => {
    clearTimeout(lingerTimer.current);
    lingerTimer.current = undefined;
  };

  useEffect(() => {
    if (!pointerInside) return undefined;
    const onMove = (event: PointerEvent): void => {
      const rect = columnRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const inside =
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom;
      if (inside) cancelLinger();
      else armLinger();
    };
    document.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("pointermove", onMove);
      cancelLinger();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columnRef is a stable ref box
  }, [pointerInside]);

  return {
    quiet: !pointerInside,
    onPointerEnter: (): void => {
      cancelLinger();
      setPointerInside(true);
    },
    onPointerLeave: (): void => {
      armLinger();
    },
  };
}
