/**
 * Public gate for the DexScreener FEED list pipeline — the hunting surface.
 *
 * `handlers/feeds.ts` and the tests import from here; nothing else should reach
 * into the individual modules.
 *
 * | module                | owns                                                       |
 * |-----------------------|------------------------------------------------------------|
 * | `feed-row.ts`         | five provider shapes → one agent row, and its derived numbers |
 * | `feed-fields.ts`      | which fields are default vs opt-in (a byte budget)          |
 * | `feed-query.ts`       | the feed param vocabulary                                  |
 * | `feed-pipeline.ts`    | stage order, filter rules, sort metrics, the envelope       |
 * | `attention-merge.ts`  | the one synthetic tool: joining two feeds into one window   |
 *
 * The feed-agnostic machinery is in `../list-core/`, shared with `../pair-list/`
 * and `../narrative-list/`.
 */

export { mergeAttentionRows } from "./attention-merge.js";
export {
  ALL_FEED_FIELDS,
  ALL_FIELDS_SENTINEL,
  LEAN_FEED_FIELDS,
  RICH_FEED_FIELDS,
  resolveFeedFields,
  type FeedFieldSelection,
} from "./feed-fields.js";
export {
  buildFeedList,
  type FeedListRequest,
  type FeedListResult,
} from "./feed-pipeline.js";
export {
  FEED_SORT_DIRECTIONS,
  FEED_SORT_KEYS,
  parseFeedListQuery,
  type FeedListFilters,
  type FeedListQuery,
  type FeedListQueryDefaults,
  type FeedSortDirection,
  type FeedSortKey,
} from "./feed-query.js";
export {
  computeFeedRowMetrics,
  projectAgentFeedRow,
  toAdFeedRow,
  toAttentionFeedRow,
  toBoostFeedRow,
  toFeedRows,
  toProfileFeedRow,
  toTakeoverFeedRow,
  type AgentDexFeedRow,
  type AgentFeedLink,
  type FeedRow,
  type FeedRowKind,
  type FeedRowMetrics,
  type FeedSourceRow,
} from "./feed-row.js";
