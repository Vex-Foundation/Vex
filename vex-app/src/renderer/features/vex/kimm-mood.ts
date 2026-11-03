/**
 * VEX STATE TO KIMM'S MOOD: which of her six moods the Vex key and her
 * section show for each presence state (docs/design/H3-DESKTOP.md section 1.6;
 * plan row S4-02). Kimm replaces K2, whose own map is `vex-emotion.ts`.
 *
 * Pure, one lookup, total over `VexState`: a state added to the union without
 * a mood here is a type error, and the test walks the union itself, so it
 * turns red too. The state word and its fill carry the state for every
 * reader; her mood only echoes it, so two states may share a mood without
 * either becoming unreadable.
 *
 * H3 draws a mood for four moments, and desktop keeps them:
 *
 *   ready      hi       the welcome: the V sign (READY)
 *   thinking   think    the hand at her mouth while Vex works (THINKING)
 *   awaiting   offer    the open palm while an approval waits
 *   done       rest     resting after the answer (DONE)
 *
 * Desktop's other states have no H3 moment (section 1.6, "Open: their
 * moods"); each takes the mood of the moment it is closest to:
 *
 *   listening  hi       the composer holds text: she is still at the welcome
 *                       she said hi from, now attending
 *   working    think    a tool runs or the answer is written: Vex works, as
 *                       H3's THINKING moment already covers
 *   concerned  held     offline, the provider rate-limited, balances stale: a
 *                       wait she cannot end herself, H3's held (the open palm,
 *                       dimmed), which Cloud draws for its sign-in hold
 *   error      refused  the turn failed or the mission paused on an error: a
 *                       stop, H3's refused (the whole anger mark), which Cloud
 *                       draws for a refusal and a budget stop
 *   sleeping   rest     paused by the person or parked on a wake: resting
 *   waking     rest     the local services are starting: she has not risen yet
 *
 * One refinement, as `vexWordOf` makes for the word ("Sleeping · Locked"): a
 * locked vault is a wait only the person can end by unlocking, desktop's
 * sign-in hold, so Sleeping while locked shows held, not rest.
 */

import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import type { VexState } from "./vex-state.js";

export const KIMM_MOOD_BY_STATE: Readonly<Record<VexState, KimmMood>> = {
  ready: "hi",
  listening: "hi",
  thinking: "think",
  working: "think",
  awaiting: "offer",
  done: "rest",
  concerned: "held",
  error: "refused",
  sleeping: "rest",
  waking: "rest",
};

/** Her mood for a presence state; `locked` as `vexWordOf` takes it. */
export function kimmMoodOf(state: VexState, options: { readonly locked?: boolean } = {}): KimmMood {
  if (state === "sleeping" && options.locked === true) return "held";
  return KIMM_MOOD_BY_STATE[state];
}
