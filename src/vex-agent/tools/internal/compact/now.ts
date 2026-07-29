/**
 * `compact_now` tool handler — thin Zod wrapper over `executeCompactNow`.
 *
 * Visible only at pressure band ≥ barrier (gated by registry visibility +
 * dispatcher hard-deny on `pressureSafety: "compact_only"`).
 *
 * On committed compact: returns an `engineSignal: { type: "compact_committed",
 * ... }` so the turn-loop can drain remaining tool calls in the batch with
 * `batch_aborted_by_compact`, reload live messages, merge operator
 * interrupts, update `mission_runs.last_checkpoint_at`, and inject the
 * deterministic resume packet for the next `POST_COMPACT_BRIDGE_CYCLES`
 * turns.
 *
 * On noop (empty prefix / nothing compactable): NO engine signal. The
 * agent sees a successful tool result with `noop: true` and the band
 * banner still appears next turn. Turn-loop's critical-band counter
 * (PR2 Step 9) escalates after consecutive noops.
 */

import { z } from "zod";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import {
  MAX_THEME_HINTS,
  CHUNK_SECTION_MAX_CHARS,
  OUTSTANDING_ITEM_TEXT_MAX,
} from "@vex-agent/memory/session-memory-policy.js";
import { executeCompactNow } from "@vex-agent/engine/compact-jobs/service.js";
import logger from "@utils/logger.js";

const CompactNowSchema = z.object({
  conversation_summary: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Your understanding of what happened in this conversation: mission goal, decisions made, current state, recent tool outcomes. Replaces the rolling summary wholesale — write it for your post-compact self. Write it in English (persisted-memory contract; translate first when the conversation happened in another language).",
    ),
  preserve_md: z
    .string()
    .max(CHUNK_SECTION_MAX_CHARS)
    .optional()
    .describe(
      "Hard-priority facts that MUST survive (open loops, pending decisions, key entities). Surfaced in the resume packet immediately after compact. Write it in English (persisted-memory contract).",
    ),
  thread_themes_hints: z
    .array(z.string().min(1).max(OUTSTANDING_ITEM_TEXT_MAX))
    .max(MAX_THEME_HINTS)
    .optional()
    .describe(
      "Optional 1-3 thematic labels suggesting how to slice the archived prefix into narrative chunks. The chunker validates and may override generic hints. Write them as English snake_case slugs (persisted-memory contract).",
    ),
});

export async function handleCompactNow(
  args: unknown,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = CompactNowSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: `compact_now: invalid arguments: ${parsed.error.message}`,
    };
  }
  const { conversation_summary, preserve_md, thread_themes_hints } = parsed.data;

  logger.info("compact.now.called", {
    sessionId: context.sessionId,
    summaryLen: conversation_summary.length,
    preserveLen: preserve_md?.length ?? 0,
    themeCount: thread_themes_hints?.length ?? 0,
    band: context.contextUsageBand,
  });

  const result = await executeCompactNow({
    sessionId: context.sessionId,
    agentSummary: conversation_summary,
    preserveMd: preserve_md ?? null,
    threadThemesHints: thread_themes_hints ?? [],
    source: "agent_tool",
  });

  if (result.kind === "noop") {
    logger.info("compact.now.noop", {
      sessionId: context.sessionId,
      reason: result.reason,
    });
    return {
      success: true,
      output:
        `compact_now noop: ${result.reason}. Nothing compactable in the live transcript right now. ` +
        `If context pressure persists, continue working — the runtime will retry the compact on the next turn.`,
      data: { noop: true, reason: result.reason },
      // Intentionally NO engineSignal — noop must not be treated as a committed
      // compact by the turn-loop (no reload, no last_checkpoint_at, no bridge).
    };
  }

  return {
    success: true,
    output:
      `Compact committed. Archived ${result.archivedMessages} message(s) (plan: ${result.planMode}). ` +
      `Generation ${result.generation}. Archive chunking job ${result.jobId} enqueued for async processing — ` +
      `the narrative chunks will become recallable via session_memory_search once that worker lands them. ` +
      `Remaining tool calls in this batch will be aborted; resume packet will inject on the next turn.`,
    data: {
      generation: result.generation,
      archived_messages: result.archivedMessages,
      job_id: result.jobId,
      plan_mode: result.planMode,
      redaction_hard_count: result.redactionCounts.hard,
      redaction_mask_count: result.redactionCounts.mask,
    },
    engineSignal: {
      type: "compact_committed",
      reason: "context_pressure_compact",
      summary: `Archived ${result.archivedMessages} message(s) at generation ${result.generation}`,
      generation: result.generation,
      jobId: result.jobId,
    },
  };
}
