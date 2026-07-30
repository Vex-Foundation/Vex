/**
 * Session memory tools — per-session narrative memory layer (PR2).
 *
 * Two tools:
 *   - `session_memory_search`: semantic search over THIS session's narrative
 *     chunks produced by Track 2 of the compact pipeline. pressureSafety
 *     read_only.
 *
 *   - `session_memory_resolve_item`: close one outstanding item on a chunk.
 *     Updates the JSONB element, re-renders body_md, re-embeds. pressureSafety
 *     read_only (the operation is small and bounded, and resolving outstanding
 *     items at pressure is a sensible pre-compact wrap-up).
 *
 * Both are gated by `visibility.requiresSessionMemory` — hidden from the tool
 * catalog until the session has active narrative chunks (a fresh session has
 * nothing to recall). The handlers still short-circuit on empty state as
 * defense-in-depth (visibility controls only what the LLM sees).
 *
 * Both tools route through `tools/internal/session-memory/{search,resolve-item}.ts`.
 */

import type { ToolDef } from "../types.js";

export const SESSION_MEMORY_TOOLS: readonly ToolDef[] = [
  {
    name: "session_memory_search",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: { requiresSessionMemory: true },
    description: [
      "Semantic recall over THIS SESSION's narrative memory chunks. Each chunk is a 4-section markdown body (what happened / what I did / what I tried / outstanding items) produced automatically when the conversation was compacted.",
      "Per-session only — does NOT reach earlier sessions. For durable cross-session lessons use `long_memory_search`.",
      "Use when you forgot what you tried earlier in this mission, want to avoid repeating a failed approach, or need to check past tool outcomes that no longer fit in the live transcript.",
      "Write SEMANTIC INTENT in English, not keywords (translate the user's intent first — embedding retrieval is significantly stronger on English).",
      "✓ \"previous attempts to debug Kyber quote timeout and what we learned\"",
      "✗ \"kyber\"",
      "✓ \"wallet balance checks earlier in the mission and their outcomes\"",
      "✗ \"balance\"",
      "Returns top-K chunks above the similarity threshold.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Semantic intent phrase in English (NOT keywords; translate the user's intent first). Write the way you would ask another expert who knows the mission.",
        },
        k: {
          type: "number",
          description: "Max chunks to return (default 5, hard max 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "session_memory_resolve_item",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "local_write",
    visibility: { requiresSessionMemory: true },
    description: [
      "Close a single outstanding item on a session memory chunk. Use when a previously-open follow-up (pending tx, awaiting decision, lookup needed) is now done — keeps the resume packet's Outstanding section honest across compacts.",
      "memory_id is the chunk id from session_memory_search output. outstanding_item_id is the UUID of the specific item to resolve (shown in the chunk's Outstanding section). resolution_note is a short (≤500-char) explanation persisted for audit and future recall.",
      "Bounded: resolving one item never affects siblings — chunks with multiple outstanding items remain partially open. The chunk's body_md is re-rendered and re-embedded so future session_memory_search reflects the resolved state. Concurrent-resolution-safe (transactional row lock).",
      "Pressure-band rule: still callable at barrier/critical (read_only classification) because closing outstanding work is a sensible pre-compact wrap-up — it actually reduces resume-packet noise.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        memory_id: {
          type: "number",
          description: "Session memory chunk id (from session_memory_search output).",
        },
        outstanding_item_id: {
          type: "string",
          description: "UUID v4 of the specific outstanding item to resolve.",
        },
        resolution_note: {
          type: "string",
          description:
            "Short note (≤500 chars) explaining how the item was resolved. Write it in English — the note is persisted and re-embedded into the chunk body for future recall.",
        },
      },
      required: ["memory_id", "outstanding_item_id", "resolution_note"],
      additionalProperties: false,
    },
  },
];
