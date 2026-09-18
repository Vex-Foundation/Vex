/**
 * One column drag handle for the shell grid: pointer capture, rAF-throttled
 * dx reports against the drag-start origin. `side` keys the hover-reveal CSS
 * to the owning column (styles/global-css/shell.css).
 */

import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from "react";

export function ShellDragHandle({
  side,
  left,
  label,
  value,
  min,
  max,
  onStart,
  onDrag,
  onEnd,
}: {
  readonly side: "sidebar" | "book";
  /** Handle strip position: the column border's x offset inside the frame. */
  readonly left: number;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onStart: () => void;
  /** Reported at rAF cadence with the total dx since drag start. */
  readonly onDrag: (dx: number) => void;
  readonly onEnd: () => void;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const active = useRef(false);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  // Ref-carried callbacks: a drag must keep reporting against the handlers
  // from the CURRENT render without re-binding mid-gesture.
  const callbacks = useRef({ onStart, onDrag, onEnd });
  callbacks.current = { onStart, onDrag, onEnd };

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    active.current = true;
    origin.current = e.clientX;
    latest.current = e.clientX;
    callbacks.current.onStart();
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (!active.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(latest.current - origin.current);
    });
  }, []);
  const endDrag = useCallback((): void => {
    if (!active.current) return;
    active.current = false;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    callbacks.current.onDrag(latest.current - origin.current);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);
  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    latest.current = e.clientX;
    endDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, [endDrag]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      title="Drag to resize · arrow keys to adjust"
      className="vex-shell-handle"
      style={{ left }}
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        callbacks.current.onStart();
        callbacks.current.onDrag(event.key === "ArrowLeft" ? -24 : 24);
        callbacks.current.onEnd();
      }}
    />
  );
}
