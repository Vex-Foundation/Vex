/**
 * K2's timeline (`k2-time.ts`), without a canvas. Regressions this catches: a wake whose beats run
 * out of order or late (the token, the beam, the assembly, asleep, the rise, the yawn, the rub, the
 * blinks, the smile); a wake that plays when she starts awake; two gestures at once, a gesture
 * during a hover, a giggle inside its cooldown; a look at you that comes too often, too rarely, too
 * long or before she is awake, that misses a gesture's end or the window's return, or pairs too
 * often; and a schedule that is not a pure function of the clock.
 */
import { describe, expect, test } from "vitest";
import {
  canGiggle,
  GESTURE_GAP,
  GESTURE_MS,
  GestureChain,
  type GestureInput,
  type GestureName,
  gestureAt,
  gestureState,
  hoverProgress,
  LOOK,
  type LookAt,
  LookChain,
  lookAt,
  lookLid,
  projector,
  T_ASM,
  T_CONE,
  T_FLIP,
  T_PRESS,
  W0,
  wakeEnd,
  wakeState,
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

const idle = (t: number, more: Partial<GestureInput> = {}): GestureInput => ({
  t,
  enabled: true,
  awakeAt: 0,
  giggles: [],
  hold: false,
  holdAge: -1,
  unholdAge: -1,
  ...more,
});

describe("the gestures", () => {
  test("her rhythm: the first blow 6 s after she is awake, the first bird 20 s after", () => {
    const chain = new GestureChain(9100);
    expect(gestureAt(chain, idle(9100 + 5900, { awakeAt: 9100 }))).toBeNull();
    expect(gestureAt(chain, idle(9100 + 6000, { awakeAt: 9100 }))?.name).toBe(
      "blow",
    );
    expect(gestureAt(chain, idle(9100 + 20000, { awakeAt: 9100 }))?.name).toBe(
      "bird",
    );
  });

  test("one at a time, never two scheduled within 20 s, and the same answer for the same moment", () => {
    const chain = new GestureChain(0);
    const runs: { name: GestureName; start: number; end: number }[] = [];
    let open: { name: GestureName; start: number } | null = null;
    for (let t = 0; t <= 900000; t += 100) {
      const g = gestureAt(chain, idle(t));
      if (g !== null && open === null) open = { name: g.name, start: g.start };
      if (g === null && open !== null) {
        runs.push({ ...open, end: t });
        open = null;
      }
    }
    expect(runs.length).toBeGreaterThan(10);
    for (let n = 2; n < runs.length; n++) {
      const a = runs[n - 1];
      const b = runs[n];
      if (a === undefined || b === undefined) continue;
      expect(b.start - a.end).toBeGreaterThanOrEqual(GESTURE_GAP - 100);
    }
    // pure: asking again, out of order, gives the same gestures
    const again = new GestureChain(0);
    for (const r of [...runs].reverse())
      expect(gestureAt(again, idle(r.start + 50))?.name).toBe(r.name);
  });

  test("a hover before a gesture cancels it, one during it fades it out in 300 ms", () => {
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

  test("the giggle answers a click, wins over a scheduled gesture and has an 8 s cooldown", () => {
    const chain = new GestureChain(0);
    const g = gestureAt(chain, idle(6500, { giggles: [6400] }));
    expect(g?.name).toBe("giggle");
    expect(
      gestureAt(chain, idle(6400 + GESTURE_MS.giggle, { giggles: [6400] })),
    ).toBeNull();
    expect(canGiggle(7000, [6400], 0)).toBe(false);
    expect(canGiggle(6400 + GESTURE_MS.giggle + 8000, [6400], 0)).toBe(true);
    expect(canGiggle(5000, [], 9100)).toBe(false);
  });

  test("nothing before she is awake, nothing when gestures are off", () => {
    const chain = new GestureChain(9100);
    expect(gestureAt(chain, idle(15100, { awakeAt: 16000 }))).toBeNull();
    expect(
      gestureAt(chain, idle(15100, { awakeAt: 9100, enabled: false })),
    ).toBeNull();
  });

  test("each gesture's state: the blow squeezes and puffs, the bird blushes, the giggle hides the mouth", () => {
    const blow = gestureState({ name: "blow", start: 0, age: 4500, fade: 1 });
    expect(blow.eyes).toBe("squeeze");
    expect(blow.mouth).toBe("o");
    expect(blow.actors).toBe("cloud");
    const bird = gestureState({ name: "bird", start: 0, age: 4000, fade: 1 });
    expect(bird.blush).toBe(1);
    expect(bird.hand?.map).toBe("palm");
    expect(bird.actors).toBe("bird");
    const giggle = gestureState({
      name: "giggle",
      start: 0,
      age: 500,
      fade: 1,
    });
    expect(giggle.eyes).toBe("happy");
    expect(giggle.mouth).toBe("none");
    expect(giggle.sh).toBe(1);
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

/** Every look at rest between `from` and `to`, sampled at her 10 fps steps. */
function restLooks(chain: LookChain, from: number, to: number): LookAt[] {
  const out: LookAt[] = [];
  for (let t = from; t <= to; t += 100) {
    const hit = lookAt(chain, t, from, []);
    if (hit !== null && out.at(-1)?.start !== hit.start) out.push(hit);
  }
  return out;
}

describe("she looks at you", () => {
  test("at rest every 8 to 20 s, each look held 1.5 to 3 s, never before she is awake", () => {
    const awake = 9100;
    const chain = new LookChain(awake);
    expect(lookAt(chain, awake - 100, awake, [])).toBeNull();
    const looks = restLooks(chain, awake, awake + 600000);
    expect(looks.length).toBeGreaterThan(
      600000 / (LOOK.gapMax + LOOK.holdMax) - 1,
    );
    expect(looks.length).toBeLessThan(600000 / LOOK.gapMin + 1);
    expect(looks[0]?.start ?? 0).toBeGreaterThanOrEqual(awake + LOOK.gapMin);
    for (const look of looks) {
      expect(look.hold).toBeGreaterThanOrEqual(LOOK.holdMin);
      expect(look.hold).toBeLessThanOrEqual(LOOK.holdMax);
    }
    const gaps = looks
      .slice(1)
      .map(
        (look, n) =>
          look.start - ((looks[n]?.start ?? 0) + (looks[n]?.hold ?? 0)),
      );
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LOOK.gapMin);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(LOOK.gapMax);
  });

  test("pure: the same moments give the same looks, asked in any order", () => {
    const a = new LookChain(0);
    const b = new LookChain(0);
    const forward = [30000, 60000, 90000, 120000].map((t) =>
      lookAt(a, t, 0, []),
    );
    const backward = [120000, 90000, 60000, 30000]
      .map((t) => lookAt(b, t, 0, []))
      .reverse();
    expect(backward).toEqual(forward);
  });

  test("a gesture's end or the window's return starts a look at once and holds it 1.5 to 3 s", () => {
    const chain = new LookChain(9100);
    const ended = 23000;
    const hit = lookAt(chain, ended + 100, 9100, [ended]);
    expect(hit?.start).toBe(ended);
    expect(hit?.hold ?? 0).toBeGreaterThanOrEqual(LOOK.holdMin);
    expect(hit?.hold ?? 9999).toBeLessThanOrEqual(LOOK.holdMax);
    const after = lookAt(chain, ended + (hit?.hold ?? 0) + 100, 9100, [ended]);
    expect(after?.start === ended).toBe(false);
    // a trigger while she is still waking up is ignored
    expect(lookAt(chain, 5100, 9100, [5000])).toBeNull();
    expect(LOOK.away).toBe(10000);
  });

  test("about one in three looks is paired with the soft smile or a slow blink", () => {
    const looks = restLooks(new LookChain(0), 0, 3600000);
    const smile = looks.filter((l) => l.flavour === "smile").length;
    const blink = looks.filter((l) => l.flavour === "blink").length;
    expect(looks.length).toBeGreaterThan(150);
    expect((smile + blink) / looks.length).toBeGreaterThan(0.2);
    expect((smile + blink) / looks.length).toBeLessThan(0.46);
    expect(smile).toBeGreaterThan(0);
    expect(blink).toBeGreaterThan(0);
  });

  test("the slow blink closes once inside the look; a plain look never moves the lid", () => {
    const blink: LookAt = { start: 0, age: 0, hold: 2000, flavour: "blink" };
    const lids = [0, 400, 700, 900, 1200, 1999].map((age) =>
      lookLid({ ...blink, age }),
    );
    expect(lids[0]).toBe(0);
    expect(Math.max(...lids)).toBe(1);
    expect(lids[5]).toBe(0);
    expect(lookLid({ ...blink, flavour: "plain", age: 900 })).toBe(0);
    expect(lookLid(null)).toBe(0);
  });
});
