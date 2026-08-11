/**
 * Balances repo - valuation reads for the mission start baseline.
 *
 * Separate from `read.ts` because it answers a different question: `read.ts`
 * serves per-wallet display, this module serves ONE frozen measurement that a
 * mission run is later compared against. Same table, different reason to change.
 *
 * Three caveats are structural, not incidental, and every caller inherits them:
 *
 * (a) `balance_raw` is TEXT and is summed as `NUMERIC`, never through a
 *     JavaScript number: a wei-scale integer exceeds `Number.MAX_SAFE_INTEGER`
 *     and would silently lose its low digits. The `balance_raw ~ '^[0-9]+$'`
 *     filter keeps one malformed row from aborting the entire read with a
 *     numeric-cast error, which would turn a single bad projection row into a
 *     missing baseline for the whole mission.
 *
 * (b) Asset identity is FAMILY AWARE. EVM addresses are case-insensitive and
 *     the sync writes the provider's casing verbatim
 *     (`sync/balance-sync.ts`), so the evm family compares with `LOWER()`. It
 *     can only over-match if two distinct mints on one chain differ solely by
 *     case, which would visibly double a display figure and can never authorize
 *     a spend. Solana base58 case IS identity, so the solana family compares
 *     EXACTLY; folding a mint's case there would match no row at all, or the
 *     wrong one.
 *
 * (c) A raw amount whose decimals are unknown or contradictory is returned as a
 *     NULL PAIR. `"1047061"` is 1.05 at 6 decimals and 0.00105 at 9, so a raw
 *     amount without trustworthy decimals is the thousandfold trap of the money
 *     rules. We decline and never rescale.
 *
 * Every USD figure here is an ESTIMATE carried by the projection, not a quote.
 *
 * (d) Both reads are SERVER-BOUNDED. Each runs in its own transaction whose
 *     first statement is `SET LOCAL statement_timeout`, so Postgres cancels a
 *     slow query itself and `SET LOCAL` resets when that transaction ends. The
 *     callers also race a timer, but a caller-side race only abandons the WAIT:
 *     the query keeps running and keeps holding one of the pool's ten
 *     connections, so repeated slow reads could starve the pool. The race is
 *     the latency bound; this is the resource bound. `withTransaction` releases
 *     the client in a `finally`, including the cancellation path, so the
 *     connection returns to the pool even though the caller has moved on.
 */

import type { QueryResultRow } from "pg";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import { queryOneWith, withTransaction } from "../../client.js";

/** Portfolio value across a wallet set, as the local projection recorded it. */
export interface PortfolioValuation {
  readonly totalUsdEstimate: number;
  readonly pricedRowCount: number;
  /** Rows with a non-zero balance and NO usd price. Excluded from the total, never zeroed into it. */
  readonly unpricedRowCount: number;
  readonly oldestSyncedAt: string | null;
  readonly newestSyncedAt: string | null;
}

/** Holding of ONE asset across a wallet set. */
export interface AssetHolding {
  /** Raw and decimals travel as a PAIR: both set, or both null. */
  readonly heldAmountRaw: string | null;
  readonly heldDecimals: number | null;
  readonly heldUsdEstimate: number | null;
  readonly rowCount: number;
  readonly hasUnpricedRow: boolean;
}

/**
 * Default server-side bound, just under the mission baseline's 4000 ms caller
 * budget so Postgres gives up first and the caller sees a real error rather
 * than an abandoned query. Callers with a tighter budget (the per-turn capital
 * banner) pass their own.
 */
export const DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS = 3_500;

/** Floor and ceiling for the bound. A bound is a guard, not a caller free-for-all. */
const MIN_STATEMENT_TIMEOUT_MS = 100;
const MAX_STATEMENT_TIMEOUT_MS = 60_000;

const EMPTY_VALUATION: PortfolioValuation = {
  totalUsdEstimate: 0,
  pricedRowCount: 0,
  unpricedRowCount: 0,
  oldestSyncedAt: null,
  newestSyncedAt: null,
};

const EMPTY_HOLDING: AssetHolding = {
  heldAmountRaw: null,
  heldDecimals: null,
  heldUsdEstimate: null,
  rowCount: 0,
  hasUnpricedRow: false,
};

interface ValuationRow {
  readonly total_usd: string | number | null;
  readonly priced_rows: string | number | null;
  readonly unpriced_rows: string | number | null;
  readonly oldest_synced_at: Date | string | null;
  readonly newest_synced_at: Date | string | null;
}

interface HoldingRow {
  readonly held_raw: string | null;
  readonly held_usd: string | number | null;
  readonly min_decimals: number | null;
  readonly max_decimals: number | null;
  readonly row_count: string | number | null;
  readonly has_unpriced: boolean | null;
}

/**
 * `SET LOCAL statement_timeout` takes no bind parameter, so the value is
 * INTERPOLATED and must therefore be proven to be a bounded integer first.
 * Anything else collapses to the default rather than reaching the SQL text.
 */
function statementTimeoutStatement(timeoutMs: number): string {
  const requested = Number.isFinite(timeoutMs)
    ? Math.trunc(timeoutMs)
    : DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS;
  const bounded = Math.min(
    MAX_STATEMENT_TIMEOUT_MS,
    Math.max(MIN_STATEMENT_TIMEOUT_MS, requested),
  );
  return `SET LOCAL statement_timeout = ${bounded}`;
}

/** One bounded read: the timeout is set, then the SELECT runs, in one tx. */
async function readBounded<T extends QueryResultRow>(
  timeoutMs: number,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  return withTransaction(async (client) => {
    await client.query(statementTimeoutStatement(timeoutMs));
    return queryOneWith<T>(client, sql, params);
  });
}

function toCount(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toUsd(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Total portfolio value across `addresses`, with the counts and freshness the
 * caller needs to say honestly how good the figure is. An EMPTY set returns an
 * empty valuation WITHOUT querying: it must never widen into a global read
 * (same guard, same reason, as `getTotalUsd`).
 */
export async function getPortfolioValuation(
  addresses: readonly string[],
  timeoutMs: number = DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS,
): Promise<PortfolioValuation> {
  if (addresses.length === 0) return EMPTY_VALUATION;

  const row = await readBounded<ValuationRow>(
    timeoutMs,
    `SELECT COALESCE(SUM(balance_usd), 0)                                      AS total_usd,
            COUNT(*) FILTER (WHERE balance_usd IS NOT NULL)                    AS priced_rows,
            COUNT(*) FILTER (WHERE balance_usd IS NULL AND balance_raw <> '0') AS unpriced_rows,
            MIN(synced_at) AS oldest_synced_at,
            MAX(synced_at) AS newest_synced_at
       FROM proj_balances
      WHERE wallet_address = ANY($1::text[])`,
    [[...addresses]],
  );
  if (row === null) return EMPTY_VALUATION;

  return {
    totalUsdEstimate: toUsd(row.total_usd),
    pricedRowCount: toCount(row.priced_rows),
    unpricedRowCount: toCount(row.unpriced_rows),
    oldestSyncedAt: toIsoOrNull(row.oldest_synced_at),
    newestSyncedAt: toIsoOrNull(row.newest_synced_at),
  };
}

/**
 * Holding of ONE asset across `addresses`, identified by (chain, token) in the
 * casing rules of that chain's family. See caveats (b) and (c) in the module
 * doc: the family decides the comparison, and contradictory decimals null the
 * amount/decimals pair rather than being reconciled.
 */
export async function getAssetHolding(
  addresses: readonly string[],
  chainId: number,
  tokenAddress: string,
  timeoutMs: number = DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS,
): Promise<AssetHolding> {
  if (addresses.length === 0) return EMPTY_HOLDING;

  const isSolana = chainId === SOLANA_SYNTHETIC_CHAIN_ID;
  const tokenPredicate = isSolana
    ? "AND token_address = $4"
    : "AND LOWER(token_address) = LOWER($4)";

  const row = await readBounded<HoldingRow>(
    timeoutMs,
    `SELECT SUM(balance_raw::numeric)::text AS held_raw,
            COALESCE(SUM(balance_usd), 0)   AS held_usd,
            MIN(decimals) AS min_decimals,
            MAX(decimals) AS max_decimals,
            COUNT(*) AS row_count,
            bool_or(balance_usd IS NULL AND balance_raw <> '0') AS has_unpriced
       FROM proj_balances
      WHERE wallet_address = ANY($1::text[])
        AND wallet_family = $2
        AND chain_id = $3
        ${tokenPredicate}
        AND balance_raw ~ '^[0-9]+$'`,
    [[...addresses], isSolana ? "solana" : "eip155", chainId, tokenAddress],
  );
  if (row === null) return EMPTY_HOLDING;

  const rowCount = toCount(row.row_count);
  if (rowCount === 0) return EMPTY_HOLDING;

  const decimalsAgree =
    row.min_decimals !== null
    && row.max_decimals !== null
    && row.min_decimals === row.max_decimals;

  return {
    heldAmountRaw: decimalsAgree ? row.held_raw : null,
    heldDecimals: decimalsAgree ? row.min_decimals : null,
    heldUsdEstimate: toUsd(row.held_usd),
    rowCount,
    hasUnpricedRow: row.has_unpriced === true,
  };
}
