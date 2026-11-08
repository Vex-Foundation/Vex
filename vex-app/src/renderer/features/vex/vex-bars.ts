/**
 * THE BARS' MODEL (docs/design/H3-DESKTOP.md section 1.8; VEX Cloud's
 * `bars()`, the H3 mockup's js/stage.js): the strip of bars on the foot of
 * Vex's column, under her line. A display of how she is, never a key and
 * never a reading (Cloud's PD-15): no figure, no data, no claim. Three moods
 * drive it, from her presence state alone: ready (a slow sweep), busy (a
 * faster sweep while she thinks or works) and approve (a soft pulse while a
 * decision waits on the person).
 *
 * Pure. No DOM and no clock: `VexBars.tsx` hands it the time in seconds and
 * the frame's step, and paints what it returns.
 *
 *   - n = max(12, round(W / 22)) bars, 3 apart, each the strip's height;
 *   - each bar is white at 1.4% plus up to 55% by its level;
 *   - each level eases toward its mood's goal on a critically damped spring
 *     (stiffness 81, damping 18), a step never longer than 50ms;
 *   - the still frame is the goal at 4 s, settled.
 */

import type { VexState } from "./vex-state.js";

export type VexBarsMood = "ready" | "busy" | "approve";

/** The gap between two bars, in CSS px. */
export const VEX_BARS_GAP = 3;

/** A bar's alpha with no level, and how much a full level adds. */
export const VEX_BARS_FLOOR = 0.014;
export const VEX_BARS_RANGE = 0.55;

/** The longest step one frame may take, in seconds, so a stall resumes calmly. */
export const VEX_BARS_STEP_CAP_S = 0.05;

/** The time the still frame is drawn at, in seconds. */
export const VEX_BARS_STILL_S = 4;

/** The spring: critically damped (18 = 2 x sqrt(81)). */
const STIFFNESS = 81;
const DAMPING = 18;

/** The level every bar starts from. */
const START_LEVEL = 0.06;

/** Her mood for the bars, from her presence state. */
export function vexBarsMoodOf(state: VexState): VexBarsMood {
  switch (state) {
    case "thinking":
    case "working":
    case "waking":
      return "busy";
    case "awaiting":
      return "approve";
    default:
      return "ready";
  }
}

/** How many bars a strip `width` CSS px wide holds. */
export function vexBarCount(width: number): number {
  return Math.max(12, Math.round(width / 22));
}

/** A bar's alpha for its level, the level clamped to 0..1. */
export function vexBarAlpha(level: number): number {
  return VEX_BARS_FLOOR + Math.max(0, Math.min(1, level)) * VEX_BARS_RANGE;
}

/** Bar `i` of `n`'s goal for `mood` at `s` seconds (Cloud's `goalOf`). */
export function vexBarGoal(mood: VexBarsMood, s: number, i: number, n: number): number {
  const t = i / (n - 1);
  const w =
    Math.pow(0.5 + 0.5 * Math.sin(s * 1.6 - i * 0.32), 3) * 0.05 +
    Math.pow(0.5 + 0.5 * Math.sin(s * 0.7 + i * 0.13), 4) * 0.035;
  if (mood === "busy") {
    const phase = (s * 0.6) % 1.15;
    return t <= phase ? (phase - t < 0.04 ? 0.55 : 0.2 + w * 1.5) : 0.03 + w * 0.6;
  }
  if (mood === "approve") return 0.16 + 0.07 * (0.5 + 0.5 * Math.sin(s * 3.2 - i * 0.4));
  const sweep = (s * 0.16) % 1.25;
  return t <= sweep ? (sweep - t < 0.04 ? 0.32 : 0.12 + w * 0.6) : 0.02 + w * 0.3;
}

/** The bars' levels, eased toward their mood's goals. */
export class VexBarsModel {
  readonly count: number;
  readonly #levels: number[];
  readonly #speeds: number[];

  constructor(count: number) {
    this.count = count;
    this.#levels = Array.from({ length: count }, () => START_LEVEL);
    this.#speeds = Array.from({ length: count }, () => 0);
  }

  /** Each bar's level now. */
  levels(): readonly number[] {
    return this.#levels;
  }

  /** Ease every level toward its goal at `s` seconds over `dt` seconds (capped). */
  step(mood: VexBarsMood, s: number, dt: number): void {
    const h = Math.max(0, Math.min(VEX_BARS_STEP_CAP_S, dt));
    for (let i = 0; i < this.count; i += 1) {
      const goal = vexBarGoal(mood, s, i, this.count);
      const level = this.#levels[i] ?? START_LEVEL;
      const speed = this.#speeds[i] ?? 0;
      const pull = -DAMPING * speed - STIFFNESS * (level - goal);
      const next = speed + pull * h;
      this.#speeds[i] = next;
      this.#levels[i] = level + next * h;
    }
  }

  /** Put every level on its goal at `s` seconds, at rest: the still frame. */
  settle(mood: VexBarsMood, s: number): void {
    for (let i = 0; i < this.count; i += 1) {
      this.#levels[i] = vexBarGoal(mood, s, i, this.count);
      this.#speeds[i] = 0;
    }
  }
}
