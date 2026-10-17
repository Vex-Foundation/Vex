/**
 * K2's poses in the app (`k2-poses.ts`), without a canvas. Regressions this catches: an emotion on
 * the wrong drawing, eyes, mouth or look (the finger on her chin, the narrowed focus, the palm
 * toward the conversation, the grin and peace sign, the worried frown, the pout looking away,
 * asleep); a change that jumps instead of the 300 ms dissolve, eyes and mouth that switch before
 * its half, a hand that pops instead of rising (500 ms) or sinking (350 ms); an emotion that
 * settles before its hand is up; an idle gesture during approval, working or error; a sleep that
 * does not lower and dim her in whole steps of two rows or keeps moving once settled; a wake out
 * of sleep that skips its beats or never hands her back to idle; reduced motion that animates; and
 * a face that is not a pure function of the change and the clock.
 */
import { describe, expect, test } from "vitest";
import { K2_EMOTIONS, type K2Emotion } from "../k2-emotion.js";
import {
  HAND_RISE,
  HAND_SINK,
  MOOD_DISSOLVE,
  MOOD_MAPS,
  MOOD_POSES,
  type MoodRig,
  moodFace,
  SLEEP,
  WAKE_FACE,
  WAKE_FROM_YAWN,
} from "../k2-poses.js";

const RIG: MoodRig = {
  rise: 34,
  pitch: 3,
  k: 1,
  glance: { x: 277.9, y: 209.2 },
  still: false,
};
const STILL: MoodRig = { ...RIG, still: true };
const T = 100_000;
/** The face `age` ms after a change. */
const at = (from: K2Emotion, to: K2Emotion, age: number, rig = RIG) =>
  moodFace({ from, to, at: T - age }, T, rig);
/** Settled in a mood (the change long past). */
const settled = (to: K2Emotion, rig = RIG) => at("idle", to, 1e6, rig);

describe("the moods", () => {
  test("the ten emotions, and the app drawings they use", () => {
    expect(K2_EMOTIONS).toEqual([
      "idle",
      "listening",
      "thinking",
      "working",
      "approval",
      "done",
      "concerned",
      "error",
      "sleeping",
      "waking",
    ]);
    for (const m of Object.values(MOOD_POSES))
      if (m.map !== "base") expect(MOOD_MAPS).toContain(m.map);
    // the wake's own drawings come with the moods
    expect(MOOD_MAPS).toEqual(
      expect.arrayContaining(["asleep", "yawn", "rub"]),
    );
  });

  test("each emotion shows its pose: drawing, eyes, mouth and look", () => {
    const show = (m: K2Emotion) => {
      const f = settled(m);
      return [f.face.map, f.face.eyes, f.face.mouth, f.look];
    };
    expect(show("idle")).toEqual([null, null, null, "free"]);
    expect(show("listening")).toEqual([null, "open", "calm", "composer"]);
    expect(show("thinking")).toEqual(["think", "open", "calm", "upSide"]);
    expect(show("working")).toEqual(["focus", "narrow", "calm", "work"]);
    expect(show("approval")).toEqual(["approve", "wide", "rest", "you"]);
    expect(show("done")).toEqual(["hover", "smile", "none", "you"]);
    expect(show("concerned")).toEqual(["concern", "worried", "frown", "you"]);
    expect(show("error")).toEqual(["pout", "half", "pout", "aside"]);
    expect(show("sleeping")).toEqual(["asleep", "map", "none", "free"]);
    // asleep the drawing carries its own face: no nose mark
    expect(settled("sleeping").face.nose).toBe(false);
  });

  test("the finger, the palm and the peace sign rise out of her light and stay up", () => {
    for (const m of ["thinking", "approval", "done"] as const) {
      const f = settled(m).face;
      expect(f.hand).toEqual({ map: f.map ?? "base", rise: 0, di: 0, p: 1 });
    }
    for (const m of ["listening", "working", "concerned", "error"] as const)
      expect(settled(m).face.hand).toBeNull();
  });
});

describe("a change", () => {
  test("dissolves in 300 ms from the drawing it leaves, the eyes and mouth switching at its half", () => {
    const start = at("working", "concerned", 0);
    expect(start.face.map).toBe("concern");
    expect(start.face.gp).toBe(0);
    expect(start.face.from).toEqual({ map: "focus", hand: null });
    expect(start.face.eyes).toBe("narrow");
    const before = at("working", "concerned", MOOD_DISSOLVE / 2 - 10);
    expect(before.face.eyes).toBe("narrow");
    expect(before.face.mouth).toBe("calm");
    const after = at("working", "concerned", MOOD_DISSOLVE / 2 + 10);
    expect(after.face.eyes).toBe("worried");
    expect(after.face.mouth).toBe("frown");
    expect(after.face.gp).toBeCloseTo(160 / 300, 5);
    const done = at("working", "concerned", MOOD_DISSOLVE);
    expect(done.face.gp).toBe(1);
    expect(done.face.from).toBeNull();
    expect(done.settled).toBe(true);
  });

  test("a new hand rises over 500 ms; the old one sinks over 350 ms", () => {
    expect(at("idle", "approval", 0).face.hand?.rise).toBe(34);
    expect(at("idle", "approval", HAND_RISE / 2).face.hand?.rise).toBe(4);
    expect(at("idle", "approval", HAND_RISE).face.hand?.rise).toBe(0);
    // the palm leaves as the finger comes: the palm sinks, then is gone with the dissolve
    const mid = at("approval", "thinking", 100);
    expect(mid.face.from?.map).toBe("approve");
    expect(mid.face.from?.hand?.rise).toBe(
      Math.round((100 / HAND_SINK) ** 2 * 34),
    );
    expect(mid.face.hand?.map).toBe("think");
    expect(at("approval", "thinking", MOOD_DISSOLVE).face.from).toBeNull();
  });

  test("settles only once the dissolve is done and the hand is up", () => {
    expect(at("idle", "working", MOOD_DISSOLVE - 1).settled).toBe(false);
    expect(at("idle", "working", MOOD_DISSOLVE).settled).toBe(true);
    expect(at("idle", "approval", MOOD_DISSOLVE).settled).toBe(false);
    expect(at("idle", "approval", HAND_RISE).settled).toBe(true);
  });

  test("back to idle ends on her own face, the plain drawing", () => {
    const back = at("thinking", "idle", 100);
    expect(back.face.map).toBe("base");
    expect(back.face.from?.map).toBe("think");
    const rest = at("thinking", "idle", MOOD_DISSOLVE);
    expect(rest.face.map).toBeNull();
    expect(rest.face.gp).toBe(0);
    expect(rest.settled).toBe(true);
  });

  test("the idle pool plays only in idle, settled: never in approval, working or error", () => {
    expect(settled("idle").gestures).toBe(true);
    expect(at("approval", "idle", 100).gestures).toBe(false);
    for (const m of K2_EMOTIONS)
      if (m !== "idle" && m !== "waking")
        expect(settled(m).gestures).toBe(false);
  });

  test("reduced motion settles at once", () => {
    const f = at("idle", "approval", 0, STILL);
    expect(f.face.gp).toBe(1);
    expect(f.face.hand?.rise).toBe(0);
    expect(f.face.from).toBeNull();
    expect(f.settled).toBe(true);
  });
});

describe("sleep and the wake", () => {
  test("asleep she lowers in whole steps of two rows and dims to half, the beam and token to 70%", () => {
    for (let age = 0; age <= 2000; age += 100) {
      const dy = at("idle", "sleeping", age).face.dy;
      expect(dy % 6).toBe(0);
    }
    const deep = settled("sleeping");
    expect(deep.face.dy).toBe(SLEEP.dy);
    expect(deep.face.dim).toBe(SLEEP.dim);
    expect(deep.light).toBe(SLEEP.light);
    expect(at("idle", "sleeping", 200).face.dim).toBe(1);
  });

  test("asleep and settled she is frozen (painted once), never settled like an awake face", () => {
    expect(at("idle", "sleeping", 1500).frozen).toBe(false);
    expect(at("idle", "sleeping", 1600).frozen).toBe(true);
    expect(settled("sleeping").settled).toBe(false);
    expect(at("idle", "sleeping", 0, STILL).frozen).toBe(true);
    expect(settled("working").frozen).toBe(false);
  });

  test("the wake out of sleep: asleep, the yawn, the rub, a smile at you, then idle", () => {
    const w = (age: number) => at("sleeping", "waking", age).face;
    expect(w(300).map).toBe("asleep");
    expect(w(300).dim).toBeCloseTo(SLEEP.dim + (0.8 - SLEEP.dim) / 3, 5);
    expect(w(2000).map).toBe("yawn");
    expect(w(3400).map).toBe("rub");
    const smile = w(5200);
    expect(smile.eyes).toBe("soft");
    expect(smile.mouth).toBe("smile");
    expect(smile.gaze).toEqual(RIG.glance);
    expect(at("sleeping", "waking", 300).gestures).toBe(false);
    const awake = at("sleeping", "waking", WAKE_FACE);
    expect(awake.face.map).toBeNull();
    expect(awake.gestures).toBe(true);
  });

  test("a wake that does not start asleep starts at the yawn; reduced motion skips it", () => {
    expect(at("idle", "waking", 0).face.map).toBe("yawn");
    expect(at("idle", "waking", WAKE_FACE - WAKE_FROM_YAWN).gestures).toBe(
      true,
    );
    expect(at("sleeping", "waking", 0, STILL).gestures).toBe(true);
  });

  test("out of sleep into any other mood her head comes up and the light returns", () => {
    const up = at("sleeping", "working", 0);
    expect(up.face.dy).toBe(SLEEP.dy);
    expect(up.face.from?.map).toBe("asleep");
    expect(at("sleeping", "working", 600).face.dy).toBe(0);
    expect(at("sleeping", "working", 600).settled).toBe(true);
  });
});

test("a pure function of the change and the clock", () => {
  const a = JSON.stringify(at("concerned", "approval", 230));
  const b = JSON.stringify(at("concerned", "approval", 230));
  expect(a).toBe(b);
  expect(JSON.stringify(at("concerned", "approval", 260))).not.toBe(a);
});
