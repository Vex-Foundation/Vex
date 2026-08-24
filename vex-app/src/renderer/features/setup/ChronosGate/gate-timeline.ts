/**
 * Chronos Gate timeline — the single source for the four-act timings
 * (mirrored by the CSS animation delays in global-css/chronos-gate.css;
 * keep both sides in sync) and the pipeline→progress mapping.
 */

import type { SetupStatusLine } from "../useSetupOrchestrator.js";

/** Act III settles at 3.0s (seal stamp + label fade complete). The gate
 * never reveals before this — the curtain must not wipe a stamp mid-act.
 * Bounded and input-free, so it can never strand a handoff. */
export const ACTS_SETTLED_MS = 3000;

/** Progress-line fraction per real orchestrator stage. Monotonic: the
 * line only ever advances. */
export const STAGE_PROGRESS: Record<SetupStatusLine["key"], number> = {
  probing: 0.2,
  services: 0.5,
  schema: 0.72,
  ledger: 0.88,
  ready: 1,
};
