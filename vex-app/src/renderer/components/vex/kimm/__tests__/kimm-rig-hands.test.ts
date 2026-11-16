/**
 * The "ghost arm" fix (owner decision 2026-11-15): her hand swap is a cut, never a crossfade (`kimmHandBlend`,
 * `KIMM_HAND_CUT` in `kimm-rig.ts`). On the shipped model a hand toggle between 0 and 1 draws the old and the new arm
 * both see-through, so no frame may hold one there.
 *
 * Regressions this catches:
 *   - a blend that returns anything but 0 or 1, or cuts away from the middle of the leg;
 *   - any frame, in any mood, idle act, event or frame rate, the card's calm rig or the lock screen's lively one, where
 *     a hand toggle sits between 0 and 1 or two are raised at once.
 */

import { describe, expect, test } from "vitest";
import { createKimmRig, KIMM_HAND_CUT, kimmHandBlend } from "../kimm-rig.js";
import { KIMM_EVENTS, KIMM_HANDS } from "../kimm-live-moods.js";

const HOST = { left: 0, top: 0, width: 720, height: 900 };

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("her hand swap", () => {
  test("is a cut at the middle of the leg: 0 before, 1 from there, nothing between", () => {
    expect(KIMM_HAND_CUT).toBe(0.5);
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const blend = kimmHandBlend(u);
      expect(blend === 0 || blend === 1).toBe(true);
      expect(blend).toBe(u >= 0.5 ? 1 : 0);
    }
  });

  for (const [label, lively, step] of [
    ["the card's calm rig at 60 fps", false, 1000 / 60],
    ["the lock screen's lively rig at 30 fps", true, 1000 / 30],
    ["a stalled window at 7 fps", true, 140],
  ] as const) {
    test(`never draws two arms: ${label}`, () => {
      let now = 1000;
      const random = seeded(11);
      const rig = createKimmRig({ now: () => now, random, lively });
      const events = KIMM_EVENTS.filter((event) => event !== "say");
      let frames = 0;
      for (let t = 0; t < 120_000; t += step) {
        now += step;
        // an event every few seconds, so swaps start from every pose
        if (Math.floor(t / 2300) !== Math.floor((t - step) / 2300)) {
          const event = events[Math.floor(random() * events.length)];
          if (event !== undefined) rig.on(event);
        }
        const { params } = rig.frame(HOST);
        let raised = 0;
        for (const hand of KIMM_HANDS) {
          const value = params.get(hand) ?? 0;
          expect(value === 0 || value === 1, `${hand} ${String(value)} at ${String(t)}`).toBe(true);
          raised += value;
        }
        expect(raised).toBeLessThanOrEqual(1);
        frames += 1;
      }
      expect(frames).toBeGreaterThan(800);
    });
  }
});
