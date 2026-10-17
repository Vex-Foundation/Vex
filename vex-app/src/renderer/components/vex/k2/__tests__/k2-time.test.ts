/**
 * K2's timeline (`k2-time.ts`), without a canvas. Regressions this catches: a wake whose beats run
 * out of order or late (the token, the beam, the assembly, asleep, the rise, the yawn, the rub, the
 * blinks, the smile); a wake that plays when she starts awake; two idle actions at once or within
 * 15 s, an action during a hover, a giggle inside its cooldown, a blush that does not follow the
 * giggle or a long hover, a whistle before 40 s of a still pointer or crowding the pool; a gaze
 * that does not rest on the viewer by default; an open episode that shows her before the token has
 * turned flat or the beam has risen, a close that leaves her standing or the coin flat, an episode
 * that plays under the still frame; a look at you that is missing after she comes back, runs out
 * of its 1.5 to 3 s, or follows a return that has not happened yet; and a schedule that is not a
 * pure function of the clock.
 */
import { describe, expect, test } from "vitest";
import {
  CLOSE,
  CLOSE_MS,
  CLOSED,
  canGiggle,
  type Episode,
  episodeBusy,
  episodeProjector,
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
  LOOK,
  lookAtYou,
  OPEN,
  OPEN_MS,
  projector,
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

/** Every idle action between `from` and `to`, sampled at her 10 fps steps. */
function runsOf(
  chain: GestureChain,
  from: number,
  to: number,
  more: Partial<GestureInput> = {},
): { name: GestureName; start: number; end: number }[] {
  const runs: { name: GestureName; start: number; end: number }[] = [];
  let open: { name: GestureName; start: number } | null = null;
  for (let t = from; t <= to; t += 100) {
    const g = gestureAt(chain, idle(t, more));
    if (g !== null && open !== null && g.start !== open.start) {
      runs.push({ ...open, end: t });
      open = null;
    }
    if (g !== null && open === null) open = { name: g.name, start: g.start };
    if (g === null && open !== null) {
      runs.push({ ...open, end: t });
      open = null;
    }
  }
  return runs;
}

describe("the idle pool", () => {
  test("her rhythm: the first blow 6 s after she is awake, then the bird 15 to 25 s after it", () => {
    const chain = new GestureChain(9100);
    expect(gestureAt(chain, idle(9100 + 5900, { awakeAt: 9100 }))).toBeNull();
    expect(gestureAt(chain, idle(9100 + 6000, { awakeAt: 9100 }))?.name).toBe(
      "blow",
    );
    const runs = runsOf(chain, 9100, 9100 + 60000, { awakeAt: 9100 });
    expect(runs.slice(0, 2).map((r) => r.name)).toEqual(["blow", "bird"]);
    const gap = (runs[1]?.start ?? 0) - (runs[0]?.end ?? 0);
    expect(gap).toBeGreaterThanOrEqual(GESTURE_GAP - 100);
    expect(gap).toBeLessThanOrEqual(25000 + 100);
  });

  test("one at a time, at least 15 s between any two, every kind in an hour, the same answer for the same moment", () => {
    const chain = new GestureChain(0);
    const runs = runsOf(chain, 0, 3600000);
    expect(runs.length).toBeGreaterThan(40);
    const gaps = runs.slice(1).map((r, n) => r.start - (runs[n]?.end ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GESTURE_GAP - 100);
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

/** Every glance away between `from` and `to`, sampled at her 10 fps steps, and the time spent away. */
function glancesOf(
  chain: GlanceChain,
  from: number,
  to: number,
): { list: GlanceAway[]; away: number } {
  const list: GlanceAway[] = [];
  let away = 0;
  for (let t = from; t <= to; t += 100) {
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
