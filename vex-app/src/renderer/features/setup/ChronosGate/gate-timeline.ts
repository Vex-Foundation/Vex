/**
 * Chronos Gate timeline: the minimum hold, the five stage lines and the pipeline to progress
 * mapping (docs/design/H3-DESKTOP.md section 4.9; the plate `stage-wake`).
 */

import { WAKE_STEPS } from "../../../components/onboarding/wake-steps.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";

/**
 * The least time the gate stays up, so its title and its stage lines can be read when the launch
 * is fast: 3 s, the hold the V10 gate had (a shorter hold is an open owner question). Bounded and
 * input-free, so it can never strand a handoff, and it never holds a stage: the pipeline runs
 * underneath from the first frame. Reduced motion skips it entirely.
 */
export const GATE_HOLD_MS = 3000;

/**
 * The gate's five stage lines in order, each the real orchestrator stage it stands for. One list
 * with the unlock's left column (`components/onboarding/wake-steps.ts`), so the two never name a
 * step differently.
 */
export const GATE_STEPS: readonly {
  readonly key: SetupStatusLine["key"];
  readonly name: string;
}[] = WAKE_STEPS;

/** Progress per real orchestrator stage. Monotonic: the meter only ever advances. */
export const STAGE_PROGRESS: Record<SetupStatusLine["key"], number> = {
  probing: 0.2,
  services: 0.5,
  schema: 0.72,
  ledger: 0.88,
  ready: 1,
};
