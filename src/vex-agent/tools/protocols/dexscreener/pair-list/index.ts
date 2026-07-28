/**
 * Public gate for the DexScreener PAIR list pipeline.
 *
 * `handlers/core.ts` and the tests import from here; nothing else should reach
 * into the individual modules. Each module behind this gate owns one reason to
 * change:
 *
 * | module               | owns                                                      |
 * |----------------------|-----------------------------------------------------------|
 * | `pair-metrics.ts`    | how a provider field becomes a Vex number                 |
 * | `agent-pair-fields.ts` | which fields are default vs opt-in (a byte budget)      |
 * | `agent-pair.ts`      | the agent-facing row shape                                |
 * | `list-query.ts`      | the pair param vocabulary                                 |
 * | `pair-filters.ts`    | which rows a pair query keeps, and why each drop happened |
 * | `pair-sort.ts`       | which metric each pair sort key reads                     |
 * | `price-sanity.ts`    | cross-pool price disagreement within one token            |
 * | `pipeline.ts`        | stage order                                               |
 *
 * The feed-agnostic machinery — param READING rules, the filter/drop-accounting
 * loop, the nulls-last comparator, the envelope and external-text labelling —
 * lives in `../list-core/` and is shared with `../feed-list/` and
 * `../narrative-list/`. It is re-exported here so this gate remains the single
 * import site for anything pair-shaped.
 */

export {
  EXTERNAL_CONTENT_PAIR_FIELDS,
  EXTERNAL_CONTENT_WARNING,
  PROVIDER_PAIR_CAP,
  PROVIDER_WINDOW_NOTE,
  SEARCH_PROVIDER_RELEVANCE_NOTE,
  TOKEN_DECIMALS_RESOLVER_NOTE,
  stripStructuralCharacters,
  type PairListEnvelope,
  type ProviderOrder,
} from "../list-core/index.js";

export { projectAgentPair, type AgentDexPair } from "./agent-pair.js";
export {
  ALL_FIELDS_SENTINEL,
  ALL_PAIR_FIELDS,
  LEAN_PAIR_FIELDS,
  PAIR_FIELD_GROUPS,
  PAIR_FILTERS_WITHOUT_ONE_FIELD,
  PAIR_FILTER_FIELD_READS,
  RICH_PAIR_FIELDS,
  resolvePairFields,
} from "./agent-pair-fields.js";
export {
  PAIR_SORT_DIRECTIONS,
  PAIR_SORT_KEYS,
  parsePairListQuery,
  type PairListFilters,
  type PairListQuery,
  type PairSortDirection,
  type PairSortKey,
} from "./list-query.js";
export {
  PAIR_WINDOWS,
  computePairMetrics,
  type PairRow,
  type PairWindow,
} from "./pair-metrics.js";
export {
  buildPairList,
  buildPairListFromRows,
  toPairRows,
  type PairListRequest,
  type PairListResult,
} from "./pipeline.js";
export {
  PRICE_OUTLIER_RATIO,
  assessCrossPoolPrices,
  type CrossPoolPriceSanity,
  type PricePoolOutlier,
  type PriceSanityVerdict,
} from "./price-sanity.js";
