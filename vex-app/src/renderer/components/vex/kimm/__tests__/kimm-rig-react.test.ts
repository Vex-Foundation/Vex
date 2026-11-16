/**
 * Her lock-screen reactions in the rig (`react()`, `KIMM_REACT`; owner decision 2026-11-15), on a manual clock.
 *
 * Regressions this catches:
 *   - typing that does not draw her gaze to the field, or never lets it go;
 *   - a shown password she still looks toward, with open eyes, or that an idle act interrupts;
 *   - a failed unlock without the head shake and the refused mood, a shake that never ends or leaves the clamp;
 *   - a successful unlock without the happy beat;
 *   - the hover tilt reaching the card's calm rig.
 */

import { describe, expect, test } from "vitest";
import { createKimmRig, KIMM_REACT } from "../kimm-rig.js";

const HOST = { left: 0, top: 0, width: 720, height: 900 };
/** Where the lock screen's field stands: right of her panel, a little under the middle. */
const FIELD = { x: 1080, y: 495 };

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
type Frame = ReturnType<Rig["frame"]>;

function run(rig: Rig, clock: ReturnType<typeof clockAt>, ms: number, each?: (frame: Frame) => void): Frame {
  let frame = rig.frame(HOST);
  for (let t = 0; t < ms; t += 33) {
    clock.advance(33);
    frame = rig.frame(HOST);
    each?.(frame);
  }
  return frame;
}

function lively(options: { idle?: boolean } = {}) {
  const clock = clockAt();
  const rig = createKimmRig({ now: clock.now, lively: true, idle: options.idle ?? false, random: () => 0 });
  rig.frame(HOST);
  return { clock, rig };
}

describe("her lock-screen reactions", () => {
  test("typing: her gaze goes to the field, then home once the keys stop", () => {
    const { clock, rig } = lively();
    rig.react("typing", FIELD);
    const looking = run(rig, clock, 800);
    expect(looking.params.get("ParamEyeBallX") ?? 0).toBeGreaterThan(0.6);
    // keys keep it there
    rig.react("typing", FIELD);
    expect(run(rig, clock, 800).params.get("ParamEyeBallX") ?? 0).toBeGreaterThan(0.6);
    // quiet for longer than its hold: back to centre
    const home = run(rig, clock, KIMM_REACT.typingLookMs + 1500);
    expect(Math.abs(home.params.get("ParamEyeBallX") ?? 1)).toBeLessThan(0.2);
  });

  test("typing holds her idle acts back", () => {
    const { clock, rig } = lively({ idle: true });
    for (let i = 0; i < 10; i += 1) {
      rig.react("typing", FIELD);
      run(rig, clock, 500);
      expect(rig.state.act).toBeNull();
    }
  });

  test("shown: she looks away with her eyes nearly shut and plays no act until hidden", () => {
    const { clock, rig } = lively({ idle: true });
    rig.react("shown");
    expect(rig.state.averted).toBe(true);
    let frame = run(rig, clock, 6000, () => {
      expect(rig.state.act).toBeNull();
    });
    // away from the field, which stands to her right
    expect(frame.params.get("ParamEyeBallX") ?? 0).toBeLessThan(-0.6);
    expect(frame.shut).toBeGreaterThan(0.8);
    // typing while shown does not turn her back toward it
    rig.react("typing", FIELD);
    frame = run(rig, clock, 600);
    expect(frame.params.get("ParamEyeBallX") ?? 0).toBeLessThan(-0.6);
    rig.react("hidden");
    frame = run(rig, clock, 1500);
    expect(rig.state.averted).toBe(false);
    expect(frame.shut).toBeLessThan(0.05);
    expect(Math.abs(frame.params.get("ParamEyeBallX") ?? 1)).toBeLessThan(0.2);
  });

  test("failed: a short head shake inside the clamp, and her refused mood", () => {
    const { clock, rig } = lively();
    run(rig, clock, 1000);
    const before = rig.frame(HOST).params.get("ParamAngleX") ?? 0;
    rig.react("failed");
    expect(rig.state.mood).toBe("no");
    let swing = 0;
    let signs = new Set<number>();
    run(rig, clock, KIMM_REACT.shakeMs, (frame) => {
      const x = (frame.params.get("ParamAngleX") ?? 0) - before;
      expect(Math.abs(frame.params.get("ParamAngleX") ?? 0)).toBeLessThanOrEqual(30);
      swing = Math.max(swing, Math.abs(x));
      if (Math.abs(x) > 3) signs.add(Math.sign(x));
    });
    expect(swing).toBeGreaterThan(6);
    expect(swing).toBeLessThanOrEqual(KIMM_REACT.shakeDeg + 2);
    expect(signs.size).toBe(2);
    // over: no shake left
    signs = new Set();
    const after = run(rig, clock, 600);
    expect(Math.abs((after.params.get("ParamAngleX") ?? 0) - before)).toBeLessThan(4);
  });

  test("unlocked: the happy beat, her V sign and a hop", () => {
    const { clock, rig } = lively();
    rig.react("shown");
    rig.react("unlocked");
    expect(rig.state.averted).toBe(false);
    expect(rig.state.mood).toBe("v");
    let lowest = 0;
    run(rig, clock, 400, (frame) => {
      lowest = Math.min(lowest, frame.y);
    });
    expect(lowest).toBeLessThan(-6);
    expect(rig.frame(HOST).params.get("T8")).toBe(1);
  });

  test("a pointer resting over her tilts her head on the lock screen, never in the calm card", () => {
    // two rigs on one clock, one hovered: the same sway, so the difference is the tilt alone
    const tilt = (isLively: boolean) => {
      const clock = clockAt();
      const make = () => createKimmRig({ now: clock.now, lively: isLively, idle: false, pointer: false });
      const plain = make();
      const hovered = make();
      hovered.hover(true);
      let last = 0;
      for (let t = 0; t < 3000; t += 33) {
        clock.advance(33);
        const a = plain.frame(HOST).params.get("ParamAngleZ") ?? 0;
        const b = hovered.frame(HOST).params.get("ParamAngleZ") ?? 0;
        last = b - a;
      }
      return last;
    };
    expect(tilt(true)).toBeGreaterThan(3);
    expect(Math.abs(tilt(false))).toBeLessThan(1.5);
  });
});
