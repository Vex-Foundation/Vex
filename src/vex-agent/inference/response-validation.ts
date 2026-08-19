import type { InferenceResponse } from "./types.js";

/**
 * A completed inference must give the engine something it can act on.
 * Reasoning alone is intentionally not actionable: it may be previewed while
 * streaming, but it cannot finish a turn or dispatch a tool.
 */
export function hasActionableInferenceResponse(
  response: InferenceResponse,
): boolean {
  const hasText =
    typeof response.content === "string" && response.content.trim().length > 0;
  const hasTools =
    Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return hasText || hasTools;
}

/**
 * Fail closed on a provider completion that would otherwise make the turn loop
 * silently request the same prompt again.
 */
export function assertActionableInferenceResponse(
  response: InferenceResponse,
): void {
  if (hasActionableInferenceResponse(response)) return;
  throw new Error("Inference provider returned an empty response");
}
