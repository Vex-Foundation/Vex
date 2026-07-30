/**
 * Session memory policy — pure TS constants and helpers for the per-session
 * narrative memory system (`session_memories` table + Track 2 chunking
 * pipeline + `session_memory_search` tool).
 *
 * No DB, no embeddings, no I/O. Tested as plain unit tests.
 *
 * Design notes:
 * - All chunk text is English-by-contract. The chunker translates narrative
 *   fields into English before persistence so session memory and knowledge
 *   recall share one embedding-language convention.
 * - `theme` is a free-form slug, not an enum. Structured fields (entities,
 *   protocols, error_classes, chains, tasks) carry the discriminators that
 *   would otherwise force a rigid kind taxonomy.
 * - Exclusion rules (`./exclusion-rules.ts`) and redaction (`./redaction.ts`)
 *   apply to all chunker output before DB write — live state and secrets
 *   never land in long-term storage.
 */

// ── Chunking limits ──────────────────────────────────────────────

/**
 * Maximum number of theme hints carried into the archive chunking worker.
 * Chunk count itself is intentionally UNCAPPED — the chunker LLM decides how
 * many narrative chunks the archived prefix warrants. Slicing or rejecting
 * past a hard cap would throw away the model's deliberate signal; see codex
 * PR5 audit and the user instruction "wtf slice, truncate".
 */
export const MAX_THEME_HINTS = 3;

/** Maximum length of any single chunk markdown section (`happened_md`, `did_md`, `tried_md`). */
export const CHUNK_SECTION_MAX_CHARS = 2000;

/** Maximum length of the materialized `body_md` (sum of sections + headers). */
export const CHUNK_BODY_MAX_CHARS = 8000;

/** Maximum number of outstanding items per chunk. */
export const MAX_OUTSTANDING_ITEMS_PER_CHUNK = 5;

/** Maximum length of a single outstanding item's text or resolution_note. */
export const OUTSTANDING_ITEM_TEXT_MAX = 500;

// ── Recall limits ───────────────────────────────────────────────

/** Default `k` for `session_memory_search` when caller omits it. */
export const MEMORY_RECALL_DEFAULT_K = 5;

/** Hard upper bound on `k` for `session_memory_search`. */
export const MEMORY_RECALL_MAX_K = 5;

/** Minimum cosine similarity for a chunk to be included in recall results. */
export const MEMORY_RECALL_MIN_SIMILARITY = 0.30;

// ── Banner / state surface ──────────────────────────────────────

/** Maximum number of distinct recent themes shown in the session memory banner. */
export const MEMORY_BANNER_RECENT_THEMES_LIMIT = 5;

// ── Theme / chunk validation ────────────────────────────────────

/**
 * Tokens that are forbidden as a theme on their own. The chunker is allowed
 * to use these as part of a compound theme (e.g. `kyber_quote_debug` is fine)
 * but a bare `debug` or `session` slug is rejected as degenerate.
 */
export const THEME_STOPLIST_STANDALONE = new Set<string>([
  "mission",
  "session",
  "debug",
  "setup",
  "work",
  "task",
  "general",
  "various",
  "miscellaneous",
  "context",
  "conversation",
  "chat",
]);

/** Theme slug regex: 3-8 underscore-separated lowercase alphanumeric tokens. */
export const THEME_REGEX = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,7}$/;

// ── Exclusion (live-state) thresholds ───────────────────────────

/**
 * If exclusion-rules detect that ≥ this fraction of a chunk's `body_md` words
 * match live-state patterns (balances, prices, gas, tx hashes), the chunk is
 * rejected entirely. Live state belongs in tool calls, not embedded memory.
 */
export const EXCLUSION_REJECT_THRESHOLD = 0.30;

// ── Helpers ─────────────────────────────────────────────────────

/** Clamp a caller-supplied `k` for `session_memory_search` to the allowed range. */
export function clampMemoryRecallK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k) || k <= 0) return MEMORY_RECALL_DEFAULT_K;
  if (k > MEMORY_RECALL_MAX_K) return MEMORY_RECALL_MAX_K;
  return Math.floor(k);
}
