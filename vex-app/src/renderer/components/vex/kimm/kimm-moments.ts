/**
 * THE LOCK SCREEN'S IDLE MOMENTS (owner decision 2026-11-15; MOTION-POLICY.md "The lock screen's lively Kimm"). In
 * her lively mode her rig plays short chained moments instead of Cloud's lone idle acts: two to four steps, each a
 * pose of her existing rig (a hand pose by mood, the head and body angles, the mouth and the eye smile, her eyes), at
 * the lively pause between moments. Picked at random, never the same one twice in a row (`pickMoment`). A hand pose
 * changes between steps through the rig's clean cut (`KIMM_HAND_CUT`), never a crossfade.
 *
 * Pure data and one picker: the rig plays them (`kimm-rig.ts`).
 */

import type { KimmLiveMood } from "./kimm-live-moods.js";

/** One step's pose at `u` (0 to 1 of the step), every field an offset the rig adds on its springs. */
export interface MomentPose {
  /** Head turn (ParamAngleX), nod (ParamAngleY), tilt (ParamAngleZ), in degrees. */
  readonly ax?: number;
  readonly ay?: number;
  readonly az?: number;
  /** Body tilt (ParamBodyAngleZ) and lean back or forward (ParamBodyAngleY). */
  readonly bz?: number;
  readonly by?: number;
  /** The mouth opening (ParamMouthOpenY). */
  readonly mouth?: number;
  /** Mouth form and eye smile, over the mood's own (rest's resting mouth otherwise). */
  readonly form?: number;
  readonly smile?: number;
  /** Her eyes: true closes them, a number half closes them (0 to 1). */
  readonly shut?: boolean | number;
  /** Where she looks: a named place (`field`, `viewer`, `left`, `right`, or Cloud's `talk` and `key`). */
  readonly to?: string | null;
}

/** One step of a moment. */
export interface MomentStep {
  readonly ms: number;
  /** The hand pose and marks for the step (`KIMM_LIVE_MOODS`); none is rest. */
  readonly mood?: KimmLiveMood;
  /** Crossed arms without the anger mark (a sigh, not a refusal). */
  readonly clean?: boolean;
  readonly hop?: number;
  readonly pose?: (u: number) => MomentPose;
}

const ease = (u: number): number => Math.sin(u * Math.PI);

/**
 * The library. Each is something the model draws convincingly with its own parts: the hand poses `think` (hand to
 * mouth), `no` (arms crossed), `point`, `offer`, `hi` (the V sign), the head and body angles, the mouth and her eyes.
 */
export const KIMM_MOMENTS = {
  /** Hand to mouth, thinking; then a playful head tilt with a smile. */
  ponderTilt: [
    { ms: 2000, mood: "think", pose: () => ({ ax: -10, ay: 10, az: 6 }) },
    { ms: 1500, pose: (u) => ({ az: 13 * ease(u), ax: 6 * ease(u), form: 0.9, smile: 0.6 }) },
  ],
  /** Arms crossed; a sigh (shoulders drop, head down, eyes half closed); arms down. */
  crossSigh: [
    { ms: 1700, mood: "no", clean: true, pose: () => ({ az: -6, ax: 5 }) },
    {
      ms: 1500,
      mood: "no",
      clean: true,
      pose: (u) => ({ ay: -11 * ease(u), by: -5 * ease(u), shut: 0.45 * ease(u), mouth: 0.25 * ease(u), form: -0.2 }),
    },
    { ms: 900, pose: () => ({ form: 0.3 }) },
  ],
  /** Looks around the screen, left then right, then back to the viewer with a smile. */
  lookAround: [
    { ms: 1100, pose: () => ({ to: "left", ax: -6 }) },
    { ms: 1100, pose: () => ({ to: "right", ax: 6 }) },
    { ms: 1400, pose: (u) => ({ to: "viewer", form: 0.9, smile: 0.7 * ease(u) + 0.2 }) },
  ],
  /** A slow stretch: chin up, shoulders back, eyes closed for a moment. */
  slowStretch: [
    {
      ms: 2600,
      pose: (u) => ({
        ay: 13 * ease(u),
        by: 6 * ease(u),
        bz: 4 * ease(u),
        shut: u > 0.25 && u < 0.75,
        mouth: 0.35 * ease(u),
      }),
    },
    { ms: 700, pose: () => ({ form: 0.6, smile: 0.4 }) },
  ],
  /** A little V sign to the viewer with a hop, then a shy smile. */
  peaceHop: [
    { ms: 1500, mood: "hi", hop: 0.6, pose: () => ({ to: "viewer", az: 5 }) },
    { ms: 900, pose: () => ({ to: "viewer", form: 0.8, smile: 0.5 }) },
  ],
  /** Points at the password field, then offers a hand toward it. */
  pointField: [
    { ms: 1500, mood: "point", pose: () => ({ to: "field" }) },
    { ms: 1600, mood: "offer", pose: () => ({ to: "viewer", form: 0.7 }) },
  ],
  /** A glance at the field, a small nod, back to the viewer. */
  glanceNod: [
    { ms: 1100, pose: () => ({ to: "field" }) },
    { ms: 900, pose: (u) => ({ to: "field", ay: -8 * ease(u) }) },
    { ms: 1000, pose: () => ({ to: "viewer", form: 0.7, smile: 0.4 }) },
  ],
} as const satisfies Record<string, readonly MomentStep[]>;

export type KimmMomentName = keyof typeof KIMM_MOMENTS;

export const KIMM_MOMENT_NAMES = Object.keys(KIMM_MOMENTS) as KimmMomentName[];

/** A moment at random, never `last` again. */
export function pickMoment(random: () => number, last: string | null): KimmMomentName {
  const names = KIMM_MOMENT_NAMES.filter((name) => name !== last);
  return names[Math.min(names.length - 1, Math.floor(random() * names.length))] as KimmMomentName;
}

/** A moment's whole length. */
export function momentMs(name: KimmMomentName): number {
  return (KIMM_MOMENTS[name] as readonly MomentStep[]).reduce((sum, step) => sum + step.ms, 0);
}
