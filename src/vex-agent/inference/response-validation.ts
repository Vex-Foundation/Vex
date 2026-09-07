/**
 * Whether a completed inference gave the engine something it can act on.
 *
 * This is a PURE PREDICATE and deliberately not a guard: the inference layer
 * never rejects an empty completion. "The model returned nothing" is a turn
 * outcome, owned by the turn loop's consecutive-blank detector
 * (`engine/core/runner/unproductive-rounds.ts`), which counts blank rounds,
 * resets on productive ones, exempts a deferral and stops the turn with
 * `no_progress`. Throwing here would pre-empt that policy and turn a stall the
 * loop knows how to end into an error the user sees instead.
 *
 * The rule itself lives here, next to `InferenceResponse`, so both the
 * inference and the engine sides read one definition: reasoning alone is
 * intentionally not actionable - it may be previewed while streaming, but it
 * cannot finish a turn or dispatch a tool.
 */

/**
 * The completion fields the rule reads. Structural rather than
 * `InferenceResponse` so the turn loop's round shape (which carries the same
 * two fields) can be tested by the same predicate without importing the full
 * provider response type.
 */
export interface ActionableCompletionFields {
  readonly content: string | null;
  readonly toolCalls: readonly unknown[] | null;
}

export function hasActionableInferenceResponse(
  response: ActionableCompletionFields,
): boolean {
  const hasText =
    typeof response.content === "string" && response.content.trim().length > 0;
  const hasTools =
    Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return hasText || hasTools;
}
