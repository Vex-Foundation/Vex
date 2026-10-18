/**
 * K2's morning coffee (the owner, 2026-10-18, approved on its prototype video, as on the web app):
 * in the morning she drinks from a plain white mug, an idle action of her pool
 * (`GESTURE_MS.coffee`, the schedule `COFFEE` and `GestureChain.setMorning` in `k2-time.ts`).
 *
 * Her drawings: `coffeeHold` (the mug cradled in both hands at her upper chest) and `coffeeSip` (the
 * same mug raised to her lips), screened on the app drawing's frame (`public/art/vex-k2/app/`, the
 * frame the Vex sidebar and the welcome draw), with the mug's rims and her lips (`coffee.json`).
 * The two hands and the mug are one hand region on each drawing, so they rise out of her light like
 * her other hands; the eyes and the mouth stay authored on the screen.
 *
 * The episode, 7.6 s at 30 fps (`coffeeFace`, ms from its start):
 *
 * - 0 to 650 the mug rises in both hands to her upper chest (the 300 ms dissolve to `coffeeHold`),
 *   she looks down at it with a small smile; from 350 two thin wisps of steam rise from its rim;
 * - 1700 to 2350 she raises it to her lips: both drawings' hands move together (the hold's up by the
 *   rims' lift, the sip's from that much lower), the dissolve between them in the middle of the move,
 *   her lids lowering into the content eye, the steam gone;
 * - 2350 to 3900 the sip, eyes half closed and content, the mug tipping up two rows and back;
 * - 3900 to 4550 she lowers it, opens her eyes and looks back at you with a small smile, the steam
 *   back; 4850 to 5650 a tiny exhale of dots from her lips (her lips calm);
 * - 6300 to 6900 the mug sinks back into her light (the dissolve to her base);
 * - to 7600 her default gaze at you.
 *
 * On the bust (the welcome, the Vex sidebar) the cut under her necklace would dissolve the mug she
 * holds, so while the coffee shows the host re-fits her with a cut under the mug (`MUG_FOOT`) and
 * the engine eases between the two fits, and back after it.
 *
 * An interruption (a hover, any state but Idle, the close; `gestureAt`'s fade) freezes the beat it
 * caught and fades it out over 300 ms: the drawing it showed sinks back into her light while her
 * base (or the emotion's face, `coffeeIntoMood`) dissolves in, the steam gone in 250 ms. Reduced
 * motion in the morning: one still frame of her holding the mug, looking at you, smiling
 * (`coffeeStill`).
 *
 * The steam and the exhale are drawn in code on the clouds' brick hex screen (pitch 5, rmax 2.2 in
 * map px, so they scale with her), dot area by density with the clouds' curve; white dots over the
 * sky and her hair, ink where they cross her white planes (the blow's rule, `drawCoffee`). Pure: every
 * frame follows from the age, the fade and her drawing's geometry.
 */
import { hash01, noise2 } from "./k2-rand.js";
import { type KeepRect, keepOut } from "./k2-scene.js";
import {
  type CoffeeMarks,
  clamp,
  type EyeMode,
  type FaceState,
  type GazeTarget,
  type Hand,
  lerp,
  type MapName,
  type MouthName,
  NO_FACE,
  ramp,
  smooth,
} from "./k2-time.js";

/** The coffee's drawings. */
export const COFFEE_MAPS: readonly MapName[] = ["coffeeHold", "coffeeSip"];

/** A mug's rim on a drawing: its centre and half width (map px). */
type Rim = readonly [number, number, number];

/** The coffee's geometry (`coffee.json`, map px of its drawing). */
export interface CoffeeGeo {
  /** Her lips, where the exhale leaves. */
  readonly lips: readonly [number, number];
  /** The sip's region rises from the hold's place: [columns, rows] between the two rims. */
  readonly lift: readonly [number, number];
  readonly coffeeHold: { readonly rim: Rim };
  readonly coffeeSip: { readonly rim: Rim };
}

const nums = (v: unknown, n: number): boolean =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

const rimOk = (v: unknown): boolean =>
  typeof v === "object" && v !== null && nums((v as Record<string, unknown>)["rim"], 3);

/** The coffee's geometry as the converter writes it (`coffee.json`); anything else is refused. */
export function isCoffeeGeo(v: unknown): v is CoffeeGeo {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const g = v as Record<string, unknown>;
  return nums(g["lips"], 2) && nums(g["lift"], 2) && rimOk(g["coffeeHold"]) && rimOk(g["coffeeSip"]);
}

/** Her drawing's constants the coffee needs. */
export interface CoffeeRig {
  readonly geo: CoffeeGeo;
  /** The screen's pitch (map px per row). */
  readonly pitch: number;
  /** Where she looks at you (her map's glance). */
  readonly glance: GazeTarget;
}

/** The episode's beats, ms from its start. */
export const COFFEE_BEATS = {
  /** The mug has risen to her chest; the steam starts. */
  risen: 650,
  steam: 350,
  /** She raises it to her lips, the sip, she lowers it. */
  raise: [1700, 2350],
  sip: [2350, 3900],
  lower: [3900, 4550],
  /** The tiny exhale of dots from her lips. */
  exhale: [4850, 5650],
  /** The mug sinks back into her light. */
  sink: [6300, 6900],
  end: 7600,
} as const;

/**
 * The hold's mug and the fingers round it end at this map y (row 146 of `coffeeHold`): a bust cut
 * whose dissolve began above it would dissolve the mug, so while the coffee shows the bust's cut
 * drops under it (`k2-rig.ts` `BUST.coffeeCut`).
 */
export const MUG_FOOT = 438;

/** Rows the mug rises from and sinks to (her other hands rise 34). */
export const C_RISE = 40;
/** An interruption fades the coffee out this fast (ms); the steam goes in `STEAM_OUT`. */
export const COFFEE_FADE = 300;
const STEAM_OUT = 250;
const SINK_MS = 350;

/** Whole steps of two rows keep the brick hex screen. */
const even = (v: number): number => Math.round(v / 2) * 2 || 0;
const easeOut = (a: number): number => 1 - (1 - a) ** 3;
const easeIn = (a: number): number => a * a * a;
const easeIO = (a: number): number => (a < 0.5 ? 4 * a * a * a : 1 - (-2 * a + 2) ** 3 / 2);

type Drawing = MapName;

/**
 * One moment of the episode: the drawing it dissolves from (A) and to (B) by `p`, each hand's rows
 * still to rise (null: no hand), the eyes, the lids, the mouth, the gaze, the steam and its rim (a
 * drawing and its hand's rows), the exhale's age.
 */
interface Beat {
  readonly A: Drawing;
  readonly B: Drawing;
  readonly p: number;
  readonly hA: number | null;
  readonly hB: number | null;
  readonly eyes: EyeMode | null;
  readonly lid: number;
  readonly mouth: MouthName | null;
  readonly gaze: "you" | "mug";
  readonly steam: number;
  readonly rimAt: readonly [Drawing, number] | null;
  readonly puff: number;
}

function rimOf(rig: CoffeeRig, map: Drawing, dj: number): Rim {
  const r = map === "coffeeSip" ? rig.geo.coffeeSip.rim : rig.geo.coffeeHold.rim;
  return [r[0], r[1] + dj * rig.pitch, r[2]];
}

/** The beat at `a` ms. */
function beatAt(a: number, rig: CoffeeRig): Beat {
  const LIFT = rig.geo.lift[1];
  if (a < COFFEE_BEATS.raise[0]) {
    const dj = even((1 - easeOut(ramp(a, 0, COFFEE_BEATS.risen))) ** 1.4 * C_RISE);
    return {
      A: "base",
      B: "coffeeHold",
      p: ramp(a, 0, 300),
      hA: null,
      hB: dj,
      eyes: a < 250 ? null : "soft",
      lid: 0,
      mouth: a < 600 ? null : "smile",
      gaze: a < 200 ? "you" : "mug",
      steam: ramp(a, COFFEE_BEATS.steam, 900),
      rimAt: ["coffeeHold", dj],
      puff: -1,
    };
  }
  if (a < COFFEE_BEATS.raise[1]) {
    const q = easeIO(ramp(a, COFFEE_BEATS.raise[0], COFFEE_BEATS.raise[1]));
    return {
      A: "coffeeHold",
      B: "coffeeSip",
      p: ramp(a, 1950, 2100),
      hA: -even(q * LIFT),
      hB: even((1 - q) * LIFT),
      eyes: a < 1900 ? "soft" : "content",
      lid: lerp(0.3, 0.62, ramp(a, 1900, 2300)),
      mouth: a < 2000 ? "smile" : "none",
      gaze: "mug",
      steam: 1 - ramp(a, 1700, 2050),
      rimAt: ["coffeeHold", -even(q * LIFT)],
      puff: -1,
    };
  }
  if (a < COFFEE_BEATS.sip[1]) {
    // the mug tips up two rows and back
    const tilt = smooth(ramp(a, 2700, 2900)) * (1 - smooth(ramp(a, 3300, 3500)));
    const dj = tilt > 0.5 ? -2 : 0;
    return {
      A: "coffeeSip",
      B: "coffeeSip",
      p: 1,
      hA: dj,
      hB: dj,
      eyes: "content",
      lid: 0.62 + 0.16 * smooth(ramp(a, 2750, 3150)) * (1 - smooth(ramp(a, 3350, 3750))),
      mouth: "none",
      gaze: "mug",
      steam: 0,
      rimAt: ["coffeeSip", dj],
      puff: -1,
    };
  }
  if (a < 4600) {
    const q = easeIO(ramp(a, COFFEE_BEATS.lower[0], COFFEE_BEATS.lower[1]));
    return {
      A: "coffeeSip",
      B: "coffeeHold",
      p: ramp(a, 4150, 4300),
      hA: even(q * LIFT),
      hB: -even((1 - q) * LIFT),
      eyes: a < 4200 ? "content" : "soft",
      lid: 0.62,
      mouth: a < 4250 ? "none" : "smile",
      gaze: a < 4250 ? "mug" : "you",
      steam: ramp(a, 4350, 4900),
      rimAt: ["coffeeHold", -even((1 - q) * LIFT)],
      puff: -1,
    };
  }
  if (a < COFFEE_BEATS.sink[0]) {
    const e0 = COFFEE_BEATS.exhale[0];
    return {
      A: "coffeeHold",
      B: "coffeeHold",
      p: 1,
      hA: 0,
      hB: 0,
      eyes: "soft",
      lid: 0,
      // her lips calm for the exhale
      mouth: a > 4800 && a < 5350 ? "calm" : "smile",
      gaze: "you",
      steam: Math.min(ramp(a, 4350, 4900), 1 - ramp(a, 6250, 6600)),
      rimAt: ["coffeeHold", 0],
      puff: a >= e0 && a < 6000 ? a - e0 : -1,
    };
  }
  if (a < 7100) {
    const dj = even(easeIn(ramp(a, COFFEE_BEATS.sink[0], COFFEE_BEATS.sink[1])) * C_RISE);
    return {
      A: "coffeeHold",
      B: "base",
      p: ramp(a, 6600, 6900),
      hA: dj,
      hB: null,
      eyes: a < 6800 ? "soft" : null,
      lid: 0,
      mouth: a < 6900 ? "smile" : null,
      gaze: "you",
      steam: 1 - ramp(a, 6250, 6600),
      rimAt: ["coffeeHold", dj],
      puff: -1,
    };
  }
  return {
    A: "base",
    B: "base",
    p: 1,
    hA: null,
    hB: null,
    eyes: null,
    lid: 0,
    mouth: null,
    gaze: "you",
    steam: 0,
    rimAt: null,
    puff: -1,
  };
}

const handOf = (map: Drawing, rise: number | null, p: number): Hand | null =>
  rise === null || map === "base" ? null : { map, rise, di: 0, p };

/** A beat as her face: B dissolving in over A, each with its hand. */
function faceOf(b: Beat, rig: CoffeeRig): FaceState {
  const rim = b.rimAt === null ? null : rimOf(rig, b.rimAt[0], b.rimAt[1]);
  const marks: CoffeeMarks = {
    steam: b.steam,
    rim,
    puff: b.puff,
    lips: rig.geo.lips,
  };
  const gaze: GazeTarget = b.gaze === "mug" && rim !== null ? { x: rim[0], y: rim[1] - 6 } : rig.glance;
  const same = b.A === b.B;
  const plain = b.B === "base" && (same || b.A === "base");
  return {
    ...NO_FACE,
    map: plain ? null : b.B,
    gp: plain ? 0 : same ? 1 : b.p,
    hand: handOf(b.B, b.hB, same ? 1 : b.p),
    eyes: b.eyes,
    mouth: b.mouth,
    gaze,
    lid: b.lid,
    actors: "coffee",
    from: same || b.A === "base" ? null : { map: b.A, hand: handOf(b.A, b.hA, 1) },
    coffee: marks,
  };
}

/**
 * Her face `age` ms into the coffee; with `fade` < 1 (an interruption, `gestureAt`) the beat it
 * caught (`COFFEE_FADE` ms of fade ago) fades out: the drawing it showed sinks back into her light
 * while her base dissolves in, the steam gone in 250 ms, no exhale.
 */
export function coffeeFace(age: number, rig: CoffeeRig, fade = 1): FaceState {
  if (fade >= 1) return faceOf(beatAt(age, rig), rig);
  const d = (1 - clamp(fade, 0, 1)) * COFFEE_FADE;
  const b = beatAt(age - d, rig);
  const shown = b.p >= 0.5 ? b.B : b.A;
  const h = b.p >= 0.5 ? b.hB : b.hA;
  const sink = even(easeIn(ramp(d, 0, SINK_MS)) * C_RISE);
  const rim = b.rimAt === null ? null : rimOf(rig, b.rimAt[0], b.rimAt[1]);
  return {
    ...NO_FACE,
    map: shown === "base" ? null : "base",
    gp: shown === "base" ? 0 : ramp(d, 0, COFFEE_FADE),
    gaze: rig.glance,
    actors: "coffee",
    from:
      shown === "base"
        ? null
        : { map: shown, hand: handOf(shown, h === null ? null : h + sink, 1) },
    coffee: {
      steam: b.steam * (1 - ramp(d, 0, STEAM_OUT)),
      rim,
      puff: -1,
      lips: rig.geo.lips,
    },
  };
}

/**
 * The coffee cut by an emotion other than idle (`coffeeFace` with its fade, and the emotion's face):
 * the emotion's dissolve runs from the coffee's drawing (its hand sinking) instead of her base, so
 * the mug leaves cell by cell as the emotion's face comes in; the emotion's eyes, mouth and hand;
 * the steam fading.
 */
export function coffeeIntoMood(coffee: FaceState, mood: FaceState): FaceState {
  const plain = mood.map === null;
  return {
    ...mood,
    map: plain ? ((coffee.from ?? null) === null ? null : "base") : mood.map,
    gp: plain ? coffee.gp : mood.gp,
    from: coffee.from ?? mood.from ?? null,
    actors: "coffee",
    coffee: coffee.coffee ?? null,
  };
}

/** Reduced motion in the morning: her holding the mug, looking at you, the soft smile, the steam. */
export function coffeeStill(rig: CoffeeRig): FaceState {
  return faceOf(
    {
      A: "coffeeHold",
      B: "coffeeHold",
      p: 1,
      hA: 0,
      hB: 0,
      eyes: "soft",
      lid: 0.22,
      mouth: "smile",
      gaze: "you",
      steam: 1,
      rimAt: ["coffeeHold", 0],
      puff: -1,
    },
    rig,
  );
}

/* ------------------------------------------------------------------ the steam and the exhale */

/** The clouds' own screen (the wide pitch), as the blow's cloud. */
const SCREEN = { pitch: 5, rmax: 2.2 } as const;
/** The clouds' density gain: a dot's area follows its density through this curve. */
export const CLOUD_GAIN = 1.6;
/** The wisps: offset across the rim (half widths), phase, strength. */
const WISPS: readonly (readonly [number, number, number])[] = [
  [-0.42, 0.3, 1],
  [0.05, 2.6, 0.85],
];
/** How high the steam rises above the rim (map px). */
const STEAM_H = 110;
/** A dot over her white planes prints in ink, a little smaller and quieter (`STEAM_INK_ALPHA`). */
const INK_R = 0.68;
export const STEAM_INK_ALPHA = 0.72;

/**
 * The coffee's actors at frame time `t` (ms; 0 in a still frame): two thin wisps of steam from the
 * mug's rim and the tiny exhale from her lips, as (x, y, r) triples in map px, white dots in `out`
 * and the ink ones (where a dot crosses her white planes, `light`) in `outInk`. Each wisp is a thin
 * sinuous band that rises (its phase scrolls up with the clock), leans away from her face over her
 * dark hair, widens and breaks up into single dots as it rises; the exhale drifts forward and up,
 * fading. Every dot keeps out of the host's blocks (`keep`).
 */
export function drawCoffee(
  out: number[],
  outInk: number[],
  m: CoffeeMarks,
  t: number,
  still: boolean,
  keep: readonly KeepRect[],
  light: (x: number, y: number) => boolean,
): void {
  const SP = SCREEN.pitch;
  const SR = SCREEN.rmax;
  const put = (x: number, y: number, d: number) => {
    let r = SR * Math.sqrt(Math.min(1, d * CLOUD_GAIN));
    if (r < SR * 0.3) return;
    r *= keepOut(keep, x, y);
    if (r < SR * 0.3) return;
    if (light(x, y)) outInk.push(x, y, r * INK_R);
    else out.push(x, y, r);
  };
  const tt = still ? 0 : t;
  if (m.steam > 0.001 && m.rim !== null) {
    const [rx, ry, hw] = m.rim;
    const step = still ? 0 : Math.floor(tt / 100);
    const j0 = Math.floor((ry - STEAM_H - 8) / SP);
    const j1 = Math.ceil((ry - 2) / SP);
    for (let j = j0; j <= j1; j++) {
      const y = j * SP;
      const h = ry - y;
      if (h < 2 || h > STEAM_H) continue;
      const v = h / STEAM_H;
      const i0 = Math.floor((rx - hw - 60) / SP);
      const i1 = Math.ceil((rx + hw) / SP);
      for (let i = i0; i <= i1; i++) {
        const x = i * SP + (j & 1) * SP * 0.5;
        let d = 0;
        WISPS.forEach(([ox, ph, k], w) => {
          const amp = 1.6 + 0.1 * h;
          const xc =
            rx + ox * hw - 0.38 * h - 0.0028 * h * h + amp * Math.sin(h / 10 - tt / 260 + ph);
          const u = Math.abs(x - xc) / (SP * (0.95 - 0.25 * v));
          if (u >= 1) return;
          // puffs rise along it; it thins as it rises and breaks up into dots near the top
          let dw =
            (1 - u * u) ** 0.6 *
            (1 - v) ** 0.6 *
            k *
            (0.62 + 0.38 * Math.sin(h / 11 - tt / 180 + ph));
          const n = 0.5 + 0.5 * noise2(x / 8, (y + tt * 0.05) / 8, 941 + w);
          if (v > 0.45 && n < (v - 0.45) * 1.3) dw *= 0.15;
          if (!still && hash01(i, j, step * 5 + w) < 0.04) dw *= 0.5;
          d = Math.max(d, dw);
        });
        d *= Math.min(1, (h - 2) / 8) * m.steam;
        if (d > 0.03) put(x, y, d);
      }
    }
  }
  if (m.puff >= 0 && !still) {
    const [lx, ly] = m.lips;
    for (let n = 0; n < 6; n++) {
      const a = m.puff - n * 60;
      if (a < 0 || a > 800) continue;
      const q = a / 800;
      const x = lx - 6 - q * (40 + n * 4) + (hash01(n, 3, 951) - 0.5) * 6;
      const y = ly + 2 - q * (18 + n * 3) + (hash01(n, 4, 951) - 0.5) * 5;
      const j = Math.round(y / SP);
      const i = Math.round((x - (j & 1) * SP * 0.5) / SP);
      put(i * SP + (j & 1) * SP * 0.5, j * SP, 0.62 * (1 - q) + 0.06);
    }
  }
}
