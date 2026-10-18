/**
 * The wizard's progress (docs/design/R3-MINIMAL.md section 10.3). Two parts:
 *
 *   HorizontalStepper  the named stepper in the top band: seven steps in a
 *                      row (13), each a swatch and its name. Status by fill:
 *                      done and the current step are solid, the steps ahead
 *                      the empty outline; the current step is blue 500 with a
 *                      2px underline.
 *   WizardStepEyebrow  the line above the step's title: "Step 3 of 7 · API
 *                      keys".
 *
 * Display only: a step does NOT navigate. The footer's Back (steps 2 to 7)
 * moves one step at a time, and Review's edit path opens a step directly.
 * The stepper is an `<ol>` with
 * `aria-label="Wizard progress"` so assistive tech can enumerate the seven
 * steps and the current one.
 *
 * Test seams kept:
 *   - `data-vex-wizard-step={stepId}`
 *   - `data-status="pending|active|completed"`
 *   - `aria-current="step"` on the current step
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

type StepStatus = "pending" | "active" | "completed";

function resolveStatus(
  stepId: WizardStepId,
  currentStepId: WizardStepId,
  completedSet: ReadonlySet<WizardStepId>,
): StepStatus {
  // The current step wins over completed: Review's edit path can leave a step
  // both current and completed, and the user is on it now.
  if (currentStepId === stepId) return "active";
  if (completedSet.has(stepId)) return "completed";
  return "pending";
}

/** Status by fill: done and here solid, ahead the empty outline. */
const SWATCH: Record<StepStatus, SwatchState> = {
  completed: "done",
  active: "done",
  pending: "idle",
};

export function HorizontalStepper({
  currentStepId,
  completedSteps,
  className,
}: HorizontalStepperProps): JSX.Element {
  const completedSet = new Set(completedSteps);

  return (
    <ol aria-label="Wizard progress" className={cn("vex-wz-steps", className)}>
      {WIZARD_STEP_IDS.map((id) => {
        const status = resolveStatus(id, currentStepId, completedSet);
        return (
          <li
            key={id}
            data-vex-wizard-step={id}
            data-status={status}
            aria-current={status === "active" ? "step" : undefined}
            className="vex-wz-steps__step"
          >
            <Swatch state={SWATCH[status]} size={10} />
            {WIZARD_STEP_META[id].label}
          </li>
        );
      })}
    </ol>
  );
}

/** "Step 3 of 7 · API keys", the line above the step's title. */
export function WizardStepEyebrow({
  currentStepId,
}: {
  readonly currentStepId: WizardStepId;
}): JSX.Element {
  const currentIndex = WIZARD_STEP_IDS.indexOf(currentStepId);
  return (
    <p className="vex-wzp__eyebrow">
      Step {currentIndex + 1} of {WIZARD_STEP_IDS.length} ·{" "}
      {WIZARD_STEP_META[currentStepId].label}
    </p>
  );
}
