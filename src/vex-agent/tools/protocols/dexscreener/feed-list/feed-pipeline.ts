/**
 * The shared DexScreener FEED pipeline — stage order is the design.
 *
 *   normalise → derive metrics → filter (count every drop) → sort →
 *   offset/limit → project → label external content → wrap in the envelope
 *
 * Identical order, and the same reasons, as `../pair-list/pipeline.ts`:
 *
 * - Windowing runs BEFORE projection, so the bytes spent are exactly the bytes
 *   delivered. Projecting 30 rows and then discarding 20 pays the cost on rows the
 *   agent never sees, and leaves nowhere to enforce a byte budget.
 * - Filtering runs BEFORE sorting, so `droppedByFilter` describes the provider's
 *   whole window rather than a re-ordered part of it, and the arithmetic
 *   `totalMatched + Σ droppedByFilter === providerReturned` holds unconditionally.
 */

import {
  EXTERNAL_CONTENT_FEED_FIELDS,
  PROVIDER_FEED_WINDOW_NOTE,
  buildPairListEnvelope,
  collectExternalContentPaths,
  filterRows,
  orderRowsByMetric,
  takeRowWindow,
  type ListEnvelope,
  type RowRejection,
} from "../list-core/index.js";

import type { FeedListFilters, FeedListQuery, FeedSortKey } from "./feed-query.js";
import {
  projectAgentFeedRow,
  toFeedRows,
  type AgentDexFeedRow,
  type FeedRow,
  type FeedSourceRow,
} from "./feed-row.js";

export interface FeedListRequest {
  /** DexScreener path this window came from, for the provenance envelope. */
  readonly endpoint: string;
  readonly providerRows: readonly FeedSourceRow[];
  readonly query: FeedListQuery;
  readonly asOfMs: number;
}

/** The envelope plus the rows. Handlers spread this into their own output. */
export interface FeedListResult extends ListEnvelope {
  rows: AgentDexFeedRow[];
}

/**
 * Build the ordered rejection list.
 *
 * Identity first: "wrong chain" is a more useful explanation than "not fresh
 * enough" for a row that is both, and `chainIds` is the filter the hunting flows
 * lead with.
 *
 * A row whose event time is unknown is counted under `unknownEventAge` rather than
 * under the freshness parameter, because "we cannot tell when this happened" is a
 * different answer from "this happened too long ago" — and on a feed where the
 * provider stopped sending timestamps, the first answer is the one worth seeing.
 */
function rejectionsFor(filters: FeedListFilters): readonly RowRejection<FeedRow>[] {
  const rejections: RowRejection<FeedRow>[] = [];

  const { chainIds } = filters;
  if (chainIds !== null) {
    rejections.push({
      reason: "chainIds",
      rejects: (row) => !chainIds.includes(row.source.chainId.toLowerCase()),
    });
  }

  if (filters.ctoOnly) {
    // Tri-state: `null` means the feed sent no `cto` flag, which is unknown rather
    // than "not a takeover". The flag asks us to prove it, so unknown is dropped.
    rejections.push({
      reason: "ctoOnly",
      rejects: (row) => row.metrics.communityTakeover !== true,
    });
  }

  const { maxEventAgeSeconds, eventAgeParamKey } = filters;
  if (maxEventAgeSeconds !== null && eventAgeParamKey !== null) {
    rejections.push({
      reason: "unknownEventAge",
      rejects: (row) => row.metrics.eventAgeSeconds === null,
    });
    rejections.push({
      reason: eventAgeParamKey,
      rejects: (row) => {
        const age = row.metrics.eventAgeSeconds;
        return age === null || age > maxEventAgeSeconds;
      },
    });
  }

  const { minBoostCountTotal } = filters;
  if (minBoostCountTotal !== null && minBoostCountTotal > 0) {
    // Above zero, an unknown value FAILS: we cannot prove a row we know nothing
    // about clears a floor. A threshold of 0 is a no-op, as everywhere else.
    rejections.push({
      reason: "minBoostCountTotal",
      rejects: (row) => {
        const total = row.metrics.boostCountTotal;
        return total === null || total < minBoostCountTotal;
      },
    });
  }

  return rejections;
}

/** Which metric each sort key reads. `relevance` means provider order. */
function sortMetric(row: FeedRow, sortBy: FeedSortKey): number | null {
  switch (sortBy) {
    case "relevance":
      return null;
    case "eventAgeSeconds":
      return row.metrics.eventAgeSeconds;
    case "boostCount":
      return row.metrics.boostCount;
    case "boostCountTotal":
      return row.metrics.boostCountTotal;
    case "adImpressionCount":
      return row.metrics.adImpressionCount;
  }
}

/** Run the feed pipeline over one provider window. */
export function buildFeedList(request: FeedListRequest): FeedListResult {
  const { query } = request;
  const rows = toFeedRows(request.providerRows, request.asOfMs);

  const { kept, droppedByFilter } = filterRows(rows, rejectionsFor(query.filters));
  const sorted = query.sortBy === "relevance"
    ? [...kept]
    : orderRowsByMetric(kept, (row) => sortMetric(row, query.sortBy), query.sortDir);
  const windowed = takeRowWindow(sorted, query.offset, query.limit);
  const projected = windowed.map((row) => projectAgentFeedRow(row, query.fields));

  const envelope = buildPairListEnvelope({
    endpoint: request.endpoint,
    // Never "relevance": DexScreener discloses no ordering for any of these feeds,
    // and the two boost feeds carry no timestamp that could imply one.
    providerOrder: "unspecified",
    providerReturned: rows.length,
    note: PROVIDER_FEED_WINDOW_NOTE,
    asOfMs: request.asOfMs,
    totalMatched: sorted.length,
    returned: projected.length,
    offset: query.offset,
    filtersApplied: query.filtersApplied,
    droppedByFilter,
    externalContentFields: collectExternalContentPaths(
      projected,
      "rows",
      EXTERNAL_CONTENT_FEED_FIELDS,
    ),
    includeDecimalsNote: false,
  });

  return { ...envelope, rows: projected };
}
