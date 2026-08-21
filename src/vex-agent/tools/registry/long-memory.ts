/**
 * Long-term memory tools (memory v2) — the agent-facing write-door into
 * cross-session candidate memory.
 *
 * `MemorySuggest` is the ONLY agent-facing write tool in the v2 memory
 * system (S2). It STAGES a candidate — it does NOT write memory directly — and
 * an async manager (S4) reviews, dedupes, and decides promotion. Namespaced
 * `long_memory_*` to stay distinct from per-session `memory_*` and the legacy
 * `knowledge_*` surface (which stays live until the S9 cutover).
 *
 * Classification rationale (memory-system/s2-plan.md §3):
 * - `mutating: false` — a LOCAL candidate write, NOT an approval-gated external
 *   mutation. `mutating: true` would wrongly trigger approval in restricted
 *   sessions (the dispatcher's internal mutating-approval gate); session-memory
 *   local-writes use `mutating: false` for the same reason.
 * - `pressureSafety: "mutating"` — still blocked at barrier/critical so the
 *   agent does not suggest while compaction is urgent.
 * - `actionKind: "local_write"` — a Vex-local DB write (candidate staging).
 * - `visibility: {}` — always visible in every session context.
 *
 * The three READ tools (S3) — `MemorySearch` / `MemoryGet` /
 * `MemoryHistory` — are the cross-session RECALL door. All are
 * `mutating:false`, `pressureSafety:"read_only"`, `actionKind:"read"`,
 * `visibility:{}` (always visible — unlike session memory's
 * `requiresSessionMemory` gate). `MemorySearch` hides its strategy
 * (vector + dual-trace + rerank); fresh un-consolidated candidates surface as
 * de-weighted soft signals (`notConsolidated:true`), never as fact.
 */

import type { ToolDef } from "../types.js";
import { formatKindExamples } from "@vex-agent/memory/kind-catalog.js";

export const LONG_MEMORY_TOOLS: readonly ToolDef[] = [
  {
    name: "MemorySuggest",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "local_write",
    visibility: {},
    description: [
      // WHAT
      "Propose a durable, cross-session LESSON for long-term memory — a trading insight, a strategy/risk lesson, a stable user preference, or a project fact or constraint. Write title and summary in English (embedding retrieval is significantly stronger on English).",
      // HOW IT WORKS
      "This does NOT write memory directly. It STAGES a candidate; an async manager later reviews it, dedupes it, and decides whether to promote it into long-term memory. You get back a candidateId and status, not a stored memory.",
      // DO NOT (steering — reject policy advertised so you rarely trip it)
      "Never include secrets (keys, seeds, API tokens) — a candidate carrying one is REJECTED and nothing is stored. Do NOT record live values (current balances, prices, gas, amounts, open quotes) — memory is for the durable LESSON, not the snapshot, and a candidate that reads as live state is REJECTED. Persisted memory text is English-only: a candidate whose title/summary/content does not read as English is REJECTED — translate the durable lesson into English and re-suggest. Wallet and transaction addresses are auto-masked, so the lesson survives without the raw value.",
      // EVIDENCE
      "Attach evidence_refs (protocol execution / capture ids, with optional instrumentKey / positionKey) when the lesson came from a real trade — it makes the lesson far stronger downstream. source_refs is pointer-only (messageIds / toolCallIds) provenance from this session.",
      // response_format
      "response_format: 'concise' (default) returns the candidate id + status; 'detailed' adds redaction counts, the derived source tier, and the dual-trace retrieval window.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description:
            `Free-form snake_case kind, English (e.g. ${formatKindExamples()}). Reuse an existing kind before inventing a new one.`,
        },
        title: {
          type: "string",
          description: "Single thesis or lesson, in English. Embedding input together with summary.",
        },
        summary: {
          type: "string",
          description:
            "1-3 sentences in English stating the durable lesson. This is ALSO the retrieval representation — title + summary are the embedding input, so write retrieval-quality semantic text using stable protocol/ticker names (and their common synonyms), never live balances, prices, amounts, or transient quotes.",
        },
        content_md: {
          type: "string",
          description: "Optional fuller markdown body in English (defaults to empty). Stored verbatim (after redaction).",
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description: "Optional entity tokens this lesson is about (e.g. ['SOL', 'kyberswap']).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional string tags (e.g. ['risk', 'memecoin']).",
        },
        source_refs: {
          type: "object",
          description:
            "Pointer-only provenance from THIS session: { messageIds:[int], toolCallIds:[string] }. No free text.",
          properties: {
            messageIds: { type: "array", items: { type: "number" } },
            toolCallIds: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        evidence_refs: {
          type: "array",
          description:
            "Immutable evidence anchors when the lesson came from a real trade. Each: { executionId:int (required), captureItemId:int?, instrumentKey:string?, positionKey:string? }.",
          items: {
            type: "object",
            properties: {
              executionId: { type: "number" },
              captureItemId: { type: "number" },
              instrumentKey: { type: "string" },
              positionKey: { type: "string" },
            },
            required: ["executionId"],
            additionalProperties: false,
          },
        },
        confidence: { type: "number", description: "Your confidence in the lesson, 0..1." },
        importance: { type: "number", description: "Importance 1..10 (default 5)." },
        event_time: {
          type: "string",
          description: "Optional ISO 8601 timestamp of when the underlying event happened.",
        },
        observed_at: {
          type: "string",
          description: "Optional ISO 8601 timestamp of when you observed the lesson.",
        },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description: "concise (default) → id + status; detailed → adds redaction counts, source tier, dual-trace window.",
        },
      },
      required: ["kind", "title", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "MemorySearch",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: {},
    description: [
      // WHAT
      "Semantic recall over LONG-TERM, cross-session memory — durable lessons, strategies, risk rules, observed user preferences, and stable protocol facts learned in earlier sessions. This is how you remember what a previous session figured out.",
      // HOW IT WORKS (strategy hidden on purpose)
      "Hides its retrieval strategy: it blends promoted long-term entries (source:'long_memory') with FRESH un-consolidated signals from this and recent sessions (source:'memory_candidate', notConsolidated:true). A confirmed long-term lesson always outranks a fresh candidate at equal relevance; a much stronger fresh match can still surface. Treat notConsolidated results as soft hints, never as established fact.",
      // QUERY GUIDANCE
      "Write SEMANTIC INTENT in English, not keywords (embedding retrieval is significantly stronger on English; translate the user's intent first). ✓ 'user trading risk preferences and position sizing rules' ✗ 'risk'. Returns only active, non-expired memory.",
      // RESPONSE
      "response_format: 'concise' (default) → source, id, kind, title, similarity, score (+ notConsolidated on fresh signals); 'detailed' adds summary, content, tags, validUntil, maturity, source tier, evidence. Results found through the knowledge graph (1-hop from a direct hit) carry via:'via_graph(entity)' and no inline content — use MemoryGet on their id when the lead matters. If results were truncated to the inline cap, the response says so and asks you to refine — there is no overflow fetch.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Semantic intent in English (translate the user's intent first). Write the way you'd ask an expert who shares your memory; 1-512 chars.",
        },
        k: {
          type: "number",
          description: "Max results to consider (default 8, hard max 15). The response is still capped to the inline limit.",
        },
        kind: {
          type: "string",
          // Intentional change: 2 → 4 examples, catalog order (D-KINDS).
          description: `Optional exact kind filter (free-form snake_case, e.g. ${formatKindExamples()}). Omit to search across all kinds.`,
        },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description: "concise (default) → id/title/scores; detailed → adds summary, content, tags, maturity, source tier, evidence.",
        },
        include_candidates: {
          type: "boolean",
          description: "Include fresh un-consolidated dual-trace signals (default true). Set false to see only promoted long-term entries.",
        },
        expand_graph: {
          type: "boolean",
          description:
            "Knowledge-graph expansion (default true): 1-hop graph neighbors of the top direct hits fill the REMAINING inline slots, marked via_graph(entity) and always scored below the direct result they came from. Set false to disable.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "MemoryGet",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: {},
    description: [
      "Fetch a single long-term memory entry by id (the numeric id returned by MemorySearch results with source:'long_memory'). Loads its full content into context.",
      "If the entry was replaced by a newer version, this fails with a pointer to the current entry id; if it is no longer current (invalidated/archived) it says so. Use MemorySearch to find a current id, MemoryHistory to trace the version chain.",
      "response_format: 'concise' (default) returns id/kind/title/summary/status + lineage links (the full body is still loaded into context); 'detailed' additionally inlines content_md, tags, source refs, confidence, and lifecycle metadata. Does not require the embeddings service.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Long-term memory entry id (from a MemorySearch 'long_memory' result)." },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description: "concise (default) → metadata + lineage links (body still loaded into context); detailed → also inlines content_md + lifecycle metadata.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "MemoryHistory",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    visibility: {},
    description: [
      "Trace the full version chain (root → head) of a long-term memory entry from any id in the chain, plus its reinforcement timeline (when it was first promoted, last reinforced, and its outcome version).",
      "Use this when you have a historical id (e.g. from MemoryGet's supersededBy/supersedesId) and want to see how the lesson evolved and whether the current head is still active. Returns compact metadata (no full content — use MemoryGet for that).",
      "Read-only. Does not require the embeddings service.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Any long-term memory entry id in the chain (root, middle, or head)." },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description: "Reserved — the chain + reinforcement timeline are returned the same way for both.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
