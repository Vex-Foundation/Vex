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
 * - `square`, H3's state square in the chats column (docs/design/
 *   H3-DESKTOP.md sections 1.4 and 2.2; `StateSquare`): a small square beside
 *   the word in caps, a drawing of its own per state, so no colour stands
 *   alone. RUNNING is the hud square, which blinks (PD-06); WAITING the
 *   target. Desktop's rows have states H3's list draws no square for
 *   (Appendix A.2): Paused and Sleeping take the dotted frame, VEX Cloud's
 *   `paused`; a mission paused on an error says Error beside the cross: it
 *   is a real state the row must not hide.
 */

import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import type { StateSquareState } from "../../../components/ui/state-square.js";
import type { SwatchState } from "../../../components/ui/swatch.js";

export interface SessionRowState {
  readonly word: string;
  readonly fill: SwatchState;
  /** H3's state square in the chats column. */
  readonly square: StateSquareState;
}

const ROW_STATES: Partial<Readonly<Record<MissionRunStatus, SessionRowState>>> = {
  running: { word: "Running", fill: "done", square: "ongoing" },
  paused_approval: { word: "Waiting", fill: "awaiting", square: "warning" },
  paused_plan_acceptance: { word: "Waiting", fill: "awaiting", square: "warning" },
  paused_user_form: { word: "Waiting", fill: "awaiting", square: "warning" },
  paused_wake: { word: "Sleeping", fill: "sleeping", square: "paused" },
  paused_user: { word: "Paused", fill: "sleeping", square: "paused" },
  paused_error: { word: "Error", fill: "error", square: "error" },
};

/** The row's state, or `null` when the row shows its time. */
export function sessionRowState(row: SessionListItem): SessionRowState | null {
  if (row.mode !== "mission" || row.missionStatus === null) return null;
  return ROW_STATES[row.missionStatus] ?? null;
}
