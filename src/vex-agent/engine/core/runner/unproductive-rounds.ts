/**
 * The consecutive-unproductive-round detector - a STALL detector, deliberately
 * kept separate from the iteration budget.
 *
 * ## Why this is not the iteration budget
 *
 * `iteration-budget.ts` bounds how much WORK one turn may do (50 rounds
 * restricted, 1000 under full autonomy); a round that batches six tool calls
 * costs one unit, so the number is a backstop against a model that works
 * forever, not a spend cap.
 *
 * This counter bounds something completely different: how many times in a row
 * the model may answer with NOTHING. A round that emits neither text nor a tool
 * call persists nothing (`saveAssistantMessage` early-returns on an empty
 * assistant message), appends nothing to the live tape, and dispatches nothing.
 * The next round therefore sees the SAME input the stalled round saw, so the
 * loop is a true no-op cycle: it cannot recover by repeating, it can only burn
 * the budget. That is exactly what the v0.2.6 report was - fifty silent rounds,
 * zero tool calls, a "budget exhausted" apology, and roughly forty dollars of
 * input tokens resent fifty times.
 *
 * Conflating the two is why a productive multi-step task died at the same
 * threshold as a spinner. Keeping them separate, and RESETTING this one on
 * every productive round, is the pattern VS Code's tool-calling loop uses for
 * the same failure mode (`autopilotIterationCount = 0` on productive work,
 * `MAX_AUTOPILOT_ITERATIONS = 3`, `toolCallingLoop.ts`).
 *
 * ## The bound
 *
 * Three consecutive unproductive rounds.
 *
 * Workload assumption: a healthy round emits text or at least one tool call. An
 * empty round is a provider- or model-side defect (an empty completion, a
 * reasoning-only response with no answer, a malformed tool call the parser
 * dropped). One of those can be transient, so the first repeat is free. By the
 * third consecutive blank the model has been asked the identical question three
 * times and answered nothing three times; a fourth ask is not evidence
 * gathering, it is spending.
 *
 * Cost of a false positive: a turn ends up to three rounds early with an honest
 * "no output" message the user can retry. Cost of not having it: 50 (or 1000)
 * rounds of full-context prompts billed for zero output.
 */

/**
 * Consecutive rounds that may emit nothing before the turn stops with
 * `no_progress`. Not configurable and not permission-aware: an autonomous
 * session has no more use for a stalled model than a restricted one does.
 */
export const MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS = 3;

/**
 * Whether a completed inference round produced anything the turn can build on.
 *
 * Productive = at least one tool call to dispatch, or assistant text with at
 * least one non-whitespace character.
 *
 * Reasoning is deliberately NOT productive. A reasoning-only response is
 * discarded by the same fall-through as an empty one (the turn loop persists
 * reasoning only alongside content or tool calls), so counting it as progress
 * would re-open the exact hole this detector closes.
 */
export function isProductiveRound(round: {
  readonly content: string | null;
  readonly toolCalls: readonly unknown[] | null;
}): boolean {
  if (round.toolCalls !== null && round.toolCalls.length > 0) return true;
  return round.content !== null && round.content.trim().length > 0;
}
