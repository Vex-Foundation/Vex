/**
 * THE TRANSCRIPT SCROLL MODEL'S GEOMETRY - the DOM reads and writes behind
 * `useTranscriptScroll.ts` (which holds the rules and the header that explains
 * them): the scrollport, the paging and saved-position row captures, the
 * newest turn anchor, the tail space and the reader-intent filter.
 *
 * Every offset is in scrollport coordinates from `getBoundingClientRect`. The
 * rows measured carry no transform (`TranscriptRows.tsx` puts its entry motion
 * on an inner wrapper), so the measurement is the row's layout box.
 */

import { ANCHOR_AIR_PX, tailSpace } from "./scrollFollow.js";

/** The turn anchors: sent rows and steering marks both render as `user`. */
const TURN_ANCHOR_SELECTOR = '[data-vex-entry-variant="user"]';
/** The tail space `SessionPanel` renders at the end of the session content. */
export const TAIL_SELECTOR = "[data-vex-transcript-tail]";

/** Reader intents that start a sample (capturing, passive listeners). */
export const READER_INTENTS = [
  "wheel",
  "touchstart",
  "pointerdown",
  "keydown",
  "beforematch",
] as const;

const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** A reflow-resistant reader position: a row identity plus where it sat. */
export interface SavedScrollPosition {
  readonly anchorKey: string;
  readonly anchorTop: number;
  readonly scrollTop: number;
}

/** The resident shell's scroll body, or this element when mounted alone. */
export function scrollportOf(from: HTMLElement): HTMLElement {
  return from.closest<HTMLElement>("[data-vex-conversation-scroll]") ?? from;
}

/** Row position in scrollport coordinates (viewport-independent). */
export function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return (
    row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
  );
}

/** The top of `element` in the scrollport's content coordinates. */
export function contentTop(element: HTMLElement, scrollport: HTMLElement): number {
  return flowTop(element, scrollport) - scrollport.clientTop + scrollport.scrollTop;
}

export function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>(
    "[data-vex-anchor-key]",
  )) {
    if (row.dataset.vexAnchorKey === key) return row;
  }
  return null;
}

/** The topmost row still visible in the scrollport; the head row otherwise. */
export function pagingAnchor(
  list: HTMLElement,
  scrollport: HTMLElement,
): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect();
  const rows = [
    ...list.querySelectorAll<HTMLElement>("[data-vex-anchor-key]"),
  ];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return row;
  }
  return rows[0] ?? null;
}

export function capturePosition(
  list: HTMLElement,
  scrollport: HTMLElement,
): SavedScrollPosition | null {
  const row = pagingAnchor(list, scrollport);
  const anchorKey = row?.dataset.vexAnchorKey;
  if (row === null || anchorKey === undefined) return null;
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  };
}

/**
 * The scroll top that shows the newest turn anchor at the top of the view, or
 * null without one. The first turn of a session whose head is loaded opens
 * it: 0, so the day label above it stays in view.
 */
export function newestAnchorTop(
  list: HTMLElement,
  scrollport: HTMLElement,
  headLoaded: boolean,
): number | null {
  const anchors = list.querySelectorAll<HTMLElement>(TURN_ANCHOR_SELECTOR);
  const newest = anchors[anchors.length - 1];
  if (newest === undefined) return null;
  if (anchors.length === 1 && headLoaded) return 0;
  return Math.max(
    0,
    Math.round(contentTop(newest, scrollport) - ANCHOR_AIR_PX),
  );
}

/** The tail space that lets the floor reach `anchorTop`; 0 removes it. */
export function sizeTail(scrollport: HTMLElement, anchorTop: number | null): void {
  const tail = scrollport.querySelector<HTMLElement>(TAIL_SELECTOR);
  if (tail === null) return;
  let next = 0;
  const content = tail.parentElement;
  if (anchorTop !== null && content !== null) {
    // The natural content end: the tail's top, the session content's bottom
    // padding and what follows it (the seat). Read from the tail's top, not
    // from `scrollHeight`, because the session content flex-fills a short
    // view and that fill is not content.
    const contentBottom = contentTop(content, scrollport) + content.offsetHeight;
    const padding = Number.parseFloat(getComputedStyle(content).paddingBottom);
    const contentEnd =
      contentTop(tail, scrollport) +
      (Number.isFinite(padding) ? padding : 0) +
      Math.max(0, scrollport.scrollHeight - contentBottom);
    next = tailSpace(anchorTop, scrollport.clientHeight, contentEnd);
  }
  const height = next === 0 ? "" : `${next}px`;
  if (tail.style.height !== height) tail.style.height = height;
}

/** True when `event` is a reader intent the follow policy samples. */
export function isReaderIntent(event: Event): boolean {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("[data-vex-composer-seat]") !== null
  ) {
    return false;
  }
  if (event.type !== "keydown") return true;
  return event instanceof KeyboardEvent && SCROLL_KEYS.has(event.key);
}
