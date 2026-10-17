/**
 * K2's timeline (`k2-time.ts`), without a canvas. Regressions this catches: a wake whose beats run
 * out of order or late (the token, the beam, the assembly, asleep, the rise, the yawn, the rub, the
 * blinks, the smile); a wake that plays when she starts awake; two idle actions at once or within
 * 15 s, an action during a hover, a giggle inside its cooldown, a blush that does not follow the
 * giggle or a long hover, a whistle before 40 s of a still pointer or crowding the pool; a gaze
 * that does not rest on the viewer by default; an open episode that shows her before the token has
 * turned flat or the beam has risen, a close that leaves her standing or the coin flat, a close off
 * the web app's beats (1.94 s: her dots by 1.2 s, the beam from 0.9 to 1.4 s, the coin from 1.3 s),
 * a close in the middle of a wake that does not run from where the wake was, a token toggle open
 * that does not press at once, an episode that plays under the still frame; a look at you that is
 * missing after she comes back, runs out of its 1.5 to 3 s, or follows a return that has not
 * happened yet; a schedule that is not a pure function of the clock; and a frame clock that does
 * not step at 30 fps through every episode (the wake, an open, the close, each gesture) and at
 * 10 fps on the idle grid otherwise, that skips an idle step, repeats a frame or goes back, or that
 * gives the wake, the close or an action another count of frames than the web app's.
 */
import { describe, expect, test } from "vitest";
import {
  AWAKE as AWAKE_PJ,
  CLOSE,
  CLOSE_MS,
  CLOSED,
  canGiggle,
  closing,
  EPISODE_FPS,
  type Episode,
  episodeBusy,
  episodeProjector,
  fineTime,
  frameTime,
  GESTURE_GAP,
  GESTURE_MS,
  GestureChain,
  type GestureInput,
  type GestureName,
  GLANCE as GLANCE_MS,
  type GlanceAway,
  GlanceChain,
  gestureAt,
  gestureState,
  hoverProgress,
  idleTime,
  inEpisode,
  LOOK,
  lookAtYou,
  OPEN,
  OPEN_LEAD,
  OPEN_MS,
  projector,
  STEP_MS,
  slowBlink,
  T_ASM,
  T_CONE,
  T_FLIP,
  T_PRESS,
  W0,
  WHISTLE,
  wakeEnd,
  wakeState,
  whistleAt,
} from "../k2-time.js";

const GLANCE = { x: 1330, y: 300 };
const wake = (t: number) => wakeState(t, "full", 3, 1, GLANCE);

describe("the wake", () => {
  test("hands her over after about 9 s on the wide drawing, 6.3 s on the short wake, at once when awake", () => {
    expect(wakeEnd("full")).toBe(9100);
    expect(wakeEnd("short")).toBe(6300);
    expect(wakeEnd("none")).toBe(0);
  });

  test("the projector: the token face-on, pressed, turned flat, then the beam, then she assembles", () => {
    const at = (t: number) => projector(t, "full");
    expect(at(300)).toEqual({ press: 0, flip: 0, cone: 0, asm: 0 });
    expect(at(T_PRESS + 100).press).toBeCloseTo(1, 5);
    expect(at(T_PRESS + 300).press).toBe(0);
    expect(at(T_FLIP[0]).flip).toBe(0);
    expect(at((T_FLIP[0] + T_FLIP[1]) / 2).flip).toBeCloseTo(0.5, 5);
    expect(at(T_FLIP[1]).flip).toBe(1);
    // the beam rises before she assembles, and is whole by the time she is
    expect(T_CONE[0]).toBeLessThan(T_ASM[0]);
    expect(at(T_ASM[0]).cone).toBeGreaterThan(0.6);
    expect(at(T_ASM[1]).asm).toBe(1);
    expect(at(T_ASM[1]).cone).toBe(1);
  });

  test("an awake start shows the token flat, the beam on and her whole", () => {
    expect(projector(0, "none")).toEqual({
      press: 0,
      flip: 1,
      cone: 1,
      asm: 1,
    });
    expect(wakeState(0, "none", 3, 1, GLANCE)).toBeNull();
  });

  test("the beats in order: asleep, the rise, the yawn with its tear, the rub, the blinks, the smile", () => {
    const asleep = wake(W0 + 300);
    expect(asleep?.map).toBe("asleep");
    expect(asleep?.eyes).toBe("map");
    // asleep she sits 36 px low and a little dim, in whole steps of two rows
    expect(asleep?.dy).toBe(36);
    expect(asleep?.dim).toBeCloseTo(0.8, 5);
    const rising = wake(W0 + 1300);
    expect(rising?.eyes).toBe("closed");
    expect((rising?.dy ?? 0) % 6).toBe(0);
    expect(rising?.dy).toBeLessThan(36);
    const yawn = wake(W0 + 2000);
    expect(yawn?.map).toBe("yawn");
    expect(yawn?.hand?.map).toBe("yawn");
    expect(yawn?.eyes).toBe("squeeze");
    expect(yawn?.tear).toBeGreaterThan(0);
    expect(yawn?.sh).toBe(1);
    const rub = wake(W0 + 3300);
    expect(rub?.map).toBe("rub");
    expect(rub?.eyes).toBe("drowsy");
    const blink = wake(W0 + 4300 + 150);
    expect(blink?.lid).toBe(1);
    expect(blink?.gaze).toEqual(GLANCE);
    const smile = wake(W0 + 5200);
    expect(smile?.mouth).toBe("smile");
    expect(smile?.eyes).toBe("soft");
    expect(smile?.dy).toBe(0);
    expect(wake(wakeEnd("full"))).toBeNull();
  });

  test("the short wake: eyes closed while she assembles, then blinks, a look and a smile", () => {
    const at = (t: number) => wakeState(t, "short", 2, 0.4259, GLANCE);
    expect(at(W0 + 300)?.eyes).toBe("closed");
    expect(at(W0 + 300)?.map).toBeNull();
    expect(at(W0 + 1650)?.lid).toBe(1);
    expect(at(W0 + 2500)?.mouth).toBe("smile");
    expect(at(wakeEnd("short"))).toBeNull();
  });
});

const ALL: readonly GestureName[] = [
  "blow",
  "bird",
  "giggle",
  "blush",
  "whistle",
  "hum",
];

const idle = (t: number, more: Partial<GestureInput> = {}): GestureInput => ({
  t,
  allowed: ALL,
  awakeAt: 0,
  giggles: [],
  blushes: [],
  stillSince: 0,
  hold: false,
  holdAge: -1,
  unholdAge: -1,
  ...more,
});

/** A 30 fps frame's step: 33 or 34 ms (three to an idle step). */
const FINE = [33, 34];

/**
 * The frames the engine's loop paints from `from` to `to` (her clock) on a 60 Hz display:
 * `frameTime` at every animation frame, as `K2Engine` calls it.
 */
function framesOf(
  from: number,
  to: number,
  episodeAt: (t: number) => boolean,
  hz = 60,
): number[] {
  const out: number[] = [];
  let last = from - 1;
  for (let n = 0; from + (n * 1000) / hz <= to; n++) {
    const t = frameTime(from + (n * 1000) / hz, last, episodeAt);
    if (t === null) continue;
    out.push(t);
    last = t;
  }
  return out;
}

/**
 * Every idle action between `from` and `to`, sampled at the frames she paints (30 fps in an action,
 * the 10 fps idle grid between): a run starts at its first frame and ends one 30 fps step after its
 * last, so both ends are found within 34 ms.
 */
function runsOf(
  chain: GestureChain,
  from: number,
  to: number,
  more: Partial<GestureInput> = {},
): { name: GestureName; start: number; end: number; frames: number[] }[] {
  const runs: { name: GestureName; start: number; end: number; frames: number[] }[] = [];
  const at = (t: number) => gestureAt(chain, idle(t, more));
  // `of` is the action's own start, `start` its first frame
  let open: { name: GestureName; of: number; start: number; frames: number[] } | null = null;
  const close = () => {
    if (open === null) return;
    const { name, start, frames } = open;
    runs.push({ name, start, frames, end: (frames.at(-1) ?? start) + 34 });
    open = null;
  };
  for (const t of framesOf(from, to, (u) => at(u) !== null)) {
    const g = at(t);
    if (g !== null && open !== null && g.start !== open.of) close();
    if (g === null) close();
    else {
      if (open === null) open = { name: g.name, of: g.start, start: t, frames: [] };
      open.frames.push(t);
    }
  }
  close();
  return runs;
}

describe("the frame clock", () => {
  test("30 fps frames step 33, 33 and 34 ms and land on every 10 fps idle step", () => {
    expect(EPISODE_FPS).toBe(30);
    expect(STEP_MS).toBe(100);
    const fine = [...new Set(Array.from({ length: 700 }, (_, n) => fineTime(n)))];
    expect(fine.slice(0, 7)).toEqual([0, 33, 66, 100, 133, 166, 200]);
    const steps = fine.slice(1).map((t, n) => t - (fine[n] ?? 0));
    expect(steps.every((s) => FINE.includes(s))).toBe(true);
    // every third is an idle step, and a fine frame's idle step is the one at or before it
    expect(fine.filter((t) => t % STEP_MS === 0)).toEqual([0, 100, 200, 300, 400, 500, 600]);
    for (const t of fine) {
      expect(idleTime(t)).toBe(Math.floor(t / 100) * 100);
      expect(idleTime(t)).toBeLessThanOrEqual(t);
    }
    expect(fineTime(99.99)).toBe(66);
    expect(fineTime(100)).toBe(100);
  });

  test("idle: one frame per idle step, 100 ms apart, as before; an episode: every 30 fps frame", () => {
    const idleFrames = framesOf(0, 10000, () => false);
    expect(idleFrames.length).toBe(101);
    expect(idleFrames.every((t, n) => t === n * 100)).toBe(true);
    const ep = framesOf(0, 1000, () => true);
    expect(ep.length).toBe(31);
    expect(ep.slice(1).every((t, n) => FINE.includes(t - (ep[n] ?? 0)))).toBe(true);
    // a 30 Hz display (or a slow one) still paints every idle step it passes
    const slow = framesOf(0, 3000, () => false, 30);
    expect(slow.every((t, n) => t === n * 100)).toBe(true);
  });

  test("an episode ending between idle steps waits for the next step; a long jump paints the step it reached", () => {
    const ends = 1450;
    const frames = framesOf(1000, 2000, (t) => t < ends);
    const inside = frames.filter((t) => t < ends);
    const after = frames.filter((t) => t >= ends);
    expect(inside.at(-1)).toBe(1433);
    expect(after[0]).toBe(1500);
    expect(after.every((t) => t % 100 === 0)).toBe(true);
    // never the same frame twice, never behind
    expect(frames.every((t, n) => n === 0 || t > (frames[n - 1] ?? 0))).toBe(true);
    expect(frameTime(1433.4, 1433, () => true)).toBeNull();
    expect(frameTime(1466.7, 1433, () => false)).toBeNull();
    // the clock jumped 250 ms (a busy frame) outside an episode: the step it reached
    expect(frameTime(1750, 1500, () => false)).toBe(1700);
    expect(frameTime(1750, 1500, () => true)).toBe(1733);
  });

  test("pure: the same clock, last frame and episodes give the same frames", () => {
    const ep = (t: number) => t % 4000 < 1300;
    expect(framesOf(0, 20000, ep)).toEqual(framesOf(0, 20000, ep));
    for (const c of [0, 33.4, 99.9, 150, 1299, 1301, 5999.5])
      expect(frameTime(c, c - 120, ep)).toBe(frameTime(c, c - 120, ep));
  });

  test("what is an episode: the wake, the close, a gesture; never a still frame or idle", () => {
    const base = { still: false, waking: false, closing: false, gesture: false };
    expect(inEpisode(base)).toBe(false);
    expect(inEpisode({ ...base, waking: true })).toBe(true);
    expect(inEpisode({ ...base, closing: true })).toBe(true);
    expect(inEpisode({ ...base, gesture: true })).toBe(true);
    expect(inEpisode({ still: true, waking: true, closing: true, gesture: true })).toBe(false);
  });

  test("the wake and an open play at 30 fps to the hand-over, then the idle grid", () => {
    const end = wakeEnd("full");
    const frames = framesOf(0, end + 2000, (t) => t < end);
    const wake = frames.filter((t) => t < end);
    // 9.1 s at 30 fps: 273 frames (it was 91 at 10 fps)
    expect(wake.length).toBe(273);
    expect(wake.slice(1).every((t, n) => FINE.includes(t - (wake[n] ?? 0)))).toBe(true);
    const after = frames.filter((t) => t >= end);
    expect(after[0]).toBe(end);
    expect(after.slice(1).every((t, n) => t - (after[n] ?? 0) === 100)).toBe(true);
    // the coin's turn (0.64 s) gets 19 frames, her assembly (1.45 s) 43 (they were 6 and 14)
    expect(wake.filter((t) => t >= T_FLIP[0] && t < T_FLIP[1]).length).toBe(19);
    expect(wake.filter((t) => t >= T_ASM[0] && t < T_ASM[1]).length).toBe(43);
    // an open is the wake from the press, on its own clock: it starts at once, between steps
    const press = 21_517;
    const wake0 = fineTime(press) - OPEN_LEAD;
    const open = framesOf(press - 300, wake0 + end + 300, (t) => t >= press && t < wake0 + end);
    const first = open.find((t) => t >= press) ?? 0;
    expect(first - press).toBeLessThan(34);
    expect(first % 100).not.toBe(0);
  });

  test("the close plays at 30 fps (59 frames over 1.94 s), and the coin at rest is idle again", () => {
    const at = 40_000;
    const frames = framesOf(at - 500, at + 4000, (t) => t >= at && t < at + CLOSE_MS);
    const close = frames.filter((t) => t >= at && t < at + CLOSE_MS);
    expect(close.length).toBe(59);
    expect(close.slice(1).every((t, n) => FINE.includes(t - (close[n] ?? 0)))).toBe(true);
    const rest = frames.filter((t) => t >= at + CLOSE_MS);
    expect(rest.every((t) => t % 100 === 0)).toBe(true);
  });
});

describe("the idle pool", () => {
  test("her rhythm: the first blow 6 s after she is awake, then the bird 15 to 25 s after it", () => {
    const chain = new GestureChain(9100);
    expect(gestureAt(chain, idle(9100 + 5900, { awakeAt: 9100 }))).toBeNull();
    expect(gestureAt(chain, idle(9100 + 6000, { awakeAt: 9100 }))?.name).toBe(
      "blow",
    );
    const runs = runsOf(chain, 9100, 9100 + 60000, { awakeAt: 9100 });
    expect(runs.slice(0, 2).map((r) => r.name)).toEqual(["blow", "bird"]);
    // the blow starts on its own frame (6 s after the hand-over is a 30 fps frame and an idle step)
    expect(runs[0]?.start).toBe(9100 + 6000);
    const gap = (runs[1]?.start ?? 0) - (runs[0]?.end ?? 0);
    // both ends are found within one 30 fps step (they were within one 100 ms step)
    expect(gap).toBeGreaterThanOrEqual(GESTURE_GAP - 34);
    expect(gap).toBeLessThanOrEqual(25000 + 34);
  });

  test("each action plays at 30 fps from its first frame to its last, and idle between stays on the 10 fps grid", () => {
    const chain = new GestureChain(0);
    const span = 900000;
    const runs = runsOf(chain, 0, span);
    expect(runs.length).toBeGreaterThan(10);
    for (const r of runs) {
      const steps = r.frames.slice(1).map((t, n) => t - (r.frames[n] ?? 0));
      expect(steps.every((s) => FINE.includes(s))).toBe(true);
    }
    // every 30 fps frame of each action the span does not cut (a 2 s hum is 60 frames, a 7.8 s
    // bird 234; they were 20 and 78)
    const whole = runs.filter((r) => r.end < span - 10000);
    expect(whole.length).toBeGreaterThanOrEqual(runs.length - 1);
    const counts = whole.map((r) => Math.abs(r.frames.length - (GESTURE_MS[r.name] * 3) / 100));
    expect(Math.max(...counts)).toBeLessThanOrEqual(1);
    expect(whole.filter((r) => r.name === "hum").map((r) => r.frames.length)).toContain(60);
    expect(whole.filter((r) => r.name === "bird").map((r) => r.frames.length)).toContain(234);
    const all = framesOf(0, span, (t) => gestureAt(chain, idle(t)) !== null);
    const inRun = new Set(runs.flatMap((r) => r.frames));
    const between = all.filter((t) => !inRun.has(t));
    expect(between.every((t) => t % STEP_MS === 0)).toBe(true);
    expect(between.length).toBeGreaterThan(span / STEP_MS / 2);
  });

  test("one at a time, at least 15 s between any two, every kind in an hour, the same answer for the same moment", () => {
    const chain = new GestureChain(0);
    const runs = runsOf(chain, 0, 3600000);
    expect(runs.length).toBeGreaterThan(40);
    const gaps = runs.slice(1).map((r, n) => r.start - (runs[n]?.end ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GESTURE_GAP - 34);
    const kinds = new Set(runs.map((r) => r.name));
    expect([...kinds].sort()).toEqual([
      "bird",
      "blow",
      "blush",
      "hum",
      "whistle",
    ]);
    // the blow and the bird keep their rhythm: never sooner than 45 s and 60 s apart
    const blows = runs.filter((r) => r.name === "blow").map((r) => r.start);
    const birds = runs.filter((r) => r.name === "bird").map((r) => r.start);
    expect(
      Math.min(...blows.slice(1).map((s, n) => s - (blows[n] ?? 0))),
    ).toBeGreaterThanOrEqual(45000);
    expect(
      Math.min(...birds.slice(1).map((s, n) => s - (birds[n] ?? 0))),
    ).toBeGreaterThanOrEqual(60000);
    // pure: asking again, out of order, gives the same actions
    const again = new GestureChain(0);
    for (const r of [...runs].reverse())
      expect(gestureAt(again, idle(r.start + 50))?.name).toBe(r.name);
  });

  test("the whistle: it takes over the first slot 40 to 90 s into a still pointer, and waits again when the pointer moves", () => {
    const chain = new GestureChain(0);
    const still = 200000;
    expect(whistleAt(chain, still + WHISTLE.min - 100, still)).toBeNull();
    let first: number | null = null;
    for (let t = still; t < still + 200000 && first === null; t += 100)
      first = whistleAt(chain, t, still)?.start ?? null;
    expect(first).not.toBeNull();
    const at = first ?? 0;
    expect(at).toBeGreaterThanOrEqual(still + WHISTLE.min);
    // it stands in one of the pool's slots, in place of that slot's action
    expect(chain.from(at).start).toBe(at);
    expect(gestureAt(chain, idle(at + 100, { stillSince: still }))?.name).toBe(
      "whistle",
    );
    expect(
      gestureAt(
        chain,
        idle(at + GESTURE_MS.whistle + 100, { stillSince: still }),
      ),
    ).toBeNull();
    // the pointer moved just before it: the wait starts again
    expect(whistleAt(chain, at + 100, at - 1000)).toBeNull();
  });

  test("a hover before an action cancels it, one during it fades it out in 300 ms", () => {
    const chain = new GestureChain(0);
    expect(
      gestureAt(chain, idle(6500, { hold: true, holdAge: 2000 })),
    ).toBeNull();
    const fading = gestureAt(chain, idle(6500, { hold: true, holdAge: 150 }));
    expect(fading?.name).toBe("blow");
    expect(fading?.fade).toBeCloseTo(0.5, 5);
    expect(
      gestureAt(chain, idle(6800, { hold: true, holdAge: 450 })),
    ).toBeNull();
    // it stays gone after the hover ends
    expect(gestureAt(chain, idle(7200, { unholdAge: 200 }))).toBeNull();
  });

  test("the giggle answers a click and a blush follows it; a long hover's end makes her blush; an 8 s cooldown", () => {
    const chain = new GestureChain(0);
    expect(gestureAt(chain, idle(6500, { giggles: [6400] }))?.name).toBe(
      "giggle",
    );
    const after = gestureAt(
      chain,
      idle(6400 + GESTURE_MS.giggle + 100, { giggles: [6400] }),
    );
    expect(after?.name).toBe("blush");
    expect(after?.start).toBe(6400 + GESTURE_MS.giggle);
    expect(
      gestureAt(
        chain,
        idle(6400 + GESTURE_MS.giggle + GESTURE_MS.blush + 100, {
          giggles: [6400],
        }),
      ),
    ).toBeNull();
    expect(gestureAt(chain, idle(3100, { blushes: [3000] }))?.name).toBe(
      "blush",
    );
    expect(canGiggle(7000, [6400], 0)).toBe(false);
    expect(canGiggle(6400 + GESTURE_MS.giggle + 8000, [6400], 0)).toBe(true);
    expect(canGiggle(5000, [], 9100)).toBe(false);
  });

  test("nothing before she is awake or when nothing is allowed; only the allowed ones play", () => {
    const chain = new GestureChain(9100);
    expect(gestureAt(chain, idle(15100, { awakeAt: 16000 }))).toBeNull();
    expect(
      gestureAt(chain, idle(15100, { awakeAt: 9100, allowed: [] })),
    ).toBeNull();
    const mapFree = runsOf(new GestureChain(0), 0, 1800000, {
      allowed: ["blush", "whistle", "hum"],
    });
    expect(mapFree.length).toBeGreaterThan(5);
    expect(
      mapFree.every(
        (r) => r.name === "blush" || r.name === "whistle" || r.name === "hum",
      ),
    ).toBe(true);
  });

  test("each action's state: blow, bird, giggle, the blush's smile, the whistle's o and notes, the hum's sway", () => {
    const blow = gestureState({ name: "blow", start: 0, age: 4500, fade: 1 });
    expect(blow.eyes).toBe("squeeze");
    expect(blow.mouth).toBe("o");
    expect(blow.actors).toBe("cloud");
    const bird = gestureState({ name: "bird", start: 0, age: 4000, fade: 1 });
    expect(bird.blush).toBe(1);
    expect(bird.actors).toBe("bird");
    const giggle = gestureState({
      name: "giggle",
      start: 0,
      age: 500,
      fade: 1,
    });
    expect(giggle.eyes).toBe("happy");
    expect(giggle.mouth).toBe("none");
    const blush = gestureState({ name: "blush", start: 0, age: 1200, fade: 1 });
    expect(blush.blush).toBe(1);
    expect(blush.mouth).toBe("smile");
    expect(blush.gaze).toBeNull();
    const whistle = gestureState({
      name: "whistle",
      start: 0,
      age: 1500,
      fade: 1,
    });
    expect(whistle.mouth).toBe("o");
    expect(whistle.aside).toBe(true);
    expect(whistle.actors).toBe("notes");
    // then the glance back at you
    expect(
      gestureState({
        name: "whistle",
        start: 0,
        age: WHISTLE.notes + 200,
        fade: 1,
      }).aside,
    ).toBe(false);
    const hum = gestureState({ name: "hum", start: 0, age: 525, fade: 1 });
    expect(hum.eyes).toBe("happy");
    expect(Math.abs(hum.sway)).toBeGreaterThan(0.5);
    // a hover fading it out drops the face marks past half
    const faded = gestureState({
      name: "blow",
      start: 0,
      age: 4500,
      fade: 0.4,
    });
    expect(faded.eyes).toBeNull();
    expect(faded.gp).toBeCloseTo(0.4, 5);
  });
});

describe("the hover", () => {
  test("a 300 ms dissolve, the hand rising over 500 ms and sinking over 350 ms; a still frame settles", () => {
    expect(hoverProgress(true, 150, -1, false)).toEqual({ hp: 0.5, rp: 0.3 });
    expect(hoverProgress(false, -1, 175, false).rp).toBeCloseTo(0.5, 5);
    expect(hoverProgress(true, 0, -1, true)).toEqual({ hp: 1, rp: 1 });
    expect(hoverProgress(false, -1, -1, false)).toEqual({ hp: 0, rp: 0 });
  });
});

/**
 * Every glance away between `from` and `to`, sampled at her idle frames (a glance is idle life: it
 * keeps the 10 fps idle grid, `framesOf` with no episode), and the time spent away.
 */
function glancesOf(
  chain: GlanceChain,
  from: number,
  to: number,
): { list: GlanceAway[]; away: number } {
  const list: GlanceAway[] = [];
  let away = 0;
  for (const t of framesOf(from, to, () => false)) {
    const hit = chain.at(t);
    if (hit === null) continue;
    away += 100;
    if (list.at(-1)?.start !== hit.start) list.push(hit);
  }
  return { list, away };
}

describe("she looks at you", () => {
  test("by default: away for under a fifth of the time, each glance 0.9 to 2 s, every 5 to 12 s", () => {
    const awake = 9100;
    const chain = new GlanceChain(awake);
    expect(chain.at(awake - 100)).toBeNull();
    const span = 600000;
    const { list, away } = glancesOf(chain, awake, awake + span);
    expect(away / span).toBeLessThan(0.2);
    expect(away / span).toBeGreaterThan(0.05);
    for (const g of list) {
      expect(g.hold).toBeGreaterThanOrEqual(GLANCE_MS.holdMin);
      expect(g.hold).toBeLessThanOrEqual(GLANCE_MS.holdMax);
    }
    const gaps = list
      .slice(1)
      .map((g, n) => g.start - ((list[n]?.start ?? 0) + (list[n]?.hold ?? 0)));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GLANCE_MS.gapMin);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GLANCE_MS.gapMax);
  });

  test("she glances to the composer, a cloud and the birds, and the same moments give the same glances", () => {
    const { list } = glancesOf(new GlanceChain(0), 0, 600000);
    const targets = new Set(list.map((g) => g.target));
    expect([...targets].sort()).toEqual(["birds", "cloud", "composer"]);
    const a = new GlanceChain(0);
    const b = new GlanceChain(0);
    const forward = [30000, 60000, 90000].map((t) => a.at(t));
    const backward = [90000, 60000, 30000].map((t) => b.at(t)).reverse();
    expect(backward).toEqual(forward);
  });
});

describe("the episodes", () => {
  const open: Episode = { kind: "open", at: 1000 };
  const close: Episode = { kind: "close", at: 1000 };
  const AWAKE = { press: 0, flip: 1, cone: 1, asm: 1 };

  test("with none she stands as she is", () => {
    expect(episodeProjector(null, 5000, false)).toEqual(AWAKE);
    expect(episodeBusy(null, 5000)).toBe(false);
  });

  test("open: the token face-on and pressed, turned flat, the beam, then she assembles, awake", () => {
    const at = (a: number) => episodeProjector(open, 1000 + a, false);
    expect(at(0)).toEqual({ press: 0, flip: 0, cone: 0, asm: 0 });
    expect(at(100).press).toBeCloseTo(1, 5);
    expect(at(OPEN.flip[0]).flip).toBe(0);
    expect(at((OPEN.flip[0] + OPEN.flip[1]) / 2).flip).toBeCloseTo(0.5, 5);
    expect(at(OPEN.flip[1]).flip).toBe(1);
    // nothing of her before the coin lies flat and the beam has started
    expect(at(OPEN.flip[1]).asm).toBe(0);
    expect(OPEN.cone[0]).toBeLessThan(OPEN.asm[0]);
    expect(at(OPEN.asm[0]).cone).toBeGreaterThan(0.6);
    expect(at(OPEN_MS - 100).asm).toBeLessThan(1);
    expect(at(OPEN_MS)).toEqual(AWAKE);
    expect(at(OPEN_MS + 60000)).toEqual(AWAKE);
  });

  test("open holds her life back until she has assembled, then lets go", () => {
    expect(episodeBusy(open, 1000)).toBe(true);
    expect(episodeBusy(open, 1000 + OPEN_MS - 100)).toBe(true);
    expect(episodeBusy(open, 1000 + OPEN_MS)).toBe(false);
  });

  test("the close keeps the web app's beats: 1.94 s, her dots by 1.2 s, the beam 0.9 to 1.4 s, the coin from 1.3 s", () => {
    expect(CLOSE).toEqual({ collapse: 1200, cone: [900, 1400], flip: [1300, 1940] });
    expect(CLOSE_MS).toBe(1940);
    expect(AWAKE_PJ).toEqual(AWAKE);
  });

  test("close: she collapses first, the beam sinks after, the coin turns face-on last; then the token alone", () => {
    const at = (a: number) => episodeProjector(close, 1000 + a, false);
    expect(at(-100)).toEqual(AWAKE);
    expect(at(0)).toEqual(AWAKE);
    // she goes before the beam, and the beam before the coin turns
    expect(at(CLOSE.cone[0]).asm).toBeLessThan(0.6);
    expect(at(CLOSE.cone[0]).cone).toBe(1);
    expect(at(CLOSE.collapse).asm).toBe(0);
    expect(at(CLOSE.flip[0]).cone).toBeLessThan(0.3);
    expect(at(CLOSE.flip[0]).flip).toBe(1);
    expect(at((CLOSE.flip[0] + CLOSE.flip[1]) / 2).flip).toBeCloseTo(0.5, 5);
    expect(at(CLOSE_MS)).toEqual(CLOSED);
    expect(CLOSED).toEqual({ press: 0, flip: 0, cone: 0, asm: 0 });
    // closed there is nothing of her to live
    expect(episodeBusy(close, 1000 + 60000)).toBe(true);
  });

  test("the close runs her assembly backwards: half of her gone half way through her dots' beat", () => {
    const mid = closing(CLOSE.collapse / 2, AWAKE_PJ);
    expect(mid.asm).toBeCloseTo(0.5, 5);
    expect(mid.cone).toBe(1);
    expect(mid.flip).toBe(1);
    const beam = closing((CLOSE.cone[0] + CLOSE.cone[1]) / 2, AWAKE_PJ);
    expect(beam.asm).toBeLessThan(0.3);
    expect(beam.cone).toBeCloseTo(0.5, 5);
    expect(beam.flip).toBe(1);
    const turning = closing((CLOSE.flip[0] + CLOSE.flip[1]) / 2, AWAKE_PJ);
    expect(turning.asm).toBe(0);
    expect(turning.cone).toBe(0);
    expect(turning.flip).toBeCloseTo(0.5, 5);
    // settled: the coin upright alone, and it stays there
    expect(closing(CLOSE_MS, AWAKE_PJ)).toEqual(CLOSED);
    expect(closing(CLOSE_MS + 60000, AWAKE_PJ)).toEqual(CLOSED);
    // the episode's close is the same function from awake
    for (const a of [0, 300, 900, 1250, 1600, 1900])
      expect(episodeProjector(close, 1000 + a, false)).toEqual(closing(a, AWAKE_PJ));
  });

  test("a close in the middle of a wake runs each part from where the wake was", () => {
    const from = projector(T_ASM[0] + 200, "full");
    expect(from.asm).toBeGreaterThan(0);
    expect(from.asm).toBeLessThan(1);
    const c = closing(CLOSE.collapse / 2, from);
    expect(c.asm).toBeCloseTo(from.asm / 2, 5);
    expect(c.cone).toBe(from.cone);
    expect(c.flip).toBe(from.flip);
    expect(closing(CLOSE_MS, from)).toEqual(CLOSED);
    // an episode that carries its projector closes from it
    const fromEp: Episode = { kind: "close", at: 1000, from };
    expect(episodeProjector(fromEp, 1000 + CLOSE.collapse / 2, false)).toEqual(c);
    expect(episodeProjector(fromEp, 1000 + CLOSE.collapse / 2, true)).toEqual(CLOSED);
  });

  test("the token toggle's open replays the wake from the press: face-on, pressed at once, then she rises", () => {
    expect(OPEN_LEAD).toBe(T_PRESS);
    // the open's clock starts OPEN_LEAD before the press: the upright coin it leaves is the wake's own
    expect(projector(OPEN_LEAD - 100, "full")).toEqual(CLOSED);
    expect(projector(OPEN_LEAD + 50, "full").press).toBeGreaterThan(0);
    expect(projector(wakeEnd("full"), "full")).toEqual(AWAKE_PJ);
    // she wakes asleep first (the yawn and the rub follow)
    expect(wakeState(W0 + 100, "full", 3, 1, GLANCE)?.map).toBe("asleep");
  });

  test("under the still frame an open shows her at once and a close leaves the token alone", () => {
    expect(episodeProjector(open, 1000, true)).toEqual(AWAKE);
    expect(episodeProjector(close, 1000, true)).toEqual(CLOSED);
  });

  test("the same moment gives the same frame", () => {
    for (const a of [0, 300, 900, 1400, 2200]) {
      expect(episodeProjector(open, 1000 + a, false)).toEqual(
        episodeProjector({ kind: "open", at: 1000 }, 1000 + a, false),
      );
      expect(episodeProjector(close, 1000 + a, false)).toEqual(
        episodeProjector({ kind: "close", at: 1000 }, 1000 + a, false),
      );
    }
  });
});

describe("the look at you chain", () => {
  test("nothing before she comes back, nor for a return still ahead", () => {
    expect(lookAtYou(5000, [])).toBeNull();
    expect(lookAtYou(5000, [6000])).toBeNull();
  });

  test("after a return she holds her eyes on you for 1.5 to 3 s, then her glances resume", () => {
    const holds: number[] = [];
    for (let r = 10000; r < 10000 + 400 * 100; r += 100) {
      const look = lookAtYou(r, [r]);
      expect(look?.age).toBe(0);
      const hold = look?.hold ?? 0;
      expect(hold).toBeGreaterThanOrEqual(LOOK.holdMin);
      expect(hold).toBeLessThanOrEqual(LOOK.holdMax);
      expect(lookAtYou(r + hold - 1, [r])).not.toBeNull();
      expect(lookAtYou(r + hold, [r])).toBeNull();
      holds.push(hold);
    }
    // the holds spread over the range, not one fixed length
    expect(Math.max(...holds) - Math.min(...holds)).toBeGreaterThan(1000);
  });

  test("the latest return decides, whatever the order they were kept in", () => {
    const look = lookAtYou(20500, [20000, 5000, 12000]);
    expect(look?.start).toBe(20000);
    expect(look?.age).toBe(500);
    expect(lookAtYou(20500, [12000, 20000, 5000])).toEqual(look);
  });

  test("about one look in six smiles and one in six blinks slowly, never both", () => {
    let smiles = 0;
    let blinks = 0;
    const n = 2000;
    for (let k = 0; k < n; k++) {
      const look = lookAtYou(k * 100, [k * 100]);
      if (look?.smile === true) smiles++;
      if (look?.blink === true) blinks++;
      expect(look?.smile === true && look.blink).toBe(false);
    }
    expect(smiles / n).toBeGreaterThan(0.1);
    expect(smiles / n).toBeLessThan(0.25);
    expect(blinks / n).toBeGreaterThan(0.1);
    expect(blinks / n).toBeLessThan(0.25);
  });

  test("the slow blink closes once, at 40% of the hold, over 600 ms", () => {
    const look = { start: 0, age: 0, hold: 2000, smile: false, blink: true };
    const at = (age: number) => slowBlink({ ...look, age });
    expect(at(799)).toBe(0);
    expect(at(800)).toBeCloseTo(0.4, 5);
    expect(at(1000)).toBe(1);
    expect(at(1350)).toBeCloseTo(0.4, 5);
    expect(at(1400)).toBe(0);
  });
});
