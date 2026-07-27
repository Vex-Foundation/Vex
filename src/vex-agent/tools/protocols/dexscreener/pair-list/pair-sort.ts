/**
 * Ordering the provider's window.
 *
 * DexScreener returns rows in an order that is neither a ranking nor stable, and
 * offers no server-side sort. So `relevance` here means literally "as returned"
 * — it is the honest name for an order we did not choose and cannot explain.
 *
 * WHY `relevance` IS THE DEFAULT FOR `search`
 *
 * The previous handler hard-sorted `search` by `liquidity.usd` descending and its
 * description sold that as trustworthy. Measured on the live window for
 * `q=SOL/USDC`: position 1 was a pool reporting **$1,632,045,954** of USD
 * liquidity against **59.72 quote tokens** of actual depth and $206,050 of 24 h
 * volume — a turnover ratio of 0.00013 — and none of the 30 rows was the
 * canonical WSOL mint. Re-ranking a relevance sample by a fabricable number and
 * presenting the result as depth promotes the most fabricated row to the top.
 *
 * `tokenPairs` keeps `liquidityUsd` as its default: it is a genuine pool list for
 * one token, and it now ships `priceUsdMedianAcrossPools` + `priceSanity` so the
 * agent can see when the deepest-looking pool is mispriced.
 *
 * The comparator itself (nulls last in BOTH directions, explicit branches rather
 * than `a - b`) lives in `../list-core/row-window.ts`, shared with the feed and
 * narrative families. This module owns only WHICH METRIC each pair sort key reads.
 */

import { orderRowsByMetric } from "../list-core/index.js";

import type { PairSortDirection, PairSortKey } from "./list-query.js";
import type { PairRow, PairWindow } from "./pair-metrics.js";

/** The metric a sort key reads. `null` for `relevance` — provider order. */
function sortMetric(row: PairRow, sortBy: PairSortKey, window: PairWindow): number | null {
  const { metrics } = row;
  switch (sortBy) {
    case "relevance":
      return null;
    case "liquidityUsd":
      return metrics.liquidityUsd;
    case "volumeUsd":
      return metrics.windows[window].volumeUsd;
    case "turnoverRatio":
      return metrics.windows.h24.turnoverRatio;
    case "marketCapUsd":
      return metrics.marketCapUsd;
    case "fdvUsd":
      return metrics.fdvUsd;
    case "pairAgeSeconds":
      return metrics.pairAgeSeconds;
    case "priceChangePct":
      return metrics.windows[window].priceChangePct;
    case "txnCount":
      return metrics.windows[window].txnCount;
    case "buySellRatio":
      return metrics.windows[window].buySellRatio;
    default:
      return assertNeverSortKey(sortBy);
  }
}

function assertNeverSortKey(value: never): never {
  throw new Error(`Unhandled DexScreener sort key: ${String(value)}`);
}

/**
 * Order rows by the requested key.
 *
 * `relevance` returns a copy in provider order — the caller still gets a new
 * array so the client's response is never mutated.
 */
export function sortPairRows(
  rows: readonly PairRow[],
  sortBy: PairSortKey,
  sortDir: PairSortDirection,
  window: PairWindow,
): PairRow[] {
  if (sortBy === "relevance") return [...rows];
  return orderRowsByMetric(rows, (row) => sortMetric(row, sortBy, window), sortDir);
}
