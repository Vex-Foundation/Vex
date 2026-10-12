/**
 * THE INDEX FOLD (docs/design/V10-SPREAD.md section 3): the session index
 * scrolls inside the sky, and no row is ever drawn across the horizon. After
 * every layout (a resize, a scroll, new rows) each item of the index
 * (`[data-vex-ix-item]`: a group head or a row) that the scroller's box would
 * cut is marked `data-vex-folded`, which left-page.css paints invisible, and
 * the rows below the box are counted. The caller shows that count on the
 * fold, a dotted rule with `n more`, whose press scrolls one page.
 *
 * A group head whose first row is folded below goes with it, so a head never
 * stands alone on the horizon. The open session is scrolled into view when it
 * changes, inside the scroller only (never an ancestor: the page itself does
 * not scroll).
 *
 * The marks are DATA attributes on the items (never an inline style, which
 * the renderer's CSP refuses as a string), written straight to the DOM after
 * layout, so measuring never re-renders the rows; only the count is state.
 */

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useReducedMotion } from "../../../lib/motion/index.js";

/** Half a pixel of slack: a row exactly on the edge is not cut. */
const SLACK = 0.5;

export interface IndexFold {
  /** Rows below the scroller's box, hidden behind the fold. */
  readonly hiddenBelow: number;
  /** Scroll the index one page down (the fold's press). */
  readonly pageDown: () => void;
}

export function useIndexFold(
  scrollerRef: RefObject<HTMLElement | null>,
  /** Re-measure when these change (the rows, the filter, the search). */
  revision: unknown,
  /** The open session's id: scrolled into view when it changes. */
  currentId: string | null,
): IndexFold {
  const reducedMotion = useReducedMotion();
  const [hiddenBelow, setHiddenBelow] = useState(0);

  const measure = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const box = scroller.getBoundingClientRect();
    const items = Array.from(scroller.querySelectorAll<HTMLElement>("[data-vex-ix-item]"));
    const below = items.map((item) => item.getBoundingClientRect().bottom > box.bottom + SLACK);
    let count = 0;
    items.forEach((item, at) => {
      const rect = item.getBoundingClientRect();
      const isRow = item.dataset.vexIxItem === "row";
      const cut = (below[at] ?? false) || rect.top < box.top - SLACK;
      // A head goes with its first row when that row is folded below.
      const orphan = !isRow && (below[at + 1] ?? false);
      if (cut || orphan) item.setAttribute("data-vex-folded", "");
      else item.removeAttribute("data-vex-folded");
      if (isRow && (below[at] ?? false)) count += 1;
    });
    setHiddenBelow(count);
  }, [scrollerRef]);

  // Every commit that can move a row: re-measure before paint.
  useLayoutEffect(() => {
    measure();
  }, [measure, revision]);

  // The open session, brought into the scroller's view (and only its).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || currentId === null) return;
    const row = scroller.querySelector<HTMLElement>("[data-vex-ix-item][data-current]");
    if (row === null) return;
    const box = scroller.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < box.top) scroller.scrollTop += rect.top - box.top;
    else if (rect.bottom > box.bottom) scroller.scrollTop += rect.bottom - box.bottom;
    measure();
  }, [scrollerRef, currentId, revision, measure]);

  // A resize of the sky (the window, the fold appearing) and a scroll.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return undefined;
    let raf: number | null = null;
    const schedule = (): void => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", schedule);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [scrollerRef, measure]);

  const pageDown = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const top = scroller.clientHeight;
    if (typeof scroller.scrollBy === "function") {
      scroller.scrollBy({ top, behavior: reducedMotion ? "auto" : "smooth" });
    } else {
      scroller.scrollTop += top;
    }
  }, [scrollerRef, reducedMotion]);

  return { hiddenBelow, pageDown };
}
