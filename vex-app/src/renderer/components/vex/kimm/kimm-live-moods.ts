/**
 * HER LIVE MOODS AND THE EVENTS THAT CHOOSE THEM (VEX Cloud's
 * `apps/web/src/components/kimm/kimm-moods.ts`: SK KIMM.md 5; vex-home
 * `kimm.js:28-38`, `:89-107`). One event, one mood: she reacts to what the
 * runtime does, never to decorate it.
 *
 *   - `KIMM_LIVE_MOODS`: what each live mood sets on the rig (a hand toggle
 *     `T4` to `T8`, the marks `E1`, `E4`, `E7`, `T1`, `FeceAngry`, the mouth
 *     form and the eye smile). The hands are crossfaded by the rig
 *     (`kimm-rig.ts`), never set two at once.
 *   - `KIMM_EVENT_MOOD`: the mood an event starts and how long it holds.
 *
 * Renamed from Cloud's `KimmMood` / `KIMM_MOODS`: on desktop `KimmMood` is the
 * mood of her stills (`kimm-assets.ts`), which a Vex state picks
 * (`features/vex/kimm-mood.ts`). Cloud's still clock (`kimmMoodAfter`,
 * `stillOfMood`) is not ported: desktop's mood clock is `useKimmMood`.
 *
 * THE BRIDGE (`KIMM_LIVE_CUE`). The live figure shows the mood her still
 * would show, so a still mood names the live mood that draws it (Cloud's
 * `stillOfMood`, read backwards: signed is `v`, refused is `no`, held is
 * offer's pose, which the panel shows undimmed as it shows offer's still) and
 * the event whose own gesture Cloud plays on the way in (the hop of hi and
 * of a fill, the glance of a request). The event plays, then the mood is
 * pinned with no end, so she holds it exactly as long as desktop's clock
 * holds the still, never Cloud's own 1.8 s or 2.8 s.
 *
 * Pure data and one table: no React, no IO.
 */

import type { KimmMood } from "./kimm-assets.js";

/** The events of `kimm.on` (SK KIMM.md 5). */
export const KIMM_EVENTS = [
  "request",
  "propose",
  "wait",
  "approve",
  "done",
  "refused",
  "hi",
  "idle",
  "spam",
  "nudge",
  "press",
  "say",
  "reset",
  "eyekey",
] as const;

export type KimmEvent = (typeof KIMM_EVENTS)[number];

/** The moods of `MOODS` (`kimm.js:28-38`). */
export type KimmLiveMood = "rest" | "think" | "point" | "offer" | "v" | "sign" | "no" | "oops" | "hi";

/** The rig ids a mood writes; `form` is ParamMouthForm, `smile` ParamEyeRSmile. */
export interface KimmMoodRig {
  readonly T1?: number;
  readonly T4?: number;
  readonly T5?: number;
  readonly T6?: number;
  readonly T7?: number;
  readonly T8?: number;
  readonly E1?: number;
  readonly E4?: number;
  readonly E7?: number;
  readonly FeceAngry?: number;
  readonly form?: number;
  readonly smile?: number;
}

/**
 * `MOODS` (`kimm.js:28-38`): rest, think (hand to the mouth), point, offer
 * (hand held out), v (V sign, blush), sign (glowing eyes), no (arms crossed,
 * the anger mark), oops (sweat), hi (V sign, blush, a wide smile).
 */
export const KIMM_LIVE_MOODS: Readonly<Record<KimmLiveMood, KimmMoodRig>> = {
  rest: {},
  think: { T5: 1, form: 0.1 },
  point: { T6: 1, form: 0.5, smile: 0.3 },
  offer: { T7: 1, form: 0.7, smile: 0.5 },
  v: { T8: 1, form: 1, smile: 0.8, E7: 1 },
  sign: { T1: 1, form: 0.4 },
  no: { T4: 1, E1: 1, FeceAngry: 0.5, form: -0.8 },
  oops: { E4: 1, form: -0.3 },
  hi: { T8: 1, E7: 1, form: 1, smile: 0.9 },
};

/** The hand toggles, crossfaded as one (SK KIMM.md 2: a swap through 0 flashes the rest arm). */
export const KIMM_HANDS = ["T4", "T5", "T6", "T7", "T8"] as const;

/** The marks `setMood` resets before it sets a mood. */
export const KIMM_MARKS = ["E1", "E4", "E6", "E7", "T1", "FeceAngry"] as const;

/** What an event does to her mood: start `mood` for `ms` (0: until the next event); events not listed keep it. */
export interface KimmMoodChange {
  readonly mood: KimmLiveMood;
  readonly ms: number;
}

/** The event table of SK KIMM.md 5 (`kimm.js:89-107`). `idle` rests only when no timed mood holds. */
export const KIMM_EVENT_MOOD: Readonly<Partial<Record<KimmEvent, KimmMoodChange>>> = {
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
};

/** How the live figure enters a still mood: the event it plays, and the live mood it then holds. */
export interface KimmLiveCue {
  readonly event: KimmEvent;
  readonly mood: KimmLiveMood;
}

/** Each of her still moods as the live figure draws it (see THE BRIDGE above). */
export const KIMM_LIVE_CUE: Readonly<Record<KimmMood, KimmLiveCue>> = {
  hi: { event: "hi", mood: "hi" },
  think: { event: "request", mood: "think" },
  offer: { event: "wait", mood: "offer" },
  held: { event: "wait", mood: "offer" },
  signed: { event: "done", mood: "v" },
  refused: { event: "refused", mood: "no" },
  rest: { event: "idle", mood: "rest" },
};
