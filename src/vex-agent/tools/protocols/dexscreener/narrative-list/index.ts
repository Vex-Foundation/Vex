/**
 * Public gate for the DexScreener NARRATIVE list pipeline.
 *
 * `handlers/narratives.ts` and the tests import from here.
 *
 * | module                    | owns                                              |
 * |---------------------------|---------------------------------------------------|
 * | `narrative-row.ts`        | the agent-facing narrative row and its metrics    |
 * | `narrative-fields.ts`     | which fields are default vs opt-in                |
 * | `narrative-query.ts`      | the narrative param vocabulary                    |
 * | `narrative-pipeline.ts`   | stage order, filters, sorts, and the subset renames |
 *
 * `dexscreener.meta` uses BOTH this module (for the narrative header) and
 * `../pair-list/` (for the pools inside the narrative), which is why the pair row
 * is not duplicated here.
 */

export {
  ALL_FIELDS_SENTINEL,
  ALL_NARRATIVE_FIELDS,
  LEAN_NARRATIVE_FIELDS,
  RICH_NARRATIVE_FIELDS,
  resolveNarrativeFields,
  type NarrativeFieldSelection,
} from "./narrative-fields.js";
export {
  NARRATIVE_SUBSET_NOTE,
  buildNarrativeList,
  type NarrativeListRequest,
  type NarrativeListResult,
} from "./narrative-pipeline.js";
export {
  NARRATIVE_SORT_DIRECTIONS,
  NARRATIVE_SORT_KEYS,
  parseNarrativeListQuery,
  type NarrativeListFilters,
  type NarrativeListQuery,
  type NarrativeSortDirection,
  type NarrativeSortKey,
  type NarrativeWindow,
} from "./narrative-query.js";
export {
  computeNarrativeMetrics,
  projectAgentNarrative,
  toNarrativeRows,
  type AgentDexNarrative,
  type NarrativeMetrics,
  type NarrativeRow,
} from "./narrative-row.js";
