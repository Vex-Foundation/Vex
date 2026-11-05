/**
 * THE WIDE ZOOM (docs/design/H3-DESKTOP.md section 1.11; VEX Cloud's
 * `apps/web/src/lib/ui/wide-zoom.ts`, the H3 mockup's `--z`): from a 1760px
 * window up the transcript, the composer dock, the picker, the console, a
 * page, her section's key and its strip grow with the window, so text never
 * shrinks to a corner of a large display. The frame's cells never zoom; the
 * foot row grows to 72 x zoom + 1 so the zoomed composer still fills it.
 *
 * `--vex-zoom` on `<html>` is clamp(1, innerWidth / 1760, 1.5), to three
 * decimals: 1.091 at 1920, 1.455 at 2560, 1.5 from 2640. Cloud names it
 * `--vx-zoom`; desktop's prefix is `--vex-`. tokens.css declares 1 for the
 * frames before it runs.
 *
 * THE RESIZE FREEZE (VEX Cloud's motion contract, section 3 rule 6): while
 * the window is being resized and for `RESIZE_SETTLE_MS` (220ms) after the
 * last `resize` event, `data-vex-resizing` stands on `<html>`: base.css holds
 * every transition still, and the Web Animations owners (the chats panel, a
 * page's re-lay) land at once (`isWindowResizing`), so nothing trails the
 * layout as it follows the window. An attribute, never a class.
 *
 * `startWideZoom` is called once, from the shell frame's layout effect,
 * before the shell's first paint; it returns its stop function.
 */

/** The window width the zoom starts at: below it the zoom is 1. */
export const ZOOM_BASE_WIDTH = 1760;
/** The largest zoom (1.5, reached at 2640px). */
export const ZOOM_MAX = 1.5;
/** The custom property on `<html>`. */
export const ZOOM_PROPERTY = "--vex-zoom";
/** The attribute on `<html>` while the window is being resized. */
export const RESIZING_ATTRIBUTE = "data-vex-resizing";
/** How long after the last `resize` event the attribute stays (Cloud's 220). */
export const RESIZE_SETTLE_MS = 220;

/** The window is being resized, or settled less than 220ms ago: motion lands at once. */
export function isWindowResizing(doc: Document = document): boolean {
  return doc.documentElement.hasAttribute(RESIZING_ATTRIBUTE);
}

/** clamp(1, width / 1760, 1.5) to three decimals; a width that is not a positive number zooms nothing. */
export function wideZoomFor(width: number): number {
  if (!(width > 0)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(1, width / ZOOM_BASE_WIDTH)) * 1000) / 1000;
}

/**
 * Keeps `--vex-zoom` current on `<html>` and marks it while the window is
 * resized (`RESIZING_ATTRIBUTE`). Returns the stop function.
 */
export function startWideZoom(win: Window = window): () => void {
  const root = win.document.documentElement;
  let zoom = "";
  let timer: number | undefined;
  const apply = (): void => {
    const next = String(wideZoomFor(win.innerWidth));
    if (next === zoom) return;
    zoom = next;
    root.style.setProperty(ZOOM_PROPERTY, next);
  };
  const settle = (): void => {
    timer = undefined;
    root.removeAttribute(RESIZING_ATTRIBUTE);
  };
  const onResize = (): void => {
    apply();
    root.setAttribute(RESIZING_ATTRIBUTE, "");
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(settle, RESIZE_SETTLE_MS);
  };
  apply();
  win.addEventListener("resize", onResize, { passive: true });
  return () => {
    win.removeEventListener("resize", onResize);
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    root.removeAttribute(RESIZING_ATTRIBUTE);
  };
}
