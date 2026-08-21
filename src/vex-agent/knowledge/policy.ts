/**
 * Long-memory policy — pure TS constants and helpers.
 *
 * No DB, no embeddings, no I/O. Tested as plain unit tests.
 *
 * Design notes:
 * - `kind` is free-form, agent-defined snake_case. The code never enumerates kinds —
 *   the taxonomy grows organically via `MemorySuggest` proposals and the prompt
 *   shows "Known kinds" so the agent can reuse instead of creating variants.
 * - Lifecycle (promotion, supersede, invalidation, archival) is owned by the memory
 *   manager; this module only describes the shared shape constraints and the
 *   retrieval/prompt-section caps that survive on the v2 side.
 */

// ── Status ───────────────────────────────────────────────────────

export type KnowledgeStatus = "active" | "superseded" | "invalidated" | "archived";

// ── Kind sanity ──────────────────────────────────────────────────

/**
 * Allowed `kind` shape: snake_case ASCII, must start with a-z, may contain
 * a-z 0-9 _ afterwards, max 64 chars. Rejects:
 *   - camelCase ("pumpFun")
 *   - kebab-case ("pump-fun")
 *   - PascalCase ("Pump_Fun")
 *   - leading digit ("1pump")
 *   - non-ASCII ("pumpfün")
 */
const KIND_REGEX = /^[a-z][a-z0-9_]*$/;
export const MAX_KIND_LENGTH = 64;

export function isValidKind(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_KIND_LENGTH) return false;
  return KIND_REGEX.test(value);
}

// ── Recall constants ─────────────────────────────────────────────

/** Hard upper bound on retrieval `k` (caller may not request more). */
export const RECALL_MAX_K = 15;

/** Maximum number of distinct kinds shown in the Active Memory "Known kinds" section. */
export const KNOWN_KINDS_LIMIT = 30;

/** Maximum total chars devoted to the Active Memory hot-context entries block. */
export const ACTIVE_KNOWLEDGE_HOT_CHARS_CAP = 3000;

/** Maximum total chars devoted to the Active Memory "Known kinds" line. */
export const ACTIVE_KNOWLEDGE_KINDS_CHARS_CAP = 500;

/** Per-entry summary truncation in the Active Memory hot-context block. */
export const ACTIVE_KNOWLEDGE_SUMMARY_TRUNCATE = 200;

/** Maximum number of hot-context entries shown in Active Memory. */
export const ACTIVE_KNOWLEDGE_ENTRY_LIMIT = 12;
