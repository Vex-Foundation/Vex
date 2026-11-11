/**
 * The wallet total OVER TIME: complete snapshot cycles for a resolved address
 * set, inside one range, on the same SETTLED + IN TRANSIT basis the portfolio
 * read reports for its latest cycle.
 *
 * This is `./snapshot-basis.ts`'s question asked for a range instead of for the
 * latest two cycles, so it keeps that module's rules and says where it differs:
 *
 *  - a cycle is a point only when EVERY wallet in the set has a row in it
 *    (`HAVING COUNT(DISTINCT wallet_address) = N`), so a cycle that missed a
 *    wallet never draws as a dip;
 *  - in transit is summed PER WALLET over exactly the set, from
 *    `proj_portfolio_snapshot_group_wallets` (migration 102), and a cycle
 *    written before 102 reads as in transit 0, the conservative pre-102
 *    reading;
 *  - the display ledger is NOT read. A chart point needs the figure, not the
 *    list, so the durable JSON never crosses the driver on this path.
 *
 * ## Why this is not the engine's `getSnapshotHistory`
 *
 * `src/vex-agent/db/repos/balances/history.ts` answers a different question:
 * the raw PER-WALLET rows, across every wallet that ever wrote one when no
 * filter is passed, on the settled basis alone. Main does not import the
 * engine repositories (`../portfolio-db.ts` header), and the history must be
 * bounded by the same server-resolved allow-list as every other portfolio
 * query, so the SQL lives here, beside the basis it has to agree with. The
 * engine's own aggregate (`getAggregateSnapshots`) groups the same way and is
 * the closest relative; it lacks the in-transit half, and a chart whose last
 * point disagreed with the total printed above it would be wrong on sight.
 *
 * ## The range cut
 *
 * Rows are cut by `created_at > NOW() - <range>` BEFORE grouping, as the engine
 * does, so the index on `created_at` serves the read. The publisher writes a
 * whole group in one transaction (`sync/balance-sync/snapshot-publication.ts`),
 * so its rows share one `created_at` and a group is never split by the cut. A
 * group written before that publisher, whose rows could straddle the cut, loses
 * a wallet to it and fails the completeness rule: it is left out, never drawn
 * short. `all` applies no cut. The interval is a bound parameter drawn from a
 * closed map, never text interpolated into the statement.
 *
 * ## The bound: equal time buckets, the latest cycle in each
 *
 * At most `maxPoints` rows come back. When the range holds no more than that,
 * every cycle is its own bucket and nothing is thinned. When it holds more, the
 * span from the range's first cycle to its last is cut into `maxPoints` equal
 * buckets (`floor(offset * (maxPoints - 1) / span)`, so the index runs 0 to
 * maxPoints - 1) and each bucket keeps its LATEST cycle - the bucket's closing
 * value, the usual reading for an equity line. The newest cycle is the latest
 * row of whichever bucket holds it, so it is always kept and the chart always
 * ends on the figure the total shows. A span of zero (every cycle at one
 * instant) is a single bucket. `groupCount` is counted over every complete
 * cycle BEFORE thinning, so the caller can say the series was thinned.
 *
 * The in-transit sum is a correlated scalar subquery run for the KEPT rows
 * only, so thinning bounds that work too.
 */

import type { Client } from "pg";

import type {
  PortfolioHistoryPointDto,
  PortfolioHistoryRange,
} from "@shared/schemas/portfolio-history.js";

/**
 * `null` is `all`: no cut. Bound as `$3::interval`, never interpolated - the
 * engine's own history read interpolates its interval, which is safe only
 * because its map is closed too; a parameter does not depend on that.
 */
const RANGE_INTERVALS: Readonly<Record<PortfolioHistoryRange, string | null>> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: null,
};

/**
 * $1 the resolved address set, $2 its size, $3 the range interval (NULL = all),
 * $4 the point bound.
 *
 * `bucket` is NUMERIC on both arms of the CASE (`ROW_NUMBER` is BIGINT and
 * `FLOOR` of a NUMERIC is NUMERIC; Postgres unifies them), and `DISTINCT ON`
 * keeps the first row per bucket under `at DESC`, the bucket's latest cycle.
 * `snapshot_group_id` breaks an exact `at` tie so the kept row is stable
 * across reads.
 */
const SNAPSHOT_HISTORY_SQL = `
  WITH groups AS (
    SELECT s.snapshot_group_id,
           SUM(s.total_usd)::float8 AS settled,
           MAX(s.created_at)        AS at,
           BOOL_OR(s.partial)       AS partial
      FROM proj_portfolio_snapshots s
     WHERE s.wallet_address = ANY($1::text[])
       AND ($3::interval IS NULL OR s.created_at > NOW() - $3::interval)
     GROUP BY s.snapshot_group_id
    HAVING COUNT(DISTINCT s.wallet_address) = $2
  ),
  span AS (
    SELECT COUNT(*) AS group_count,
           EXTRACT(EPOCH FROM MIN(at)) AS first_epoch,
           EXTRACT(EPOCH FROM MAX(at)) - EXTRACT(EPOCH FROM MIN(at)) AS span_seconds
      FROM groups
  ),
  bucketed AS (
    SELECT g.snapshot_group_id, g.settled, g.at, g.partial, sp.group_count,
           CASE
             WHEN sp.group_count <= $4
               THEN ROW_NUMBER() OVER (ORDER BY g.at, g.snapshot_group_id)
             WHEN sp.span_seconds = 0
               THEN 0
             ELSE FLOOR((EXTRACT(EPOCH FROM g.at) - sp.first_epoch) * ($4 - 1) / sp.span_seconds)
           END AS bucket
      FROM groups g
     CROSS JOIN span sp
  ),
  kept AS (
    SELECT DISTINCT ON (bucket) snapshot_group_id, settled, at, partial, group_count
      FROM bucketed
     ORDER BY bucket, at DESC, snapshot_group_id DESC
  )
  SELECT k.settled,
         k.at,
         k.partial,
         k.group_count,
         (SELECT COALESCE(SUM(w.in_transit_usd), 0)::float8
            FROM proj_portfolio_snapshot_group_wallets w
           WHERE w.snapshot_group_id = k.snapshot_group_id
             AND w.wallet_address = ANY($1::text[])) AS in_transit
    FROM kept k
   ORDER BY k.at ASC, k.snapshot_group_id ASC`;

interface SnapshotHistoryRow {
  readonly settled: number | string | null;
  readonly at: string | Date | null;
  readonly partial: boolean | null;
  /** The same on every row: complete cycles in the range, before thinning. */
  readonly group_count: number | string | null;
  /** Summed over the RESOLVED addresses only; 0 for a group written before 102. */
  readonly in_transit: number | string | null;
}

export interface SnapshotHistory {
  /** Oldest first, at most `maxPoints`. */
  readonly points: PortfolioHistoryPointDto[];
  /** Complete cycles in the range before thinning; 0 when there are none. */
  readonly groupCount: number;
}

/**
 * Read the complete snapshot cycles for `addresses` inside `range`.
 *
 * `addresses` is the server-resolved allow-list and must be non-empty (the
 * caller returns the empty answer before any SQL, as the read does). It is
 * bound into the ONE `$1::text[]` that both the cycle predicate and the
 * in-transit sum use, so neither can be widened without the other.
 */
export async function readSnapshotHistory(
  client: Client,
  addresses: readonly string[],
  range: PortfolioHistoryRange,
  maxPoints: number,
): Promise<SnapshotHistory> {
  const result = await client.query<SnapshotHistoryRow>(SNAPSHOT_HISTORY_SQL, [
    [...addresses],
    addresses.length,
    RANGE_INTERVALS[range],
    maxPoints,
  ]);
  const points: PortfolioHistoryPointDto[] = [];
  for (const row of result.rows) {
    const point = readPoint(row);
    if (point !== null) points.push(point);
  }
  return {
    // Defensive: the SQL cannot return more than `maxPoints` rows. If it ever
    // did, the NEWEST are kept, so the chart still ends on the current total
    // rather than the output schema refusing the whole answer.
    points: points.slice(-maxPoints),
    groupCount: toCount(result.rows[0]?.group_count),
  };
}

/**
 * One row as a point, or `null` when its time or settled figure cannot be
 * read. `total_usd` is `NOT NULL` and `at` is a `MAX` over rows that exist, so
 * neither should happen; if one does, the point is dropped rather than drawn
 * at a fabricated 0 or a fabricated time.
 */
function readPoint(row: SnapshotHistoryRow): PortfolioHistoryPointDto | null {
  const settledUsd = toNullableUsd(row.settled);
  if (settledUsd === null || row.at === null) return null;
  const at = toIso(row.at);
  if (at === null) return null;
  // Clamped for the reason `snapshot-basis.ts` gives: a row predating 102's
  // CHECK must not subtract from a portfolio.
  const inTransitUsd = Math.max(0, toNullableUsd(row.in_transit) ?? 0);
  return {
    at,
    totalUsd: settledUsd + inTransitUsd,
    settledUsd,
    inTransitUsd,
    partial: row.partial === true,
  };
}

/**
 * `NUMERIC`/`float8` and `BIGINT` columns come back from `pg` as strings or
 * numbers. Like `snapshot-basis.ts`, this module keeps its own coercions so no
 * other file's column contract can change them.
 */
function toNullableUsd(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCount(value: number | string | null | undefined): number {
  const parsed = toNullableUsd(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * `pg` parses `timestamptz` into a `Date`. The DTO wants an ISO string with an
 * offset; an unparseable value is refused here rather than at the output
 * schema, where it would fail the whole answer.
 */
function toIso(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
