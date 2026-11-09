/**
 * The loader gate's count, as pure functions: VEX Cloud's
 * `components/brand/loader-gate-model.ts` (its CTR/brand contract, section 3;
 * DG-3 `boot.js`), ported line for line; docs/design/H3-DESKTOP.md section 5.9.
 *
 * The bar shows what has really arrived and never more: the caller reports
 * `progress` (0 to 1), the count walks toward it at one steady speed (the
 * whole bar in 2.4 s), and waits where it stands when nothing new has
 * arrived. Nothing in here knows what a mark of progress is; the consumer
 * names its marks from real events only.
 */

/** The first mark, what the static markup shows before any script runs. */
export const GATE_START = 0.08;

/** Seconds for the whole bar at the steady speed. */
export const GATE_PACE_S = 2.4;

/** One frame never counts for more than this many seconds, so a stalled tab does not jump the bar. */
export const GATE_FRAME_CAP_S = 0.05;

/** The bar is full from here: every cell is lit and the gate rests. */
export const GATE_READY = 0.995;

/** A full bar rests this long before the gate fades (it is skipped under reduced motion). */
export const GATE_HOLD_MS = 320;

/** After this long since the gate mounted the bar completes whatever has arrived (DG-3 decision 14: the 12 s ceiling stays). */
export const GATE_CEILING_MS = 12_000;

/** One cell per this many pixels of window width, and never fewer than the minimum. */
export const GATE_CELL_PX = 22;
export const GATE_MIN_CELLS = 18;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The goal a reported progress sets: a bar never runs backwards, so the highest report counts. */
export function raiseGoal(goal: number, progress: number | undefined): number {
  if (progress === undefined || Number.isNaN(progress)) return goal;
  return Math.max(goal, clamp01(progress));
}

/**
 * One frame of the count: `min(goal, shown + dt / 2.4)`, `dt` capped at 0.05 s. At or past the goal it stays put.
 * `instant` (reduced motion) lands on the goal with no walk.
 */
export function advanceGate(
  shown: number,
  goal: number,
  seconds: number,
  instant = false,
): number {
  const target = clamp01(goal);
  if (instant) return target;
  const step = Math.min(Math.max(seconds, 0), GATE_FRAME_CAP_S) / GATE_PACE_S;
  return Math.min(target, shown + step);
}

/** How many cells a window of this width draws: `max(18, round(width / 22))` (65 at 1440). */
export function gateCellCount(width: number): number {
  return Math.max(GATE_MIN_CELLS, Math.round(width / GATE_CELL_PX));
}

/** How many cells are lit at this point of the count. */
export function litCells(shown: number, count: number): number {
  return Math.round(clamp01(shown) * count);
}

/** One cell's state: lit, the head (the last lit one) or off (`undefined`). */
export function cellState(
  index: number,
  lit: number,
): "on" | "head" | undefined {
  if (index < lit - 1) return "on";
  return index === lit - 1 ? "head" : undefined;
}

/** The mark's fill: revealed from the left, clipped from the right (`inset(0 X% 0 0)`). */
export function fillClip(shown: number): string {
  return `inset(0 ${(100 - clamp01(shown) * 100).toFixed(2)}% 0 0)`;
}
