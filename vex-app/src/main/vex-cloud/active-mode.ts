/**
 * Which inference backend the engine is configured for right now, read the
 * way the engine's registry reads it (`resolveInferenceMode`), so the copy
 * main and the renderer show for a failure always names the backend that
 * actually failed. Read per call: a provider change applies at once.
 */

import type { InferenceProviderMode } from "@shared/engine-error-classification.js";
import { resolveInferenceMode } from "@vex-agent/inference/config.js";

export function activeInferenceProviderMode(): InferenceProviderMode {
  return resolveInferenceMode() === "vexcloud" ? "vexcloud" : "openrouter";
}
