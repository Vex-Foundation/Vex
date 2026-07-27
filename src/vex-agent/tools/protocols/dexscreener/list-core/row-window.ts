/**
 * Filtering with drop accounting, ordering, and the offset/limit window.
 *
 * Generic over the row type because all three DexScreener list families (pairs,
 * feeds, narratives) need the identical three stages, and the arithmetic they
 * guarantee is a single invariant that must hold in all three:
 *
 *     kept.length + Σ droppedByFilter === providerReturned
 *
 * That invariant is the only reason the envelope is trustworthy, so it is
 * implemented once. Three copies of a twelve-line loop is three chances for a row
 * to be counted twice — and a double-counted drop makes `providerReturned` stop
 * reconciling, which is exactly the arithmetic an agent uses to tell "the market
 * is empty" from "my filter emptied it".
 *
 * THE DEFECT THE ACCOUNTING CLOSES
 *
 * `dexscreener.search { query: "USDC", chainId: "ethereum" }` returned
 * `pairs: [], matched: 0, success: true`. Measured on the live window: `q=USDC`
 * spans 15 chains and holds ZERO Ethereum rows. A context-free agent reads that
 * empty result as "USDC does not trade on Ethereum". With `droppedByFilter` the
 * same call reports `providerReturned: 30, droppedByFilter: { chainIds: 30 }` —
 * a completely different fact, and one the agent can act on.
 *
 * Each row is counted against exactly ONE reason, the first that rejected it.
 */

/** One named rejection rule. `reason` becomes a `droppedByFilter` key. */
export interface RowRejection<TRow> {
  /** The PARAMETER NAME that did the dropping — never a prose description. */
  readonly reason: string;
  readonly rejects: (row: TRow) => boolean;
}

export interface FilterOutcome<TRow> {
  readonly kept: TRow[];
  /** Reason → row count. Only reasons that dropped something appear. */
  readonly droppedByFilter: Record<string, number>;
}

/**
 * Apply an ORDERED rejection list, attributing every dropped row to one reason.
 *
 * Order determines which reason a multi-fail row is attributed to, so each
 * family declares identity filters before economic ones: "wrong chain" is a more
 * useful explanation than "below the liquidity floor" for a row that is both.
 *
 * `droppedByFilter` carries only reasons that actually dropped something — a
 * table of zeroes would be noise in every payload.
 */
export function filterRows<TRow>(
  rows: readonly TRow[],
  rejections: readonly RowRejection<TRow>[],
): FilterOutcome<TRow> {
  const kept: TRow[] = [];
  const droppedByFilter: Record<string, number> = {};

  for (const row of rows) {
    const rejection = rejections.find((candidate) => candidate.rejects(row));
    if (rejection === undefined) {
      kept.push(row);
      continue;
    }
    droppedByFilter[rejection.reason] = (droppedByFilter[rejection.reason] ?? 0) + 1;
  }

  return { kept, droppedByFilter };
}

export type SortDirection = "desc" | "asc";

/**
 * Order rows by a numeric metric, NULLS LAST IN BOTH DIRECTIONS.
 *
 * A row whose metric is unknown is not the smallest — it is unranked, and letting
 * it win an `asc` sort would make "cheapest pool" mean "pool with no price".
 *
 * Comparisons are explicit, never `a - b`: two nulls coalesced to a sentinel and
 * subtracted produce `NaN`, and a comparator that returns `NaN` leaves the sort
 * order undefined. `Array.prototype.sort` is stable, so equal metrics keep
 * provider order.
 */
export function orderRowsByMetric<TRow>(
  rows: readonly TRow[],
  metricOf: (row: TRow) => number | null,
  direction: SortDirection,
): TRow[] {
  const withMetric = rows.map((row) => ({ row, metric: metricOf(row) }));
  withMetric.sort((left, right) => {
    if (left.metric === right.metric) return 0;
    if (left.metric === null) return 1;
    if (right.metric === null) return -1;
    if (direction === "asc") return left.metric < right.metric ? -1 : 1;
    return left.metric > right.metric ? -1 : 1;
  });
  return withMetric.map((entry) => entry.row);
}

/**
 * Take the `offset`/`limit` window.
 *
 * `limit === null` means every remaining row — there is deliberately no default.
 * Windowing runs BEFORE projection everywhere, so the bytes spent are exactly the
 * bytes delivered; the predecessor projected 30 rows and then discarded 10.
 */
export function takeRowWindow<TRow>(
  rows: readonly TRow[],
  offset: number,
  limit: number | null,
): TRow[] {
  const start = Math.min(offset, rows.length);
  const end = limit === null ? rows.length : start + limit;
  return rows.slice(start, end);
}
