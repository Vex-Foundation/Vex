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
 * `dexscreener.search { query: "USDC", chainIds: "ethereum" }` returned
 * `pairs: [], matched: 0, success: true`. Measured on the live window: `q=USDC`
 * spans 15 chains and holds ZERO Ethereum rows. A context-free agent reads that
 * empty result as "USDC does not trade on Ethereum". With `droppedByFilter` the
 * same call reports `providerReturned: 30, droppedByFilter: { chainIds: 30 }` —
 * a completely different fact, and one the agent can act on.
 *
 * Each row is counted against exactly ONE reason, the first that rejected it.
 */

/**
 * A value on either side of a filter comparison, as the agent will read it.
 *
 * Deliberately not `unknown`: these are echoed into the payload, so the shape
 * has to be one a caller can compare without re-parsing.
 */
export type DropComparisonValue = string | number | boolean | readonly string[] | null;

/** One named rejection rule. `reason` becomes a `droppedByFilter` key. */
export interface RowRejection<TRow> {
  /** The PARAMETER NAME that did the dropping — never a prose description. */
  readonly reason: string;
  readonly rejects: (row: TRow) => boolean;
  /**
   * The row's own value for THIS filter, read only when `explainDrops` is on.
   *
   * Optional because a few rules are presence tests with nothing to report
   * (`unknownAge` IS the statement that the value is absent).
   */
  readonly rowValueOf?: (row: TRow) => DropComparisonValue;
  /** The threshold as the caller passed it, normalised. */
  readonly threshold?: DropComparisonValue;
}

/**
 * One dropped row, explained. See {@link ExplainDropsOptions} for the cap.
 */
export interface DroppedRowRecord {
  /**
   * 0-based index of the row in THIS response's PRE-FILTER input — the provider
   * window order for a plain tool, the Vex merge order for `attention`.
   *
   * Deterministic within one response and NOT stable across calls: the provider
   * re-chooses its window every time. It is a pointer into the answer in hand,
   * never a row identity, and the param text says so.
   */
  readonly providerRowIndex: number;
  /** Best-effort family identity: pair address, token address or slug. */
  readonly rowId: string | null;
  /** The FIRST filter that rejected the row — the same one `droppedByFilter` counted. */
  readonly filter: string;
  readonly value: DropComparisonValue;
  readonly threshold: DropComparisonValue;
}

/** The cap on the explained sample. `droppedByFilter` remains the full census. */
export const MAX_EXPLAINED_DROPPED_ROWS = 10;

export interface ExplainDropsOptions<TRow> {
  /** Best-effort identity for a provider row, or `null` when it carries none. */
  readonly rowIdOf: (row: TRow) => string | null;
}

export interface FilterOutcome<TRow> {
  readonly kept: TRow[];
  /** Reason → row count. Only reasons that dropped something appear. */
  readonly droppedByFilter: Record<string, number>;
  /** Present only when `explainDrops` was requested. At most 10 records. */
  readonly droppedRows?: DroppedRowRecord[];
  /** Present with `droppedRows`: whether the census exceeds the sample. */
  readonly droppedRowsTruncated?: boolean;
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
  explain?: ExplainDropsOptions<TRow>,
): FilterOutcome<TRow> {
  const kept: TRow[] = [];
  const droppedByFilter: Record<string, number> = {};
  const droppedRows: DroppedRowRecord[] = [];
  let droppedTotal = 0;

  for (const [providerRowIndex, row] of rows.entries()) {
    const rejection = rejections.find((candidate) => candidate.rejects(row));
    if (rejection === undefined) {
      kept.push(row);
      continue;
    }
    droppedByFilter[rejection.reason] = (droppedByFilter[rejection.reason] ?? 0) + 1;
    droppedTotal += 1;
    // The SAMPLE is capped; the census above is not. An agent needs one row's
    // losing number to decide whether to loosen the filter — it does not need
    // thirty of them, and paying for thirty on every explained call would
    // reintroduce the blob this pipeline exists to remove.
    if (explain !== undefined && droppedRows.length < MAX_EXPLAINED_DROPPED_ROWS) {
      droppedRows.push({
        providerRowIndex,
        rowId: explain.rowIdOf(row),
        filter: rejection.reason,
        value: rejection.rowValueOf === undefined ? null : rejection.rowValueOf(row),
        threshold: rejection.threshold ?? null,
      });
    }
  }

  if (explain === undefined) return { kept, droppedByFilter };
  return {
    kept,
    droppedByFilter,
    droppedRows,
    droppedRowsTruncated: droppedTotal > droppedRows.length,
  };
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
