/**
 * Public gate for the FEED-AGNOSTIC list machinery shared by all three
 * DexScreener list families.
 *
 * DexScreener has no server-side filtering of any kind: one query parameter
 * exists in the entire API (`q` on `/latest/dex/search`), every list is capped at
 * ~30 provider-chosen rows, and there is no pagination. So every filter, sort and
 * window Vex offers is applied here, client-side, over that window — for pair
 * rows, for promotional feed rows and for narratives alike.
 *
 * That is why this module exists rather than three parallel ones. The shared
 * vocabulary is a PRODUCT requirement: if `limit` validated differently on
 * `search` than on `profiles.recent`, an agent would have to remember which tool
 * spelled the same idea which way, which is the guessing this phase exists to
 * remove.
 *
 * | module              | owns                                                       |
 * |---------------------|------------------------------------------------------------|
 * | `param-readers.ts`  | the untrusted-param boundary — one rule per param, once     |
 * | `row-window.ts`     | filtering with drop accounting, ordering, offset/limit      |
 * | `provenance.ts`     | the envelope contract                                      |
 * | `external-text.ts`  | provenance labelling of third-party text                   |
 *
 * The three families layer their own row shape, metrics, filter set and sort
 * vocabulary on top: `../pair-list/`, `../feed-list/`, `../narrative-list/`.
 */

export {
  EXTERNAL_CONTENT_FEED_FIELDS,
  EXTERNAL_CONTENT_NARRATIVE_FIELDS,
  EXTERNAL_CONTENT_PAIR_FIELDS,
  EXTERNAL_CONTENT_WARNING,
  collectExternalContentPaths,
  stripStructuralCharacters,
} from "./external-text.js";
export {
  WINDOW_NUMERIC_PARAMS,
  isAbsent,
  readBoolean,
  readEnum,
  readNumber,
  readOmitFields,
  readStringList,
  readStringOrArrayParam,
  type FiltersApplied,
  type NumericParamSpec,
  type NumericParamSpecs,
  type Read,
} from "./param-readers.js";
export {
  PROVIDER_FEED_WINDOW_NOTE,
  PROVIDER_NARRATIVE_WINDOW_NOTE,
  PROVIDER_PAIR_CAP,
  PROVIDER_WINDOW_NOTE,
  SEARCH_PROVIDER_RELEVANCE_NOTE,
  TOKEN_DECIMALS_RESOLVER_NOTE,
  buildPairListEnvelope,
  type ListEnvelope,
  type PairListEnvelope,
  type ProviderOrder,
} from "./provenance.js";
export {
  MAX_EXPLAINED_DROPPED_ROWS,
  filterRows,
  orderRowsByMetric,
  takeRowWindow,
  type DropComparisonValue,
  type DroppedRowRecord,
  type ExplainDropsOptions,
  type FilterOutcome,
  type RowRejection,
  type SortDirection,
} from "./row-window.js";
