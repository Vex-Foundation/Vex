/**
 * K2's poses (`docs/design/R3-MINIMAL.md section 10.4`): the agent's state as her face
 * (`k2-emotion.ts`), the same engine on the app drawing with its emotion maps:
 *
 * - idle: her own life (by default she looks at you, glances away now and then, blinks, the
 *   wind; the idle pool of gestures plays only here);
 * - listening: eyes down on the composer, the calm mouth;
 * - thinking: the finger on her chin rises out of her light, eyes up to the side;
 * - working: the narrowed, focused eyes on the work;
 * - approval: the palm toward the conversation (her face, hair and vx never mirrored), wide eyes,
 *   looking at you;
 * - done: the grin and the peace sign (the hover drawing), looking at you;
 * - concerned: worried brows and lids, a small frown, looking at you;
 * - error: a pout, half lidded eyes looking away;
 * - sleeping: the head lowers asleep, the light dims (the beam and the token too);
 * - waking: the wake (asleep, the rise, the yawn, the rub, the blinks, a look at you, the smile),
 *   then idle.
 *
 * A change dissolves cell by cell in 300 ms (the Bayer dissolve); the eyes and the mouth switch at
 * its half; a new hand rises out of her light over 500 ms, the old one sinks over 350 ms. Pure:
 * every frame follows from the change, its start on her clock and t, so the tests can step
 * through any moment; reduced motion settles at once.
 */
import type { K2Emotion } from "./k2-emotion.js";
import {
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
  W0,
  wakeEnd,
  wakeState,
} from "./k2-time.js";

/**
 * Where her eyes go: `free` is the idle life's (the pointer, her glances, you); `you` straight at
 * the viewer; the composer; up to the side (thinking); down on the work; away (error).
 */
export type MoodLook =
  | "free"
  | "you"
  | "composer"
  | "upSide"
  | "work"
  | "aside";

/** A mood's pose: its drawing, whether that drawing's hand rises, the eyes, the mouth, the look. */
export interface MoodPose {
  readonly map: MapName;
  readonly hand: boolean;
  /** Null: her own eyes (open, blinking). */
  readonly eyes: EyeMode | null;
  /** Null: her own mouth (soft, with the idle smirk). */
  readonly mouth: MouthName | null;
  readonly look: MoodLook;
  readonly nose: boolean;
}

type PoseName = Exclude<K2Emotion, "waking">;

export const MOOD_POSES: Readonly<Record<PoseName, MoodPose>> = {
  idle: {
    map: "base",
    hand: false,
    eyes: null,
    mouth: null,
    look: "free",
    nose: true,
  },
  listening: {
    map: "base",
    hand: false,
    eyes: "open",
    mouth: "calm",
    look: "composer",
    nose: true,
  },
  thinking: {
    map: "think",
    hand: true,
    eyes: "open",
    mouth: "calm",
    look: "upSide",
    nose: true,
  },
  working: {
    map: "focus",
    hand: false,
    eyes: "narrow",
    mouth: "calm",
    look: "work",
    nose: true,
  },
  approval: {
    map: "approve",
    hand: true,
    eyes: "wide",
    mouth: "rest",
    look: "you",
    nose: true,
  },
  done: {
    map: "hover",
    hand: true,
    eyes: "smile",
    mouth: "none",
    look: "you",
    nose: true,
  },
  concerned: {
    map: "concern",
    hand: false,
    eyes: "worried",
    mouth: "frown",
    look: "you",
    nose: true,
  },
  error: {
    map: "pout",
    hand: false,
    eyes: "half",
    mouth: "pout",
    look: "aside",
    nose: true,
  },
  sleeping: {
    map: "asleep",
    hand: false,
    eyes: "map",
    mouth: "none",
    look: "free",
    nose: false,
  },
};

/** The drawings the moods need beyond the base (the app drawing's maps, `public/art/vex-k2/app/`). */
export const MOOD_MAPS: readonly MapName[] = [
  "think",
  "focus",
  "approve",
  "hover",
  "concern",
  "pout",
  "asleep",
  "yawn",
  "rub",
];

/** The dissolve, the new hand's rise and the old hand's sink, ms. */
export const MOOD_DISSOLVE = 300;
export const HAND_RISE = 500;
export const HAND_SINK = 350;
/**
 * Asleep: she sits as low as in the wake (36 map px at scale k 1, in whole steps of two rows),
 * lowered over 1.3 s; her light dims to half from 0.3 s to 1.6 s, the beam and the token to 70%.
 */
export const SLEEP = {
  lower: 1300,
  dimFrom: 300,
  dimTo: 1600,
  dy: 36,
  dim: 0.5,
  light: 0.7,
} as const;
/** Leaving sleep for any mood but the wake: her head comes up and the light returns in 600 ms. */
export const UNSLEEP = 600;
/** The wake's face beats after the projector (`wakeState` from W0), ms. */
export const WAKE_FACE = wakeEnd("full") - W0;
/** A wake that does not start asleep starts at the yawn (she is up, eyes closed). */
export const WAKE_FROM_YAWN = 1500;

/** A mood change on her clock: from, to, when (ms; far in the past when she starts in it). */
export interface MoodChange {
  readonly from: K2Emotion;
  readonly to: K2Emotion;
  readonly at: number;
}

/** Her drawing's constants the moods need (its `meta.json`). */
export interface MoodRig {
  /** Rows a hand rises from. */
  readonly rise: number;
  readonly pitch: number;
  readonly k: number;
  /** Where she looks when she has woken (at you). */
  readonly glance: GazeTarget;
  readonly still: boolean;
}

/** One frame of a mood. */
export interface MoodFace {
  readonly face: FaceState;
  readonly look: MoodLook;
  /** The dissolve is done and the hand is up: the engine caches her unchanging dots. */
  readonly settled: boolean;
  /** Asleep and settled: nothing of her moves (no wind, no blink, no shimmer); painted once. */
  readonly frozen: boolean;
  /** The idle pool may play (idle, settled, the wake over). */
  readonly gestures: boolean;
  /** The beam's and the token's light, 0.7..1. */
  readonly light: number;
}

/** An emotion's pose (the wake shows her own face, idle's). */
export const poseOf = (m: K2Emotion): MoodPose =>
  m === "waking" ? MOOD_POSES.idle : MOOD_POSES[m];

/** Whole steps of two rows (the hex screen's brick parity holds). */
function rows2(dy: number, pitch: number): number {
  return Math.round(dy / (2 * pitch)) * 2 * pitch;
}

function sleepDepth(q: number, r: MoodRig): number {
  return rows2(SLEEP.dy * r.k * q, r.pitch);
}

/** The wake as a mood: the face beats of `wakeState`, from asleep (or from the yawn), then idle. */
function wakingFace(ch: MoodChange, age: number, r: MoodRig): MoodFace | null {
  const fromSleep = ch.from === "sleeping";
  const a = r.still ? WAKE_FACE : age + (fromSleep ? 0 : WAKE_FROM_YAWN);
  if (a >= WAKE_FACE) return null;
  const ws = wakeState(W0 + a, "full", r.pitch, r.k, r.glance);
  if (ws === null) return null;
  // out of sleep her light comes up from half while she is still asleep
  const dim = fromSleep
    ? Math.min(ws.dim, lerp(SLEEP.dim, 0.8, ramp(age, 0, 900)))
    : ws.dim;
  return {
    face: { ...ws, dim },
    look: "free",
    settled: false,
    frozen: false,
    gestures: false,
    light: lerp(SLEEP.light, 1, (dim - SLEEP.dim) / (1 - SLEEP.dim)),
  };
}

/**
 * Her face at t for a mood change. The engine draws `face` (a gesture of the idle pool wins over it
 * only while `gestures` holds) and resolves `look` to a point of her map.
 */
export function moodFace(ch: MoodChange, t: number, r: MoodRig): MoodFace {
  const age = Math.max(0, t - ch.at);
  if (ch.to === "waking") {
    const w = wakingFace(ch, age, r);
    if (w !== null) return w;
    return moodFace({ from: "waking", to: "idle", at: -1e9 }, t, r);
  }
  const A = poseOf(ch.from);
  const B = poseOf(ch.to);
  const p = r.still ? 1 : ramp(age, 0, MOOD_DISSOLVE);
  const up = r.still ? 1 : ramp(age, 0, HAND_RISE);
  const sink = r.still ? 1 : ramp(age, 0, HAND_SINK);
  const pose = p >= 0.5 ? B : A;
  const same = A.map === B.map;
  const handB: Hand | null = B.hand
    ? { map: B.map, rise: Math.round((1 - up) ** 3 * r.rise), di: 0, p }
    : null;
  const handA: Hand | null =
    A.hand && !same && p < 1
      ? { map: A.map, rise: Math.round(sink ** 2 * r.rise), di: 0, p: 1 }
      : null;
  const plain = B.map === "base" && (same || p >= 1);
  // asleep: lowered and dimmed; out of sleep: up and bright again
  let dy = 0;
  let dim = 1;
  let light = 1;
  if (ch.to === "sleeping") {
    const q = r.still ? 1 : smooth(ramp(age, 0, SLEEP.lower));
    const d = r.still ? 1 : smooth(ramp(age, SLEEP.dimFrom, SLEEP.dimTo));
    dy = sleepDepth(q, r);
    dim = lerp(1, SLEEP.dim, d);
    light = lerp(1, SLEEP.light, d);
  } else if (ch.from === "sleeping" && !r.still) {
    const q = 1 - smooth(ramp(age, 0, UNSLEEP));
    dy = sleepDepth(q, r);
    dim = lerp(1, SLEEP.dim, q);
    light = lerp(1, SLEEP.light, q);
  }
  const face: FaceState = {
    ...NO_FACE,
    map: plain ? null : B.map,
    gp: plain ? 0 : p,
    hand: handB,
    eyes: pose.eyes,
    mouth: pose.mouth,
    nose: pose.nose,
    dy,
    dim,
    from:
      !plain && !same && p < 1 && A.map !== "base"
        ? { map: A.map, hand: handA }
        : null,
  };
  const done = p >= 1 && (!B.hand || up >= 1) && dy === 0 && dim === 1;
  const asleep =
    ch.to === "sleeping" &&
    (r.still || age >= Math.max(SLEEP.lower, SLEEP.dimTo));
  return {
    face,
    look: pose.look,
    settled: done && ch.to !== "sleeping",
    frozen: asleep,
    gestures: done && ch.to === "idle",
    light,
  };
}
