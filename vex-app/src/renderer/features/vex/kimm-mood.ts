/**
 * VEX STATE TO KIMM'S MOOD: which of her moods the Vex key and her section
 * show for each presence state (docs/design/H3-DESKTOP.md section 1.6;
 * plan row S4-02), as VEX Cloud maps them (its mockup's `js/data.js`, the
 * seat per state, and `h3-shell-gaps` decision 15).
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
 * Desktop's other states take the mood of the moment Cloud gives them:
 *
 *   listening  hi       the composer holds text: she is still at the welcome
 *                       she said hi from, now attending
 *   working    think    a tool runs or the answer is written: Vex works, as
 *                       H3's THINKING moment already covers
 *   concerned  rest     offline, the provider rate-limited, balances stale:
 *                       in a chat she rests, as Cloud's Concerned seat does
 *                       (its spent budget); on a status panel she thinks
 *                       (`seat: "panel"`, decision 15's 404 still)
 *   error      rest     the turn failed or the mission failed or paused on
 *                       an error: she rests, because no still reads as an
 *                       error and she is not the failure (decision 15)
 *   sleeping   rest     paused by the person or parked on a wake: resting
 *   waking     rest     the local services are starting: she has not risen yet
 *
 * A settled turn is Done whatever its outcome, and her act follows the
 * outcome when the caller knows it (`outcome`), as Cloud's settled seats do:
 *
 *   filled     signed   done after a fill: the still Cloud draws for it
 *   refused    refused  done after a refusal, the only place the whole anger
 *                       mark shows: never for a failure, never for a stop
 *   failed     rest     done after a failure: she is not the failure
 *
 * One refinement, as `vexWordOf` makes for the word ("Sleeping · Locked"): a
 * locked vault is a wait only the person can end by unlocking, desktop's
 * sign-in hold, so Sleeping while locked shows held (the offer pose, dimmed;
 * `kimm-assets.ts`), not rest.
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
  concerned: "rest",
  error: "rest",
  sleeping: "rest",
  waking: "rest",
};

/**
 * Where she is seen: in a chat (her section and the Vex key, the default) or
 * on a status panel (a page that states one condition beside her plate).
 */
export type KimmSeat = "chat" | "panel";

/** How a settled turn ended, when its caller knows: a fill, a refusal, a failure. */
export type KimmOutcome = "filled" | "refused" | "failed";

/** What a done turn's outcome shows; a failure rests like any other done. */
const KIMM_MOOD_BY_OUTCOME: Readonly<Record<KimmOutcome, KimmMood>> = {
  filled: "signed",
  refused: "refused",
  failed: "rest",
};

export interface KimmMoodOptions {
  /** The vault is locked: `vexWordOf`'s own reading of Sleeping. */
  readonly locked?: boolean;
  /** Her seat: a chat by default. Only Concerned reads it. */
  readonly seat?: KimmSeat;
  /** A settled turn's outcome. Only Done reads it. */
  readonly outcome?: KimmOutcome | null;
}

/** Her mood for a presence state, its seat and, once settled, its outcome. */
export function kimmMoodOf(state: VexState, options: KimmMoodOptions = {}): KimmMood {
  if (state === "sleeping" && options.locked === true) return "held";
  if (state === "concerned" && options.seat === "panel") return "think";
  const outcome = options.outcome ?? null;
  if (state === "done" && outcome !== null) return KIMM_MOOD_BY_OUTCOME[outcome];
  return KIMM_MOOD_BY_STATE[state];
}
