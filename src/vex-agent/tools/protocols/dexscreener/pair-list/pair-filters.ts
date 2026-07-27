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
 * `dexscreener.search { query: "USDC", chainId: "ethereum" }` returns
 * `pairs: [], matched: 0, success: true`. Measured on the live window: `q=USDC`
 * spans 15 chains and holds ZERO Ethereum rows. A context-free agent reads that
 * empty result as "USDC does not trade on Ethereum".
 *
 * With `droppedByFilter` the same call reports `providerReturned: 30,
 * droppedByFilter: { chainIds: 30 }` — the window held nothing on that chain,
 * which is a completely different fact and one the agent can act on (by calling
 * `dexscreener.tokenPairs` with the address on that chain).
 */

import { filterRows, type FilterOutcome, type RowRejection } from "../list-core/index.js";

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
    });
  }
  if (dexIds !== null) {
    rejections.push({
      reason: "dexIds",
      rejects: (row) => !includesFolded(dexIds, row.pair.dexId),
    });
  }
  if (excludeDexIds !== null) {
    rejections.push({
      reason: "excludeDexIds",
      rejects: (row) => includesFolded(excludeDexIds, row.pair.dexId),
    });
  }
  if (labels !== null) {
    rejections.push({
      reason: "labels",
      rejects: (row) => {
        const rowLabels = Array.isArray(row.pair.labels) ? row.pair.labels : [];
        return !rowLabels.some((label) => includesFolded(labels, label));
      },
    });
  }
  if (quoteSymbols !== null) {
    rejections.push({
      reason: "quoteSymbols",
      rejects: (row) => !includesFolded(quoteSymbols, row.pair.quoteToken?.symbol ?? null),
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

  // Thresholds.
  rejections.push(
    {
      reason: "minLiquidityUsd",
      rejects: (row) => !passesMin(row.metrics.liquidityUsd, filters.minLiquidityUsd),
    },
    {
      reason: "maxLiquidityUsd",
      rejects: (row) => !passesMax(row.metrics.liquidityUsd, filters.maxLiquidityUsd),
    },
    {
      reason: "minQuoteDepthTokens",
      rejects: (row) =>
        !passesMin(row.metrics.liquidityQuoteTokens, filters.minQuoteDepthTokens),
    },
    {
      reason: "minVolumeUsd",
      rejects: (row) => !passesMin(row.metrics.windows[window].volumeUsd, filters.minVolumeUsd),
    },
    {
      reason: "maxVolumeUsd",
      rejects: (row) => !passesMax(row.metrics.windows[window].volumeUsd, filters.maxVolumeUsd),
    },
    { reason: "minFdvUsd", rejects: (row) => !passesMin(row.metrics.fdvUsd, filters.minFdvUsd) },
    { reason: "maxFdvUsd", rejects: (row) => !passesMax(row.metrics.fdvUsd, filters.maxFdvUsd) },
    {
      reason: "minMarketCapUsd",
      rejects: (row) => !passesMin(row.metrics.marketCapUsd, filters.minMarketCapUsd),
    },
    {
      reason: "maxMarketCapUsd",
      rejects: (row) => !passesMax(row.metrics.marketCapUsd, filters.maxMarketCapUsd),
    },
    {
      reason: "minTurnoverRatio",
      rejects: (row) =>
        !passesMin(row.metrics.windows.h24.turnoverRatio, filters.minTurnoverRatio),
    },
    {
      reason: "maxTurnoverRatio",
      rejects: (row) =>
        !passesMax(row.metrics.windows.h24.turnoverRatio, filters.maxTurnoverRatio),
    },
    {
      reason: "minTxnCount",
      rejects: (row) => !passesMin(row.metrics.windows[window].txnCount, filters.minTxnCount),
    },
    {
      reason: "minBuySellRatio",
      rejects: (row) =>
        !passesMin(row.metrics.windows[window].buySellRatio, filters.minBuySellRatio),
    },
    {
      reason: "maxBuySellRatio",
      rejects: (row) =>
        !passesMax(row.metrics.windows[window].buySellRatio, filters.maxBuySellRatio),
    },
    {
      reason: "minPriceChangePct",
      rejects: (row) =>
        !passesSignedMin(row.metrics.windows[window].priceChangePct, filters.minPriceChangePct),
    },
    {
      reason: "maxPriceChangePct",
      rejects: (row) =>
        !passesSignedMax(row.metrics.windows[window].priceChangePct, filters.maxPriceChangePct),
    },
  );

  // Age. `pairCreatedAt` is absent on ~9 % of rows; those rows are excluded by
  // an age filter and counted SEPARATELY, because "we do not know how old this
  // pool is" is a different answer from "this pool is too old".
  const wantsAge = filters.minPairAgeSeconds !== null || filters.maxPairAgeSeconds !== null;
  if (wantsAge) {
    rejections.push({
      reason: "unknownAge",
      rejects: (row) => row.metrics.pairAgeSeconds === null,
    });
    rejections.push(
      {
        reason: "minPairAgeSeconds",
        rejects: (row) => !passesMin(row.metrics.pairAgeSeconds, filters.minPairAgeSeconds),
      },
      {
        reason: "maxPairAgeSeconds",
        rejects: (row) => !passesMax(row.metrics.pairAgeSeconds, filters.maxPairAgeSeconds),
      },
    );
  }

  return rejections;
}

/** Apply the query's filters, attributing every dropped row to one reason. */
export function filterPairRows(
  rows: readonly PairRow[],
  filters: PairListFilters,
  window: PairWindow,
): FilterOutcome<PairRow> {
  return filterRows(rows, rejectionsFor(filters, window));
}
