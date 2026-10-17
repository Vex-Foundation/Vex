/**
 * ONE WORD PER VEX STATE CHANGE, SPOKEN ONCE (docs/design/R3-MINIMAL.md section 5.2): the state
 * word is visible in two places (the title bar's token chip and the Vex sidebar) and neither is a
 * live region, so a screen reader would hear two copies, or none. One announcer speaks it instead
 * (`VexStateAnnouncer`, mounted beside the chip), and this module decides what it says.
 *
 * It says the word as the chip reads it ("Vex, Working"), once, when the state CHANGES. It stays
 * quiet where something else already speaks the same moment, so nothing is heard twice:
 *
 *  - the first read is not a change (the app opening says nothing);
 *  - a different chat, mission, project or mode is the user's own move, not news;
 *  - while a turn is live in the open chat, and at its end, the turn island's own status speaks
 *    ("Vex is responding", its phase, "Waiting for approval", "Vex responded", the error);
 *  - Listening is the user's own typing, and Ready after Listening or after Done is only the rest;
 *  - a notification spoken through the app's announcer in the same moment is the fuller sentence
 *    about it (a failure, a rate limit, an approval raised in the other mode): the component
 *    holds the word a beat and drops it when one was (`SAME_MOMENT_MS`);
 *  - the reads a move starts (the new chat's session, its approvals, its run) settle over a few
 *    renders: changes in the same moment as the move are part of it (`SAME_MOMENT_MS`).
 */

import type { VexState } from "./vex-state.js";

/** One read of the state, as the announcer compares it. */
export interface VexStateRead {
  readonly state: VexState;
  /** The word as shown ("Waiting for approval", "Sleeping · Locked"). */
  readonly word: string;
  /** A turn is in flight in the open chat: its turn island speaks for it. */
  readonly live: boolean;
  /** Where the state is about: the mode and the open session or project. */
  readonly scopeKey: string;
}

/**
 * Two events this close are one moment. A notification spoken within it of a state change takes
 * the moment, and the word is dropped: long enough for a notification raised just before the
 * render that changed the state (an engine failure is recorded, then rendered) or in a sibling's
 * effect just after it (the approvals inbox), short enough that an unrelated one rarely mutes a
 * word. A state change within it of the user's move is the move's reads settling, and is quiet.
 */
export const SAME_MOMENT_MS = 1_000;

/** The subject, as the chip's own accessible name begins. */
const SUBJECT = "Vex, ";

/** What the announcer says for a change from `prev` to `next`, or `null` to stay quiet. */
export function vexAnnouncementFor(prev: VexStateRead | null, next: VexStateRead): string | null {
  if (prev === null) return null;
  if (prev.scopeKey !== next.scopeKey) return null;
  if (prev.state === next.state) return null;
  if (prev.live || next.live) return null;
  if (next.state === "listening") return null;
  if (next.state === "ready" && (prev.state === "listening" || prev.state === "done")) return null;
  return `${SUBJECT}${next.word}`;
}
