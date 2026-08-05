/**
 * WHICH PAIR ROWS a query keeps, and why each dropped row was dropped.
 *
 * The loop that applies these rules and tallies the drops lives in
 * `../list-core/row-window.ts`, shared with the feed and narrative families —
 * `kept.length + Σ droppedByFilter === providerReturned` is one invariant and is
 * implemented once. This module owns only the pair-specific rules: which
 * threshold reads which metric, and in what order rows are judged.
 *
 * DexScreener has no server-side filter of any kind — one query parameter exists
 * in the entire API. So every rule here subtracts from a window of at most 30
 * rows the provider already chose, and that is exactly why the accounting matters
 * more than the filtering.
 *
 * THE DEFECT THIS CLOSES
 *
 * `dexscreener.search { query: "USDC", chainIds: "ethereum" }` returns
 * `pairs: [], matched: 0, success: true`. Measured on the live window: `q=USDC`
 * spans 15 chains and holds ZERO Ethereum rows. A context-free agent reads that
 * empty result as "USDC does not trade on Ethereum".
 *
 * With `droppedByFilter` the same call reports `providerReturned: 30,
 * droppedByFilter: { chainIds: 30 }` — the window held nothing on that chain,
 * which is a completely different fact and one the agent can act on (by calling
 * `dexscreener.tokenPairs` with the address on that chain).
 */

import {
  filterRows,
  type ExplainDropsOptions,
  type FilterOutcome,
  type RowRejection,
} from "../list-core/index.js";

import type { PairListFilters } from "./list-query.js";
import type { PairRow, PairWindow } from "./pair-metrics.js";

/**
 * A `min` threshold of 0 on a NON-NEGATIVE domain is a no-op: it admits every
 * row, including rows whose value is unknown. "At least zero dollars of
 * liquidity" excludes nothing, and the old `(value ?? -Infinity) >= 0` made it
 * exclude every null-liquidity row instead.
 *
 * Above zero, an unknown value FAILS: we cannot prove a row we know nothing
 * about clears a floor.
 */
function passesMin(value: number | null, threshold: number | null): boolean {
  if (threshold === null) return true;
  if (threshold === 0) return true;
  if (value === null) return false;
  return value >= threshold;
}

/**
 * `max` has no zero special case — `maxLiquidityUsd: 0` is a real request. An
 * unknown value still fails, for the same reason.
 */
function passesMax(value: number | null, threshold: number | null): boolean {
  if (threshold === null) return true;
  if (value === null) return false;
  return value <= threshold;
}

/**
 * Signed domain: 0 is a genuine threshold, not "no filter". `minPriceChangePct:
 * 0` means "flat or up", and treating it as a no-op would answer a different
 * question than the one asked.
 */
function passesSignedMin(value: number | null, threshold: number | null): boolean {
  if (threshold === null) return true;
  if (value === null) return false;
  return value >= threshold;
}

function passesSignedMax(value: number | null, threshold: number | null): boolean {
  if (threshold === null) return true;
  if (value === null) return false;
  return value <= threshold;
}

/** Case-insensitive membership: the provider emits both `V2` and `v2`. */
function includesFolded(haystack: readonly string[], needle: string | null | undefined): boolean {
  if (typeof needle !== "string") return false;
  const folded = needle.toLowerCase();
  return haystack.includes(folded);
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * One threshold rule, with the metric it reads named EXACTLY ONCE.
 *
 * `rejects` and `rowValueOf` must read the same number: `explainDrops` reports the
 * value that caused the drop, and a rule where the two drifted apart would show
 * the agent a number that passed while claiming it failed. Supplying the metric
 * once makes that impossible rather than merely unlikely.
 */
function thresholdRejection(
  reason: string,
  metricOf: (row: PairRow) => number | null,
  threshold: number | null,
  passes: (value: number | null, threshold: number | null) => boolean,
): RowRejection<PairRow> {
  return {
    reason,
    rejects: (row) => !passes(metricOf(row), threshold),
    rowValueOf: metricOf,
    threshold,
  };
}

/**
 * Build the ordered rejection list for one query.
 *
 * Order determines which reason a multi-fail row is attributed to. Identity
 * filters run first because "wrong chain" is a more useful explanation than
 * "below the liquidity floor" for a row that is both.
 */
function rejectionsFor(
  filters: PairListFilters,
  window: PairWindow,
): readonly RowRejection<PairRow>[] {
  const rejections: RowRejection<PairRow>[] = [];

  const { chainIds, dexIds, excludeDexIds, labels, quoteSymbols } = filters;

  if (chainIds !== null) {
    rejections.push({
      reason: "chainIds",
      rejects: (row) => !includesFolded(chainIds, row.pair.chainId),
      rowValueOf: (row) => strOrNull(row.pair.chainId),
      threshold: chainIds,
    });
  }
  if (dexIds !== null) {
    rejections.push({
      reason: "dexIds",
      rejects: (row) => !includesFolded(dexIds, row.pair.dexId),
      rowValueOf: (row) => strOrNull(row.pair.dexId),
      threshold: dexIds,
    });
  }
  if (excludeDexIds !== null) {
    rejections.push({
      reason: "excludeDexIds",
      rejects: (row) => includesFolded(excludeDexIds, row.pair.dexId),
      rowValueOf: (row) => strOrNull(row.pair.dexId),
      threshold: excludeDexIds,
    });
  }
  if (labels !== null) {
    rejections.push({
      reason: "labels",
      rejects: (row) => {
        const rowLabels = Array.isArray(row.pair.labels) ? row.pair.labels : [];
        return !rowLabels.some((label) => includesFolded(labels, label));
      },
      rowValueOf: (row) => (Array.isArray(row.pair.labels) ? row.pair.labels : null),
      threshold: labels,
    });
  }
  if (quoteSymbols !== null) {
    rejections.push({
      reason: "quoteSymbols",
      rejects: (row) => !includesFolded(quoteSymbols, row.pair.quoteToken?.symbol ?? null),
      rowValueOf: (row) => strOrNull(row.pair.quoteToken?.symbol),
      threshold: quoteSymbols,
    });
  }

  // Quality flags. `hasWebsite`/`hasSocials` are TRI-STATE: `null` means the
  // provider sent no `info` block (33 % of rows), i.e. unknown. An unknown row
  // is dropped by a `require*` flag — the flag asks us to prove presence.
  if (filters.requireWebsite) {
    rejections.push({ reason: "requireWebsite", rejects: (row) => row.metrics.hasWebsite !== true });
  }
  if (filters.requireSocials) {
    rejections.push({ reason: "requireSocials", rejects: (row) => row.metrics.hasSocials !== true });
  }
  if (filters.requirePriceUsd) {
    rejections.push({
      reason: "requirePriceUsd",
      rejects: (row) => typeof row.pair.priceUsd !== "string" || row.pair.priceUsd === "",
    });
  }
  if (filters.onlyBoosted) {
    rejections.push({
      reason: "onlyBoosted",
      rejects: (row) => (row.metrics.activeBoostCount ?? 0) <= 0,
    });
  }

  // Thresholds. The metric each one reads is the field named in its param text
  // (`../../manifests/pair-list-params.ts`) — one filter, one field, one place.
  rejections.push(
    thresholdRejection("minLiquidityUsd", (row) => row.metrics.liquidityUsd, filters.minLiquidityUsd, passesMin),
    thresholdRejection("maxLiquidityUsd", (row) => row.metrics.liquidityUsd, filters.maxLiquidityUsd, passesMax),
    thresholdRejection(
      "minQuoteDepthTokens",
      (row) => row.metrics.liquidityQuoteTokens,
      filters.minQuoteDepthTokens,
      passesMin,
    ),
    thresholdRejection("minVolumeUsd", (row) => row.metrics.windows[window].volumeUsd, filters.minVolumeUsd, passesMin),
    thresholdRejection("maxVolumeUsd", (row) => row.metrics.windows[window].volumeUsd, filters.maxVolumeUsd, passesMax),
    thresholdRejection("minFdvUsd", (row) => row.metrics.fdvUsd, filters.minFdvUsd, passesMin),
    thresholdRejection("maxFdvUsd", (row) => row.metrics.fdvUsd, filters.maxFdvUsd, passesMax),
    thresholdRejection("minMarketCapUsd", (row) => row.metrics.marketCapUsd, filters.minMarketCapUsd, passesMin),
    thresholdRejection("maxMarketCapUsd", (row) => row.metrics.marketCapUsd, filters.maxMarketCapUsd, passesMax),
    thresholdRejection(
      "minTurnoverRatio",
      (row) => row.metrics.windows.h24.turnoverRatio,
      filters.minTurnoverRatio,
      passesMin,
    ),
    thresholdRejection(
      "maxTurnoverRatio",
      (row) => row.metrics.windows.h24.turnoverRatio,
      filters.maxTurnoverRatio,
      passesMax,
    ),
    thresholdRejection("minTxnCount", (row) => row.metrics.windows[window].txnCount, filters.minTxnCount, passesMin),
    thresholdRejection(
      "minBuySellRatio",
      (row) => row.metrics.windows[window].buySellRatio,
      filters.minBuySellRatio,
      passesMin,
    ),
    thresholdRejection(
      "maxBuySellRatio",
      (row) => row.metrics.windows[window].buySellRatio,
      filters.maxBuySellRatio,
      passesMax,
    ),
    thresholdRejection(
      "minPriceChangePct",
      (row) => row.metrics.windows[window].priceChangePct,
      filters.minPriceChangePct,
      passesSignedMin,
    ),
    thresholdRejection(
      "maxPriceChangePct",
      (row) => row.metrics.windows[window].priceChangePct,
      filters.maxPriceChangePct,
      passesSignedMax,
    ),
  );

  // Age. `pairCreatedAt` is absent on ~9 % of rows; those rows are excluded by
  // an age filter and counted SEPARATELY, because "we do not know how old this
  // pool is" is a different answer from "this pool is too old".
  const wantsAge = filters.minPairAgeSeconds !== null || filters.maxPairAgeSeconds !== null;
  if (wantsAge) {
    rejections.push({
      reason: "unknownAge",
      // No `rowValueOf`: this rule IS the statement that the row has no age.
      rejects: (row) => row.metrics.pairAgeSeconds === null,
    });
    rejections.push(
      thresholdRejection(
        "minPairAgeSeconds",
        (row) => row.metrics.pairAgeSeconds,
        filters.minPairAgeSeconds,
        passesMin,
      ),
      thresholdRejection(
        "maxPairAgeSeconds",
        (row) => row.metrics.pairAgeSeconds,
        filters.maxPairAgeSeconds,
        passesMax,
      ),
    );
  }

  return rejections;
}

/** Apply the query's filters, attributing every dropped row to one reason. */
export function filterPairRows(
  rows: readonly PairRow[],
  filters: PairListFilters,
  window: PairWindow,
  explain?: ExplainDropsOptions<PairRow>,
): FilterOutcome<PairRow> {
  return filterRows(rows, rejectionsFor(filters, window), explain);
}
