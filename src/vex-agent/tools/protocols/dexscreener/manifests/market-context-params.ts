/**
 * Row vocabulary owned by the narratives tool.
 *
 * Deliberately NOT shared with `./screen-params/` or `./resolve-params.ts`.
 * Those describe pair rows on channels with a bounded window and a drifting
 * provider count; a narrative row has neither. Sharing the constants would
 * carry the wrong honesty facts into a tool whose entire population arrives in
 * one document.
 */

/** Field GROUPS a narrative row may carry. `core` is always included. */
export const NARRATIVE_FIELD_GROUPS = [
  "core",
  "windows",
  "description",
] as const;

export type NarrativeFieldGroup = (typeof NARRATIVE_FIELD_GROUPS)[number];

/** What ships when the caller says nothing. */
export const NARRATIVE_FIELD_GROUPS_DEFAULT: readonly NarrativeFieldGroup[] = [
  "core",
];

/** How the narratives may be ordered. All run locally over the whole set. */
export const NARRATIVE_SORT_KEYS = [
  "marketCapUsd",
  "volumeUsd",
  "liquidityUsd",
  "tokenCount",
  "marketCapChangePct",
  "volumeToMarketCapRatio",
] as const;

export type NarrativeSortKey = (typeof NARRATIVE_SORT_KEYS)[number];

/**
 * Row bounds.
 *
 * There is no MAX: the provider sends the whole population in one small
 * document, so a limit above it returns the population rather than reaching
 * for rows that do not exist, and refusing a large number would be a Vex
 * invention with nothing behind it (owner decision D-DS5, no artificial caps).
 */
export const NARRATIVE_LIMIT_MIN = 1;
export const NARRATIVE_LIMIT_DEFAULT = 20;

/**
 * Leading pairs embeddable per narrative, by default.
 *
 * There is NO maximum, for the same reason `limit` has none: the enriching
 * request already fetched a whole screener page, so `topTokens` only decides
 * how much of a page in hand is projected, and a value above the page returns
 * the page (owner decision D-DS5, no artificial Vex-side caps). What costs
 * something is `maxEnrichedNarratives`, below.
 */
export const NARRATIVE_TOP_TOKENS_MIN = 1;
/** Enrichment is OFF unless asked for: 0 and omitted are the same instruction. */
export const NARRATIVE_TOP_TOKENS_OFF = 0;

/**
 * How many narratives `topTokens` enriches in one call, by default.
 *
 * A FAN-OUT bound, not a result bound: each enriched narrative costs ONE extra
 * screener WebSocket exchange against the site host, sequentially, inside the
 * caller's deadline. Five was the frozen default; it is now a RAISABLE
 * parameter with no hard ceiling (plan 14.6 item 4), because the only real
 * bound is the deadline and a Vex-side refusal at five was an invention.
 * `topTokensCoverage` names every narrative that was not enriched, so nothing
 * is silently thin whatever the value.
 */
export const NARRATIVE_MAX_ENRICHED_MIN = 1;
export const NARRATIVE_MAX_ENRICHED_DEFAULT = 5;
