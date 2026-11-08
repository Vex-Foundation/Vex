/**
 * THE CLIP CUE (Cloud's `ClipCue` and `use-card-clip.ts`, `.vx-tk-more`;
 * H3-DESKTOP.md section 4.3). A waiting card can be taller than the room it
 * is shown in: the chat's approvals stack is bounded (`ApprovalsRegion`,
 * 75vh) and a card's own footer is sticky over its last rows, so rows can sit
 * out of view while Reject and the approve key stay in view. The cue says so
 * over the keys, never over a row: "{n} more lines below".
 *
 * Presentational only, and `aria-hidden`: every row is in the card's reading
 * order already. Nothing here reads or writes the decision, the keys or what
 * is signed; it measures boxes and counts rows.
 */

import { useEffect, useState } from "react";
import type { JSX, RefObject } from "react";

/**
 * The rows the cue counts: the table's rows, "All signed fields" and, when
 * open, the signed fields' own rows. Each `dt` stands for its row, since the
 * rows' wrappers are `display: contents` and have no box.
 */
const ROWS = ".vex-appr__dl dt, .vex-appr__more-key, .vex-appr__well dt";

/** The rows of `card` whose bottom is under `end` (a viewport y), counted. */
export function rowsBelow(card: HTMLElement, end: number): number {
  return Array.from(card.querySelectorAll<HTMLElement>(ROWS)).filter(
    (row) => row.getBoundingClientRect().bottom > end + 1,
  ).length;
}

/** The nearest ancestor that scrolls its content on the y axis, or null. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Where the card's visible part ends: its scrolling ancestor's bottom, the
 * window's, and the top of whatever draws the keys over or under it (its own
 * sticky footer, or the chat's dock).
 */
function visibleEnd(card: HTMLElement, scroller: HTMLElement | null, dock: HTMLElement | null): number {
  const ends = [card.ownerDocument.defaultView?.innerHeight ?? Number.POSITIVE_INFINITY];
  if (scroller !== null) ends.push(scroller.getBoundingClientRect().bottom);
  const foot = dock ?? card.querySelector<HTMLElement>('[data-vex-area="approval-foot"]');
  if (foot !== null) ends.push(foot.getBoundingClientRect().top);
  return Math.min(...ends);
}

/**
 * How many of the card's rows are out of view under its visible end. Read
 * after layout, again on its scroller's scroll and on any resize; 0 where
 * nothing is cut (and in a test DOM with no layout).
 */
export function useRowsBelow(
  cardRef: RefObject<HTMLElement | null>,
  dock: HTMLElement | null,
  active: boolean,
): number {
  const [below, setBelow] = useState(0);
  useEffect(() => {
    const card = cardRef.current;
    if (!active || card === null) {
      setBelow(0);
      return;
    }
    const scroller = scrollerOf(card);
    const view = card.ownerDocument.defaultView;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      setBelow(rowsBelow(card, visibleEnd(card, scroller, dock)));
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = view?.requestAnimationFrame(measure) ?? 0;
      if (frame === 0) measure();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(card);
    if (scroller !== null) observer?.observe(scroller);
    if (dock !== null) observer?.observe(dock);
    scroller?.addEventListener("scroll", schedule, { passive: true });
    view?.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) view?.cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller?.removeEventListener("scroll", schedule);
      view?.removeEventListener("resize", schedule);
    };
  }, [cardRef, dock, active]);
  return below;
}

/** "{n} more lines below", or nothing while every row is in view. */
export function ClipCue({ below }: { readonly below: number }): JSX.Element | null {
  if (below <= 0) return null;
  return (
    <p aria-hidden="true" data-vex-area="approval-clip-cue" className="vex-appr__more-cue">
      {below === 1 ? "1 more line below" : `${below} more lines below`}
    </p>
  );
}
