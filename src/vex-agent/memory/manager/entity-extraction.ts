/**
 * Graph v1 entity extraction + plan build/apply (S8 §4/§5) — public entry point.
 *
 * Internal manager functions ONLY (FIX-3 — never a ToolDef). The extraction LLM
 * call happens EXCLUSIVELY when a candidate's verdict resolved to
 * promote/supersede (F1): the judge stays the judge; this is a SEPARATE call
 * made PRE-TX (D-ORDER — the LLM never holds locks). No promotion ⇒ zero
 * extraction cost.
 *
 * Public surface:
 *   - `extractEntities(lesson, makeProvider?)`   — the extraction LLM call
 *   - `buildGraphPlan(candidate, verdict, deps)` — pre-tx plan (FAIL-OPEN → null)
 *   - `defaultGraphPlanDeps(makeProvider?)`      — production wiring for the above
 *   - `applyGraphPlan(plan, entryId, tx)`        — in-tx writes (caller SAVEPOINTs)
 *   - `canonicalizeDollarName(name, aliases)`    — pure `$`-canonicalization
 *   - `buildExtractionSystemPrompt()` / `buildExtractionUserPrompt(lesson)`
 *
 * Implementation lives in `./entity-extraction/`, split by reason to change:
 *   - `types.ts`        — the lesson input and graph-plan data contracts
 *   - `prompt.ts`       — the prompt artifact (closed vocab rendered from the enums)
 *   - `extract-call.ts` — provider call, deadline, JSON recovery, schema validation
 *   - `plan-build.ts`   — redaction, canonicalization, identity dedupe, embedding
 *   - `plan-apply.ts`   — the idempotent in-tx repo writes
 *
 * Doctrine that spans those modules:
 *
 * D-FAIL-OPEN — the graph is HELP, not a source of truth. ANY failure (provider
 * config, timeout, malformed JSON, schema violation, embedding outage) yields
 * `null` from `buildGraphPlan` (audited via `memory.manager.graph_extraction_failed`)
 * and the lesson promotes WITHOUT a graph. There is no retry machinery in S8;
 * knowledge > graph, asymmetry is deliberate.
 *
 * Alias discipline (F2) — entities merge ONLY on the identical normalized
 * identity `(type, normalizeEntityName(name))` plus aliases the LLM explicitly
 * emitted. ZERO embedding-similarity fuzzy-merge; scam tokens prey on look-alike
 * names and auto-merging them would poison the graph.
 *
 * $-canonicalization (D-WRITE, critique L3) — `normalizeEntityName` deliberately
 * does NOT strip `$`, so "$WIF" and "WIF" would be two identities. The pure
 * `canonicalizeDollarName` strips the leading `$` into the canonical name and
 * preserves the `$XXX` surface form as an alias — entirely in this layer; the
 * S1d substrate is untouched.
 *
 * FIX-4 — the ONLY content entering the graph comes from the ALREADY-REDACTED
 * candidate text, and every LLM output field passes `redact()` again
 * (defense-in-depth) before it reaches a plan.
 */

export {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
} from "./entity-extraction/prompt.js";

export { extractEntities } from "./entity-extraction/extract-call.js";

export {
  buildGraphPlan,
  canonicalizeDollarName,
  defaultGraphPlanDeps,
} from "./entity-extraction/plan-build.js";

export { applyGraphPlan } from "./entity-extraction/plan-apply.js";

export type {
  ExtractionLesson,
  GraphApplyCounts,
  GraphLessonCandidate,
  GraphPlan,
  GraphPlanDeps,
  GraphPlanEdge,
  GraphPlanEntity,
  GraphPlanLink,
} from "./entity-extraction/types.js";
