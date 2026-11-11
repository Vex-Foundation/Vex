/**
 * Where you are in the setup wizard, as H3's stage says it
 * (docs/design/H3-DESKTOP.md section 4.9; the plates `stage-wizard-password`
 * and `stage-wizard-wallets`, approved as drawn): the seven steps in the left
 * column, drawn like the nav, and "Setup · Step N of 7" on the title cell's
 * second line. This replaces R3's horizontal stepper and the step line above
 * the title.
 *
 *   done   a step behind you: saved, or continued past without saving (the
 *          plate's open question, answered: it reads DONE either way)
 *   now    the step you are on, on the selected row's fill
 *   next   a step ahead, muted, with an outline square
 *
 * Display only: a row does not navigate. Back (steps 2 to 7) moves one step,
 * and Review's edit path opens a step directly.
 *
 * Test seams kept on each row: `data-vex-wizard-step={stepId}` and
 * `data-status="pending|active|completed"`, beside `aria-current="step"`.
 */

import { WIZARD_STEP_IDS, type WizardStepId } from "@shared/schemas/wizard.js";

import type { StageStep, StageWhere } from "../../components/onboarding/StageFrame.js";
import { WIZARD_STEP_META } from "./wizard-icons.js";

/** The left column's name for the wizard. */
export const WIZARD_LABEL = "Setup";

type StepStatus = "pending" | "active" | "completed";

/**
 * A step's place. The current step wins over completed: Review's edit path
 * can leave a step both current and completed, and the person is on it now.
 */
function statusOf(
  id: WizardStepId,
  index: number,
  current: WizardStepId | null,
  completed: ReadonlySet<WizardStepId>,
): StepStatus {
  if (id === current) return "active";
  const at = current === null ? -1 : WIZARD_STEP_IDS.indexOf(current);
  return completed.has(id) || index < at ? "completed" : "pending";
}

const AT: Readonly<Record<StepStatus, StageStep["at"]>> = {
  completed: "done",
  active: "now",
  pending: "next",
};

export function wizardWhere(
  current: WizardStepId | null,
  completedSteps: ReadonlyArray<WizardStepId>,
): StageWhere {
  const completed = new Set(completedSteps);
  return {
    label: WIZARD_LABEL,
    steps: WIZARD_STEP_IDS.map((id, index) => {
      const status = statusOf(id, index, current, completed);
      return {
        id,
        label: WIZARD_STEP_META[id].label,
        at: AT[status],
        attrs: { "data-vex-wizard-step": id, "data-status": status },
      };
    }),
  };
}

/** The title cell's second line: "Setup · Step 2 of 7". */
export function wizardSub(current: WizardStepId): string {
  const at = WIZARD_STEP_IDS.indexOf(current);
  return `${WIZARD_LABEL} · Step ${String(at + 1)} of ${String(WIZARD_STEP_IDS.length)}`;
}
