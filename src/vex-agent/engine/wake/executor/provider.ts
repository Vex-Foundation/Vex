import { isInferenceConfigured } from "../../../inference/config.js";

// ── Production provider gate ───────────────────────────────────────

/**
 * Production provider/config gate. Wake resumes run the agent turn loop, which
 * needs a configured inference backend (OpenRouter key or Vex Cloud session)
 * and a model (AGENT_MODEL): the shared `isInferenceConfigured()` gate, the
 * same one the compact executor asks pre-claim, so a wake never consumes a row
 * it cannot service (e.g. before the vault injects the credential at unlock).
 */
export function isWakeProviderConfigured(): boolean {
  return isInferenceConfigured();
}
