/**
 * One composed frame instead of motion (MOTION-POLICY.md, "Reduced motion"): a canvas that
 * animates paints its still frame and stops when the user asks for reduced motion or the network
 * asks to save data. The still frame is the frame motion starts from.
 *
 * SAVE-DATA REACHES CSS AS AN ATTRIBUTE ON <html> (docs/design/H3-DESKTOP.md section 3.7).
 * Reduced motion has its own media query, so CSS can follow it unaided; Save-Data has none, so
 * `data-still` on documentElement carries it: `public/theme-boot.js` stamps it before first paint
 * and keeps it current when the connection's preference changes, and base.css collapses every
 * animation and transition under it as the reduced-motion catch-all does. So a CSS-only motion
 * (Kimm's clip-path wipe, the swatch step, the loading line) lands at once under Save-Data
 * without a JS branch. `stampSaveData` below is that stamp's rule; the boot script mirrors it
 * (it runs before the bundle, so it cannot import this module) - keep the two in sync.
 */
import { prefersReducedMotion, useReducedMotion } from "./reduced-motion.js";

type NetworkInformationLike = { readonly saveData?: boolean };

/** The attribute on <html> that tells CSS the network asked to save data. */
export const STILL_ATTRIBUTE = "data-still";

/** The user asked the network to save data: the composed frame only. */
export function prefersSaveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav: Navigator & { readonly connection?: NetworkInformationLike } = navigator;
  return nav.connection?.saveData === true;
}

/**
 * Stamp or clear `data-still` on the root from a connection's Save-Data preference. Present
 * (empty-valued) only when `saveData` is exactly true: an absent connection, an unknown value or
 * false all leave motion on, the same answer `prefersSaveData` gives.
 */
export function stampSaveData(
  root: Pick<HTMLElement, "setAttribute" | "removeAttribute">,
  connection: NetworkInformationLike | undefined,
): void {
  if (connection?.saveData === true) root.setAttribute(STILL_ATTRIBUTE, "");
  else root.removeAttribute(STILL_ATTRIBUTE);
}

/**
 * The same answer read once, outside render: for a JS owner that decides at the moment of a press
 * whether an episode will play at all (the Vex sidebar's hide waits for her close only when she
 * moves; under the still frame the column goes at once).
 */
export function prefersStillFrame(): boolean {
  return prefersReducedMotion() || prefersSaveData();
}

/** One composed frame instead of motion: reduced motion or Save-Data. */
export function useStillFrame(): boolean {
  const reduced = useReducedMotion();
  return reduced || prefersSaveData();
}
