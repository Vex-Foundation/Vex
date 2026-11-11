/**
 * HER PANEL'S GEOMETRY (docs/design/H3-DESKTOP.md section 6.3; owner decision
 * 2026-11-10, "the chat takes that space"). Vex's panel is a box over the
 * chat's top right, as tall as what it holds, and the chat's own ground under
 * it. Two lengths in it are the chat's, not hers, so the frame measures them
 * and writes them on itself for the sheet to read (shell.css):
 *
 *   --vex-panel-floor  how far above the window's foot the chat's composer
 *                      group starts: the composer's dock (its live rows, the
 *                      status strip, the bottom row) and the card's decision
 *                      dock, whichever stands higher. Her panel never comes
 *                      down past it, so nothing the composer shows (a live
 *                      step, a growing draft, the docked approval band and its
 *                      reason field) ever lies under her: her card gives way
 *                      first, then her column scrolls. A page covers the
 *                      composer, and Studio has none, so there it is not
 *                      written and the panel may reach the body's foot.
 *   --vex-panel-h      her panel's own height, 0 while she is hidden: the
 *                      chat's scrollbar track starts under it, so the thumb
 *                      is never under her.
 *
 * Measured before paint and again whenever the frame, the composer group or
 * her panel changes size, a composer part mounts or goes (a session switch,
 * a card arriving), or the welcome scrolls; at most once a frame. Neither
 * length reaches the chat's tracks or its reading column, and neither reads
 * her shown or hidden choice, so nothing here can move a waiting card
 * (section 3.6).
 */

import { useLayoutEffect, type RefObject } from "react";

/** The composer group's parts, inside the chat. */
const COMPOSER_PARTS = '[data-vex-composer-dock], [data-vex-area="approval-dock"]';

/**
 * The floor for one frame: the frame's foot less the highest top among the
 * composer's parts that have a box, or null when none does.
 */
export function panelFloorOf(frameBottom: number, parts: readonly { readonly top: number; readonly height: number }[]): number | null {
  let top: number | null = null;
  for (const part of parts) {
    if (part.height <= 0) continue;
    top = top === null ? part.top : Math.min(top, part.top);
  }
  return top === null ? null : Math.max(0, Math.round(frameBottom - top));
}

export function useVexPanelGeometry(
  frameRef: RefObject<HTMLElement | null>,
  centreRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  options: { readonly active: boolean; readonly composer: boolean },
): void {
  const { active, composer } = options;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const centre = centreRef.current;
    const panel = panelRef.current;
    if (frame === null) return undefined;
    const clear = (): void => {
      frame.style.removeProperty("--vex-panel-floor");
      frame.style.removeProperty("--vex-panel-h");
    };
    if (!active || centre === null || panel === null) {
      clear();
      return undefined;
    }
    let parts: readonly HTMLElement[] = [];
    let sizes: ResizeObserver | null = null;
    const watch = (): void => {
      const next = composer ? [...centre.querySelectorAll<HTMLElement>(COMPOSER_PARTS)] : [];
      if (next.length === parts.length && next.every((el, i) => el === parts[i])) return;
      for (const el of parts) sizes?.unobserve(el);
      parts = next;
      for (const el of parts) sizes?.observe(el);
    };
    const measure = (): void => {
      const floor = panelFloorOf(
        frame.getBoundingClientRect().bottom,
        parts.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, height: r.height };
        }),
      );
      if (floor === null) frame.style.removeProperty("--vex-panel-floor");
      else frame.style.setProperty("--vex-panel-floor", `${String(floor)}px`);
      frame.style.setProperty("--vex-panel-h", `${String(Math.round(panel.getBoundingClientRect().height))}px`);
    };
    let raf: number | null = null;
    const schedule = (): void => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        watch();
        measure();
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      sizes = new ResizeObserver(schedule);
      sizes.observe(frame);
      sizes.observe(panel);
    }
    watch();
    measure();
    const tree = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    tree?.observe(centre, { childList: true, subtree: true });
    // The welcome's stack scrolls on a short window, and its dock with it.
    centre.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      sizes?.disconnect();
      tree?.disconnect();
      centre.removeEventListener("scroll", schedule, { capture: true });
      clear();
    };
  }, [frameRef, centreRef, panelRef, active, composer]);
}
