/**
 * A TERMINAL'S STATE SQUARE, 6px, beside its word: the tab, the panel header
 * and a split pane's head draw the same one (our approved Studio plate,
 * docs/design/H3-DESKTOP.md section 4.9).
 *
 * The squares are H3's state squares (section 2.2, `StateSquare`), a drawing
 * of their own per state: running the hud square, which blinks while the
 * process runs (PD-06); exited the empty frame (it finished, nothing went
 * wrong); an error the cross in the refusal ink, which keeps it meaning "look
 * at this" instead of "a shell closed"; restoring the empty frame, told apart
 * from exited by its word. The square is `aria-hidden`; the word beside it is
 * what a screen reader gets.
 */

import type { JSX } from "react";
import { StateSquare, type StateSquareState } from "../../../../components/ui/state-square.js";
import type { TerminalTabRunState } from "./terminal-tab-model.js";

const SQUARE_BY_STATE: Readonly<Record<TerminalTabRunState, StateSquareState>> = {
  running: "ongoing",
  restoring: "idle",
  exited: "idle",
  error: "error",
};

export function TerminalStateSquare({
  state,
}: {
  readonly state: TerminalTabRunState;
}): JSX.Element {
  return <StateSquare state={SQUARE_BY_STATE[state]} size={6} />;
}
