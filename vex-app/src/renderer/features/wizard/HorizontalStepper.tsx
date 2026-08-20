/**
 * Horizontal wizard stepper — the minimal progress rail above the step
 * panel (Chronos rebrand): seven dots on the pre-shell plate plus one
 * quiet mono line naming where you are ("Step 3 of 7 · API keys").
 * The DotMatrix node system is retired; state is color, not motion —
 * done = solid paper, current = cobalt, upcoming = faint white
 * (see DOT_CHROME below for the contrast reasoning).
 *
 * Display-only: clicking a dot does NOT navigate. The wizard still has
 * no back-navigation outside the dedicated ReviewStep "edit" path
 * (codex turn 5 answer #2). The rail is an `<ol>` with
 * `aria-label="Wizard progress"` and sr-only step labels so assistive
 * tech can still enumerate the seven steps and the current one.
 *
 * Test/debug surface preserved from the old node system:
 *   - `data-vex-wizard-step={stepId}`
 *   - `data-status="pending|active|completed"`
 *   - `aria-current="step"` on active
 */

import type { JSX } from "react";

import {
  WIZARD_STEP_IDS,
  type WizardStepId,
} from "@shared/schemas/wizard.js";

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

/* State is color, not motion. The INK REDESIGN moves the ACTIVE marker into
 * the cobalt accent family so "you are here" is the one colored thing on the
 * rail; done stays paper and upcoming stays a faint white.
 *
 * The active dot is the accent's lighter mix, not raw #1f44ff: these dots are
 * 6px, and raw cobalt on the #070b1e plate is 3.09:1 — the same reason the
 * plate's rule forbids raw accent for text and thin strokes. The mix is
 * 7.99:1. `--vex-accent-text` is defined by both the gate and shell scopes,
 * with a fallback for anything that defines neither. */
const DOT_CHROME: Record<StepDotStatus, string> = {
  pending: "bg-white/[0.28]",
  active: "bg-accent-primary",
  completed: "bg-ink-primary",
};

export function HorizontalStepper({
  currentStepId,
  completedSteps,
  className,
}: HorizontalStepperProps): JSX.Element {
  const completedSet = new Set(completedSteps);
  const currentIndex = WIZARD_STEP_IDS.indexOf(currentStepId);

  return (
    <div className={cn("flex flex-col items-center gap-2.5", className)}>
      <ol aria-label="Wizard progress" className="flex items-center gap-2">
        {WIZARD_STEP_IDS.map((id) => {
          const status = resolveStatus(id, currentStepId, completedSet);
          return (
            <li
              key={id}
              data-vex-wizard-step={id}
              data-status={status}
              aria-current={status === "active" ? "step" : undefined}
              className={cn("h-1.5 w-1.5 rounded-full", DOT_CHROME[status])}
            >
              <span className="sr-only">{WIZARD_STEP_META[id].label}</span>
            </li>
          );
        })}
      </ol>
      <p className="vex-micro text-ink-secondary">
        Step {currentIndex + 1} of {WIZARD_STEP_IDS.length}
        <span className="text-ink-tertiary">
          {" "}
          · {WIZARD_STEP_META[currentStepId].label}
        </span>
      </p>
    </div>
  );
}
