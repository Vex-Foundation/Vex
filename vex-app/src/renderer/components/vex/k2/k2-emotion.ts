/**
 * What K2 shows of the agent (`docs/design/R3-MINIMAL.md section 5` and `section 10.4`): one
 * emotion per Vex state, the agent's state as her face. Each emotion's pose (her drawing, whether
 * its hand rises, her eyes, her mouth and where she looks) is in `k2-poses.ts`; the engine dissolves
 * from one to the next on her clock. Only `idle` plays her idle life (the blow, the bird, the blush,
 * the whistle, the hum); `waking` plays the wake and then hands her to idle.
 */

export const K2_EMOTIONS = [
  "idle",
  "listening",
  "thinking",
  "working",
  "approval",
  "done",
  "concerned",
  "error",
  "sleeping",
  "waking",
] as const;

export type K2Emotion = (typeof K2_EMOTIONS)[number];
