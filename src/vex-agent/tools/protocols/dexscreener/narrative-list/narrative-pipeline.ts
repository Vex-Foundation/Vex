/**
 * The narrative pipeline, and the naming that keeps two different numbers apart.
 *
 * Stage order is the same as the other two families: filter (count every drop) →
 * sort → offset/limit → project → label external content → wrap in the envelope.
 *
 * THE RENAMES ARE THE POINT OF THIS MODULE
 *
 * `/metas/meta/v1/{slug}` sends four aggregates and none of them means what its
 * name implies. Measured on `cat`, 2026-07-27:
 *
 * | provider field | live value | what it actually is |
 * |---|---|---|
 * | `marketCap` | 224,446,681 | EXACTLY `sum(pairs[].marketCap)` — the 31 pools it sent, not the narrative |
 * | `tokenCount` | 31 | EXACTLY `pairs.length` — while `/metas/trending/v1` reported **67** tokens for the same slug in the same minute |
 * | `liquidity` | 23,354,089.77 | NOT a sum over those pairs (they sum to 21,774,508.92) |
 * | `volume` | 1,706,297.56 | NOT a sum either (1,463,001.72) |
 *
 * So the detail endpoint's own object is internally inconsistent: two fields are
 * exact sums of the subset it returned and two are not sums of anything we can
 * see. An agent handed `marketCap: 224446681` next to `tokenCount: 31` reads "this
 * narrative is a $224 M, 31-token theme". Both halves are wrong — it is a $224 M
 * SUBSET of a 67-token theme.
 *
 * Hence `subsetMarketCapSumUsd` and `narrativeSubsetTokenCount`, plus
 * `pairsReturned` for the count after Vex's own filters, plus a note naming
 * `dexscreener.trending` as the owner of narrative-level truth. Three numbers that
 * cannot be mistaken for each other, where there were two that could.
 */

import {
  EXTERNAL_CONTENT_NARRATIVE_FIELDS,
  PROVIDER_NARRATIVE_WINDOW_NOTE,
  buildPairListEnvelope,
  collectExternalContentPaths,
  filterRows,
  orderRowsByMetric,
  takeRowWindow,
  type ListEnvelope,
  type RowRejection,
} from "../list-core/index.js";

import {
  projectAgentNarrative,
  toNarrativeRows,
  type AgentDexNarrative,
  type NarrativeRow,
} from "./narrative-row.js";
import type {
  NarrativeListFilters,
  NarrativeListQuery,
  NarrativeSortKey,
  NarrativeWindow,
} from "./narrative-query.js";
import type { DexMeta } from "@tools/dexscreener/types.js";

/**
 * What `dexscreener.meta` must say about its own aggregates.
 *
 * Emitted on every `meta` response, not only when the numbers look odd: the
 * disagreement is structural and permanent, so a conditional warning would train
 * the agent to trust the unwarned case.
 */
export const NARRATIVE_SUBSET_NOTE =
  "These aggregates describe the pools in THIS response, not the narrative. Measured live: this "
  + "endpoint's marketCap is exactly the sum of the pairs it returns, and its tokenCount is exactly "
  + "the number of pairs it returns, while the trending feed reported more than twice as many "
  + "tokens for the same slug in the same minute. Its liquidity and volume are not sums of these "
  + "pairs either, so the object is internally inconsistent. For narrative-level totals call "
  + "dexscreener.trending, which owns them.";

export interface NarrativeListRequest {
  readonly endpoint: string;
  readonly providerMetas: readonly DexMeta[];
  readonly query: NarrativeListQuery;
  readonly asOfMs: number;
}

export interface NarrativeListResult extends ListEnvelope {
  narratives: AgentDexNarrative[];
}

/**
 * Thresholds only — a narrative has no identity to filter on, which is also why
 * `chainIds` is refused at the param boundary.
 *
 * `min* = 0` is a no-op on a non-negative domain, as everywhere else. Above zero,
 * an unknown value fails: we cannot prove a narrative we know nothing about clears
 * a floor. Those rows are counted under the parameter that dropped them.
 */
function rejectionsFor(filters: NarrativeListFilters): readonly RowRejection<NarrativeRow>[] {
  const rejections: RowRejection<NarrativeRow>[] = [];
  const thresholds: readonly (readonly [string, number | null, (row: NarrativeRow) => number | null])[] = [
    ["minTokenCount", filters.minTokenCount, (row) => row.metrics.narrativeTokenCount],
    ["minMarketCapUsd", filters.minMarketCapUsd, (row) => row.metrics.marketCapUsd],
    ["minLiquidityUsd", filters.minLiquidityUsd, (row) => row.metrics.liquidityUsd],
    ["minVolumeUsd", filters.minVolumeUsd, (row) => row.metrics.volumeUsdH24],
  ];
  for (const [reason, threshold, metricOf] of thresholds) {
    if (threshold === null || threshold === 0) continue;
    rejections.push({
      reason,
      rejects: (row) => {
        const value = metricOf(row);
        return value === null || value < threshold;
      },
    });
  }
  return rejections;
}

function sortMetric(
  row: NarrativeRow,
  sortBy: NarrativeSortKey,
  window: NarrativeWindow,
): number | null {
  switch (sortBy) {
    case "relevance":
      return null;
    case "marketCapUsd":
      return row.metrics.marketCapUsd;
    case "liquidityUsd":
      return row.metrics.liquidityUsd;
    case "volumeUsdH24":
      return row.metrics.volumeUsdH24;
    case "narrativeTokenCount":
      return row.metrics.narrativeTokenCount;
    case "marketCapChangePct":
      return row.metrics.marketCapChangePct[window];
  }
}

export function buildNarrativeList(request: NarrativeListRequest): NarrativeListResult {
  const { query } = request;
  const rows = toNarrativeRows(request.providerMetas);

  const { kept, droppedByFilter } = filterRows(rows, rejectionsFor(query.filters));
  const sorted = query.sortBy === "relevance"
    ? [...kept]
    : orderRowsByMetric(kept, (row) => sortMetric(row, query.sortBy, query.window), query.sortDir);
  const windowed = takeRowWindow(sorted, query.offset, query.limit);
  const projected = windowed.map((row) =>
    projectAgentNarrative(row, query.fields, query.window),
  );

  const envelope = buildPairListEnvelope({
    endpoint: request.endpoint,
    providerOrder: "unspecified",
    providerReturned: rows.length,
    // 19 rows is the most this endpoint has been observed to return, which is a
    // floor on its cap and not the cap. Claiming 30 would assert a limit nobody
    // has measured.
    providerCap: null,
    note: PROVIDER_NARRATIVE_WINDOW_NOTE,
    asOfMs: request.asOfMs,
    totalMatched: sorted.length,
    returned: projected.length,
    offset: query.offset,
    filtersApplied: query.filtersApplied,
    droppedByFilter,
    externalContentFields: collectExternalContentPaths(
      projected,
      "narratives",
      EXTERNAL_CONTENT_NARRATIVE_FIELDS,
    ),
    includeDecimalsNote: false,
  });

  return { ...envelope, narratives: projected };
}
