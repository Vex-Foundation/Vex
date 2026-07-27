/**
 * The shared DexScreener list pipeline — stage order is the design.
 *
 *   metrics → filter (count every drop) → sort → offset/limit → project →
 *   label external content → wrap in the provenance envelope
 *
 * WHY THE ORDER MATTERS
 *
 * The previous `search` handler ran `projectPairs(sorted).slice(0, limit)`: it
 * projected all 30 rows and only THEN discarded 10 of them. With windowing after
 * projection there is nowhere to enforce a byte budget — the cost is already paid
 * on rows that never reach the agent, and the count the agent is shown is the
 * post-slice one. Windowing before projection means the bytes spent are exactly
 * the bytes delivered.
 *
 * Filtering runs before sorting so `droppedByFilter` describes the provider's
 * whole window rather than a re-ordered part of it, and so the arithmetic
 * `totalMatched + Σ droppedByFilter === providerReturned` holds unconditionally.
 *
 * Cross-pool price sanity is computed by the CALLER over the full provider
 * window (see `./price-sanity.ts`) and threaded in, because a median taken after
 * filtering would move with the caller's filters and stop being a property of the
 * token.
 */

import type { DexPair } from "@tools/dexscreener/types.js";

import {
  EXTERNAL_CONTENT_PAIR_FIELDS,
  buildPairListEnvelope,
  collectExternalContentPaths,
  takeRowWindow,
  type PairListEnvelope,
  type ProviderOrder,
} from "../list-core/index.js";

import { projectAgentPair, type AgentDexPair } from "./agent-pair.js";
import type { PairListQuery } from "./list-query.js";
import { computePairMetrics, type PairRow } from "./pair-metrics.js";
import { filterPairRows } from "./pair-filters.js";
import { sortPairRows } from "./pair-sort.js";
import type { CrossPoolPriceSanity, PriceSanityVerdict } from "./price-sanity.js";

export interface PairListRequest {
  /** DexScreener path this window came from, for the provenance envelope. */
  readonly endpoint: string;
  readonly providerOrder: ProviderOrder;
  readonly providerPairs: readonly DexPair[];
  readonly query: PairListQuery;
  readonly asOfMs: number;
  /** Only `tokenPairs` supplies this — one token's pools can have a median. */
  readonly priceSanity?: CrossPoolPriceSanity;
}

/** The envelope plus the rows. Handlers spread this into their own output. */
export interface PairListResult extends PairListEnvelope {
  pairs: AgentDexPair[];
}

/** Derive metrics once for the whole window — filters, sort and projection share them. */
export function toPairRows(pairs: readonly DexPair[], asOfMs: number): PairRow[] {
  return pairs.map((pair) => ({ pair, metrics: computePairMetrics(pair, asOfMs) }));
}

/**
 * Run the list pipeline over one provider window.
 *
 * `rows` is accepted pre-derived so a caller that needs metrics for something
 * else first (cross-pool price sanity) does not compute them twice.
 */
export function buildPairListFromRows(
  rows: readonly PairRow[],
  request: PairListRequest,
): PairListResult {
  const { query } = request;

  const { kept, droppedByFilter } = filterPairRows(rows, query.filters, query.window);
  const sorted = sortPairRows(kept, query.sortBy, query.sortDir, query.window);

  const windowed = takeRowWindow(sorted, query.offset, query.limit);

  // When cross-pool sanity was assessed, EVERY row carries a verdict — a row with
  // no pair address, or one the assessment could not price, is `"unknown"` rather
  // than silently missing the field. An absent verdict would read as "fine".
  const verdicts = request.priceSanity?.verdictByPairAddress;
  const verdictFor = (row: PairRow): PriceSanityVerdict | null => {
    if (verdicts === undefined) return null;
    if (typeof row.pair.pairAddress !== "string") return "unknown";
    return verdicts.get(row.pair.pairAddress) ?? "unknown";
  };
  const pairs = windowed.map((row) =>
    projectAgentPair(row, {
      fields: query.fields,
      window: query.window,
      priceSanity: verdictFor(row),
    }),
  );

  const envelope = buildPairListEnvelope({
    endpoint: request.endpoint,
    providerOrder: request.providerOrder,
    providerReturned: rows.length,
    asOfMs: request.asOfMs,
    totalMatched: sorted.length,
    returned: pairs.length,
    offset: query.offset,
    filtersApplied: query.filtersApplied,
    droppedByFilter,
    externalContentFields: collectExternalContentPaths(
      pairs,
      "pairs",
      EXTERNAL_CONTENT_PAIR_FIELDS,
    ),
    includeDecimalsNote: query.fields.has("decimalsAvailable"),
  });

  return { ...envelope, pairs };
}

/** Convenience entry point for callers with no cross-pool work to do first. */
export function buildPairList(request: PairListRequest): PairListResult {
  return buildPairListFromRows(toPairRows(request.providerPairs, request.asOfMs), request);
}
