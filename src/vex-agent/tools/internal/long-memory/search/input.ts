/**
 * `long_memory_search` input contract (step 1 of the handler, split out in
 * 0R.15, refactor-only): the accepted param set, the snake_case → camelCase
 * mapping onto the Zod schema, and the readable steering message for a
 * rejected input. An unknown key is REJECTED, never silently dropped.
 */

import type { ZodError } from "zod";

import {
  longMemorySearchInputSchema,
  type LongMemorySearchInput,
} from "@vex-agent/memory/schema/long-memory-search.js";

/** The only accepted tool params. An unknown key (typo / a removed param like `scope`) is rejected with a steering message rather than silently dropped (final-gate fix). */
export const ALLOWED_SEARCH_PARAMS = [
  "query",
  "k",
  "kind",
  "response_format",
  "include_candidates",
  "expand_graph",
] as const;

/**
 * Map the snake_case tool params to the camelCase search-input schema and
 * validate. Only forwards keys the agent supplied so the schema applies its own
 * defaults; `.strict()` rejects unknown keys. Returns the parsed input or a
 * typed Zod error for a readable steering message.
 */
export function mapAndValidate(
  params: Record<string, unknown>,
): { ok: true; input: LongMemorySearchInput } | { ok: false; error: ZodError } {
  const mapped: Record<string, unknown> = {};
  if (params["query"] !== undefined) mapped["query"] = params["query"];
  if (params["k"] !== undefined) mapped["k"] = params["k"];
  if (params["kind"] !== undefined) mapped["kind"] = params["kind"];
  if (params["response_format"] !== undefined) mapped["responseFormat"] = params["response_format"];
  if (params["include_candidates"] !== undefined) {
    mapped["includeCandidates"] = params["include_candidates"];
  }
  if (params["expand_graph"] !== undefined) mapped["expandGraph"] = params["expand_graph"];

  const parsed = longMemorySearchInputSchema.safeParse(mapped);
  if (!parsed.success) return { ok: false, error: parsed.error };
  return { ok: true, input: parsed.data };
}

/** First Zod issue rendered as a readable field/message steering hint. */
export function firstIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
