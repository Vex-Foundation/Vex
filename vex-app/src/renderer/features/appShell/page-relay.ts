/**
 * A PAGE RE-LAYS AT THE PRESS (docs/design/H3-DESKTOP.md sections 1.9 and 3.6;
 * VEX Cloud's EC-26, the H3 mockup's `js/stage.js` lines 283 to 287).
 *
 * The frame's tracks never animate. On a table page, Show Vex brings Vex's
 * column back and Hide Vex folds it to the page's strip: the page re-lays
 * into its new width at the press, in one frame, and then fades in from 0.4
 * opacity over the leg's duration (720ms opening, 420ms closing) on the house
 * curve, while her column, opening, wipes in from its top edge on the push
 * curve with clip-path. Opacity and clip-path only: nothing in the layout
 * moves after the press. It is a person's press only, never a cue, and never
 * where a money card can wait (a table page holds none).
 *
 * Reduced motion, Save-Data and a window being resized land it at once.
 * Without Web Animations (jsdom) nothing runs.
 */

import {
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_OPEN_MS,
  EASE_HOUSE,
  EASE_PUSH,
  cssCurve,
} from "../../lib/motion/index.js";
import { prefersStillFrame } from "../../lib/motion/use-still-frame.js";
import { isWindowResizing } from "../../lib/wide-zoom.js";

/** The opacity a re-laid page starts its fade from (Cloud's 0.4). */
export const PAGE_RELAY_FROM_OPACITY = 0.4;

/**
 * Play the re-lay's motion on the page (the chat column, which holds it) and,
 * when she opens, her column. Returns the animations it started.
 */
export function relayPage(page: HTMLElement | null, column: HTMLElement | null, open: boolean): readonly Animation[] {
  if (page === null || typeof page.animate !== "function" || prefersStillFrame() || isWindowResizing()) {
    return [];
  }
  const duration = open ? DURATION_VEX_OPEN_MS : DURATION_VEX_CLOSE_MS;
  const started = [
    page.animate([{ opacity: PAGE_RELAY_FROM_OPACITY }, { opacity: 1 }], {
      duration,
      easing: cssCurve(EASE_HOUSE),
    }),
  ];
  if (open && column !== null && typeof column.animate === "function") {
    started.push(
      column.animate([{ clipPath: "inset(0px 0px 100% 0px)" }, { clipPath: "inset(0px)" }], {
        duration,
        easing: cssCurve(EASE_PUSH),
      }),
    );
  }
  return started;
}
