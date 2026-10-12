/**
 * The wizard's progress on the stage (docs/design/V10-SPREAD.md section 1,
 * the d8 reference). Two parts, because they sit in two places:
 *
 *   HorizontalStepper  the step index on the print's sky beside the giant
 *                      step counter: seven rows of italic numeral, status
 *                      swatch and step name. Status is shown by fill: done
 *                      is solid, the current step the target, the rest an
 *                      empty outline. (The name is kept from the dot rail it
 *                      replaced; App and the tests import it.)
 *   WizardStepEyebrow  the mono line on the paper leaf above the step's
 *                      title: "Step 3 of 7 · API keys".
 *
 * Display-only: a row does NOT navigate. The wizard still has no
 * back-navigation outside the dedicated ReviewStep "edit" path (codex turn
 * 5 answer #2). The index is an `<ol>` with `aria-label="Wizard progress"`
 * so assistive tech can enumerate the seven steps and the current one.
 *
 * Test/debug surface preserved:
 *   - `data-vex-wizard-step={stepId}`
 *   - `data-status="pending|active|completed"`
 *   - `aria-current="step"` on active
 */

import type { JSX } from "react";

import {
  WIZARD_STEP_IDS,
  type WizardStepId,
} from "@shared/schemas/wizard.js";

import { Swatch, type SwatchState } from "../../components/ui/swatch.js";
import { cn } from "../../lib/utils.js";
import { WIZARD_STEP_META } from "./wizard-icons.js";

export interface HorizontalStepperProps {
  readonly currentStepId: WizardStepId;
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly className?: string;
}

type StepDotStatus = "pending" | "active" | "completed";

function resolveStatus(
  stepId: WizardStepId,
  currentStepId: WizardStepId,
  completedSet: ReadonlySet<WizardStepId>,
): StepDotStatus {
  // Active wins over completed — a back-edit flow can leave a step
  // both "active" and "completed", but the user is interacting with
  // it RIGHT NOW so the current marker must show (codex review V2 #1).
  if (currentStepId === stepId) return "active";
  if (completedSet.has(stepId)) return "completed";
  return "pending";
}

/** Status by fill: done solid, here the target, ahead the empty outline. */
const SWATCH: Record<StepDotStatus, SwatchState> = {
  completed: "done",
  active: "warning",
  pending: "idle",
};

/** `2` -> `02`, the counter's two-figure form. */
export function stepNumeral(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function HorizontalStepper({
  currentStepId,
  completedSteps,
  className,
}: HorizontalStepperProps): JSX.Element {
  const completedSet = new Set(completedSteps);

  return (
    <ol aria-label="Wizard progress" className={cn("vex-stage-steps", className)}>
      {WIZARD_STEP_IDS.map((id, index) => {
        const status = resolveStatus(id, currentStepId, completedSet);
        return (
          <li
            key={id}
            data-vex-wizard-step={id}
            data-status={status}
            aria-current={status === "active" ? "step" : undefined}
            className="vex-stage-step"
          >
            <span aria-hidden className="vex-stage-step__n">
              ({stepNumeral(index)})
            </span>
            <span aria-hidden className="vex-stage-step__sw">
              <Swatch state={SWATCH[status]} size={9} />
            </span>
            <span className="vex-stage-step__t">
              {WIZARD_STEP_META[id].label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "Step 3 of 7 · API keys", the leaf's eyebrow. */
export function WizardStepEyebrow({
  currentStepId,
}: {
  readonly currentStepId: WizardStepId;
}): JSX.Element {
  const currentIndex = WIZARD_STEP_IDS.indexOf(currentStepId);
  return (
    <>
      Step {currentIndex + 1} of {WIZARD_STEP_IDS.length}
      <span> · {WIZARD_STEP_META[currentStepId].label}</span>
    </>
  );
}
