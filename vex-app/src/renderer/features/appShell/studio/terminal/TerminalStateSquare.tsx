/**
 * A TERMINAL'S STATE SQUARE, 6px, beside its word: the tab, the panel header
 * and a split pane's head draw the same one (our approved Studio plate,
 * docs/design/H3-DESKTOP.md section 4.9).
 *
 * The squares are the status colours of section 2.2: running the running
 * grey; exited an ink outline (it finished, nothing went wrong); an error the
 * status red, which keeps red meaning "look at this" instead of "a shell
 * closed"; restoring an outline, told apart from exited by its word. The
 * square is `aria-hidden`; the word beside it is what a screen reader gets.
 */

import type { JSX } from "react";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import type { TerminalTabRunState } from "./terminal-tab-model.js";

const SQUARE_BY_STATE: Readonly<
  Record<TerminalTabRunState, { readonly fill: SwatchState; readonly className?: string }>
> = {
  running: { fill: "done", className: "text-running-mark" },
  restoring: { fill: "idle" },
  exited: { fill: "idle" },
  error: { fill: "done", className: "text-danger-mark" },
};

export function TerminalStateSquare({
  state,
}: {
  readonly state: TerminalTabRunState;
}): JSX.Element {
  const square = SQUARE_BY_STATE[state];
  return <Swatch state={square.fill} size={6} className={square.className} />;
}
