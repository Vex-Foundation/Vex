/**
 * One drag splitter for the desk's seams. The hook owns the gesture
 * (pointer capture, keyboard steps, double-click reset) and hands back the
 * props for a `role="separator"` handle; the caller owns the value, so it can
 * keep the live number in React state and persist it once on `onCommit`.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY_STEP = 24;

export interface SplitterOptions {
  /** `x`: the handle moves left/right and resizes a width; `y`: up/down, a height. */
  readonly axis: "x" | "y";
  /** The panel grows when the pointer moves toward this edge: `end` = right/down. */
  readonly grows: "start" | "end";
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly label: string;
  readonly onChange: (next: number) => void;
  /** Fired once when a drag, key step or reset settles. */
  readonly onCommit?: () => void;
  /** Double-click: instead of `onChange(defaultValue)`, e.g. to hand the size back to auto. */
  readonly onReset?: () => void;
}

export interface SplitterHandleProps {
  readonly role: "separator";
  readonly tabIndex: 0;
  readonly "aria-label": string;
  readonly "aria-orientation": "horizontal" | "vertical";
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly "aria-valuenow": number;
  readonly "aria-valuetext": string;
  readonly title: string;
  readonly "data-dragging": true | undefined;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onLostPointerCapture: () => void;
  readonly onDoubleClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useSplitter(options: SplitterOptions): {
  readonly dragging: boolean;
  readonly handleProps: SplitterHandleProps;
} {
  const { axis, grows, value, min, max, defaultValue, label, onChange, onCommit, onReset } = options;
  const dragRef = useRef<{ origin: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number): number => Math.round(Math.min(max, Math.max(min, next)));
  const settle = (next: number): void => {
    onChange(clamp(next));
    onCommit?.();
  };
  const endDrag = (): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setDragging(false);
    onCommit?.();
  };
  const sign = grows === "end" ? 1 : -1;
  const growKey = axis === "x" ? "ArrowRight" : "ArrowDown";
  const shrinkKey = axis === "x" ? "ArrowLeft" : "ArrowUp";

  return {
    dragging,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": label,
      // A separator between two columns is vertical; between two rows, horizontal.
      "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": value,
      "aria-valuetext": `${value} pixels`,
      title: "Drag to resize · arrow keys to adjust · double-click to reset",
      "data-dragging": dragging || undefined,
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = { origin: axis === "x" ? event.clientX : event.clientY, value };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        setDragging(true);
      },
      onPointerMove: (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const position = axis === "x" ? event.clientX : event.clientY;
        onChange(clamp(drag.value + sign * (position - drag.origin)));
      },
      onPointerUp: (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endDrag();
      },
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onDoubleClick: () => {
        if (onReset === undefined) { settle(defaultValue); return; }
        onReset();
        onCommit?.();
      },
      onKeyDown: (event) => {
        const next = event.key === growKey ? value + KEY_STEP
          : event.key === shrinkKey ? value - KEY_STEP
          : event.key === "Home" ? min
          : event.key === "End" ? max
          : null;
        if (next === null) return;
        event.preventDefault();
        settle(next);
      },
    },
  };
}
