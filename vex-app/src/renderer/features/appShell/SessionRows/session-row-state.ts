/**
 * The state a session row speaks: a word from the mission run status, or
 * nothing, and the row then shows its time instead. Agent sessions and
 * finished missions carry no state.
 *
 * Two looks share the one table:
 *
 * - `fill`, the R3 swatch (docs/design/R3-MINIMAL.md sections 1.6 and 4),
 *   which the Sessions library's register row and the hover card still draw:
 *   solid for Running, the target for a mission waiting on the user (an
 *   approval, the plan, a form), the dotted outline for Sleeping and Paused,
 *   the ink cross for a run paused on an error.
 * - `square`, H3's status square in the chats column (docs/design/
 *   H3-DESKTOP.md sections 1.4 and 2.2): a small square beside the word in
 *   caps. H3 draws RUNNING with the status grey square and WAITING with an
 *   ink one; its colours are the status marks (`text-running-mark`,
 *   `text-danger-mark`, ink). Desktop's rows have two states H3 draws no
 *   square for (Appendix A.2): Paused takes the grey outline, Sleeping the
 *   grey dotted outline, so neither reads as running. A mission paused on an
 *   error says Error beside the status red square: it is a real state the
 *   row must not hide, though H3's list draws none.
 */

import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import type { SwatchState } from "../../../components/ui/swatch.js";

/** H3's square: the swatch's fill, and the status mark's colour class. */
export interface SessionRowSquare {
  readonly fill: SwatchState;
  readonly className: "text-running-mark" | "text-ink-primary" | "text-danger-mark";
}

export interface SessionRowState {
  readonly word: string;
  readonly fill: SwatchState;
  readonly square: SessionRowSquare;
}

const RUNNING: SessionRowSquare = { fill: "done", className: "text-running-mark" };
const WAITING: SessionRowSquare = { fill: "done", className: "text-ink-primary" };

const ROW_STATES: Partial<Readonly<Record<MissionRunStatus, SessionRowState>>> = {
  running: { word: "Running", fill: "done", square: RUNNING },
  paused_approval: { word: "Waiting", fill: "awaiting", square: WAITING },
  paused_plan_acceptance: { word: "Waiting", fill: "awaiting", square: WAITING },
  paused_user_form: { word: "Waiting", fill: "awaiting", square: WAITING },
  paused_wake: {
    word: "Sleeping",
    fill: "sleeping",
    square: { fill: "sleeping", className: "text-running-mark" },
  },
  paused_user: {
    word: "Paused",
    fill: "sleeping",
    square: { fill: "idle", className: "text-running-mark" },
  },
  paused_error: {
    word: "Error",
    fill: "error",
    square: { fill: "done", className: "text-danger-mark" },
  },
};

/** The row's state, or `null` when the row shows its time. */
export function sessionRowState(row: SessionListItem): SessionRowState | null {
  if (row.mode !== "mission" || row.missionStatus === null) return null;
  return ROW_STATES[row.missionStatus] ?? null;
}
