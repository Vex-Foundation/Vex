/**
 * Engine runner shared utilities — tool definitions and default config.
 */

import { getOpenAITools } from "@vex-agent/tools/registry.js";
import type { ToolDefinition } from "@vex-agent/inference/types.js";
import type { TurnLoopConfig } from "../turn-loop.js";

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
  // backstops against runaway tool-call loops; the 10-minute timeoutMs and
  // context-pressure compaction are the independent wall-clock backstops.
  maxIterations: 50,
  timeoutMs: 600_000, // 10 minutes
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
 * The deterministic reply for a turn that exhausted a runtime bound without the
 * model ever emitting text. Honest about WHICH bound fired; never a generic
 * "budget" paragraph and never a cost figure.
 */
export function runtimeBoundExhaustedReply(
  trigger: "iteration_limit" | "timeout",
): string {
  return trigger === "timeout" ? TIMEOUT_REPLY : ITERATION_LIMIT_REPLY;
}
