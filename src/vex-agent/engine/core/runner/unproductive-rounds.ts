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

import { hasActionableInferenceResponse } from "@vex-agent/inference/response-validation.js";
import type { InferenceStallKind } from "@vex-agent/inference/stream-consumer.js";

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
 * least one non-whitespace character. The rule is NOT restated here: it is the
 * inference layer's `hasActionableInferenceResponse`, so "the provider
 * returned nothing to act on" and "this round was blank" can never drift
 * apart. That predicate is pure - the inference layer hands an empty
 * completion straight through and this detector is the only owner of what to
 * do about it.
 *
 * Reasoning is deliberately NOT productive, and a reasoning-only completion is
 * therefore a blank round like any other. It is discarded by the same
 * fall-through as an empty one (the turn loop persists reasoning only
 * alongside content or tool calls), so counting it as progress would re-open
 * the exact hole this detector closes - and it is the shape an empty stream
 * that exhausted its endpoint failover degrades into.
 */
export function isProductiveRound(round: {
  readonly content: string | null;
  readonly toolCalls: readonly unknown[] | null;
}): boolean {
  return hasActionableInferenceResponse(round);
}

/**
 * The fields of a completed round the classification reads. Structural, like
 * `isProductiveRound`'s input, so the rule can be tested without a full
 * `SingleTurnResult`.
 */
export interface InferenceRoundFields {
  readonly content: string | null;
  readonly toolCalls: readonly unknown[] | null;
  /** Provider finish reason, verbatim (open enum); `null` when unreported. */
  readonly finishReason: string | null;
  /** Tool calls the inference layer dropped as unassemblable. */
  readonly malformedToolCallCount: number;
  /** The inference bound that stopped this round, or null when none fired. */
  readonly timedOut: InferenceStallKind | null;
}

/**
 * What a completed (not aborted) inference round amounted to.
 *
 * - `productive`: text or a COMPLETE tool batch - the normal paths.
 * - `incomplete_tool_batch`: the provider returned at least one tool call that
 *   could not be assembled, even if others survived, OR the output limit
 *   ended a round that carried any tool call at all. `truncated` is true when
 *   the output limit cut it off (`finish_reason === "length"`), false when
 *   the call was simply malformed. None of the batch may be dispatched: the
 *   survivors are part of a plan the model did not finish writing, and in a
 *   financial agent one of them may be a fund-moving prepare. A cut that
 *   lands exactly between two complete calls leaves nothing malformed, yet
 *   the batch is still unfinished - the limit, not the model, ended it - so
 *   `length` alone is enough to refuse it.
 * - `reasoning_exhausted`: the output limit was hit with no answer and no tool
 *   call - the model spent its budget thinking.
 * - `blank`: nothing at all, for any other reason.
 * - `stream_timeout`: an inference bound (first chunk, idle, reasoning-only or
 *   the round deadline) stopped the stream. Whatever it streamed is a fragment
 *   the model never finished: it carries no tool calls (the inference layer
 *   drops in-flight ones) and its text is not persisted. `stall` says which
 *   bound fired.
 *
 * Every class but `productive` counts toward
 * `MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS`.
 */
export type InferenceRoundClassification =
  | { readonly kind: "productive" }
  | {
      readonly kind: "incomplete_tool_batch";
      readonly truncated: boolean;
      readonly validToolCalls: number;
      readonly malformedToolCalls: number;
    }
  | { readonly kind: "reasoning_exhausted" }
  | { readonly kind: "blank" }
  | { readonly kind: "stream_timeout"; readonly stall: InferenceStallKind };

export type UnproductiveRoundKind = Exclude<InferenceRoundClassification["kind"], "productive">;

/**
 * Classify a completed round. Pure; the turn loop calls it once per round,
 * BEFORE any dispatch, and acts only on its answer.
 *
 * The timeout check comes first: a round a bound cut short is never
 * productive, whatever text it streamed before it was stopped. The
 * incomplete-batch check is next and just as unconditional: a round that
 * dropped a call, or that carried any call when the output limit ended it, is
 * never productive, whatever else it carried. Only then does the ordinary
 * productive rule apply (a text-only `length` round stays productive: it is
 * the cut-off answer `cutoff-continuation.ts` finishes).
 */
export function classifyInferenceRound(round: InferenceRoundFields): InferenceRoundClassification {
  if (round.timedOut !== null) {
    return { kind: "stream_timeout", stall: round.timedOut };
  }
  const validToolCalls = round.toolCalls?.length ?? 0;
  const truncated = round.finishReason === "length";
  if (round.malformedToolCallCount > 0 || (truncated && validToolCalls > 0)) {
    return {
      kind: "incomplete_tool_batch",
      truncated,
      validToolCalls,
      malformedToolCalls: round.malformedToolCallCount,
    };
  }
  if (isProductiveRound(round)) return { kind: "productive" };
  if (round.finishReason === "length") return { kind: "reasoning_exhausted" };
  return { kind: "blank" };
}
