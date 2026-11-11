/**
 * THE STAGE CONTRACT - one of the REAL screens before the shell, mounted in
 * the harness on the stand-in bridge (`?stage=<id>`), so it can be captured
 * beside the approved plate it was built from (`?plate=stage-*`,
 * docs/design/H3-DESKTOP.md section 4.9).
 *
 * Like a state it is DATA: the harness always mounts the product's own
 * `StagePlate` (her column) and the product's own screen component, exactly
 * as `App` mounts them, and a stage only decides what the process boundary
 * answers and where the stores point. Nothing above the bridge is faked; the
 * art is the app's own; Kimm's stand-ins only on `?kimm=standins`, as for
 * every state.
 */

import type { JSX } from "react";
import type { UiState, View } from "../../../stores/uiStore.js";
import type { BridgeAnswers } from "../bridge.js";

export interface HarnessStage {
  /** The `?stage=` value. */
  readonly id: string;
  /** One line for the index and the capture's name. */
  readonly title: string;
  /** The view the machine stands on, as `App` would have it. */
  readonly view: View;
  /** The product's own screen for that view. */
  readonly Screen: () => JSX.Element;
  readonly answers: () => BridgeAnswers;
  /** UI store slots beyond the view (her stored choice, a wizard's entry). */
  readonly ui?: Partial<UiState>;
  /** Where the stage store starts (`components/onboarding/stage-vex.ts`), before the first render. */
  readonly setup?: () => void;
  /** A selector that is on screen once the stage has rendered. */
  readonly ready: string;
}
