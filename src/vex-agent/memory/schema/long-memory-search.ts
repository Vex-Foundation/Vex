/**
 * Memory v2 — `MemorySearch` Zod boundary schema (S3).
 *
 * Validates the agent-facing `MemorySearch` payload. The tool HIDES its
 * strategy (vector + dual-trace + rerank), so the agent input is deliberately
 * small: a semantic `query`, an optional result count `k`, an optional exact
 * `kind` filter, the response shape, and the dual-trace / graph-expansion
 * toggles (`expand_graph` defaults ON since S8 — F3).
 *
 * Deliberately ABSENT:
 * - `scope` (R1-#5) — its semantics were undefined vs the hardcoded expiry gate;
 *   S3 always returns active + non-expired.
 * - `include_expired` — S3 never surfaces expired entries (the gate is fixed).
 *
 * `kind` reuses the shared `isValidKind` regex (`knowledge/policy.ts`) — open
 * snake_case, NOT an enum — matching `knowledge_entries.kind`.
 *
 * `k` is clamped to [1, LONG_MEMORY_MAX_K] here so the repo always receives a
 * bounded value — the agent can never push an unbounded k to the repo.
 *
 * Pure module: Zod schema + derived type. No DB, no embeddings, no I/O.
 */

import { z } from "zod";

import { isValidKind, MAX_KIND_LENGTH } from "@vex-agent/knowledge/policy.js";
import {
  LONG_MEMORY_DEFAULT_K,
  LONG_MEMORY_MAX_K,
} from "@vex-agent/memory/long-memory-retrieval-policy.js";

/** Min/max query length accepted at the search boundary. */
export const LONG_MEMORY_QUERY_MIN = 1;
export const LONG_MEMORY_QUERY_MAX = 512;

const responseFormatSchema = z.enum(["concise", "detailed"]);
export type LongMemorySearchResponseFormat = z.infer<typeof responseFormatSchema>;

export const longMemorySearchInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(LONG_MEMORY_QUERY_MIN, "query must not be empty")
      .max(LONG_MEMORY_QUERY_MAX, `query must be ≤ ${LONG_MEMORY_QUERY_MAX} chars`),
    // Coerce a finite number, floor it, clamp to [1, MAX]; default when absent.
    k: z
      .number()
      .int()
      .positive()
      .transform((v) => Math.min(v, LONG_MEMORY_MAX_K))
      .default(LONG_MEMORY_DEFAULT_K),
    kind: z
      .string()
      .max(MAX_KIND_LENGTH)
      .refine((v) => isValidKind(v), {
        message: "kind must be snake_case ASCII starting with a letter",
      })
      .optional(),
    responseFormat: responseFormatSchema.default("concise"),
    includeCandidates: z.boolean().default(true),
    // S8 (F3): graph expansion is ON by default — 1-hop neighbors fill the
    // remaining inline slots, bounded + marked; the agent can opt out.
    expandGraph: z.boolean().default(true),
  })
  .strict();

export type LongMemorySearchInput = z.infer<typeof longMemorySearchInputSchema>;
