/**
 * Model-aware answer headroom (Kairos R-2).
 *
 * WHY THIS EXISTS
 *
 * On OpenRouter the request's `max_tokens` "applies to reasoning and visible
 * output combined" (https://openrouter.ai/docs/use-cases/reasoning-tokens).
 * When reasoning spends the whole budget, the response comes back with
 * `finish_reason: "length"` and EMPTY content, and the reasoning is still
 * billed. `AGENT_MAX_OUTPUT_TOKENS` defaults to 16_384, which is a fine answer
 * budget but a thin one once a high reasoning effort is also drawing from it.
 *
 * Effort is a behavioural signal, not a token reservation, so nothing else in
 * the request protects the answer. This module raises the request's
 * `max_tokens` to a per-effort floor — only when an effort is actually sent —
 * so the model has room to think AND still answer or emit complete tool-call
 * arguments.
 *
 * WHAT IT NEVER DOES
 *
 * - It never LOWERS the configured `AGENT_MAX_OUTPUT_TOKENS`: the result is
 *   always `>= configured`.
 * - It never asks for more than the model's advertised max completion tokens.
 * - It never asks for so much that prompt + max_tokens could exceed the context
 *   limit (see {@link resolveAnswerHeadroomMaxTokens} for how the prompt size
 *   is bounded).
 * - It never touches the `reasoning` object: `effort` stays the only reasoning
 *   field on the wire (OpenRouter accepts `effort` OR `reasoning.max_tokens`,
 *   never both).
 *
 * Pure module — no logger, no I/O. The caller (`params.ts`) supplies the prompt
 * size bound so this stays trivially testable.
 */

import type { ReasoningEffort } from "../types.js";

/**
 * Switch for the whole policy. `false` restores the pre-R-2 wire request
 * exactly: `max_tokens` is the configured `AGENT_MAX_OUTPUT_TOKENS`, always.
 */
export const ANSWER_HEADROOM_ENABLED = true;

/**
 * Minimum request `max_tokens` per reasoning effort.
 *
 * Families whose budget scales with `max_tokens` (Anthropic) are skipped —
 * see `BUDGET_SCALES_WITH_MAX_TOKENS_PREFIXES` — so these floors apply only
 * where a raise is pure answer room. The sizing still follows OpenRouter's
 * documented Anthropic mapping, the tightest split we know of: `budget_tokens = max(min(max_tokens × ratio, 128_000), 1024)`
 * with ratios minimal 0.1, low 0.2, medium 0.5, high 0.8, xhigh/max 0.95. The
 * answer only gets what the budget leaves, `(1 − ratio) × max_tokens`:
 *
 * - low 16k    → ~12.8k answer. Same as today's default; floor is a no-op there
 *                and only lifts an operator who configured something smaller.
 * - medium 24k → ~12k answer, i.e. today's low-effort answer room is kept.
 * - high 32k   → ~6.4k answer (at 16k it was ~3.2k, too little for a large
 *                tool call). 32k is also Anthropic's long-standing thinking
 *                budget ceiling for extended thinking.
 * - xhigh/max 64k → ~3.2k answer (at 16k it was ~800 tokens). 64k follows
 *                Anthropic's own recommendation of a large max_tokens (e.g. 64k)
 *                at the highest efforts.
 *
 * Effort-native families (OpenAI, Grok) do not split by ratio: there the floor
 * is plain room for the model to reason further before it must answer.
 *
 * `none` gets no floor: no reasoning is requested, so the answer already owns
 * the whole configured budget. `minimal` shares the low floor.
 */
export const ANSWER_HEADROOM_FLOORS: Readonly<Record<ReasoningEffort, number | null>> = {
  none: null,
  minimal: 16_384,
  low: 16_384,
  medium: 24_576,
  high: 32_768,
  xhigh: 65_536,
  max: 65_536,
};

/** Why the resolved `max_tokens` is what it is — asserted by tests. */
export type AnswerHeadroomReason =
  /** Policy switched off. */
  | "disabled"
  /** No effort is sent, or the effort has no floor (`none`). */
  | "no_effort"
  /** Endpoint pinned: its own completion ceiling is not known here. */
  | "endpoint_pinned"
  /**
   * The family's thinking budget is a fraction of `max_tokens`, so a raise
   * would also let the model think longer — the opposite of what the floor
   * is for. Left at the configured value until an explicit reasoning budget
   * replaces effort for these families.
   */
  | "budget_scales_with_max_tokens"
  /** Catalog did not advertise a max completion tokens for the model. */
  | "model_max_unknown"
  /** Configured value already meets the (capped) floor. */
  | "configured_sufficient"
  /** Raised to the full floor. */
  | "raised_to_floor"
  /** Raised, but capped below the floor by the model's max completion tokens. */
  | "capped_by_model_max"
  /** Raised, but capped below the floor by the context room left after the prompt. */
  | "capped_by_context";

/**
 * Model families whose OpenRouter effort mapping sizes the thinking budget
 * from `max_tokens` (`budget_tokens = max(min(max_tokens × ratio, 128_000),
 * 1024)` — documented for Anthropic). Raising `max_tokens` there buys answer
 * room only by buying proportionally more thinking, so the floor is skipped.
 */
const BUDGET_SCALES_WITH_MAX_TOKENS_PREFIXES = ["anthropic/"] as const;

function budgetScalesWithMaxTokens(model: string): boolean {
  return BUDGET_SCALES_WITH_MAX_TOKENS_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export interface AnswerHeadroomInput {
  /** `AGENT_MAX_OUTPUT_TOKENS` — today's `max_tokens`. */
  readonly configuredMaxTokens: number;
  /** OpenRouter model slug, e.g. `anthropic/claude-sonnet-5`. */
  readonly model: string;
  /** The effort that WILL be sent, or `undefined` when none is sent. */
  readonly sentEffort: ReasoningEffort | undefined;
  /** Model's advertised max completion tokens, or `undefined` when unknown. */
  readonly modelMaxCompletionTokens: number | undefined;
  /** Effective context limit the request must fit in (`InferenceConfig.contextLimit`). */
  readonly contextLimit: number;
  /** Whether a provider endpoint is pinned (`InferenceConfig.endpointTag`). */
  readonly endpointPinned: boolean;
  /**
   * Upper bound on the prompt's tokens, evaluated lazily and only when a raise
   * is actually possible, because measuring it costs a serialization.
   */
  readonly promptTokensUpperBound: () => number;
}

export interface AnswerHeadroomDecision {
  readonly maxTokens: number;
  readonly reason: AnswerHeadroomReason;
}

/**
 * Resolve the request `max_tokens`.
 *
 * Result = `max(configured, min(floor, modelMax, contextLimit − promptBound))`.
 *
 * The prompt bound must be an UPPER bound. Undershooting it would let
 * prompt + max_tokens overrun the window, which OpenRouter rejects outright —
 * a hard failure the configured value alone would not have caused. Over-
 * shooting only means less headroom, never less than today.
 *
 * Endpoint pinned (by the operator or after a failover switch) → no raise. The
 * catalog's max completion tokens describes the TOP provider; a pinned endpoint
 * can advertise less, and with fallbacks off OpenRouter could not route
 * around it. Unknown model max → no raise, for the same reason.
 */
export function resolveAnswerHeadroomMaxTokens(
  input: AnswerHeadroomInput,
  enabled: boolean = ANSWER_HEADROOM_ENABLED,
): AnswerHeadroomDecision {
  const configured = input.configuredMaxTokens;
  if (!enabled) return { maxTokens: configured, reason: "disabled" };

  const floor = input.sentEffort === undefined ? null : ANSWER_HEADROOM_FLOORS[input.sentEffort];
  if (floor === null) return { maxTokens: configured, reason: "no_effort" };
  if (floor <= configured) return { maxTokens: configured, reason: "configured_sufficient" };
  if (budgetScalesWithMaxTokens(input.model)) {
    return { maxTokens: configured, reason: "budget_scales_with_max_tokens" };
  }
  if (input.endpointPinned) return { maxTokens: configured, reason: "endpoint_pinned" };

  const modelMax = input.modelMaxCompletionTokens;
  if (modelMax === undefined) return { maxTokens: configured, reason: "model_max_unknown" };

  let target = floor;
  let reason: AnswerHeadroomReason = "raised_to_floor";
  if (modelMax < target) {
    target = modelMax;
    reason = "capped_by_model_max";
  }

  const contextRoom = input.contextLimit - input.promptTokensUpperBound();
  if (contextRoom < target) {
    target = contextRoom;
    reason = "capped_by_context";
  }

  if (target <= configured) return { maxTokens: configured, reason: "configured_sufficient" };
  return { maxTokens: Math.floor(target), reason };
}

/**
 * Validate the catalog's `top_provider.max_completion_tokens`. Untrusted
 * provider data: anything but a positive integer is "unknown".
 */
export function parseModelMaxCompletionTokens(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
}
