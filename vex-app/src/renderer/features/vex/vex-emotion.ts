/**
 * VEX STATE TO K2 EMOTION: what her face shows for each presence state
 * (docs/design/R3-MINIMAL.md section 5 and section 10.4).
 *
 * Pure, one lookup. The state word and its fill carry the state for every
 * reader; her face only echoes it, so a state she has no pose for would still
 * read through the word beside her. The poses themselves (her drawing, eyes,
 * mouth and gaze) live with the engine in `components/vex/k2/k2-poses.ts`.
 *
 *   ready      idle: her own life (she looks at you, glances away, the idle pool)
 *   listening  her eyes on the composer, the calm mouth
 *   thinking   the finger on her chin, eyes up to the side
 *   working    the narrowed, focused eyes on the work
 *   awaiting   approval: the palm toward the conversation, wide eyes on you
 *   done       the grin and the peace sign
 *   concerned  worried lids and a small frown
 *   error      a pout, half lidded eyes looking away
 *   sleeping   asleep, lowered, her light dimmed
 *   waking     the wake (the rise, the yawn, the rub, the smile), then idle
 */

import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import type { VexState } from "./vex-state.js";

export const VEX_EMOTION: Readonly<Record<VexState, K2Emotion>> = {
  ready: "idle",
  listening: "listening",
  thinking: "thinking",
  working: "working",
  awaiting: "approval",
  done: "done",
  concerned: "concerned",
  error: "error",
  sleeping: "sleeping",
  waking: "waking",
};

/** Her emotion for a presence state. */
export function vexEmotionOf(state: VexState): K2Emotion {
  return VEX_EMOTION[state];
}
