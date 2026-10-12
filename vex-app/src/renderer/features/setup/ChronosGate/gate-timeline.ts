/**
 * Chronos Gate timeline: the single source for the act timings (mirrored
 * by the CSS animation delays in global-css/chronos-gate.css; keep both
 * sides in sync) and the pipeline to progress mapping.
 */

import type { SetupStatusLine } from "../useSetupOrchestrator.js";

/** Act III settles at 3.0s (the ground and its status line have faded in).
 * The gate never lifts before this, so no act is cut off mid-entrance.
 * Bounded and input-free, so it can never strand a handoff. */
export const ACTS_SETTLED_MS = 3000;

/** Ground-rule fill per real orchestrator stage. Monotonic: the line only
 * ever advances. */
export const STAGE_PROGRESS: Record<SetupStatusLine["key"], number> = {
  probing: 0.2,
  services: 0.5,
  schema: 0.72,
  ledger: 0.88,
  ready: 1,
};
