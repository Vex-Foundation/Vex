/**
 * Her live moods (`kimm-live-moods.ts`): VEX Cloud's mood table and event table, ported from its
 * `apps/web/src/components/kimm/kimm-moods.test.ts` (owner decision 2026-11-15), and desktop's bridge from the mood
 * of her still to the live figure.
 *
 * Regressions this catches:
 *   - a mood that sets two hands (the rig crossfades one pose; two toggles flash the rest arm);
 *   - an event that starts the wrong mood or holds it for the wrong time (done 2800, refused 3400, hi 1800, spam
 *     1600, nudge 2200);
 *   - a still mood the live figure does not draw, or draws as another still's pose (Cloud's `stillOfMood` read
 *     backwards: approve's `sign` shows offer's still, so desktop never asks for `sign`; signed is `v`, refused `no`);
 *   - held drawn by anything but offer's pose, as held's still is offer's.
 */

import { describe, expect, test } from "vitest";
import { KIMM_ART_MOOD, KIMM_MOODS } from "../kimm-assets.js";
import {
  KIMM_EVENT_MOOD,
  KIMM_EVENTS,
  KIMM_HANDS,
  KIMM_LIVE_CUE,
  KIMM_LIVE_MOODS,
  type KimmLiveMood,
} from "../kimm-live-moods.js";

/** Cloud's `stillOfMood`: the still nearest to a live mood. */
const STILL_OF: Readonly<Record<KimmLiveMood, string>> = {
  think: "think",
  point: "offer",
  offer: "offer",
  sign: "offer",
  v: "signed",
  no: "refused",
  hi: "hi",
  rest: "rest",
  oops: "rest",
};

describe("kimm-live-moods", () => {
  test("each mood raises at most one hand", () => {
    for (const [mood, rig] of Object.entries(KIMM_LIVE_MOODS)) {
      const raised = KIMM_HANDS.filter((hand) => (rig[hand as keyof typeof rig] ?? 0) > 0);
      expect({ mood, many: raised.length > 1 }).toEqual({ mood, many: false });
    }
    expect(KIMM_LIVE_MOODS.offer).toEqual({ T7: 1, form: 0.7, smile: 0.5 });
    expect(KIMM_LIVE_MOODS.no).toEqual({ T4: 1, E1: 1, FeceAngry: 0.5, form: -0.8 });
  });

  test("the event table: the mood each event starts and how long it holds", () => {
    expect(KIMM_EVENT_MOOD).toEqual({
      request: { mood: "think", ms: 0 },
      propose: { mood: "rest", ms: 0 },
      wait: { mood: "offer", ms: 0 },
      approve: { mood: "sign", ms: 0 },
      done: { mood: "v", ms: 2800 },
      refused: { mood: "no", ms: 3400 },
      hi: { mood: "hi", ms: 1800 },
      idle: { mood: "rest", ms: 0 },
      spam: { mood: "oops", ms: 1600 },
      nudge: { mood: "offer", ms: 2200 },
    });
    expect(KIMM_EVENTS).toContain("say");
  });

  test("every still mood has a cue whose live mood draws that still's own pose", () => {
    expect(Object.keys(KIMM_LIVE_CUE).sort()).toEqual([...KIMM_MOODS].sort());
    for (const mood of KIMM_MOODS) {
      const cue = KIMM_LIVE_CUE[mood];
      expect({ mood, still: STILL_OF[cue.mood] }).toEqual({ mood, still: KIMM_ART_MOOD[mood] });
    }
  });

  test("each cue's event starts the mood the cue then holds", () => {
    for (const mood of KIMM_MOODS) {
      const cue = KIMM_LIVE_CUE[mood];
      expect({ mood, starts: KIMM_EVENT_MOOD[cue.event]?.mood }).toEqual({ mood, starts: cue.mood });
    }
  });

  test("the six drawn moods map to six different live poses, held sharing offer's", () => {
    expect(KIMM_LIVE_CUE.held).toEqual(KIMM_LIVE_CUE.offer);
    expect(KIMM_LIVE_CUE.signed).toEqual({ event: "done", mood: "v" });
    expect(KIMM_LIVE_CUE.refused).toEqual({ event: "refused", mood: "no" });
    const poses = new Set(KIMM_MOODS.filter((mood) => mood !== "held").map((mood) => KIMM_LIVE_CUE[mood].mood));
    expect(poses.size).toBe(6);
  });
});
