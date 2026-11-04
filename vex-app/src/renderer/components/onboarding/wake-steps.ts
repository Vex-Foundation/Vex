/**
 * The wake's five steps, as H3's stage shows them (docs/design/H3-DESKTOP.md
 * section 4.9; the plates `stage-wake`, `stage-unlock` and
 * `stage-unlock-locked`, approved as drawn): the left column of the wake
 * while the launch runs, and of the unlock after it, every step done (after
 * Lock Vex too, as the plate draws it).
 *
 * Each step is the real launch stage it stands for (`useSetupOrchestrator`'s
 * status keys, `features/setup/ChronosGate/gate-timeline.ts`), so the column
 * never says a step is done that the pipeline has not finished.
 */

import type { StageWhere } from "./StageFrame.js";

/** The wake's stage keys, the launch pipeline's own. */
export type WakeStepKey = "probing" | "services" | "schema" | "ledger" | "ready";

/** The five steps in order, each the real orchestrator stage it stands for. */
export const WAKE_STEPS: readonly { readonly key: WakeStepKey; readonly name: string }[] = [
  { key: "probing", name: "Waking the desk" },
  { key: "services", name: "Starting services" },
  { key: "schema", name: "Preparing the ledger" },
  { key: "ledger", name: "Reading your setup" },
  { key: "ready", name: "Ready" },
];

/** The left column's name for the wake. */
export const WAKE_LABEL = "Waking the desk";

/**
 * The wake's left column: the steps behind the current one done, the current
 * one on the selected fill with the grey square of a step in flight, the rest
 * ahead; with no current step (the unlock), every step done.
 */
export function wakeWhere(current: WakeStepKey | null): StageWhere {
  const at = current === null ? WAKE_STEPS.length : WAKE_STEPS.findIndex((step) => step.key === current);
  return {
    label: WAKE_LABEL,
    steps: WAKE_STEPS.map((step, index) => ({
      id: step.key,
      label: step.name,
      at: index < at ? "done" : index === at ? "now" : "next",
      ...(index === at ? { square: "running" as const, word: null } : {}),
      attrs: { "data-vex-gate-step": step.key },
    })),
  };
}
