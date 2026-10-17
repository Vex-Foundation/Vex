/**
 * K2's timeline: every beat of her as a pure function of the clock
 * (`docs/design/R3-MINIMAL.md section 10`):
 *
 * - the wake: the token presses, turns flat, its beam of dots rises, she assembles bottom up asleep,
 *   rises, yawns behind her hand, rubs an eye, blinks twice, looks at you and smiles (about 9 s);
 *   `projector` and `wakeState`;
 * - the gestures (blow the cloud, the bird on her palm, the giggle on a click), one at a time, never
 *   during a hover, with a fixed rhythm; `GestureChain`, `gestureAt`, `gestureState`;
 * - the idle life: blinks, gusts of wind, the smirk, and now and then she looks at you
 *   (`LookChain`, `lookAt`).
 *
 * Nothing here reads a clock, the DOM or `Math.random()`: the engine passes t (ms of her own clock,
 * which stops while she is off screen) and the inputs (the hover, the clicks), so each frame follows
 * from them and the tests can step through any moment. Coordinates are her map's px (the wide
 * drawing's own frame, `k2-rig.ts`).
 */
import { hash01, noise1, schedule } from "./k2-rand.js";

export const clamp = (v: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, v));
export const smooth = (a: number): number => a * a * (3 - 2 * a);
export const lerp = (a: number, b: number, q: number): number =>
  a + (b - a) * q;
/** 0 before a, 1 after b, linear between. */
export const ramp = (t: number, a: number, b: number): number =>
  clamp((t - a) / (b - a), 0, 1);

/** Her clock steps at 10 fps (the brief): a frame's time is a whole step. */
export const STEP_MS = 100;

/* ------------------------------------------------------------------ the wake */

/** The projector's beats, ms from the start of the wake. */
export const T_PRESS = 700;
export const T_FLIP = [960, 1600] as const;
export const T_CONE = [1450, 2050] as const;
export const T_ASM = [1850, 3300] as const;
/** The wake proper starts when she has assembled. */
export const W0 = T_ASM[1];

/**
 * How she wakes: `full` on the wide drawing (asleep, the yawn and the rub have their own drawings),
 * `short` without those drawings (she assembles with her eyes closed, then blinks, looks at you and
 * smiles), `none` when she starts awake (no wake asked, or reduced motion).
 */
export type WakeMode = "full" | "short" | "none";

const WAKE_SPAN: Readonly<Record<WakeMode, number>> = {
  full: 5800,
  short: 3000,
  none: 0,
};

/** When the wake hands her over to her normal life (ms); 0 when she starts awake. */
export function wakeEnd(mode: WakeMode): number {
  return mode === "none" ? 0 : W0 + WAKE_SPAN[mode];
}

export interface Projector {
  /** The token pressed like a key, 0..1. */
  readonly press: number;
  /** Face-on (0) to lying flat (1), eased. */
  readonly flip: number;
  /** The cone of light grown, 0..1. */
  readonly cone: number;
  /** She is assembled, 0..1 (bottom up). */
  readonly asm: number;
}

const AWAKE: Projector = { press: 0, flip: 1, cone: 1, asm: 1 };

/** The projector at t: the press, the turn to flat, the cone, the assembly (all done when awake). */
export function projector(t: number, mode: WakeMode): Projector {
  if (mode === "none") return AWAKE;
  const a = t - T_PRESS;
  const press =
    a < 0 || a > 260
      ? 0
      : a < 100
        ? 1 - (1 - a / 100) ** 3
        : 1 - smooth((a - 100) / 160);
  const fr = ramp(t, T_FLIP[0], T_FLIP[1]);
  const flip = fr < 0.5 ? 4 * fr * fr * fr : 1 - (-2 * fr + 2) ** 3 / 2;
  return {
    press,
    flip,
    cone: ramp(t, T_CONE[0], T_CONE[1]),
    asm: ramp(t, T_ASM[0], T_ASM[1]),
  };
}

/** Her drawings: the base and the hover, and one per gesture and wake beat. */
export type MapName =
  | "base"
  | "hover"
  | "blow"
  | "palm"
  | "giggle"
  | "asleep"
  | "yawn"
  | "rub";

/** The mouths authored on the screen (`rest` is her own, with its idle smirk). */
export type MouthName = "rest" | "calm" | "smile" | "pucker" | "o" | "none";

/**
 * The eyes: `map` the drawing's own (asleep), `closed`, `drowsy` (half), `squeeze` (`> <`),
 * `happy` (arcs), `soft` (the lids a little lower, the smile lifting the lower lid), `open`.
 */
export type EyeMode =
  | "map"
  | "closed"
  | "drowsy"
  | "squeeze"
  | "happy"
  | "soft"
  | "open";

/** A hand that rises out of her light: its drawing, rows still to rise, a column shift, its dissolve. */
export interface Hand {
  readonly map: MapName;
  readonly rise: number;
  readonly di: number;
  readonly p: number;
}

/** Where she looks: a point of her map, or the gesture's cloud as it drifts. */
export type GazeTarget = { readonly x: number; readonly y: number };

/** What every part of her does at one moment of a gesture or of the wake. */
export interface FaceState {
  /** The drawing it dissolves to, and how far (0..1, the 300 ms Bayer dissolve). */
  readonly map: MapName | null;
  readonly gp: number;
  readonly hand: Hand | null;
  /** Shoulder rows up (gestures only). */
  readonly sh: number;
  readonly eyes: EyeMode | null;
  readonly mouth: MouthName | null;
  readonly blush: number;
  readonly gaze: GazeTarget | null;
  readonly actors: "cloud" | "bird" | null;
  /** The nose mark shows (hidden while the asleep drawing carries its own face). */
  readonly nose: boolean;
  /** A blink layered on top (the wake's two). */
  readonly lid: number;
  /** The yawn's tear, 0..1. */
  readonly tear: number;
  /** Rows down (map px), whole steps of two rows: asleep she sits low. */
  readonly dy: number;
  /** Her brightness while she wakes, 0.8..1. */
  readonly dim: number;
  /** A gesture fading out under a hover, 1..0. */
  readonly fade: number;
}

export const NO_FACE: FaceState = {
  map: null,
  gp: 0,
  hand: null,
  sh: 0,
  eyes: null,
  mouth: null,
  blush: 0,
  gaze: null,
  actors: null,
  nose: true,
  lid: 0,
  tear: 0,
  dy: 0,
  dim: 1,
  fade: 1,
};

const DY0 = 36;
const blinkOnce = (x: number): number =>
  x < 0 ? 0 : x < 90 ? 0.55 : x < 200 ? 1 : x < 290 ? 0.55 : 0;

/**
 * The wake at t as a face state, or null once she is awake. `pitch` and `k` are her map's (3 and 1
 * on the wide drawing): asleep she sits 36 map px low and rises in whole steps of
 * two rows. `glance` is the point she looks at when she has woken (out at you).
 */
export function wakeState(
  t: number,
  mode: WakeMode,
  pitch: number,
  k: number,
  glance: GazeTarget,
): FaceState | null {
  if (mode === "none" || t >= wakeEnd(mode)) return null;
  const a = t - W0;
  const r = 1 - (1 - ramp(a, 600, 1500)) ** 3;
  const dy = Math.round((DY0 * k * (1 - r)) / (2 * pitch)) * 2 * pitch;
  const base = { ...NO_FACE, dy, dim: lerp(0.8, 1, r) };
  if (mode === "short") {
    if (a < 1200) return { ...base, eyes: "closed", mouth: "calm" };
    return {
      ...base,
      eyes: a >= 2300 ? "soft" : "open",
      lid: Math.max(blinkOnce(a - 1500), blinkOnce(a - 1900)),
      gaze: glance,
      mouth: a < 2300 ? "calm" : "smile",
    };
  }
  if (a < 1200) {
    const gp = 1 - ramp(a, 900, 1200);
    return {
      ...base,
      map: "asleep",
      gp,
      eyes: gp >= 0.5 ? "map" : "closed",
      nose: gp < 0.5,
      mouth: gp >= 0.5 ? "none" : "calm",
    };
  }
  if (a < 1500) return { ...base, eyes: "closed", mouth: "calm" };
  if (a < 2800) {
    const gp = ramp(a, 1500, 1800) * (1 - ramp(a, 2500, 2800));
    const up = ramp(a, 1500, 2000);
    const down = ramp(a, 2400, 2800);
    return {
      ...base,
      map: "yawn",
      gp,
      hand: {
        map: "yawn",
        rise: Math.round((1 - up * (1 - down)) ** 3 * 34),
        di: 0,
        p: gp,
      },
      eyes: a > 1600 && a < 2700 ? "squeeze" : "closed",
      mouth: a > 1650 && a < 2650 ? "none" : "calm",
      sh: a > 1800 && a < 2400 ? 1 : 0,
      tear: a > 1750 && a < 2650 ? ramp(a, 1750, 2350) : 0,
    };
  }
  if (a < 4000) {
    const gp = ramp(a, 2800, 3100) * (1 - ramp(a, 3700, 4000));
    const w = a - 3150;
    const seq = [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const;
    const sq =
      (w > 0 && w < 140 * 12 ? seq[Math.floor(w / 140) % seq.length] : undefined) ?? seq[0];
    return {
      ...base,
      map: "rub",
      gp,
      hand: { map: "rub", rise: sq[1] * 2, di: sq[0], p: gp },
      eyes: a > 2900 && a < 3900 ? "drowsy" : "closed",
      mouth: a > 2950 && a < 3850 ? "none" : "calm",
    };
  }
  return {
    ...base,
    eyes: a >= 5000 ? "soft" : "open",
    lid: Math.max(blinkOnce(a - 4300), blinkOnce(a - 4700)),
    gaze: glance,
    mouth: a < 5000 ? "calm" : "smile",
  };
}

/* ------------------------------------------------------------------ the gestures */

export type GestureName = "blow" | "bird" | "giggle";

export const GESTURE_MS: Readonly<Record<GestureName, number>> = {
  blow: 6400,
  bird: 7800,
  giggle: 2000,
};
/** Never two scheduled gestures within 20 s (end to start). */
export const GESTURE_GAP = 20000;
/** A giggle's cooldown after its end: clicks inside are ignored. */
export const GIGGLE_COOLDOWN = 8000;

export interface ScheduledGesture {
  readonly name: GestureName;
  readonly start: number;
}

/**
 * The idle pool's chain: the first blow 6 s after she is awake, the first
 * bird 20 s after; then a blow every 45 to 90 s and a bird every 60 to 120 s (seeded), never two
 * within 20 s. Pure in t: the chain extends itself as far as it is asked and never changes behind.
 */
export class GestureChain {
  readonly #ev: ScheduledGesture[] = [];
  #nb: number;
  #nd: number;
  #kb = 0;
  #kd = 0;
  #end: number;

  /** `force` (review in the dev harness) plays that gesture 1 s after she is awake instead. */
  constructor(awakeAt: number, force: "blow" | "bird" | null = null) {
    if (force !== null) {
      const at = awakeAt + 1000;
      this.#ev.push({ name: force, start: at });
      this.#end = at + GESTURE_MS[force];
      this.#nb =
        force === "blow" ? at + 45000 + hash01(0, 301) * 45000 : at + 29000;
      this.#nd =
        force === "bird" ? at + 60000 + hash01(0, 302) * 60000 : at + 29000;
      return;
    }
    this.#ev.push(
      { name: "blow", start: awakeAt + 6000 },
      { name: "bird", start: awakeAt + 20000 },
    );
    this.#end = awakeAt + 20000 + GESTURE_MS.bird;
    this.#nb = awakeAt + 6000 + 45000 + hash01(0, 301) * 45000;
    this.#nd = awakeAt + 20000 + 60000 + hash01(0, 302) * 60000;
  }

  /** The scheduled gesture running at t (with its age), or null. */
  at(t: number): (ScheduledGesture & { readonly age: number }) | null {
    while ((this.#ev[this.#ev.length - 1]?.start ?? 0) <= t) {
      const isBlow = this.#nb <= this.#nd;
      const name: GestureName = isBlow ? "blow" : "bird";
      const start = Math.max(
        isBlow ? this.#nb : this.#nd,
        this.#end + GESTURE_GAP,
      );
      this.#ev.push({ name, start });
      this.#end = start + GESTURE_MS[name];
      if (isBlow) {
        this.#kb++;
        this.#nb = start + 45000 + hash01(this.#kb, 301) * 45000;
      } else {
        this.#kd++;
        this.#nd = start + 60000 + hash01(this.#kd, 302) * 60000;
      }
    }
    for (let n = this.#ev.length - 1; n >= 0; n--) {
      const e = this.#ev[n];
      if (e === undefined || e.start > t) continue;
      return t < e.start + GESTURE_MS[e.name]
        ? { ...e, age: t - e.start }
        : null;
    }
    return null;
  }
}

/** Whether a click at t starts a giggle: she is awake and the last one's cooldown is over. */
export function canGiggle(
  t: number,
  giggles: readonly number[],
  awakeAt: number,
): boolean {
  if (t < awakeAt) return false;
  const last = giggles[giggles.length - 1];
  return last === undefined || t >= last + GESTURE_MS.giggle + GIGGLE_COOLDOWN;
}

export interface GestureInput {
  readonly t: number;
  /** Gestures can run at all (the wide drawing, motion allowed). */
  readonly enabled: boolean;
  /** When the wake handed her over (0 when she started awake). */
  readonly awakeAt: number;
  /** Click times on her clock. */
  readonly giggles: readonly number[];
  /**
   * What holds the idle pool back: a hover on her (or her products), a reply running, typing in
   * the composer. `holdAge` is ms since the hold began (-1 when none), `unholdAge` ms since the
   * last one ended (-1 when holding or never).
   */
  readonly hold: boolean;
  readonly holdAge: number;
  readonly unholdAge: number;
}

export interface ActiveGesture {
  readonly name: GestureName;
  readonly start: number;
  readonly age: number;
  /** A hold during a scheduled gesture fades it out in 300 ms. */
  readonly fade: number;
}

/**
 * The gesture at t, one at a time: a giggle (a click) wins; a scheduled gesture is cancelled by a
 * hold that began before it, faded out by one that begins during it, and stays gone after.
 */
export function gestureAt(
  chain: GestureChain,
  g: GestureInput,
): ActiveGesture | null {
  if (!g.enabled || g.t < g.awakeAt) return null;
  const t = g.t;
  for (let n = g.giggles.length - 1; n >= 0; n--) {
    const at = g.giggles[n] ?? 0;
    if (at > t) continue;
    if (t - at < GESTURE_MS.giggle)
      return { name: "giggle", start: at, age: t - at, fade: 1 };
    break;
  }
  const ev = chain.at(t);
  if (ev === null) return null;
  if (g.giggles.some((at) => at >= ev.start - GESTURE_MS.giggle && at <= t))
    return null;
  if (g.hold) {
    if (g.holdAge >= ev.age) return null;
    const fade = 1 - clamp(g.holdAge / 300, 0, 1);
    return fade > 0 ? { ...ev, fade } : null;
  }
  if (g.unholdAge >= 0 && t - g.unholdAge > ev.start) return null;
  return { ...ev, fade: 1 };
}

/* the blow's cloud: it gathers from wisps, then drifts toward her face (map px) */
export const BLOW = {
  c0: [1140, 142],
  c1: [1144, 160],
  c2: [1150, 226],
  form: 1700,
  drift: 3500,
  inhale: 3300,
  blow: 3900,
  recover: 5100,
} as const;

/** The blow cloud's centre at a gesture age (map px). */
export function cloudCentre(age: number): readonly [number, number] {
  const { c0, c1, c2 } = BLOW;
  if (age < BLOW.form)
    return [
      lerp(c0[0], c1[0], age / BLOW.form),
      lerp(c0[1], c1[1], age / BLOW.form),
    ];
  const q = smooth(ramp(age, BLOW.form, BLOW.drift));
  return [lerp(c1[0], c2[0], q), lerp(c1[1], c2[1], q)];
}

export type BirdFrame = "up" | "mid" | "down" | "flare" | "perch" | "peck";

export interface BirdState {
  readonly x: number;
  readonly y: number;
  readonly frame: BirdFrame;
  /** -1 flying left, 1 flying right. */
  readonly dir: number;
  readonly fly: boolean;
  /** Its ink outline where it sits on her white palm, 0..1. */
  readonly outline: number;
  /** Anchored at its feet (perched) rather than its centre. */
  readonly feet: boolean;
}

/** On her thumb and the heel of her palm (the palm redo). */
export const PERCH = [1405, 376] as const;

const CYCLE: readonly BirdFrame[] = ["up", "mid", "down", "mid"];

/**
 * The bird at a gesture age: it flies in from the right edge over the sky, lands on her palm, bobs
 * its head three times, and flies off to the upper right, away from the blocks it keeps out of.
 */
export function birdState(age: number): BirdState | null {
  const [px, py] = PERCH;
  const T_IN0 = 500;
  const T_LAND = 2500;
  const T_SIT = 2700;
  const T_OFF = 5300;
  const T_GONE = 6900;
  if (age < T_IN0 || age > T_GONE) return null;
  const cyc = CYCLE[Math.floor(age / 100) % 4] ?? "mid";
  if (age < T_LAND) {
    const s = 1 - (1 - ramp(age, T_IN0, T_LAND)) ** 1.6;
    const S = [1478, 168] as const;
    const C = [1456, 404] as const;
    const E = [px + 9, py - 10] as const;
    const x = (1 - s) * (1 - s) * S[0] + 2 * (1 - s) * s * C[0] + s * s * E[0];
    const y = (1 - s) * (1 - s) * S[1] + 2 * (1 - s) * s * C[1] + s * s * E[1];
    const glide = s > 0.42 && s < 0.7;
    const frame = age > T_LAND - 300 ? "flare" : glide ? "mid" : cyc;
    return {
      x,
      y,
      frame,
      dir: -1,
      fly: age < T_LAND - 300,
      outline: ramp(age, T_LAND - 400, T_LAND - 100),
      feet: false,
    };
  }
  if (age < T_SIT) {
    const q = smooth(ramp(age, T_LAND, T_SIT));
    return {
      x: px + 9 * (1 - q),
      y: py - 10 * (1 - q) * (1 - q),
      frame: age < T_LAND + 100 ? "flare" : "perch",
      dir: -1,
      fly: false,
      outline: 1,
      feet: true,
    };
  }
  if (age < T_OFF) {
    const a = age - T_SIT;
    const peck =
      (a > 700 && a < 900) || (a > 1000 && a < 1200) || (a > 1900 && a < 2100);
    return {
      x: px,
      y: py,
      frame: peck ? "peck" : "perch",
      dir: -1,
      fly: false,
      outline: 1,
      feet: true,
    };
  }
  if (age < T_OFF + 200)
    return {
      x: px,
      y: py,
      frame: age < T_OFF + 100 ? "peck" : "flare",
      dir: -1,
      fly: false,
      outline: 1,
      feet: true,
    };
  const s = ramp(age, T_OFF + 200, T_GONE) ** 1.25;
  const S = [px + 4, py - 12] as const;
  const C = [1418, 300] as const;
  const E = [1490, 104] as const;
  const x = (1 - s) * (1 - s) * S[0] + 2 * (1 - s) * s * C[0] + s * s * E[0];
  const y = (1 - s) * (1 - s) * S[1] + 2 * (1 - s) * s * C[1] + s * s * E[1];
  return {
    x,
    y,
    frame: cyc,
    dir: 1,
    fly: true,
    outline: 1 - ramp(age, T_OFF + 200, T_OFF + 600),
    feet: false,
  };
}

/** What each part of her does at this moment of a gesture. */
export function gestureState(g: ActiveGesture | null): FaceState {
  if (g === null) return NO_FACE;
  const a = g.age;
  let st: FaceState = NO_FACE;
  if (g.name === "blow") {
    let sh =
      a < BLOW.inhale + 100
        ? 0
        : a < BLOW.inhale + 250
          ? 1
          : a < BLOW.recover
            ? 2
            : a < BLOW.recover + 150
              ? 1
              : 0;
    // tense: a one-row tremble while she blows
    if (
      a > BLOW.blow + 200 &&
      a < BLOW.recover - 200 &&
      Math.floor(a / 100) % 4 === 0
    )
      sh = 1;
    const c = cloudCentre(a);
    st = {
      ...NO_FACE,
      map: "blow",
      gp:
        ramp(a, BLOW.inhale, BLOW.inhale + 300) *
        (1 - ramp(a, BLOW.recover, BLOW.recover + 300)),
      sh,
      eyes: a >= BLOW.inhale && a < BLOW.recover ? "squeeze" : null,
      mouth:
        a < BLOW.inhale
          ? null
          : a < BLOW.blow
            ? "pucker"
            : a < BLOW.recover
              ? "o"
              : a < GESTURE_MS.blow
                ? "smile"
                : null,
      gaze:
        a > 700 && a < BLOW.inhale
          ? { x: c[0], y: c[1] }
          : a >= BLOW.recover && a < BLOW.recover + 700
            ? { x: BLOW.c2[0] - 40, y: BLOW.c2[1] - 30 }
            : null,
      actors: "cloud",
    };
  } else if (g.name === "bird") {
    const up = ramp(a, 0, 650);
    const down = ramp(a, 6700, 7150);
    const gp = ramp(a, 0, 300) * (1 - ramp(a, 6850, 7150));
    const b = birdState(a);
    st = {
      ...NO_FACE,
      map: "palm",
      gp,
      hand: {
        map: "palm",
        rise: Math.round((1 - up * (1 - down)) ** 3 * 40),
        di: 0,
        p: gp,
      },
      gaze: b ? { x: b.x, y: b.y - 8 } : a < 600 ? { x: 1400, y: 300 } : null,
      eyes: a > 2500 && a < 7000 ? "soft" : null,
      mouth: a > 1200 && a < 7500 ? "smile" : null,
      blush: ramp(a, 2600, 3200) * (1 - ramp(a, 6600, 7400)),
      actors: "bird",
    };
  } else {
    const up = ramp(a, 0, 200);
    const down = ramp(a, 1750, 1950);
    const gp = ramp(a, 0, 150) * (1 - ramp(a, 1750, 1950));
    st = {
      ...NO_FACE,
      map: "giggle",
      gp,
      hand: {
        map: "giggle",
        rise: Math.round((1 - up * (1 - down)) ** 2 * 8),
        di: 0,
        p: gp,
      },
      // the shoulders shake one row, three times
      sh:
        (a > 400 && a < 600) || (a > 800 && a < 1000) || (a > 1200 && a < 1400)
          ? 1
          : 0,
      eyes: a > 100 && a < 1900 ? "happy" : null,
      mouth: a > 150 && a < 1850 ? "none" : null,
    };
  }
  const fd = g.fade;
  if (fd >= 1) return st;
  const faded: FaceState = {
    ...st,
    gp: st.gp * fd,
    hand: st.hand ? { ...st.hand, p: st.hand.p * fd } : null,
    blush: st.blush * fd,
    fade: fd,
  };
  return fd < 0.5 ? { ...faded, eyes: null, mouth: null, sh: 0 } : faded;
}

/* ------------------------------------------------------------------ idle life */

/** Slow gusts over a light breeze, 0..1. */
export function gustAt(t: number): number {
  const n = noise1(t / 3400, 41) * 0.65 + noise1(t / 1300, 42) * 0.35;
  return smooth(clamp((n + 0.15) / 0.9, 0, 1));
}

/** A blink every 2.5 to 6.5 s: half, closed, half (100 ms steps); one in four is a double. */
export function blinkAt(t: number): number {
  const s = schedule(t, 77, 2500, 6500, 700);
  if (!s.on) return 0;
  const dbl = hash01(s.index, 78) < 0.25;
  const one = (x: number) =>
    x < 0 ? 0 : x < 100 ? 0.55 : x < 220 ? 1 : x < 320 ? 0.55 : 0;
  return Math.max(one(s.age), dbl ? one(s.age - 380) : 0);
}

/* ------------------------------------------------------------------ she looks at you */

/**
 * Now and then she looks at the viewer: her eyes turn straight out (the wake's last beat), held 1.5
 * to 3 s, at rest every 8 to 20 s, right after a gesture ends, when the window is shown again after
 * 10 s or more away; about one in three paired with the soft smile or a slow blink.
 */
export const LOOK = {
  gapMin: 8000,
  gapMax: 20000,
  holdMin: 1500,
  holdMax: 3000,
  /** Away this long, the window shown again makes her look at you. */
  away: 10000,
} as const;

export type LookFlavour = "plain" | "smile" | "blink";

export interface LookAt {
  readonly start: number;
  readonly age: number;
  readonly hold: number;
  readonly flavour: LookFlavour;
}

const holdOf = (seed: number, salt: number): number =>
  LOOK.holdMin + hash01(seed, salt) * (LOOK.holdMax - LOOK.holdMin);

/** About one in three looks is paired: half with the soft smile, half with a slow blink. */
function flavourOf(seed: number, salt: number): LookFlavour {
  const h = hash01(seed, salt);
  return h < 1 / 6 ? "smile" : h < 1 / 3 ? "blink" : "plain";
}

/**
 * Her looks at rest from when she is awake: start(k + 1) = start(k) + hold(k) + gap(k + 1), each gap
 * hashed in 8 to 20 s, each hold in 1.5 to 3 s. Pure in t: the chain extends itself as asked.
 */
export class LookChain {
  readonly #starts: number[] = [];
  readonly #awakeAt: number;

  constructor(awakeAt: number) {
    this.#awakeAt = awakeAt;
  }

  #gap(k: number): number {
    return LOOK.gapMin + hash01(k, 151) * (LOOK.gapMax - LOOK.gapMin);
  }

  /** The look at rest running at t, or null. */
  at(t: number): LookAt | null {
    const st = this.#starts;
    while (st.length === 0 || (st[st.length - 1] ?? 0) <= t) {
      const k = st.length;
      const prev = st[k - 1];
      st.push(
        prev === undefined
          ? this.#awakeAt + this.#gap(0)
          : prev + holdOf(k - 1, 152) + this.#gap(k),
      );
    }
    for (let k = st.length - 1; k >= 0; k--) {
      const start = st[k] ?? 0;
      if (start > t) continue;
      const hold = holdOf(k, 152);
      return t < start + hold
        ? { start, age: t - start, hold, flavour: flavourOf(k, 153) }
        : null;
    }
    return null;
  }
}

/**
 * Whether she looks at you at t: a triggered look (a gesture just ended, the window came back; times
 * on her clock) wins over the rest chain; nothing before she is awake.
 */
export function lookAt(
  chain: LookChain,
  t: number,
  awakeAt: number,
  triggers: readonly number[],
): LookAt | null {
  if (t < awakeAt) return null;
  for (let n = triggers.length - 1; n >= 0; n--) {
    const at = triggers[n] ?? 0;
    if (at > t || at < awakeAt) continue;
    const seed = Math.round(at / STEP_MS);
    const hold = holdOf(seed, 154);
    if (t < at + hold)
      return { start: at, age: t - at, hold, flavour: flavourOf(seed, 155) };
    break;
  }
  return chain.at(t);
}

/** A look's slow blink: half, closed, half, about a third into the look (0 when it has none). */
export function lookLid(look: LookAt | null): number {
  if (look === null || look.flavour !== "blink") return 0;
  const x = look.age - look.hold * 0.35;
  return x < 0 ? 0 : x < 150 ? 0.55 : x < 400 ? 1 : x < 550 ? 0.55 : 0;
}

/** Every 20 to 40 s, for 1.5 s, the near mouth corner lifts. */
export function smirking(t: number): boolean {
  return schedule(t, 131, 20000, 40000, 1500).on;
}

/**
 * The hover's progress: the 300 ms Bayer dissolve (`hp`) and the hand rising over 500 ms, sinking
 * over 350 ms (`rp`); a still frame settles at once.
 */
export function hoverProgress(
  hover: boolean,
  hoverAge: number,
  unhoverAge: number,
  still: boolean,
): { readonly hp: number; readonly rp: number } {
  if (still) return hover ? { hp: 1, rp: 1 } : { hp: 0, rp: 0 };
  if (hover)
    return { hp: clamp(hoverAge / 300, 0, 1), rp: clamp(hoverAge / 500, 0, 1) };
  if (unhoverAge >= 0)
    return {
      hp: 1 - clamp(unhoverAge / 300, 0, 1),
      rp: 1 - clamp(unhoverAge / 350, 0, 1),
    };
  return { hp: 0, rp: 0 };
}
