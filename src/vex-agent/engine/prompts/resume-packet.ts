/**
 * Resume packet — deterministic snapshot injected into the system prompt
 * for the first `POST_COMPACT_BRIDGE_CYCLES` (default 2) turns immediately
 * after a `compact_committed` engine signal.
 *
 * Sourced entirely from DB (no LLM calls, no embeddings). Includes:
 *   - The fresh rolling summary from `sessions.summary` (agent's own
 *     prepared branch-A summary).
 *   - The `preserve_md` field from the most recent `compact_jobs` row,
 *     sanitized via `sanitizePreserveMd` before injection. preserve_md is
 *     attacker-influenced data (agent supplied it, redaction stripped raw
 *     secrets, but the model could still embed pseudo-system tags or fence
 *     escapes to alter the prompt structure). A markdown fence is NOT
 *     enough — triple-backtick fences are themselves emit-able. The
 *     sanitizer neutralizes triple backticks, `<system>` / `<assistant>` /
 *     `<user>` pseudo-tags, and `[INST]` / `[/INST]` /
 *     `<|im_start|>` / `<|im_end|>` chat-template artifacts.
 *   - Up to N unresolved outstanding items aggregated across active chunks.
 *   - Last 3 assistant decisions and last 3 tool outcomes (best-effort from
 *     the post-archive `messages` table, which is now the post-compact tail
 *     so it's a small read).
 *
 * Codex required: "include sanitized preserve_md in resume packets."
 */

import { query, queryOne } from "@vex-agent/db/client.js";
import { getBySessionAndGeneration } from "@vex-agent/db/repos/compact-jobs/index.js";
import { listUnresolvedOutstandingItems } from "@vex-agent/db/repos/session-memories/index.js";
import { sanitizeForSystemPrompt } from "./sanitize.js";

/** Re-export so the regression suite that already imports `sanitizePreserveMd`
 *  from this module keeps compiling after the helper moved to `./sanitize.ts`. */
export { sanitizePreserveMd } from "./sanitize.js";

const MAX_UNRESOLVED_LINES = 10;
const MAX_DECISIONS = 3;
const MAX_TOOL_OUTCOMES = 3;

export async function buildResumePacket(
  sessionId: string,
  generation: number,
): Promise<string> {
  const session = await queryOne<{ summary: string | null; checkpoint_generation: number }>(
    "SELECT summary, checkpoint_generation FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) return "";

  const compactJob = await getBySessionAndGeneration(sessionId, generation);

  // Aggregate unresolved outstanding items across active chunks — repo-owned
  // SQL (D-RESUME-SQL: `listUnresolvedOutstandingItems` in
  // db/repos/session-memories carries the query 1:1).
  const outstandingRows = await listUnresolvedOutstandingItems(
    sessionId,
    MAX_UNRESOLVED_LINES,
  );

  // Last N assistant messages with substantive content (decisions).
  const decisionRows = await query<{ content: string; created_at: string }>(
    `SELECT content, created_at
     FROM messages
     WHERE session_id = $1
       AND role = 'assistant'
       AND content IS NOT NULL
       AND length(content) > 40
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sessionId, MAX_DECISIONS],
  );

  // Last N tool result messages.
  const toolRows = await query<{ tool_call_id: string | null; content: string; created_at: string }>(
    `SELECT tool_call_id, content, created_at
     FROM messages
     WHERE session_id = $1
       AND role = 'tool'
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sessionId, MAX_TOOL_OUTCOMES],
  );

  const lines: string[] = [];
  lines.push(`[Resume packet — generation ${session.checkpoint_generation}, just compacted]`);
  lines.push("");
  // Every DB-derived string below is funneled through
  // `sanitizeForSystemPrompt` because the resume packet ends up as a system
  // prompt layer. `sessions.summary` and `compact_jobs.preserve_md` are
  // LLM-emitted prose (post-redaction); outstanding-item text and recent
  // assistant/tool content can also embed fence escapes or pseudo role
  // tags. Without per-field sanitization the durable rolling context would
  // be a prompt-injection vector. (codex P1 — round 2.)
  lines.push("## Rolling summary");
  const summary = session.summary?.trim();
  lines.push(summary ? sanitizeForSystemPrompt(summary) : "(empty)");
  lines.push("");
  if (compactJob?.preserveMd && compactJob.preserveMd.trim().length > 0) {
    lines.push("## Preserve");
    const safe = sanitizeForSystemPrompt(compactJob.preserveMd.trim());
    lines.push("```");
    lines.push(safe);
    lines.push("```");
    lines.push("");
  }
  if (outstandingRows.length > 0) {
    lines.push(`## Outstanding follow-ups (${outstandingRows.length})`);
    for (const r of outstandingRows) {
      const safeText = sanitizeForSystemPrompt(r.text);
      const safeTheme = sanitizeForSystemPrompt(r.theme);
      lines.push(`- [${safeTheme}] (memory_id=${r.memoryId}, item_id=${r.itemId}) ${safeText}`);
    }
    lines.push("");
  }
  if (decisionRows.length > 0) {
    lines.push(`## Recent decisions (last ${decisionRows.length})`);
    for (const r of decisionRows) {
      const compact = r.content.replace(/\s+/g, " ").trim().slice(0, 280);
      lines.push(`- (${r.created_at}) ${sanitizeForSystemPrompt(compact)}`);
    }
    lines.push("");
  }
  if (toolRows.length > 0) {
    lines.push(`## Recent tool outcomes (last ${toolRows.length})`);
    for (const r of toolRows) {
      const compact = r.content.replace(/\s+/g, " ").trim().slice(0, 240);
      lines.push(`- (${r.created_at}) ${sanitizeForSystemPrompt(compact)}`);
    }
  }
  return lines.join("\n");
}
