/**
 * The vexing loop's choreography, tested without a canvas or a clock.
 *
 * The invariant that matters: `phaseAt` is TOTAL. Every elapsed value — before
 * the loop started, mid-cycle, past the wrap, negative after a clock skew —
 * lands on exactly one phase with a progress inside [0,1], so the draw loop
 * can never be handed an undefined phase and freeze the mark half-formed.
 */

import { describe, expect, it } from "vitest";
import { VEXING_CYCLE, phaseAt, type VexingPhase } from "../phases.js";

const C = VEXING_CYCLE;

describe("VEXING_CYCLE", () => {
  it("is the sum of its four acts and every act is positive", () => {
    expect(C.assembleMs).toBeGreaterThan(0);
    expect(C.holdMs).toBeGreaterThan(0);
    expect(C.disperseMs).toBeGreaterThan(0);
    expect(C.gapMs).toBeGreaterThan(0);
    expect(C.cycleMs).toBe(
      C.assembleMs + C.holdMs + C.disperseMs + C.gapMs,
    );
  });
});

describe("phaseAt", () => {
  it("opens each act at its own boundary with t = 0", () => {
    const boundaries: ReadonlyArray<readonly [number, VexingPhase]> = [
      [0, "assemble"],
      [C.assembleMs, "hold"],
      [C.assembleMs + C.holdMs, "disperse"],
      [C.assembleMs + C.holdMs + C.disperseMs, "gap"],
    ];
    for (const [elapsed, phase] of boundaries) {
      expect(phaseAt(C, elapsed)).toEqual({ phase, t: 0 });
    }
  });

  it("reports progress strictly inside [0,1) within an act", () => {
    for (let ms = 0; ms < C.cycleMs; ms += 37) {
      const at = phaseAt(C, ms);
      expect(at.t).toBeGreaterThanOrEqual(0);
      expect(at.t).toBeLessThan(1);
    }
  });

  it("wraps: one full cycle later is the same frame", () => {
    for (const ms of [0, 10, C.assembleMs + 5, C.cycleMs - 1]) {
      expect(phaseAt(C, C.cycleMs + ms)).toEqual(phaseAt(C, ms));
      expect(phaseAt(C, C.cycleMs * 4 + ms)).toEqual(phaseAt(C, ms));
    }
  });

  it("clamps a negative elapsed to the loop's first frame — a clock skew never blanks the mark", () => {
    expect(phaseAt(C, -1)).toEqual({ phase: "assemble", t: 0 });
    expect(phaseAt(C, -C.cycleMs * 3)).toEqual({ phase: "assemble", t: 0 });
  });

  it("never reports a zero-length act", () => {
    const noHold = { ...C, holdMs: 0, cycleMs: C.cycleMs - C.holdMs };
    for (let ms = 0; ms < noHold.cycleMs; ms += 13) {
      expect(phaseAt(noHold, ms).phase).not.toBe("hold");
    }
  });
});
