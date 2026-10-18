/**
 * K2's morning coffee (`k2-coffee.ts`) on the real geometry (`public/art/vex-k2/app/coffee.json`),
 * without a canvas. Regressions this catches: a geometry file the engine would refuse, or one out of
 * register with the app drawing's glance; a beat out of the episode's order or time (the mug rising,
 * the steam, the raise, the sip with its content eyes, the lowering, the exhale, the sink, her gaze
 * back at you); hands that move apart during the raise or the lowering, or by an odd number of rows
 * (the hex screen would shear); an interruption that pops instead of fading over 300 ms or keeps the
 * exhale; a mood that cuts it without its dissolve running from the mug; a reduced motion frame that
 * moves, shows no mug or no steam; steam that leaves from the wrong place, ignores the blow's ink rule
 * or the page's blocks; and a beat that is not a pure function of its age.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  C_RISE,
  COFFEE_BEATS,
  type CoffeeGeo,
  type CoffeeRig,
  coffeeFace,
  coffeeIntoMood,
  coffeeStill,
  drawCoffee,
  isCoffeeGeo,
  STEAM_INK_ALPHA,
} from "../k2-coffee.js";
import { type FaceState, GESTURE_MS, NO_FACE } from "../k2-time.js";

const ART = join(dirname(fileURLToPath(import.meta.url)), "../../../../public/art/vex-k2");
function jsonAt(file: string): unknown {
  return JSON.parse(readFileSync(join(ART, file), "utf8"));
}
function geoAt(file: string): CoffeeGeo {
  const raw = jsonAt(file);
  if (!isCoffeeGeo(raw)) throw new Error(`${file} is not the coffee geometry`);
  return raw;
}
const APP = geoAt("app/coffee.json");
const P = 3;
/** The app drawing's glance (`app/meta.json`). */
const GLANCE = { x: 277.9, y: 209.2 };
const RIG: CoffeeRig = { geo: APP, pitch: P, glance: GLANCE };
const LIFT = APP.lift[1];

/** Every 30 fps frame of the episode (33, 33, 34 ms). */
function frames(): number[] {
  const out: number[] = [];
  for (let n = 0; ; n++) {
    const t = Math.floor((Math.floor(n / 3) * 300 + (n % 3) * 100) / 3);
    if (t >= GESTURE_MS.coffee) break;
    out.push(t);
  }
  return out;
}

const at = (age: number) => coffeeFace(age, RIG);

describe("the coffee's geometry", () => {
  test("the app drawing's file: rims, lips, the lift between the rims in whole two-row steps, her glance as the rig's", () => {
    const g = APP;
    expect(g.lift[0]).toBe(0);
    expect(g.lift[1] % 2).toBe(0);
    const [hx, hy] = g.coffeeHold.rim;
    const [sx, sy] = g.coffeeSip.rim;
    // the sip's rim is the hold's raised by the lift (within a row)
    expect(Math.abs(hy - sy - g.lift[1] * P)).toBeLessThanOrEqual(P);
    expect(Math.abs(hx - sx)).toBeLessThan(P);
    // the raised rim meets her lips (within a few rows), the lips right of its centre
    expect(Math.abs(g.lips[1] - sy)).toBeLessThan(6 * P);
    expect(g.lips[0]).toBeGreaterThan(sx);
    // the rig's glance is the drawing's own (`GLANCE` above is what the real file says)
    const meta = jsonAt("app/meta.json") as { glance?: unknown };
    expect(meta.glance).toEqual([GLANCE.x, GLANCE.y]);
    expect(isCoffeeGeo({ ...APP, lips: [1] })).toBe(false);
    expect(isCoffeeGeo(null)).toBe(false);
  });
});

describe("the episode's beats", () => {
  test("0 to 650 the mug rises in both hands, she looks down at it with a small smile, the steam from 350", () => {
    const a0 = at(0);
    expect(a0.map).toBe("coffeeHold");
    expect(a0.gp).toBe(0);
    expect(a0.hand?.rise).toBe(C_RISE);
    expect(a0.gaze).toEqual(GLANCE);
    expect(a0.coffee?.steam).toBe(0);
    expect(at(300).gp).toBe(1);
    expect(at(COFFEE_BEATS.risen).hand?.rise).toBe(0);
    expect(at(300).eyes).toBe("soft");
    expect(at(700).mouth).toBe("smile");
    expect(at(300).coffee?.steam).toBe(0);
    expect(at(400).coffee?.steam ?? 0).toBeGreaterThan(0);
    expect(at(1000).coffee?.steam).toBe(1);
    // she looks at the mug: just above its rim
    const rim = APP.coffeeHold.rim;
    expect(at(1000).gaze).toEqual({ x: rim[0], y: rim[1] - 6 });
    expect(at(1000).actors).toBe("coffee");
  });

  test("1700 to 2350 the raise: both drawings' hands move together, the dissolve in the middle, the lids lowering", () => {
    const [r0, r1] = COFFEE_BEATS.raise;
    let lastA = 1;
    let lastB = LIFT + 1;
    for (const t of frames().filter((u) => u >= r0 && u < r1)) {
      const f = at(t);
      const ha = f.from?.hand?.rise ?? 0;
      const hb = f.hand?.rise ?? 0;
      expect(f.map).toBe("coffeeSip");
      expect(f.from?.map).toBe("coffeeHold");
      // the hold's hand rises toward her lips while the sip's rises from that much lower
      expect(hb - ha).toBeGreaterThanOrEqual(LIFT - 2);
      expect(hb - ha).toBeLessThanOrEqual(LIFT + 2);
      expect(ha).toBeLessThanOrEqual(lastA);
      expect(hb).toBeLessThanOrEqual(lastB);
      lastA = ha;
      lastB = hb;
    }
    expect(at(1940).gp).toBe(0);
    expect(at(2100).gp).toBe(1);
    expect(at(1800).eyes).toBe("soft");
    expect(at(2000).eyes).toBe("content");
    expect(at(2300).lid).toBeCloseTo(0.62, 5);
    expect(at(2100).coffee?.steam).toBe(0);
  });

  test("2350 to 3900 the sip: content eyes half closed and lower in the middle, the mug tipping up two rows and back", () => {
    const sip = frames().filter((t) => t >= COFFEE_BEATS.sip[0] && t < COFFEE_BEATS.sip[1]);
    expect(sip.every((t) => at(t).eyes === "content")).toBe(true);
    expect(sip.every((t) => at(t).mouth === "none")).toBe(true);
    expect(sip.every((t) => at(t).lid >= 0.62)).toBe(true);
    expect(Math.max(...sip.map((t) => at(t).lid))).toBeCloseTo(0.78, 2);
    expect(at(2500).hand?.rise).toBe(0);
    expect(at(3100).hand?.rise).toBe(-2);
    expect(at(3700).hand?.rise).toBe(0);
    const rim = APP.coffeeSip.rim;
    expect(at(3100).gaze).toEqual({ x: rim[0], y: rim[1] - 2 * P - 6 });
  });

  test("3900 to 4550 she lowers it and looks back at you with a small smile; 4850 to 5650 the exhale, her lips calm", () => {
    const low = at(4000);
    expect(low.map).toBe("coffeeHold");
    expect(low.from?.map).toBe("coffeeSip");
    expect((low.hand?.rise ?? 0) - (low.from?.hand?.rise ?? 0)).toBeLessThanOrEqual(-LIFT + 2);
    const back = at(4600);
    expect(back.hand?.rise).toBe(0);
    expect(back.from ?? null).toBeNull();
    expect(back.eyes).toBe("soft");
    expect(back.mouth).toBe("smile");
    expect(back.gaze).toEqual(GLANCE);
    expect(at(4840).coffee?.puff).toBe(-1);
    expect(at(4900).coffee?.puff).toBe(50);
    expect(at(5000).mouth).toBe("calm");
    expect(at(5400).mouth).toBe("smile");
    expect(at(6000).coffee?.puff).toBe(-1);
  });

  test("6300 to 6900 the mug sinks back into her light; to 7600 her own face at you, nothing drawn", () => {
    const [s0, s1] = COFFEE_BEATS.sink;
    expect(at(s0).from?.hand?.rise ?? at(s0).hand?.rise).toBe(0);
    const sinking = at(6800);
    expect(sinking.map).toBe("base");
    expect(sinking.from?.map).toBe("coffeeHold");
    expect(sinking.from?.hand?.rise ?? 0).toBeGreaterThan(20);
    expect(at(6600).gp).toBe(0);
    expect(at(s1).gp).toBe(1);
    expect(at(6700).coffee?.steam).toBe(0);
    const end = at(7200);
    expect(end.map).toBeNull();
    expect(end.hand).toBeNull();
    expect(end.from ?? null).toBeNull();
    expect(end.eyes).toBeNull();
    expect(end.mouth).toBeNull();
    expect(end.gaze).toEqual(GLANCE);
    expect(end.coffee?.rim ?? null).toBeNull();
  });

  test("every frame: hands in whole two-row steps, the same face for the same age", () => {
    for (const t of frames()) {
      const f = at(t);
      for (const r of [f.hand?.rise ?? 0, f.from?.hand?.rise ?? 0])
        expect(Math.abs(r) % 2).toBe(0);
      expect(JSON.stringify(coffeeFace(t, RIG))).toBe(JSON.stringify(f));
    }
    expect(frames().length).toBe((GESTURE_MS.coffee * 3) / 100);
  });
});

describe("an interruption", () => {
  test("freezes the beat it caught and fades it in 300 ms: the drawing sinks into her light, her base comes in, no exhale", () => {
    // a hover 150 ms into the sip's hold at 3000: the beat at 2850, half faded
    const half = coffeeFace(3000, RIG, 0.5);
    expect(half.map).toBe("base");
    expect(half.gp).toBeCloseTo(0.5, 5);
    expect(half.from?.map).toBe("coffeeSip");
    expect(half.from?.hand?.rise ?? 0).toBeGreaterThan(0);
    expect(half.eyes).toBeNull();
    expect(half.mouth).toBeNull();
    expect(half.gaze).toEqual(GLANCE);
    const gone = coffeeFace(3150, RIG, 0);
    expect(gone.gp).toBe(1);
    // during the exhale: the steam fades, the exhale stops
    const ex = coffeeFace(5100, RIG, 0.4);
    expect(ex.coffee?.puff).toBe(-1);
    expect(ex.coffee?.steam ?? 1).toBeLessThan(0.5);
  });

  test("an app mood: its dissolve runs from the mug (sinking) instead of her base, with the mood's eyes and mouth", () => {
    const cut = coffeeFace(1200, RIG, 0.6);
    const listening: FaceState = { ...NO_FACE, eyes: "open", mouth: "calm" };
    const into = coffeeIntoMood(cut, listening);
    expect(into.map).toBe("base");
    expect(into.gp).toBeCloseTo(cut.gp, 5);
    expect(into.from?.map).toBe("coffeeHold");
    expect(into.eyes).toBe("open");
    expect(into.mouth).toBe("calm");
    expect(into.actors).toBe("coffee");
    const thinking: FaceState = {
      ...NO_FACE,
      map: "think",
      gp: 0.3,
      eyes: "open",
    };
    const think = coffeeIntoMood(cut, thinking);
    expect(think.map).toBe("think");
    expect(think.gp).toBe(0.3);
    expect(think.from?.map).toBe("coffeeHold");
  });
});

describe("reduced motion and the steam", () => {
  test("the still: her holding the mug, the soft eyes and smile at you, the steam, no exhale; the same dots at any time", () => {
    const s = coffeeStill(RIG);
    expect(s.map).toBe("coffeeHold");
    expect(s.gp).toBe(1);
    expect(s.hand).toEqual({ map: "coffeeHold", rise: 0, di: 0, p: 1 });
    expect(s.eyes).toBe("soft");
    expect(s.mouth).toBe("smile");
    expect(s.lid).toBeCloseTo(0.22, 5);
    expect(s.gaze).toEqual(GLANCE);
    expect(s.coffee?.steam).toBe(1);
    expect(s.coffee?.puff).toBe(-1);
    const dots = (t: number) => {
      const w: number[] = [];
      const k: number[] = [];
      if (s.coffee) drawCoffee(w, k, s.coffee, t, true, [], () => false);
      return [w, k];
    };
    expect(dots(0)[0]?.length ?? 0).toBeGreaterThan(30);
    expect(dots(4321)).toEqual(dots(0));
  });

  test("two wisps rise from the rim, lean away from her face, scroll with the clock; ink where they cross her white planes", () => {
    const m = at(1000).coffee;
    expect(m).toBeDefined();
    if (!m || m.rim === null) return;
    const [rx, ry] = m.rim;
    const white: number[] = [];
    const ink: number[] = [];
    drawCoffee(white, ink, m, 1000, false, [], () => false);
    expect(white.length).toBeGreaterThan(60);
    expect(ink.length).toBe(0);
    const xs = white.filter((_, i) => i % 3 === 0);
    const ys = white.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeLessThan(ry);
    expect(Math.min(...ys)).toBeGreaterThan(ry - 120);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeLessThan(rx);
    // the clouds' screen: dots on a 5 px brick grid
    expect(ys.every((y) => Math.abs(y / 5 - Math.round(y / 5)) < 1e-9)).toBe(true);
    // over her white planes the same dots print in ink, smaller
    const w2: number[] = [];
    const k2: number[] = [];
    drawCoffee(w2, k2, m, 1000, false, [], () => true);
    expect(w2.length).toBe(0);
    expect(k2.length).toBe(white.length);
    expect((k2[2] ?? 0) / (white[2] ?? 1)).toBeCloseTo(0.68, 5);
    expect(STEAM_INK_ALPHA).toBe(0.72);
    // it moves with the clock
    const later: number[] = [];
    drawCoffee(later, [], m, 1400, false, [], () => false);
    expect(later).not.toEqual(white);
    // a page block over the rim keeps it clear
    const kept: number[] = [];
    drawCoffee(kept, [], m, 1000, false, [[rx - 200, ry - 200, rx + 200, ry, 0]], () => false);
    expect(kept.length).toBe(0);
  });

  test("the exhale: a few dots from her lips drifting forward and up, none in a still frame", () => {
    const m = at(5100).coffee;
    expect(m?.puff).toBe(250);
    if (!m) return;
    const steamOnly = { ...m, puff: -1 };
    const a: number[] = [];
    const b: number[] = [];
    drawCoffee(a, [], steamOnly, 5100, false, [], () => false);
    drawCoffee(b, [], m, 5100, false, [], () => false);
    const puff = b.slice(a.length);
    expect(puff.length).toBeGreaterThanOrEqual(3 * 3);
    const [lx, ly] = m.lips;
    for (let i = 0; i < puff.length; i += 3) {
      expect(puff[i] ?? 0).toBeLessThan(lx);
      expect(Math.abs((puff[i + 1] ?? 0) - ly)).toBeLessThan(30);
    }
    const still: number[] = [];
    drawCoffee(still, [], m, 5100, true, [], () => false);
    const stillSteam: number[] = [];
    drawCoffee(stillSteam, [], steamOnly, 5100, true, [], () => false);
    expect(still).toEqual(stillSteam);
  });
});
