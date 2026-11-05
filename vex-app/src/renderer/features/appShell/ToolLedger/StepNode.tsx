/**
 * A TRACE STEP'S NODE (docs/design/H3-DESKTOP.md sections 1.7 and 2.2; VEX
 * Cloud's trace, `h3-chat-gaps` section 19, `.rz-n`): a 7px square that says
 * the step's state by its drawing, never by a colour alone, with a word or a
 * time beside it in the row's time column.
 *
 *   done     the ink 2 square            the step ran; its measured time
 *   running  the ink square, blinking    under way (PD-06), its live timer
 *   waiting  the target: an ink ring     the step waits on the reader's
 *            and its 3px centre          decision
 *   failed   the ink cross               FAILED, in the refusal ink
 *
 * A running node blinks in phase with every other running square and holds
 * still as half a square under reduced motion and Save-Data. Decoration
 * (`aria-hidden`): the word or the row's name says the state.
 */

import type { JSX } from "react";
import { syncBlink } from "../../../components/ui/state-square.js";

export type StepNodeState = "done" | "running" | "waiting" | "failed";

export function StepNode({ state }: { readonly state: StepNodeState }): JSX.Element {
  return (
    <span
      ref={state === "running" ? syncBlink : undefined}
      aria-hidden="true"
      className="vex-step-node"
      data-step-node={state}
    />
  );
}
