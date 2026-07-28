/**
 * PROLOGUE CHOREOGRAPHY — the act boundaries, as plain functions.
 *
 * Three acts plus a settle, driven entirely by elapsed milliseconds so the
 * whole timeline is testable without a canvas or a clock:
 *
 *   I  FIELD     — the mark's particles scattered across the WHOLE window as
 *                  a star field; one slow cobalt arc sweeps the screen.
 *   II GLOBE     — the stars converge into a slowly rotating sphere of points
 *                  (fibonacci lattice, orthographic projection, Y rotation).
 *   III SIGNATURE— the sphere breaks orbit onto the monogram letterforms at
 *                  hero scale, with a specular glint travelling across them.
 *   SETTLE       — the assembled mark shrinks into the VexLoader ring slot
 *                  while the real hold content crossfades in over it.
 *
 * The full timeline's boundaries are the owner's: 0–0.8s, 0.8–2.2s,
 * 2.2–3.5s (the settle is the tail of act III, not a fourth beat on screen).
 * The condensed variant drops the field and the globe entirely and keeps the
 * assembly + glint + a small settle, which is close to the gate's original
 * behavior.
 */

import type { ProloguePlay } from "./prologue-policy.js";

export type PrologueAct = "field" | "globe" | "signature" | "settle" | "done";

export interface PrologueTimeline {
  readonly fieldMs: number;
  readonly globeMs: number;
  readonly signatureMs: number;
  readonly settleMs: number;
  /** Sum of the four acts — the prologue's total floor on the reveal. */
  readonly totalMs: number;
}

/** Owner's cinematic timing: acts end at 0.8s, 2.2s and 3.5s. */
export const FULL_TIMELINE: PrologueTimeline = {
  fieldMs: 800,
  globeMs: 1400,
  signatureMs: 900,
  settleMs: 400,
  totalMs: 3500,
};

/** ~1.2s: assembly + glint + a small settle, no star field, no globe. */
export const CONDENSED_TIMELINE: PrologueTimeline = {
  fieldMs: 0,
  globeMs: 0,
  signatureMs: 900,
  settleMs: 300,
  totalMs: 1200,
};

export function timelineFor(play: Exclude<ProloguePlay, "none">): PrologueTimeline {
  return play === "full" ? FULL_TIMELINE : CONDENSED_TIMELINE;
}

/** Cumulative act ends, in order. */
function boundaries(timeline: PrologueTimeline): {
  readonly fieldEnd: number;
  readonly globeEnd: number;
  readonly signatureEnd: number;
  readonly settleEnd: number;
} {
  const fieldEnd = timeline.fieldMs;
  const globeEnd = fieldEnd + timeline.globeMs;
  const signatureEnd = globeEnd + timeline.signatureMs;
  return {
    fieldEnd,
    globeEnd,
    signatureEnd,
    settleEnd: signatureEnd + timeline.settleMs,
  };
}

/**
 * Which act is on screen at `elapsedMs`. Zero-length acts are skipped by
 * construction (a `< end` test can never match when the act has no width),
 * which is what makes the condensed timeline reuse this untouched.
 */
export function actAt(
  timeline: PrologueTimeline,
  elapsedMs: number,
): PrologueAct {
  const { fieldEnd, globeEnd, signatureEnd, settleEnd } = boundaries(timeline);
  if (elapsedMs < fieldEnd) return "field";
  if (elapsedMs < globeEnd) return "globe";
  if (elapsedMs < signatureEnd) return "signature";
  if (elapsedMs < settleEnd) return "settle";
  return "done";
}

/**
 * The act plus normalised progress WITHIN it (0…1). `done` always reports 1.
 * A zero-length act can never be reported, so `t` never divides by zero.
 */
export function actProgress(
  timeline: PrologueTimeline,
  elapsedMs: number,
): { readonly act: PrologueAct; readonly t: number } {
  const act = actAt(timeline, elapsedMs);
  const { fieldEnd, globeEnd, signatureEnd } = boundaries(timeline);
  const spans: Record<PrologueAct, { start: number; length: number }> = {
    field: { start: 0, length: timeline.fieldMs },
    globe: { start: fieldEnd, length: timeline.globeMs },
    signature: { start: globeEnd, length: timeline.signatureMs },
    settle: { start: signatureEnd, length: timeline.settleMs },
    done: { start: 0, length: 0 },
  };
  const span = spans[act];
  if (act === "done" || span.length <= 0) return { act, t: 1 };
  const t = (elapsedMs - span.start) / span.length;
  return { act, t: t < 0 ? 0 : t > 1 ? 1 : t };
}

/**
 * Opacity of the REAL hold content (VexLoader + VexSigil) at `elapsedMs`.
 *
 * The hold content is mounted underneath from t=0 at opacity 0 — invisible,
 * but mounted, so VexSigil runs its own ~1.4s assembly during the prologue
 * and is already settled (and shimmering) when this crossfade reveals it.
 * That is what stops the handoff from showing a second, smaller assembly.
 */
export function holdOpacityAt(
  timeline: PrologueTimeline,
  elapsedMs: number,
): number {
  const { signatureEnd, settleEnd } = boundaries(timeline);
  if (elapsedMs <= signatureEnd) return 0;
  if (elapsedMs >= settleEnd) return 1;
  return (elapsedMs - signatureEnd) / timeline.settleMs;
}
