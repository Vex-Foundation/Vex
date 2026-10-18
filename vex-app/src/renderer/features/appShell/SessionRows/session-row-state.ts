/**
 * The state a session row speaks (docs/design/R3-MINIMAL.md sections 1.6 and
 * 4): a fill and a word from the mission run status, or nothing, and the row
 * then shows its time instead. Agent sessions and finished missions carry no
 * state.
 *
 * Fills follow the swatch table: solid for Running, the target for a mission
 * waiting on the user (an approval, the plan, a form), the dotted outline for
 * Sleeping and Paused, the ink cross for a run paused on an error.
 */

import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import type { SwatchState } from "../../../components/ui/swatch.js";

export interface SessionRowState {
  readonly word: string;
  readonly fill: SwatchState;
}

const ROW_STATES: Partial<Readonly<Record<MissionRunStatus, SessionRowState>>> = {
  running: { word: "Running", fill: "done" },
  paused_approval: { word: "Waiting", fill: "awaiting" },
  paused_plan_acceptance: { word: "Waiting", fill: "awaiting" },
  paused_user_form: { word: "Waiting", fill: "awaiting" },
  paused_wake: { word: "Sleeping", fill: "sleeping" },
  paused_user: { word: "Paused", fill: "sleeping" },
  paused_error: { word: "Error", fill: "error" },
};

/** The row's state, or `null` when the row shows its time. */
export function sessionRowState(row: SessionListItem): SessionRowState | null {
  if (row.mode !== "mission" || row.missionStatus === null) return null;
  return ROW_STATES[row.missionStatus] ?? null;
}
