/**
 * VEX STATE TO KIMM'S MOOD: which of her moods the Vex key and her section
 * show for each presence state (docs/design/H3-DESKTOP.md section 1.6;
 * plan row S4-02), as VEX Cloud maps them (its mockup's `js/data.js`, the
 * seat per state, `h3-shell-gaps` decision 15, and its built mood clock and
 * status panel).
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
 *                       (`seat: "panel"`, Cloud's `StatusPanel` 404 plate)
 *   error      rest     the turn failed or the mission failed or paused on
 *                       an error: she rests in a chat, she is not the
 *                       failure; on a status panel she is refused (Cloud's
 *                       `StatusPanel` error plate)
 *   sleeping   rest     paused by the person or parked on a wake: resting
 *   waking     rest     the local services are starting: she has not risen yet
 *
 * THE MONEY CALL, as VEX Cloud's built event clock draws it
 * (`apps/web/src/components/kimm/use-kimm-events.ts` and `kimm-moods.ts`,
 * verified 2026-11-08). A caller that knows the person approved the money
 * call now running passes `approved`, and once it has ended, `outcome`:
 *
 *   approved  offer    Thinking or Working while the approved money call
 *                      runs: Cloud's `approve` event and its `sign` mood,
 *                      which Cloud draws with the offer still
 *   filled    signed   the money call ended in a fill (Done): Cloud's `done`
 *                      event, held 2.8 s, then rest
 *   failed    refused  the money call ended in an error (Error or Done):
 *                      Cloud's `refused` event, held 3.4 s, then rest
 *   refused   refused  the money call was refused (Error or Done): the same
 *
 * The holds (`KIMM_MOOD_HOLD_MS`) are kept by `useKimmMood`, which returns
 * rest once a held mood's time is up, as Cloud's clock does. A failure with
 * no money call rests: the whole anger mark is the money call's alone.
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

/** How the approved money call ended, when its caller knows: a fill, a refusal, an error. */
export type KimmOutcome = "filled" | "refused" | "failed";

/** What a money call's end shows: signed after a fill, refused for a refusal or an error. */
const KIMM_MOOD_BY_OUTCOME: Readonly<Record<KimmOutcome, KimmMood>> = {
  filled: "signed",
  refused: "refused",
  failed: "refused",
};

/**
 * How long a money call's end shows before she rests (Cloud's
 * `KIMM_EVENT_MOOD`: `done` 2800, `refused` 3400). Only a mood read from an
 * `outcome` is held; a status panel's refused stands as long as the panel.
 */
export const KIMM_MOOD_HOLD_MS: Readonly<Record<KimmOutcome, number>> = {
  filled: 2800,
  refused: 3400,
  failed: 3400,
};

export interface KimmMoodOptions {
  /** The vault is locked: `vexWordOf`'s own reading of Sleeping. */
  readonly locked?: boolean;
  /** Her seat: a chat by default. Concerned and Error read it. */
  readonly seat?: KimmSeat;
  /** The money call the person approved is running. Thinking and Working read it. */
  readonly approved?: boolean;
  /** How the approved money call ended. Done and Error read it. */
  readonly outcome?: KimmOutcome | null;
}

/**
 * The money call's end a reading shows, if any: the mood `useKimmMood`
 * holds, then rests. Done shows any end; Error shows a refusal or an error
 * (a fill never ends in one), never on a status panel.
 */
export function kimmOutcomeOf(state: VexState, options: KimmMoodOptions = {}): KimmOutcome | null {
  const outcome = options.outcome ?? null;
  if (outcome === null) return null;
  if (state === "done") return outcome;
  if (state === "error" && options.seat !== "panel" && outcome !== "filled") return outcome;
  return null;
}

/** Her mood for a presence state, its seat and the money call it follows. */
export function kimmMoodOf(state: VexState, options: KimmMoodOptions = {}): KimmMood {
  if (state === "sleeping" && options.locked === true) return "held";
  if (options.seat === "panel") {
    if (state === "concerned") return "think";
    if (state === "error") return "refused";
  }
  if ((state === "thinking" || state === "working") && options.approved === true) return "offer";
  const outcome = kimmOutcomeOf(state, options);
  if (outcome !== null) return KIMM_MOOD_BY_OUTCOME[outcome];
  return KIMM_MOOD_BY_STATE[state];
}
