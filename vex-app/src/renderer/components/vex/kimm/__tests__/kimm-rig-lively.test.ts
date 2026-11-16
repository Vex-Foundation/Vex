/**
 * The lock screen's lively mode of her rig (`KIMM_LIVELY`, owner decision 2026-11-15: "never standing still"), on a
 * manual clock, beside Cloud's calm rig it must leave unchanged.
 *
 * Regressions this catches:
 *   - the Vex card turning lively (the mode must be off unless asked);
 *   - a lively rig that still waits Cloud's 5 s and 3.5 to 7 s between idle acts;
 *   - a bounce that jitters or grows past its 2.4 px, or a sway that leaves the angle clamps;
 *   - her gaze that never comes home: lively, she follows a pointer still for under 3 s, then eases back to centre,
 *     and at once when the pointer leaves the window; the eyes and head never pass their limits;
 *   - reduced motion that still bobs or sways.
 */

import { describe, expect, test } from "vitest";
import { createKimmRig, KIMM_LIVELY } from "../kimm-rig.js";

const HOST = { left: 0, top: 0, width: 720, height: 900 };

function clockAt(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Rig = ReturnType<typeof createKimmRig>;

/** Steps `ms` in 33 ms frames (30 fps), calling `each` on every frame. */
function run(rig: Rig, clock: ReturnType<typeof clockAt>, ms: number, each?: (frame: ReturnType<Rig["frame"]>) => void) {
  let frame = rig.frame(HOST);
  for (let t = 0; t < ms; t += 33) {
    clock.advance(33);
    frame = rig.frame(HOST);
    each?.(frame);
  }
  return frame;
}

/** How many idle acts start in `ms`. */
function actsIn(rig: Rig, clock: ReturnType<typeof clockAt>, ms: number): number {
  let count = 0;
  let previous: string | null = null;
  run(rig, clock, ms, () => {
    const act = rig.state.act;
    if (act !== null && act !== previous) count += 1;
    previous = act;
  });
  return count;
}

describe("her rig's lively mode", () => {
  test("is off unless asked: Cloud's calm rig waits 5 s for her first idle act", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, random: () => 0 });
    expect(rig.state.lively).toBe(false);
    run(rig, clock, 4800);
    expect(rig.state.act).toBeNull();
  });

  test("plays her first idle act after 2 s and the next ones far more often", () => {
    const clock = clockAt();
    const lively = createKimmRig({ now: clock.now, random: () => 0.5, lively: true });
    run(lively, clock, KIMM_LIVELY.firstActMs + 100);
    expect(lively.state.act).not.toBeNull();
    const livelyClock = clockAt();
    const calmClock = clockAt();
    const busy = actsIn(createKimmRig({ now: livelyClock.now, random: () => 0.5, lively: true }), livelyClock, 30_000);
    const calm = actsIn(createKimmRig({ now: calmClock.now, random: () => 0.5 }), calmClock, 30_000);
    expect(busy).toBeGreaterThan(calm);
    expect(busy).toBeGreaterThanOrEqual(5);
  });

  test("switched on later, brings her next act forward", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, random: () => 0 });
    run(rig, clock, 500);
    rig.lively(true);
    expect(rig.state.lively).toBe(true);
    run(rig, clock, KIMM_LIVELY.firstActMs + 100);
    expect(rig.state.act).not.toBeNull();
  });

  test("bounces gently with her breath: up to 2.4 px, smoothly, never down", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, lively: true });
    let lowest = 0;
    let highest = -Infinity;
    let biggestStep = 0;
    let last: number | null = null;
    run(rig, clock, 7000, (frame) => {
      lowest = Math.min(lowest, frame.y);
      highest = Math.max(highest, frame.y);
      if (last !== null) biggestStep = Math.max(biggestStep, Math.abs(frame.y - last));
      last = frame.y;
    });
    expect(lowest).toBeLessThan(-2.2);
    expect(lowest).toBeGreaterThanOrEqual(-KIMM_LIVELY.bobPx - 1e-9);
    expect(highest).toBeLessThanOrEqual(1e-9);
    // at 30 fps a step is a fraction of a pixel: a bob, not a jitter
    expect(biggestStep).toBeLessThan(0.25);
    const calmClock = clockAt();
    const calm = createKimmRig({ now: calmClock.now, idle: false });
    run(calm, calmClock, 7000, (frame) => expect(frame.y).toBe(0));
  });

  test("sways more than the calm rig, inside the angle clamps", () => {
    const peak = (lively: boolean) => {
      const clock = clockAt();
      const rig = createKimmRig({ now: clock.now, idle: false, pointer: false, lively });
      let most = 0;
      run(rig, clock, 30_000, (frame) => {
        const z = Math.abs(frame.params.get("ParamAngleZ") ?? 0);
        const x = frame.params.get("ParamAngleX") ?? 0;
        expect(Math.abs(x)).toBeLessThanOrEqual(30);
        most = Math.max(most, z);
      });
      return most;
    };
    const calm = peak(false);
    const lively = peak(true);
    expect(lively).toBeGreaterThan(calm * 1.4);
  });

  test("looks toward the pointer within her limits, and eases home after 3 s of a still pointer", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, lively: true });
    rig.frame(HOST);
    // far to the right and above: the eyes and head clamp, never pass their limits
    rig.pointerMove(5000, -3000);
    let frame = run(rig, clock, 1500);
    expect(frame.params.get("ParamEyeBallX")).toBeCloseTo(0.9, 2);
    expect(frame.params.get("ParamEyeBallY")).toBeCloseTo(0.8, 2);
    expect(frame.params.get("ParamAngleX") ?? 0).toBeLessThanOrEqual(30);
    // still for 3 s: she lets it go and her eyes come back toward centre on their springs
    frame = run(rig, clock, KIMM_LIVELY.lookHoldMs + 1500);
    expect(Math.abs(frame.params.get("ParamEyeBallX") ?? 1)).toBeLessThan(0.2);
    // calm (the card) keeps Cloud's 5 s
    const calmClock = clockAt();
    const calm = createKimmRig({ now: calmClock.now, idle: false });
    calm.frame(HOST);
    calm.pointerMove(5000, 100);
    expect(run(calm, calmClock, 4000).params.get("ParamEyeBallX")).toBeCloseTo(0.9, 2);
  });

  test("eases home at once when the pointer leaves the window", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, lively: true });
    rig.frame(HOST);
    rig.pointerMove(5000, 160);
    expect(run(rig, clock, 1000).params.get("ParamEyeBallX")).toBeCloseTo(0.9, 2);
    rig.pointerAway();
    expect(Math.abs(run(rig, clock, 1200).params.get("ParamEyeBallX") ?? 1)).toBeLessThan(0.2);
  });

  test("under reduced motion she neither bobs nor sways", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, pointer: false, lively: true, reducedMotion: true });
    run(rig, clock, 5000, (frame) => {
      expect(frame.y).toBe(0);
    });
  });

  test("caps her ticker at 30 fps", () => {
    expect(KIMM_LIVELY.fps).toBe(30);
  });
});
