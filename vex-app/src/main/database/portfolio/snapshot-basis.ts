/**
 * The PnL BASIS of a portfolio read: what the most recent complete snapshot
 * cycles measured, and what was in flight FOR THE WALLETS BEING ASKED ABOUT.
 *
 * Extracted from `../portfolio-db.ts` (2026-09-04) when that file crossed the
 * repository's 750-line gate. `getPortfolio` keeps its public shape and its
 * home; what moved here is one coherent responsibility with its own name: read
 * the snapshot groups, scope their in-flight accounting, and hand back a basis.
 * It owns the snapshot SQL, the durable-JSON parse and the basis arithmetic.
 * It knows nothing about balances, chains, tokens or address resolution.
 *
 * ## The basis is SETTLED + IN TRANSIT, and IN TRANSIT is per wallet
 *
 * `proj_portfolio_snapshots.total_usd` still means exactly what it always did:
 * balances that were read. Comparing that alone across a cycle in which money
 * left one chain and had not yet arrived on the other reports a loss the user
 * did not take - the "$50 and -$150" reading that migration 101 exists to
 * prevent.
 *
 * Migration 101 answered that with ONE group-wide in-transit total, which
 * external review then showed is wrong for any read narrower than the whole
 * inventory: a session or project scoped to wallet A would inherit wallet B's
 * pending bridge. Migration 102 persists the accounting PER WALLET, and every
 * figure below is summed over exactly the resolved address set - the same
 * `wallet_address = ANY($1::text[])` allow-list that bounds every other query
 * in this read. There is no path here that can widen it.
 *
 * ## The bounded list is a list, never a total
 *
 * `in_flight` is the group's DISPLAY ledger, bounded at 50 entries by the
 * publisher. Nothing here derives a total from it. `inTransitUsd`,
 * `unresolvedCount` and `totalCount` all come from the per-wallet aggregate
 * rows, which the publisher computed over EVERY in-flight row. `truncated`
 * compares the two so a consumer is never handed a short list as the truth.
 *
 * ## The durable row is parsed, not trusted
 *
 * The ledger arrives as JSON text written by this repository's own publisher,
 * and it is still PARSED (rule 04: durable data that has crossed serialization
 * is external input), because it feeds a surface that shows the user money. A
 * malformed entry is dropped and reported by COUNT; a kind this build has never
 * heard of - a ledger written by a newer build - maps to the typed `unknown`
 * fallback and stays listed rather than vanishing.
 */

import type { Client } from "pg";

import {
  SNAPSHOT_IN_FLIGHT_KINDS,
  snapshotInFlightEntryDtoSchema,
  type SnapshotInFlightEntryDto,
} from "@shared/schemas/portfolio.js";
import { log } from "../../logger/index.js";

/**
 * The latest TWO groups that cover EXACTLY the resolved address set
 * (`HAVING COUNT(DISTINCT) = N` - a partial group for a subset of the wallets
 * is ignored), each with its in-flight accounting scoped to those same
 * addresses.
 *
 * The four in-flight figures come from CORRELATED SCALAR SUBQUERIES, not joins:
 * the aggregate is over one group's per-wallet rows and the outer query already
 * groups by exactly that key, so this stays a lookup, and a group written
 * before migration 102 yields 0 rather than dropping out of the result.
 *
 * `COALESCE(..., 0)` on all three sums is the pre-102 contract: no per-wallet
 * rows means no attribution exists for that group, and the conservative reading
 * is that these wallets had nothing in flight - never that the group's own
 * whole-inventory figure belongs to them.
 */
const SNAPSHOT_BASIS_SQL = `
  SELECT s.snapshot_group_id,
         SUM(s.total_usd)::float8 AS total,
         MAX(s.created_at)        AS at,
         (SELECT COALESCE(SUM(w.in_transit_usd), 0)::float8
            FROM proj_portfolio_snapshot_group_wallets w
           WHERE w.snapshot_group_id = s.snapshot_group_id
             AND w.wallet_address = ANY($1::text[]))       AS in_transit,
         (SELECT COALESCE(SUM(w.unresolved_count), 0)
            FROM proj_portfolio_snapshot_group_wallets w
           WHERE w.snapshot_group_id = s.snapshot_group_id
             AND w.wallet_address = ANY($1::text[]))       AS unresolved_count,
         (SELECT COALESCE(SUM(w.entry_count), 0)
            FROM proj_portfolio_snapshot_group_wallets w
           WHERE w.snapshot_group_id = s.snapshot_group_id
             AND w.wallet_address = ANY($1::text[]))       AS in_flight_total_count,
         (SELECT g.in_flight::text
            FROM proj_portfolio_snapshot_groups g
           WHERE g.snapshot_group_id = s.snapshot_group_id) AS in_flight
    FROM proj_portfolio_snapshots s
   WHERE s.wallet_address = ANY($1::text[])
   GROUP BY s.snapshot_group_id
  HAVING COUNT(DISTINCT s.wallet_address) = $2
   ORDER BY at DESC
   LIMIT 2`;

interface SnapshotRow {
  readonly total: number | string | null;
  readonly at: string | Date | null;
  /** Summed over the RESOLVED addresses only; 0 for a group written before 102. */
  readonly in_transit: number | string | null;
  readonly unresolved_count: number | string | null;
  readonly in_flight_total_count: number | string | null;
  /** The group's display ledger as JSON TEXT, so it crosses the driver whole. */
  readonly in_flight: string | null;
}

/** One snapshot group, read as the facts the Position card needs. */
export interface SnapshotBasis {
  /** SETTLED + IN TRANSIT. `null` only when the group's settled sum is absent. */
  readonly totalUsd: number | null;
  readonly settledUsd: number | null;
  readonly inTransitUsd: number;
  readonly unresolvedCount: number;
  /** The scoped entries of the bounded display list. Never a source of totals. */
  readonly inFlight: SnapshotInFlightEntryDto[];
  /** Every in-flight row these wallets had, displayed or not. */
  readonly inFlightTotalCount: number;
  /** `inFlightTotalCount > inFlight.length`: rows exist beyond the list. */
  readonly inFlightTruncated: boolean;
  readonly at: string | null;
}

export interface SnapshotBases {
  readonly latest: SnapshotBasis | null;
  readonly previous: SnapshotBasis | null;
}

/**
 * Read the two most recent complete snapshot cycles for `addresses`.
 *
 * `addresses` is the server-resolved allow-list; it is bound into the ONE
 * `$1::text[]` parameter that every predicate and every aggregate in
 * `SNAPSHOT_BASIS_SQL` uses, and it is the same array used to filter the
 * display ledger below. A caller cannot widen the scope of one without the
 * other.
 */
export async function readSnapshotBases(
  client: Client,
  addresses: readonly string[],
): Promise<SnapshotBases> {
  const result = await client.query<SnapshotRow>(SNAPSHOT_BASIS_SQL, [
    [...addresses],
    addresses.length,
  ]);
  const scope = new Set(addresses);
  return {
    latest: readSnapshotBasis(result.rows[0], scope),
    previous: readSnapshotBasis(result.rows[1], scope),
  };
}

function readSnapshotBasis(
  row: SnapshotRow | undefined,
  scope: ReadonlySet<string>,
): SnapshotBasis | null {
  if (row === undefined) return null;
  const settledUsd = toNullableUsd(row.total);
  // Clamped: `in_transit_usd` is CHECKed non-negative from migration 102
  // onward, and a pre-102 row that predates the check must not subtract from a
  // portfolio either.
  const inTransitUsd = Math.max(0, toUsd(row.in_transit));
  const unresolvedCount = toCount(row.unresolved_count);
  const inFlight = scopedInFlight(row.in_flight, scope);
  const inFlightTotalCount = toCount(row.in_flight_total_count);
  return {
    totalUsd: settledUsd === null ? null : settledUsd + inTransitUsd,
    settledUsd,
    inTransitUsd,
    unresolvedCount,
    inFlight,
    inFlightTotalCount,
    inFlightTruncated: inFlightTotalCount > inFlight.length,
    at: row.at !== null ? toIso(row.at) : null,
  };
}

/**
 * The group's bounded ledger, narrowed to the wallets this read is about.
 *
 * Each entry is validated on its own rather than the array as a whole: one
 * unreadable row must not delete the rest of a report about the user's money.
 * Drops are reported by COUNT - never silently, and never with their content,
 * which is unvalidated durable text.
 *
 * An entry whose `walletAddress` is outside `scope` belongs to another wallet
 * in the same publication cycle and is dropped BEFORE validation: it is not
 * this portfolio's money. An entry with no `walletAddress` at all was written
 * before migration 102, carries no attribution, and is dropped for the same
 * reason - the pre-102 reading is "nothing in flight for these wallets", not
 * "somebody's rows".
 */
function scopedInFlight(
  json: string | null,
  scope: ReadonlySet<string>,
): SnapshotInFlightEntryDto[] {
  if (json === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    log.warn("[portfolio-db] snapshot in-flight ledger is not valid JSON; reporting an empty ledger");
    return [];
  }
  if (!Array.isArray(raw)) {
    log.warn("[portfolio-db] snapshot in-flight ledger is not an array; reporting an empty ledger");
    return [];
  }

  const entries: SnapshotInFlightEntryDto[] = [];
  let rejected = 0;
  for (const candidate of raw) {
    if (!belongsToScope(candidate, scope)) continue;
    const parsed = snapshotInFlightEntryDtoSchema.safeParse(withKnownKind(candidate));
    if (parsed.success) entries.push(parsed.data);
    else rejected += 1;
  }
  if (rejected > 0) {
    log.warn(
      `[portfolio-db] snapshot in-flight ledger dropped ${rejected} entr${
        rejected === 1 ? "y" : "ies"
      } that failed the entry schema`,
    );
  }
  return entries;
}

function belongsToScope(candidate: unknown, scope: ReadonlySet<string>): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const address = (candidate as { walletAddress?: unknown }).walletAddress;
  return typeof address === "string" && scope.has(address);
}

/**
 * A durable ledger written by a NEWER build can name a kind this one has never
 * heard of. Mapping it to the typed `unknown` fallback keeps the row VISIBLE -
 * money is in flight and a human should see it - while the closed enum still
 * refuses to let an unnamed kind reach a surface as if it were understood. It
 * contributes to no total, because every total on this path comes from the
 * publisher's aggregates rather than from this list.
 */
function withKnownKind(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null) return candidate;
  const kind = (candidate as { kind?: unknown }).kind;
  const known = SNAPSHOT_IN_FLIGHT_KINDS.some((value) => value === kind);
  return known ? candidate : { ...candidate, kind: "unknown" };
}

/**
 * `NUMERIC`/`float8` columns come back from `pg` as strings or numbers. These
 * three coercions are this module's own: they read the snapshot group's money
 * and time columns, and `portfolio-db.ts` keeps its own for the balance
 * columns, so neither file's column contract can be changed by editing the
 * other's helper.
 */
function toUsd(value: number | string | null | undefined): number {
  const parsed = toNullableUsd(value);
  return parsed ?? 0;
}

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

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
