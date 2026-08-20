/**
 * One column drag handle for the shell grid: pointer capture, rAF-throttled
 * dx reports against the drag-start origin. `side` keys the hover-reveal CSS
 * to the owning column (styles/global-css/shell.css).
 */

import { useCallback, useRef, useState, type JSX, type PointerEvent } from "react";

export function ShellDragHandle({
  side,
  left,
  label,
  onStart,
  onDrag,
  onEnd,
}: {
  readonly side: "sidebar" | "book";
  /** Handle strip position: the column border's x offset inside the frame. */
  readonly left: number;
  readonly label: string;
  readonly onStart: () => void;
  /** Reported at rAF cadence with the total dx since drag start. */
  readonly onDrag: (dx: number) => void;
  readonly onEnd: () => void;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  // Ref-carried callbacks: a drag must keep reporting against the handlers
  // from the CURRENT render without re-binding mid-gesture.
  const callbacks = useRef({ onStart, onDrag, onEnd });
  callbacks.current = { onStart, onDrag, onEnd };

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = e.clientX;
    latest.current = e.clientX;
    callbacks.current.onStart();
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(latest.current - origin.current);
    });
  }, []);
  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    callbacks.current.onDrag(latest.current - origin.current);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="vex-shell-handle"
      style={{ left }}
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
