/**
 * THE VEXING LOOP — its choreography, as pure arithmetic.
 *
 * The scene is a THIRD consumer of the shared sigil sampler (after `VexSigil`
 * and the setup gate's prologue), and it is the only one that never ends: the
 * mark assembles, holds, disperses, and does it again for as long as Vex has
 * produced nothing to read. Splitting the act boundaries out here — the same
 * split `gate-prologue/prologue-phases.ts` uses — means the cadence is one
 * table a tuning round can change in one line, and every frame decision is
 * testable without a canvas or a clock.
 *
 * `phaseAt` is TOTAL by construction: it wraps the elapsed value into the
 * cycle and clamps a negative one (a clock skew) to the first frame, so the
 * draw loop can never be handed an undefined phase and freeze the mark
 * half-formed.
 */

export type VexingPhase = "assemble" | "hold" | "disperse" | "gap";

export interface VexingCycle {
  /** Flight home on the landing Out curve (VexSigil's own ASSEMBLE_MS). */
  readonly assembleMs: number;
  /** The mark rests, fully formed. */
  readonly holdMs: number;
  /** Flight back out to the scatter seats, on the In curve. */
  readonly disperseMs: number;
  /** Empty beat before the next assembly — the breath in the loop. */
  readonly gapMs: number;
  readonly cycleMs: number;
}

const ASSEMBLE_MS = 1400;
const HOLD_MS = 900;
const DISPERSE_MS = 900;
const GAP_MS = 120;

/** ~3.3s per revolution — "soft", per the owner's brief. */
export const VEXING_CYCLE: VexingCycle = {
  assembleMs: ASSEMBLE_MS,
  holdMs: HOLD_MS,
  disperseMs: DISPERSE_MS,
  gapMs: GAP_MS,
  cycleMs: ASSEMBLE_MS + HOLD_MS + DISPERSE_MS + GAP_MS,
};

export interface VexingFrame {
  readonly phase: VexingPhase;
  /** Normalised progress within the phase, in [0,1). */
  readonly t: number;
}

const ACTS: ReadonlyArray<readonly [VexingPhase, (c: VexingCycle) => number]> = [
  ["assemble", (c) => c.assembleMs],
  ["hold", (c) => c.holdMs],
  ["disperse", (c) => c.disperseMs],
  ["gap", (c) => c.gapMs],
];

export function phaseAt(cycle: VexingCycle, elapsedMs: number): VexingFrame {
  if (!(elapsedMs > 0) || cycle.cycleMs <= 0) {
    return { phase: "assemble", t: 0 };
  }
  let remaining = elapsedMs % cycle.cycleMs;
  for (const [phase, span] of ACTS) {
    const duration = span(cycle);
    // A zero-length act has an empty range and can never be reported.
    if (remaining < duration) return { phase, t: remaining / duration };
    remaining -= duration;
  }
  // Unreachable while the acts sum to `cycleMs`; the honest fallback is the
  // first frame rather than an undefined phase.
  return { phase: "assemble", t: 0 };
}
