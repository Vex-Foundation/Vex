/**
 * HoverCard: delayed hover-preview card portaled to document.body, fixed at
 * the anchor's right edge and repositioned on scroll/resize while open. The
 * card is hit-testable on purpose: leaving the anchor only arms a
 * grace-delayed close, so the pointer can cross the 8px gap and settle on
 * the card. The portaled card is a React child of the wrapper, so one pair
 * of wrapper handlers covers anchor and card alike.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePointerGrace } from "../../lib/pointer-grace.js";

/** Gap between the anchor's right edge and the card. */
const OFFSET = 8;
/** Clamp margin to the viewport bottom edge. */
const EDGE = 8;

export function HoverCard({
  anchor,
  content,
  openDelayMs = 500,
  disabled = false,
}: {
  /** The hover target (rendered in place inside a wrapper span). */
  readonly anchor: ReactNode;
  /** Card content; readable and selectable, no dismissal affordance. */
  readonly content: ReactNode;
  /** Hover dwell before the card shows. */
  readonly openDelayMs?: number;
  /** Suppress opening; turning true closes an open card. */
  readonly disabled?: boolean;
}): JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(close);

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Owner disabling mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    if (!disabled) return;
    clearTimer();
    cancelClose();
    close();
  }, [disabled, cancelClose, close]);

  useEffect(() => clearTimer, []);

  // Fixed-position from the anchor rect before paint; track the anchor while
  // open (capture-phase scroll catches nested panes).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const wrapper = rootRef.current;
      if (wrapper === null) return;
      const r = wrapper.getBoundingClientRect();
      const h = cardRef.current?.offsetHeight ?? 0;
      const top =
        r.top + h > window.innerHeight - EDGE
          ? window.innerHeight - h - EDGE
          : r.top;
      setPos({ left: r.right + OFFSET, top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // The first placement ran before the card mounted (height read 0): once
  // the real height is measurable, correct the bottom-edge clamp. The
  // correction converges - a clamped top satisfies the guard, so it runs once.
  useLayoutEffect(() => {
    if (!open || pos === null) return;
    const h = cardRef.current?.offsetHeight ?? 0;
    if (pos.top + h > window.innerHeight - EDGE) {
      setPos({ left: pos.left, top: window.innerHeight - h - EDGE });
    }
  }, [open, pos]);

  const card = open && pos !== null && (
    <div ref={cardRef} className="vex-hover-card" style={pos}>
      {content}
    </div>
  );

  return (
    <span
      ref={rootRef}
      className="vex-hover-card-root"
      onPointerEnter={() => {
        if (disabled) return;
        // Coming back inside during the grace (the gap, or the card itself)
        // keeps the current card rather than restarting the dwell.
        cancelClose();
        if (open) return;
        clearTimer();
        timerRef.current = setTimeout(() => setOpen(true), openDelayMs);
      }}
      onPointerLeave={() => {
        clearTimer();
        if (open) armClose();
      }}
      // A press inside the anchor dismisses the card immediately; a press on
      // the card itself starts a selection, so the card stays mounted.
      onPointerDownCapture={(e) => {
        if (cardRef.current?.contains(e.target as Node)) return;
        clearTimer();
        cancelClose();
        close();
      }}
    >
      {anchor}
      {card !== false && createPortal(card, document.body)}
    </span>
  );
}
