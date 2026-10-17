/**
 * What K2 shows of the agent (`docs/design/R3-MINIMAL.md section 5`): one emotion per Vex state.
 * The poses (her drawing, eyes, mouth and gaze per emotion) are layered onto the engine on top of
 * this union; until an emotion has its own pose she shows her idle drawing, and any emotion but
 * `idle` holds her idle gestures back, so she never blows a cloud while the agent works or waits.
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
] as const;

export type K2Emotion = (typeof K2_EMOTIONS)[number];

/** Whether an emotion holds the idle gestures back (every one but `idle`). */
export function holdsGestures(emotion: K2Emotion): boolean {
  return emotion !== "idle";
}
