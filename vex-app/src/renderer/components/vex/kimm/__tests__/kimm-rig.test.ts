/**
 * L kimm-rig (SK KIMM.md 6 and plates K06, K07; vex-home `kimm.js:43-107, 157-226`; the embed's fixes): her own motion
 * on a manual clock.
 *
 * Regressions this catches:
 * - a hand swap that goes through zero (the rest arm flashes) or misses its 340 ms (260 into crossed arms) and its
 *   650 ms hold;
 * - springs that diverge on a slow frame (the eye spring of `kimm.js` was unstable under 19.5 fps): the embed
 *   sub-steps at 1/60 s, so 12 fps converges with no overshoot;
 * - a hop off its measure (7 px up at about 96 ms, settled by 600 ms);
 * - reduced motion still moving her (values jump, no hop, no sway);
 * - idle acts during a run, or never at rest.
 *
 * Ported unchanged from VEX Cloud's `apps/web/src/components/kimm/kimm-rig.test.ts` (owner decision 2026-11-15). The
 * last case is desktop's: a mood pinned after its cue's event holds, as desktop's clock holds her still.
 */
import { describe, expect, test } from "vitest";
import { createKimmRig } from "../kimm-rig.js";

const HOST = { left: 0, top: 0, width: 432, height: 563 };

function clockAt(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Runs `ms` of frames of `step` ms each and returns the last frame. */
function run(
  rig: ReturnType<typeof createKimmRig>,
  clock: ReturnType<typeof clockAt>,
  ms: number,
  step = 1000 / 60,
) {
  let frame = rig.frame(HOST);
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    frame = rig.frame(HOST);
  }
  return frame;
}

describe("kimm-rig", () => {
  test("a hand swap is one crossfade: 340 ms into the pose, the other hands at zero, never two raised", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, random: () => 0 });
    rig.frame(HOST);
    rig.on("wait");
    const at = (ms: number) => {
      clock.advance(ms);
      return rig.frame(HOST).params;
    };
    const start = at(0);
    expect(start.get("T7")).toBe(0);
    const mid = at(170);
    expect(mid.get("T7")).toBeCloseTo(0.5, 6);
    const end = at(170);
    expect(end.get("T7")).toBe(1);
    for (const hand of ["T4", "T5", "T6", "T8"]) expect(end.get(hand)).toBe(0);
    expect(rig.state.mood).toBe("offer");
  });

  test("a pose holds 650 ms before the next swap; into crossed arms takes 260 ms", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false });
    rig.frame(HOST);
    rig.on("wait");
    run(rig, clock, 400);
    rig.on("refused");
    clock.advance(100);
    expect(rig.frame(HOST).params.get("T7")).toBe(1);
    clock.advance(170);
    rig.frame(HOST);
    clock.advance(130);
    const mid = rig.frame(HOST).params;
    expect(mid.get("T4")).toBeCloseTo(0.5, 6);
    expect((mid.get("T4") ?? 0) + (mid.get("T7") ?? 0)).toBeCloseTo(1, 6);
    clock.advance(130);
    const end = rig.frame(HOST).params;
    expect(end.get("T4")).toBe(1);
    expect(end.get("T7")).toBe(0);
    expect(end.get("E1")).toBeGreaterThan(0.5);
  });

  test("the springs converge without overshoot at 12 fps", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false, pointer: true });
    run(rig, clock, 100);
    rig.pointerMove(432 / 2 + 520, 563 * 0.18);
    let peak = 0;
    let frame = rig.frame(HOST);
    for (let i = 0; i < 48; i++) {
      clock.advance(83);
      frame = rig.frame(HOST);
      peak = Math.max(peak, frame.params.get("ParamEyeBallX") ?? 0);
    }
    expect(frame.params.get("ParamEyeBallX")).toBeCloseTo(0.9, 2);
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
    const angle = frame.params.get("ParamAngleX") ?? 0;
    expect(Math.abs(angle)).toBeLessThanOrEqual(30);
    expect(angle).toBeGreaterThan(20);
  });

  test("the hop after hi: about 7 px up near 96 ms, settled by 600 ms", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false });
    rig.frame(HOST);
    rig.on("hi");
    let lowest = 0;
    let lowestAt = 0;
    for (let t = 0; t <= 600; t += 4) {
      clock.advance(4);
      const { y } = rig.frame(HOST);
      if (y < lowest) {
        lowest = y;
        lowestAt = t + 4;
      }
    }
    expect(lowest).toBeLessThan(-6.5);
    expect(lowest).toBeGreaterThan(-8.5);
    expect(lowestAt).toBeGreaterThan(70);
    expect(lowestAt).toBeLessThan(130);
    expect(Math.abs(rig.frame(HOST).y)).toBeLessThan(0.6);
  });

  test("reduced motion: values jump and she never hops", () => {
    const clock = clockAt();
    const rig = createKimmRig({
      now: clock.now,
      idle: false,
      reducedMotion: true,
    });
    rig.frame(HOST);
    rig.on("hi");
    clock.advance(16);
    rig.frame(HOST);
    clock.advance(16);
    const frame = rig.frame(HOST);
    expect(frame.y).toBe(0);
    expect(frame.params.get("T8")).toBe(1);
    expect(frame.params.get("ParamEyeRSmile")).toBeCloseTo(0.9, 6);
    clock.advance(700);
    expect(rig.frame(HOST).y).toBe(0);
  });

  test("a timed mood returns to rest; idle acts start at rest after 5 s, never during a run", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, random: () => 0 });
    rig.frame(HOST);
    rig.on("request");
    run(rig, clock, 6000, 50);
    expect(rig.state).toMatchObject({ mood: "think", active: true, act: null });
    rig.on("done");
    run(rig, clock, 2900, 50);
    expect(rig.state.mood).toBe("rest");
    rig.on("idle");
    run(rig, clock, 4100, 50);
    expect(rig.state.act).toBe("scan");
  });

  test("the breath stays in its range and a raw parameter is drawn last", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false });
    rig.param("ParamAngleX", 12);
    for (let i = 0; i < 40; i++) {
      clock.advance(100);
      const { params } = rig.frame(HOST);
      const breath = params.get("ParamBreath") ?? -1;
      expect(breath >= 0 && breath <= 1).toBe(true);
      expect(params.get("ParamAngleX")).toBe(12);
    }
    rig.param("ParamAngleX", null);
    clock.advance(16);
    expect(rig.frame(HOST).params.get("ParamAngleX")).not.toBe(12);
  });

  test("a cue's event then its mood pinned: the gesture plays and the mood outlives the event's own hold", () => {
    const clock = clockAt();
    const rig = createKimmRig({ now: clock.now, idle: false });
    rig.frame(HOST);
    // desktop's signed: Cloud's `done` (the hop, v for 2800 ms), then v held with no end
    rig.on("done");
    rig.mood("v", 0);
    let lowest = 0;
    for (let t = 0; t < 400; t += 4) {
      clock.advance(4);
      lowest = Math.min(lowest, rig.frame(HOST).y);
    }
    expect(lowest).toBeLessThan(-6.5);
    run(rig, clock, 6000, 50);
    expect(rig.state.mood).toBe("v");
    expect(rig.frame(HOST).params.get("T8")).toBe(1);
  });
});
