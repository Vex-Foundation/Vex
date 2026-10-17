/**
 * Chronos Gate timeline: the minimum hold, the five stage lines and the pipeline to progress
 * mapping (`docs/design/R3-MINIMAL.md section 10.2`).
 */

import type { SetupStatusLine } from "../useSetupOrchestrator.js";

/**
 * The least time the gate stays up, so its title and its stage lines can be read when the launch
 * is fast: 3 s, the hold the V10 gate had (a shorter hold is an open owner question). Bounded and
 * input-free, so it can never strand a handoff, and it never holds a stage: the pipeline runs
 * underneath from the first frame. Reduced motion skips it entirely. Vex's wake runs on the plate
 * and goes on across the screens that follow, so it is not waited for.
 */
export const GATE_HOLD_MS = 3000;

/** The gate's five stage lines in order, each the real orchestrator stage it stands for. */
export const GATE_STEPS: readonly {
  readonly key: SetupStatusLine["key"];
  readonly name: string;
}[] = [
  { key: "probing", name: "Waking the desk" },
  { key: "services", name: "Starting services" },
  { key: "schema", name: "Preparing the ledger" },
  { key: "ledger", name: "Reading your setup" },
  { key: "ready", name: "Ready" },
];

/** Progress line fill per real orchestrator stage. Monotonic: the line only ever advances. */
export const STAGE_PROGRESS: Record<SetupStatusLine["key"], number> = {
  probing: 0.2,
  services: 0.5,
  schema: 0.72,
  ledger: 0.88,
  ready: 1,
};
