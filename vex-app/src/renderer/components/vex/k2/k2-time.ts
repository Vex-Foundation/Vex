/**
 * K2's timeline: every beat of her as a pure function of the clock
 * (`docs/design/R3-MINIMAL.md section 10`):
 *
 * - the wake: the token presses, turns flat, its beam of dots rises, she assembles bottom up asleep,
 *   rises, yawns behind her hand, rubs an eye, blinks twice, looks at you and smiles (about 9 s);
 *   `projector` and `wakeState`;
 * - the idle pool (blow the cloud, the bird on her palm, the giggle on a click, the blush, the
 *   whistle, the hum), one at a time, never during a hover, 15 to 25 s apart; `GestureChain`,
 *   `whistleStarts`, `whistleAt`, `gestureAt`, `gestureState`;
 * - the idle life: by default she looks at you and now and then glances away (`GlanceChain`);
 *   blinks, gusts of wind, the smirk.
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

/**
 * Her drawings: the base and the hover, one per gesture and wake beat, and the moods' (the finger
 * on her chin, the narrowed focus, the concern, the pout, the palm toward the conversation;
 * `k2-poses.ts`).
 */
export type MapName =
  | "base"
  | "hover"
  | "blow"
  | "palm"
  | "giggle"
  | "asleep"
  | "yawn"
  | "rub"
  | "think"
  | "focus"
  | "concern"
  | "pout"
  | "approve";

/**
 * The mouths authored on the screen (`rest` is her own, with its idle smirk); the app's moods add
 * `frown` (the corners down) and `pout` (a short full stroke, a fuller lip).
 */
export type MouthName =
  | "rest"
  | "calm"
  | "smile"
  | "pucker"
  | "o"
  | "none"
  | "frown"
  | "pout";

/**
 * The eyes: `map` the drawing's own (asleep), `closed`, `drowsy` (half), `squeeze` (`> <`),
 * `happy` (arcs), `soft` (the lids a little lower, the smile lifting the lower lid), `open`; the
 * moods: `narrow` (focused, Working), `wide` (brows up, the
 * approval), `worried` (the lid tilting up to the inner corner, Concerned), `half` (half lidded,
 * Error), `smile` (the grin's lifted lower lid, Done).
 */
export type EyeMode =
  | "map"
  | "closed"
  | "drowsy"
  | "squeeze"
  | "happy"
  | "soft"
  | "open"
  | "narrow"
  | "wide"
  | "worried"
  | "half"
  | "smile";

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
  readonly actors: "cloud" | "bird" | "notes" | null;
  /** Her eyes drift up to the side (the whistle). */
  readonly aside: boolean;
  /** The hum's sway of her free hair, -1..1 (her head stays still). */
  readonly sway: number;
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
  /**
   * The drawing it dissolves from (the app's mood changes; the base when absent): the cells the
   * dissolve has not reached show it, with its hand sinking back into her light.
   */
  readonly from?: {
    readonly map: MapName;
    readonly hand: Hand | null;
  } | null;
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
  aside: false,
  sway: 0,
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

/* ------------------------------------------------------------------ the idle pool */

/**
 * Her idle actions, one at a time, never under a hover, a gesture or the wake: the blow, the bird
 * and the giggle, and the blush, the whistle and the hum.
 */
export type GestureName =
  | "blow"
  | "bird"
  | "giggle"
  | "blush"
  | "whistle"
  | "hum";

export const GESTURE_MS: Readonly<Record<GestureName, number>> = {
  blow: 6400,
  bird: 7800,
  giggle: 2000,
  blush: 2600,
  whistle: 4000,
  hum: 2000,
};
/** At least 15 s between any two idle actions (end to start), at most 25 s; the reflexes (a giggle, a blush that answers it or a long hover) are the user's, not idle. */
export const GESTURE_GAP = 15000;
const GAP_MAX = 25000;
/** A giggle's cooldown after its end: clicks inside are ignored. */
export const GIGGLE_COOLDOWN = 8000;
/** A hover this long, once it ends, makes her blush. */
export const LONG_HOVER = 4000;
/** The whistle: after 40 to 90 s without the pointer moving, then again every 40 to 90 s; 3 s of notes, then a glance back at you. */
export const WHISTLE = { min: 40000, max: 90000, notes: 3000 } as const;

/** The actions on a clock: when each is first due after she is awake, how often at most, its seed. */
type PoolName = "blow" | "bird" | "blush" | "hum";
const POOL: Readonly<
  Record<PoolName, { first: number; min: number; max: number; seed: number }>
> = {
  blow: { first: 6000, min: 45000, max: 90000, seed: 301 },
  bird: { first: 20000, min: 60000, max: 120000, seed: 302 },
  blush: { first: 45000, min: 60000, max: 120000, seed: 303 },
  hum: { first: 70000, min: 80000, max: 160000, seed: 304 },
};
const POOL_NAMES: readonly PoolName[] = ["blow", "bird", "blush", "hum"];
/** A slot keeps room for the longest action that may take it over (the whistle). */
const slotSpan = (name: GestureName) =>
  Math.max(GESTURE_MS[name], GESTURE_MS.whistle);

export interface ScheduledGesture {
  readonly name: GestureName;
  readonly start: number;
}

/**
 * The pool's slots: one idle action, then 15 to 25 s of her just looking at you, then the next
 * (seeded). Each slot takes the most overdue kind: the blow keeps its own rhythm (first 6 s
 * after she is awake, then 45 to 90 s), the bird 60 to 120 s, the blush 60 to 120 s, the hum 80 to
 * 160 s, never sooner; a kind not yet due waits. A due whistle takes a slot over (`whistleAt`).
 * Pure in t: the chain extends itself as far as it is asked and never changes behind.
 */
export class GestureChain {
  readonly #ev: ScheduledGesture[] = [];
  readonly #due: Record<PoolName, number>;
  readonly #k: Record<PoolName, number> = {
    blow: 0,
    bird: 0,
    blush: 0,
    hum: 0,
  };

  /** `force` (review in the dev harness) plays that action 1 s after she is awake first. */
  constructor(awakeAt: number, force: PoolName | null = null) {
    this.#due = {
      blow: awakeAt + POOL.blow.first,
      bird: awakeAt + POOL.bird.first,
      blush: awakeAt + POOL.blush.first,
      hum: awakeAt + POOL.hum.first,
    };
    if (force !== null) {
      const at = awakeAt + 1000;
      this.#ev.push({ name: force, start: at });
      this.#bump(force, at);
    }
  }

  #bump(name: PoolName, start: number): void {
    const p = POOL[name];
    this.#k[name]++;
    this.#due[name] =
      start + p.min + hash01(this.#k[name], p.seed) * (p.max - p.min);
  }

  #extend(t: number): void {
    while (
      (this.#ev[this.#ev.length - 1]?.start ?? Number.NEGATIVE_INFINITY) <= t
    ) {
      const prev = this.#ev[this.#ev.length - 1];
      const n = this.#ev.length;
      const free =
        prev === undefined
          ? Number.NEGATIVE_INFINITY
          : prev.start +
            slotSpan(prev.name) +
            GESTURE_GAP +
            hash01(n, 305) * (GAP_MAX - GESTURE_GAP);
      let name: PoolName = "blow";
      for (const k of POOL_NAMES) if (this.#due[k] < this.#due[name]) name = k;
      const start = Math.max(free, this.#due[name]);
      this.#ev.push({ name, start });
      this.#bump(name, start);
    }
  }

  /** The slot running at t (by its own action's length, with its age), or null. */
  at(t: number): (ScheduledGesture & { readonly age: number }) | null {
    this.#extend(t);
    for (let n = this.#ev.length - 1; n >= 0; n--) {
      const e = this.#ev[n];
      if (e === undefined || e.start > t) continue;
      return t < e.start + GESTURE_MS[e.name]
        ? { ...e, age: t - e.start }
        : null;
    }
    return null;
  }

  /** The first slot that starts at or after t. */
  from(t: number): ScheduledGesture {
    this.#extend(t);
    for (const e of this.#ev) if (e.start >= t) return e;
    return this.#ev[this.#ev.length - 1] ?? { name: "blow", start: t };
  }
}

/**
 * The slots a whistle takes over up to t, for a pointer still since `since` (her clock): the first
 * slot 40 to 90 s into the stillness, then the first slot 40 to 90 s after each whistle. A pointer
 * that moves starts a new stillness (and ends a whistle).
 */
export function whistleStarts(
  chain: GestureChain,
  t: number,
  since: number,
): readonly number[] {
  const seed = Math.round(since / STEP_MS);
  const out: number[] = [];
  let due = since;
  for (let k = 0; k < 4096; k++) {
    due += WHISTLE.min + hash01(seed, k, 311) * (WHISTLE.max - WHISTLE.min);
    const s = chain.from(due).start;
    if (s > t) break;
    out.push(s);
    due = s + GESTURE_MS.whistle;
  }
  return out;
}

/** The whistle running at t, or null (it lasts its own 4 s in the slot it takes over). */
export function whistleAt(
  chain: GestureChain,
  t: number,
  since: number,
): (ScheduledGesture & { readonly age: number }) | null {
  const last = whistleStarts(chain, t, since).at(-1);
  return last !== undefined && t < last + GESTURE_MS.whistle
    ? { name: "whistle", start: last, age: t - last }
    : null;
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
  /** The actions that can run: all once her gestures' drawings are in, the map-free ones before, none still. */
  readonly allowed: readonly GestureName[];
  /** When the wake handed her over (0 when she started awake). */
  readonly awakeAt: number;
  /** Click times on her clock (each a giggle, then a blush). */
  readonly giggles: readonly number[];
  /** When long hovers ended (each a blush). */
  readonly blushes: readonly number[];
  /** Since when the pointer has not moved (the whistle's stillness). */
  readonly stillSince: number;
  /**
   * What holds the idle pool back: a hover on her, an emotion other than idle (`k2-poses.ts`).
   * `holdAge` is ms since the hold began (-1 when none), `unholdAge` ms since the last one ended
   * (-1 when holding or never).
   */
  readonly hold: boolean;
  readonly holdAge: number;
  readonly unholdAge: number;
}

export interface ActiveGesture {
  readonly name: GestureName;
  readonly start: number;
  readonly age: number;
  /** A hold during a scheduled action fades it out in 300 ms. */
  readonly fade: number;
}

/**
 * The action at t, one at a time: a giggle (a click) wins, and a blush follows it; a long hover's
 * end makes her blush; then the pool and the whistle, each cancelled by a hold that began before it,
 * faded out by one that begins during it, and gone after.
 */
export function gestureAt(
  chain: GestureChain,
  g: GestureInput,
): ActiveGesture | null {
  if (g.allowed.length === 0 || g.t < g.awakeAt) return null;
  const t = g.t;
  const can = (n: GestureName) => g.allowed.includes(n);
  const GG = GESTURE_MS.giggle;
  const GB = GESTURE_MS.blush;
  if (can("giggle"))
    for (let n = g.giggles.length - 1; n >= 0; n--) {
      const at = g.giggles[n] ?? 0;
      if (at > t) continue;
      if (t - at < GG)
        return { name: "giggle", start: at, age: t - at, fade: 1 };
      if (can("blush") && t - at < GG + GB)
        return { name: "blush", start: at + GG, age: t - at - GG, fade: 1 };
      break;
    }
  if (can("blush"))
    for (let n = g.blushes.length - 1; n >= 0; n--) {
      const at = g.blushes[n] ?? 0;
      if (at > t) continue;
      if (t - at < GB)
        return { name: "blush", start: at, age: t - at, fade: 1 };
      break;
    }
  // the pool's slot at t, unless a whistle took it over
  const whistles = whistleStarts(chain, t, Math.max(g.stillSince, g.awakeAt));
  const w = whistles.at(-1);
  const slotNow = chain.at(t);
  const ev =
    w !== undefined && t < w + GESTURE_MS.whistle
      ? { name: "whistle" as const, start: w, age: t - w }
      : slotNow !== null && whistles.includes(slotNow.start)
        ? null
        : slotNow;
  if (ev === null || !can(ev.name)) return null;
  // a reflex inside its window cancels it
  if (g.giggles.some((at) => at >= ev.start - GG - GB && at <= t)) return null;
  if (g.blushes.some((at) => at >= ev.start - GB && at <= t)) return null;
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
  } else if (g.name === "blush") {
    // the hatch blush on both cheeks with the soft smile, looking at you
    const D = GESTURE_MS.blush;
    st = {
      ...NO_FACE,
      blush: ramp(a, 0, 300) * (1 - ramp(a, D - 400, D)),
      eyes: a > 100 && a < D - 150 ? "soft" : null,
      mouth: a > 150 && a < D - 100 ? "smile" : null,
    };
  } else if (g.name === "whistle") {
    // eyes up to the side, lips in a small "o", notes rising; then a glance back at you
    const W = WHISTLE.notes;
    st = {
      ...NO_FACE,
      mouth: a > 150 && a < W ? "o" : null,
      aside: a < W,
      actors: "notes",
    };
  } else if (g.name === "hum") {
    // eyes closed in happy arcs, her free hair swaying while her head stays still
    const D = GESTURE_MS.hum;
    st = {
      ...NO_FACE,
      eyes: a > 100 && a < D - 100 ? "happy" : null,
      sway:
        Math.sin((a / 700) * 6.2832) *
        ramp(a, 0, 250) *
        (1 - ramp(a, D - 300, D)),
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
    sway: st.sway * fd,
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
 * By default she looks at you; every 5 to 12 s she glances away for 0.9 to
 * 2 s, to the composer, a passing cloud or the birds, and comes back. A moving pointer pulls her eyes
 * while it moves; a hover wins over everything (the engine).
 */
export const GLANCE = {
  gapMin: 5000,
  gapMax: 12000,
  holdMin: 900,
  holdMax: 2000,
} as const;

export type GlanceTarget = "composer" | "cloud" | "birds";

export interface GlanceAway {
  readonly start: number;
  readonly age: number;
  readonly hold: number;
  readonly target: GlanceTarget;
}

const holdOf = (k: number): number =>
  GLANCE.holdMin + hash01(k, 162) * (GLANCE.holdMax - GLANCE.holdMin);

/** Half of her glances go to the composer, a quarter to a cloud, a quarter to the birds. */
function targetOf(k: number): GlanceTarget {
  const h = hash01(k, 163);
  return h < 0.5 ? "composer" : h < 0.75 ? "cloud" : "birds";
}

/**
 * Her glances away from when she is awake: start(k + 1) = start(k) + hold(k) + gap(k + 1), each gap
 * hashed in 5 to 12 s, each hold in 0.9 to 2 s. Pure in t: the chain extends itself as asked.
 */
export class GlanceChain {
  readonly #starts: number[] = [];
  readonly #awakeAt: number;

  constructor(awakeAt: number) {
    this.#awakeAt = awakeAt;
  }

  #gap(k: number): number {
    return GLANCE.gapMin + hash01(k, 161) * (GLANCE.gapMax - GLANCE.gapMin);
  }

  /** The glance away at t, or null (she looks at you); nothing before she is awake. */
  at(t: number): GlanceAway | null {
    if (t < this.#awakeAt) return null;
    const st = this.#starts;
    while (st.length === 0 || (st[st.length - 1] ?? 0) <= t) {
      const k = st.length;
      const prev = st[k - 1];
      st.push(
        prev === undefined
          ? this.#awakeAt + this.#gap(0)
          : prev + holdOf(k - 1) + this.#gap(k),
      );
    }
    for (let k = st.length - 1; k >= 0; k--) {
      const start = st[k] ?? 0;
      if (start > t) continue;
      const hold = holdOf(k);
      return t < start + hold
        ? { start, age: t - start, hold, target: targetOf(k) }
        : null;
    }
    return null;
  }
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
