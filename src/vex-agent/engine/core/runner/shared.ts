/**
 * Engine runner shared utilities — tool definitions and default config.
 */

import { getOpenAITools } from "@vex-agent/tools/registry.js";
import type { ToolDefinition } from "@vex-agent/inference/types.js";
import type { RuntimeStopReason, StopReason } from "../../types.js";
import type { TurnLoopConfig } from "../turn-loop.js";
import { MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS } from "./unproductive-rounds.js";

/**
 * Convert OpenAITool[] to ToolDefinition[]. Type-level identity after
 * `ToolDefinition.function.parameters` was narrowed from
 * `Record<string, unknown>` to `JsonSchema` (PR3) — no cast needed.
 */
export function toToolDefinitions(openAITools: ReturnType<typeof getOpenAITools>): ToolDefinition[] {
  return openAITools.map(t => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

// ── Default loop config ─────────────────────────────────────────

export const DEFAULT_LOOP_CONFIG: TurnLoopConfig = {
  // Mission runs use this cap (50). Agent (one-shot) and mission setup
  // override it locally — see processAgentTurn (50) and
  // processMissionSetupTurn (25). All three are finite, deliberate
  // backstops against runaway tool-call loops; the 30-minute timeoutMs and
  // context-pressure compaction are the independent wall-clock backstops.
  maxIterations: 50,
  // 30 minutes, and never below it (owner decision 2026-08-28, pinned by
  // `DEFAULT_LOOP_CONFIG.timeoutMs >= 1_800_000`). Ten minutes was cutting
  // real autonomous work in half: a slice that does genuine research and
  // several on-chain reads spends most of it waiting on providers, so the
  // clock was ending productive turns and charging a fresh full-context
  // continuation to resume them. The bound still exists - it is the backstop
  // against a turn that never ends - it is just no longer the thing that
  // normally ends a turn. Setup inherits it through the spread below, which
  // is accepted fleet-wide: a setup turn that runs long is a conversation
  // the operator is still in.
  timeoutMs: 1_800_000,
  contextLimit: 256_000,
};

/**
 * Deterministic assistant reply persisted when an AGENT or SETUP turn exits on
 * `iteration_limit` WITHOUT the model ever emitting text. Without it the turn
 * returns null and the user sees a silent empty turn (the cap only bites when
 * the model loops on tool-calls without summarising). Mission runs never reach
 * this path — they convert `iteration_limit` into a `paused_wake` continuation.
 *
 * Intentionally a constant (not model-generated) so the fallback is fully
 * deterministic and testable.
 */
export const ITERATION_LIMIT_REPLY =
  "I reached my tool-use budget for this turn before producing a final answer, " +
  "so I've paused rather than keep spinning. Tell me how you'd like me to " +
  "proceed — continue, narrow the task, or ask me something specific — and " +
  "I'll pick up from here.";

/**
 * The `timeout` sibling of `ITERATION_LIMIT_REPLY`.
 *
 * Before this existed, `agent.ts` and `setup-turn.ts` special-cased ONLY
 * `iteration_limit`, so a turn that ran out of wall-clock returned `text: null`
 * and the user saw a completely silent turn. Reusing `ITERATION_LIMIT_REPLY`
 * would have closed the hole dishonestly — the tool-use budget was NOT
 * exhausted, the clock ran out, and those call for different next steps from
 * the user.
 *
 * The duration is derived from `DEFAULT_LOOP_CONFIG.timeoutMs` (the bound both
 * agent and setup turns actually run on) so the sentence cannot drift away from
 * the value it claims.
 */
export const TIMEOUT_REPLY =
  `I ran out of time for this turn (the ${Math.round(DEFAULT_LOOP_CONFIG.timeoutMs / 60_000)}-minute ` +
  "wall-clock limit) before producing a final answer, so I've paused here rather " +
  "than leave you with nothing. Tell me how you'd like me to proceed — continue, " +
  "narrow the task, or ask me something specific — and I'll pick up from here.";

/**
 * The `no_progress` sibling of `ITERATION_LIMIT_REPLY`.
 *
 * Reusing `ITERATION_LIMIT_REPLY` here would be the same dishonesty the
 * `TIMEOUT_REPLY` comment above rejected, and worse: nothing was spent on tool
 * use, no budget was exhausted, and "tell me how to proceed" invites the user
 * to pay for another run of empty rounds. The model returned nothing, several
 * times over. That is what this says, and it points at the two actions that can
 * actually change the outcome.
 *
 * The count is derived from the bound so the sentence cannot drift from the
 * value it claims.
 *
 * It deliberately does NOT claim that nothing ran. The stall is only the tail
 * of the turn - rounds before it can have dispatched real tool calls - and a
 * reply that promised a clean slate would be a false statement about a turn
 * that may have moved funds. Pointing at the transcript is the honest version;
 * the renderer's own notice gates one-click retry on the same fact.
 */
export const NO_PROGRESS_REPLY =
  `I stopped this turn early: the model returned ${MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS} ` +
  "empty responses in a row - no answer and no tool call - so continuing would " +
  "have re-sent the same request without producing anything. Check the " +
  "transcript above for what did run, then send the request again, or try a " +
  "different model if it keeps happening.";

/**
 * The `tool_call_loop` sibling of `ITERATION_LIMIT_REPLY`.
 *
 * Says the one thing the user needs to decide what to do next: the model was
 * repeating an identical call that kept returning an identical result, it was
 * told so once, and it did it again. Naming the repetition is what separates
 * this from a budget message - "continue" is precisely the wrong next step
 * here, because continuing is what the model already proved it would do.
 *
 * Like `NO_PROGRESS_REPLY` it does NOT claim that nothing ran: the repeated
 * calls DID execute up to the correction, and earlier rounds in the turn can
 * have done real work, including work that moved funds. It points at the
 * transcript instead, which is both honest and the same policy the renderer's
 * notice uses to withhold one-click retry.
 *
 * It deliberately names no tool and no arguments. The arguments are the
 * sensitive part (a repeated call can carry an address, an amount, a key
 * fragment in an error string), and a reply the user reads is not the place to
 * re-print them; the structured facts on the stop payload carry the tool name
 * and the counts for operators.
 */
export const TOOL_CALL_LOOP_REPLY =
  "I stopped this turn early: I kept repeating the same tool call and getting the "
  + "same result back, and I did it again after being asked to change approach, so "
  + "continuing would just repeat it. Check the transcript above for what did run, "
  + "then tell me what to try differently - a different approach, a narrower step, "
  + "or a different tool.";

/**
 * A runtime bound that ends a turn and therefore owes the user a deterministic
 * reply when the model produced no text.
 *
 * This is deliberately NOT the same set as `isContinuableRuntimeStop`, which
 * answers a different question: whether the turn may be auto-continued.
 * `no_progress` belongs here (a stalled turn must never be silent) but not
 * there (auto-continuing a stall would re-send the request that just produced
 * nothing). Conflating the two predicates is what made a stalled mission-setup
 * turn return `text: null`.
 */
export type RuntimeBoundStop = Extract<
  RuntimeStopReason,
  "iteration_limit" | "timeout" | "no_progress" | "tool_call_loop"
>;

export function isRuntimeBoundStop(
  stopReason: StopReason | null,
): stopReason is RuntimeBoundStop {
  return (
    stopReason === "iteration_limit"
    || stopReason === "timeout"
    || stopReason === "no_progress"
    // Same reason `no_progress` is here and not in `isContinuableRuntimeStop`:
    // a turn that ended on a repetition must never be silent, and must never
    // be auto-continued into repeating it again.
    || stopReason === "tool_call_loop"
  );
}

/**
 * The deterministic reply for a turn that exhausted a runtime bound without the
 * model ever emitting text. Honest about WHICH bound fired; never a generic
 * "budget" paragraph and never a cost figure.
 */
export function runtimeBoundExhaustedReply(trigger: RuntimeBoundStop): string {
  if (trigger === "timeout") return TIMEOUT_REPLY;
  if (trigger === "no_progress") return NO_PROGRESS_REPLY;
  if (trigger === "tool_call_loop") return TOOL_CALL_LOOP_REPLY;
  return ITERATION_LIMIT_REPLY;
}
