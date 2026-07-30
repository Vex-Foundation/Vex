/**
 * Forced compact fallback — runs when the band is `critical` AND the agent
 * has no applicable prepared compaction. Synthesizes the
 * `executeCompactNow` arguments deterministically (NO LLM calls — must be
 * fast and offline-safe) and invokes the service directly. The service
 * never invokes the tool handler, per codex's guardrail.
 *
 * Synthesis sources (best-effort, all from DB):
 *   - agent_summary: top of `sessions.summary` (previous rolling) +
 *     short tail of recent assistant message content. Truncated to ~2000
 *     chars so the noop check doesn't fire on an empty prefix.
 *   - preserve_md: aggregated unresolved outstanding items from
 *     `session_memories.outstanding_items` (last few generations).
 *   - thread_themes_hints: top recent themes from active chunks.
 *
 * If the service still returns `noop` (e.g. the prefix selector finds
 * nothing compactable), the caller decides whether to escalate to
 * `compact_unable_at_critical` after consecutive noop attempts.
 */

import { executeCompactNow, type CompactCommitResult } from "./service.js";
import { getSessionMemoryStats } from "@vex-agent/db/repos/session-memories/index.js";
import { query, queryOne } from "@vex-agent/db/client.js";
import { MEMORY_BANNER_RECENT_THEMES_LIMIT } from "@vex-agent/memory/session-memory-policy.js";
import logger from "@utils/logger.js";

const SUMMARY_TAIL_CHARS = 1500;
const PRESERVE_MAX = 1800;

export async function maybeRunForcedCompactFallback(
  sessionId: string,
): Promise<CompactCommitResult> {
  const summarySource = await synthesizeAgentSummary(sessionId);
  const preserveSource = await synthesizePreserveMd(sessionId);
  const themes = await synthesizeThemes(sessionId);

  logger.info("compact.forced_fallback.fired", {
    sessionId,
    summaryLen: summarySource.length,
    preserveLen: preserveSource.length,
    themeCount: themes.length,
  });

  return executeCompactNow({
    sessionId,
    agentSummary: summarySource,
    preserveMd: preserveSource || null,
    threadThemesHints: themes,
    source: "forced_fallback",
  });
}

async function synthesizeAgentSummary(sessionId: string): Promise<string> {
  const session = await queryOne<{ summary: string | null }>(
    "SELECT summary FROM sessions WHERE id = $1",
    [sessionId],
  );
  const previousSummary = session?.summary?.trim() ?? "";

  // Tail of recent assistant content (compressed).
  const tail = await query<{ content: string }>(
    `SELECT content
     FROM messages
     WHERE session_id = $1
       AND role = 'assistant'
       AND content IS NOT NULL
       AND length(content) > 40
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
    [sessionId],
  );
  const recent = tail
    .map((r) => r.content.replace(/\s+/g, " ").trim().slice(0, 280))
    .reverse()
    .join("\n");

  const composed = [
    previousSummary ? `[Previous rolling summary]\n${previousSummary}` : "",
    recent ? `[Recent assistant tail]\n${recent}` : "",
    "[Note] Deterministic fallback synthesis — no prepared summary was applicable at critical context pressure.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return composed.slice(0, SUMMARY_TAIL_CHARS);
}

async function synthesizePreserveMd(sessionId: string): Promise<string> {
  const rows = await query<{ theme: string; text: string }>(
    `SELECT m.theme, item->>'text' AS text
     FROM session_memories m,
          jsonb_array_elements(m.outstanding_items) item
     WHERE m.session_id = $1
       AND m.status = 'active'
       AND item->>'resolved_at' IS NULL
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 15`,
    [sessionId],
  );
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- [${r.theme}] ${r.text}`);
  return `[Unresolved follow-ups carried forward]\n${lines.join("\n")}`.slice(0, PRESERVE_MAX);
}

async function synthesizeThemes(sessionId: string): Promise<string[]> {
  const stats = await getSessionMemoryStats(sessionId, MEMORY_BANNER_RECENT_THEMES_LIMIT);
  return stats.recentThemes.slice(0, 3);
}
