/**
 * Canonical kind examples — the ONE catalog of example `kind` values shown
 * to the agent (D-KINDS). v1 consumers: EXACTLY the two tool descriptions in
 * `tools/registry/long-memory.ts` (`MemorySuggest.kind` and
 * `MemorySearch.kind`). Deliberately NOT injected into the memory
 * section's empty-state texts — those stay verbatim until S9.
 *
 * `kind` itself remains free-form snake_case; these are examples that anchor
 * reuse, not an enum. `kind-families.ts` (manager-side semantics) is a
 * separate concern and unchanged.
 */

export const CANONICAL_KIND_EXAMPLES = [
  "trade_lesson",
  "risk_rule",
  "user_preference",
  "protocol_fact",
] as const;

export function formatKindExamples(): string {
  return CANONICAL_KIND_EXAMPLES.join(", ");
}
