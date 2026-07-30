/**
 * Turn envelope — assembly of the provider request's message array.
 *
 * MOVED VERBATIM out of `turn.ts` (behaviour-preserving extraction, proven by
 * `turn-envelope-characterization.test.ts`, which was green before and after
 * the move and was never edited). It lives on its own so that the
 * pre-inference byte ceiling (C8) and the request actually sent can measure
 * the IDENTICAL object: a ceiling computed over a re-built envelope would be
 * a lie the moment the two builds diverge.
 *
 * Provider-message layout (D-LAYOUT) — four cache segments, marked with
 * `cacheHint` so the inference layer can place cache breakpoints without
 * positional heuristics:
 *
 *   [0]  system  static prefix (joined staticLayers)   "static_prefix"
 *   [1]  system  compaction summary (when present)     "summary"
 *   […]  history (DB tape; LAST non-empty message      "history_tail"
 *        marked AFTER repairOrphanedToolCalls)
 *   [N]  system  turn state (joined turnLayers)        "turn_state"
 */

import type { EngineContext } from "../types.js";
import type { ProviderMessage } from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import { buildPromptStack, type PromptStackOptions } from "../prompts/index.js";
import { sanitizeForSystemPrompt } from "../prompts/sanitize.js";
import { repairOrphanedToolCalls } from "./transcript-integrity.js";
import logger from "@utils/logger.js";

export interface TurnEnvelope {
  /** The final, repaired, cache-hinted message array sent to the provider. */
  readonly providerMessages: ProviderMessage[];
  /** Synthetic tool-result rows inserted by the in-flight orphan repair. */
  readonly insertedPlaceholders: number;
}

/**
 * Build the provider message array for one turn.
 *
 * Pure apart from the one repair log line: no DB reads, no memory/knowledge
 * IO. `promptOptions` arrives FULLY BUILT from the caller —
 * `buildTurnPromptStack` owns the single pre-inference memory read.
 */
export function buildTurnEnvelope(
  context: EngineContext,
  existingMessages: Message[],
  summary: string | null,
  promptOptions: PromptStackOptions = {},
): TurnEnvelope {
  // Build prompt — split into the stable static prefix and the volatile
  // turn-state segment (D-LAYOUT). Each segment is joined separately.
  const promptStack = buildPromptStack(context, promptOptions);
  const staticPrompt = promptStack.staticLayers.join("\n\n---\n\n");
  const turnStatePrompt = promptStack.turnLayers.join("\n\n---\n\n");

  // Convert to provider format
  const providerMessages = buildProviderMessages(
    staticPrompt,
    summary,
    existingMessages,
    turnStatePrompt,
  );

  // In-flight repair only; DB tape remains unchanged.
  const repair = repairOrphanedToolCalls(providerMessages);
  if (repair.insertedPlaceholders > 0) {
    logger.info("turn.transcript.repaired", {
      sessionId: context.sessionId,
      inserted: repair.insertedPlaceholders,
    });
  }

  // Mark the history tail AFTER repair so breakpoint B sits on the FINAL
  // tape — repair may append placeholder tool rows behind an assistant with
  // unanswered tool calls, and B must not land before them. `hasSummary`
  // mirrors buildProviderMessages' truthiness check (empty string = none).
  markHistoryTail(repair.messages, summary !== null && summary.length > 0);

  return {
    providerMessages: repair.messages,
    insertedPlaceholders: repair.insertedPlaceholders,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function buildProviderMessages(
  staticPrompt: string,
  summary: string | null,
  messages: Message[],
  turnStatePrompt: string,
): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  // Static system prefix — breakpoint A candidate.
  result.push({ role: "system", content: staticPrompt, cacheHint: "static_prefix" });

  // Compaction summary (if checkpoint happened). The summary is LLM-emitted
  // prose that reaches the next provider call as a system message. Sanitize
  // before injection so a crafted summary can't carry fence escapes or pseudo
  // role tags into the durable rolling context.
  if (summary) {
    result.push({
      role: "system",
      content: `[Previous conversation summary]\n${sanitizeForSystemPrompt(summary)}`,
      cacheHint: "summary",
    });
  }

  // Message history
  for (const msg of messages) {
    const providerMsg: ProviderMessage = {
      role: msg.role as ProviderMessage["role"],
      content: msg.content,
    };

    if (msg.toolCallId) {
      providerMsg.toolCallId = msg.toolCallId;
    }

    if (msg.toolCalls) {
      providerMsg.toolCalls = msg.toolCalls.map(tc => ({
        id: tc.id,
        command: tc.command,
        args: tc.args,
      }));
    }

    result.push(providerMsg);
  }

  // Trailing turn-state system message — NEVER cache-marked for a breakpoint.
  result.push({ role: "system", content: turnStatePrompt, cacheHint: "turn_state" });

  return result;
}

/**
 * Mark the LAST history message with non-empty content as `history_tail`
 * (breakpoint B carrier). Empty-content rows are skipped backwards; an empty
 * history leaves no marker (no B). Role-agnostic — production tapes
 * legitimately end with system rows (continue-cue / operator-cue) or with
 * repair-inserted placeholder tool rows, which carry non-empty content.
 *
 * Operates on the POST-repair tape: history spans the indices between the
 * leading static/summary system messages and the trailing turn-state message.
 */
function markHistoryTail(messages: ProviderMessage[], hasSummary: boolean): void {
  const historyStart = hasSummary ? 2 : 1;
  // Last index before the trailing turn-state message.
  for (let i = messages.length - 2; i >= historyStart; i--) {
    // Bound by the loop, but narrowed explicitly rather than asserted: the
    // app's `noUncheckedIndexedAccess` ratchet types this read as possibly
    // undefined, and a `!` here would trade a compiler guarantee for a comment.
    const candidate = messages[i];
    if (candidate !== undefined && candidate.content.length > 0) {
      candidate.cacheHint = "history_tail";
      return;
    }
  }
}
