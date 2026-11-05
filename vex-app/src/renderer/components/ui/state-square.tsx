/**
 * StateSquare: H3's state square (docs/design/H3-DESKTOP.md section 2.2), the
 * desktop twin of VEX Cloud's StateDot (`.vx-sq`, its `styles/status.css`).
 * Every status has its own drawing, so a colour never stands alone (PD-03):
 *
 *   done       solid, status green     Confirmed, Filled
 *   ongoing    blink, the hud          Running, Submitted, Pending (PD-06)
 *   warning    target, ink             Waiting, your move
 *   error      cross, refusal ink      Failed, Did not execute
 *   idle       empty frame, muted      Ready, a word this build does not map
 *   paused     dotted frame, ink 2     Paused, Sleeping
 *   draft      hatch, ink 2            a draft
 *   concerned  framed hatch, ink       Status unknown, Concerned
 *
 * A running square blinks and holds still as half a square under reduced
 * motion and Save-Data, so it never reads as Filled. Every running square in
 * view blinks in phase: the callback ref pins its animation to document time
 * zero, as Cloud's `syncAnimations` does.
 *
 * Always beside a word, and always `aria-hidden`: the word says the state.
 * 8px by default; rows pass 6. The drawings live in `ui-primitives/marks.css`
 * (`.vex-sq`). It replaces the R3 `Swatch` wherever a surface restyles.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

export type StateSquareState =
  | "done"
  | "ongoing"
  | "warning"
  | "error"
  | "idle"
  | "paused"
  | "draft"
  | "concerned";

/** Every state, in Cloud's order. */
export const STATE_SQUARE_STATES: readonly StateSquareState[] = [
  "done",
  "warning",
  "ongoing",
  "error",
  "idle",
  "draft",
  "paused",
  "concerned",
];

/**
 * Pins the element's CSS animations to document time zero, so squares
 * mounted at different moments blink together. A no-op for `null` (the
 * unmount call) and where Web Animations is missing (jsdom).
 */
export function syncBlink(element: Element | null): void {
  if (element === null) return;
  const target = element as { getAnimations?: Element["getAnimations"] };
  for (const animation of target.getAnimations?.() ?? []) animation.startTime = 0;
}

export function StateSquare({
  state,
  size = 8,
  className,
}: {
  readonly state: StateSquareState;
  /** Outer edge in px: 8 by default, 6 in rows. */
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      ref={state === "ongoing" ? syncBlink : undefined}
      className={cn("vex-sq", className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
