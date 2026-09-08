/**
 * Balances repo — aggregate (per-session) snapshots.
 *
 * Per-CYCLE totals across a wallet set, stitched back together via
 * `snapshot_group_id`; every selected wallet must have a row. A whole group
 * can still carry partial chain reads, which remain visible with null PnL.
 */

import { query } from "../../client.js";
import type { AggregateSnapshot } from "./types.js";

interface AggregateGroupRow {
  snapshot_group_id: string;
  total_usd: string;
  at: string;
  chains: string[][] | null;
  partial: boolean;
  unresolved_chain_count: string | number;
}

function flattenChains(nested: string[][] | null): string[] {
  return [...new Set((nested ?? []).flat())];
}

function aggregatePnl(totalUsd: number, prevTotal: number | null): { pnlVsPrev: number | null; pnlPctVsPrev: number | null } {
  if (prevTotal === null) return { pnlVsPrev: null, pnlPctVsPrev: null };
  const pnlVsPrev = totalUsd - prevTotal;
  return { pnlVsPrev, pnlPctVsPrev: prevTotal > 0 ? (pnlVsPrev / prevTotal) * 100 : null };
}

/**
 * Aggregate per-wallet snapshots into per-CYCLE totals for the given wallet
 * set. Only COMPLETE cycles (a row for EVERY selected wallet, via
 * `HAVING COUNT(DISTINCT wallet_address) = <n>`) count, so a partial/failed
 * sync can't understate the total. PnL requires two adjacent groups whose
 * chain reads are complete; partial values never become delta baselines.
 * An empty wallet set returns no rows and never widens to the global scope.
 */
export async function getAggregateSnapshots(
  addresses: string[],
  range: "24h" | "7d" | "30d" | "all" = "7d",
): Promise<AggregateSnapshot[]> {
  if (addresses.length === 0) return [];
  const intervals: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", "all": "100 years" };
  const rows = await query<AggregateGroupRow>(
    `SELECT snapshot_group_id, SUM(total_usd) AS total_usd, MAX(created_at) AS at,
            array_agg(active_chains) AS chains, BOOL_OR(partial) AS partial,
            SUM(unresolved_chain_count) AS unresolved_chain_count
     FROM proj_portfolio_snapshots
     WHERE created_at > NOW() - INTERVAL '${intervals[range]}' AND wallet_address = ANY($1::text[])
     GROUP BY snapshot_group_id
     HAVING COUNT(DISTINCT wallet_address) = $2
     ORDER BY at ASC`,
    [addresses, addresses.length],
  );
  let prevTotal: number | null = null;
  return rows.map((r) => {
    const totalUsd = Number(r.total_usd);
    const partial = r.partial === true;
    const { pnlVsPrev, pnlPctVsPrev } = aggregatePnl(totalUsd, partial ? null : prevTotal);
    prevTotal = partial ? null : totalUsd;
    return {
      snapshotGroupId: r.snapshot_group_id,
      partial,
      unresolvedChainCount: Number(r.unresolved_chain_count ?? 0),
      totalUsd,
      pnlVsPrev,
      pnlPctVsPrev,
      activeChains: flattenChains(r.chains),
      at: String(r.at),
    };
  });
}

/**
 * Latest whole wallet group, with PnL only when both adjacent groups have
 * complete chain reads. Empty set → null. Used by the portfolio summary.
 */
export async function getLatestAggregateSnapshot(
  addresses: string[],
): Promise<AggregateSnapshot | null> {
  if (addresses.length === 0) return null;
  const rows = await query<AggregateGroupRow>(
    `SELECT snapshot_group_id, SUM(total_usd) AS total_usd, MAX(created_at) AS at,
            array_agg(active_chains) AS chains, BOOL_OR(partial) AS partial,
            SUM(unresolved_chain_count) AS unresolved_chain_count
     FROM proj_portfolio_snapshots
     WHERE wallet_address = ANY($1::text[])
     GROUP BY snapshot_group_id
     HAVING COUNT(DISTINCT wallet_address) = $2
     ORDER BY at DESC
     LIMIT 2`,
    [addresses, addresses.length],
  );
  const latest = rows[0];
  if (latest === undefined) return null;
  const totalUsd = Number(latest.total_usd);
  const { pnlVsPrev, pnlPctVsPrev } = aggregatePnl(totalUsd, !latest.partial && rows[1] && !rows[1].partial ? Number(rows[1].total_usd) : null);
  return {
    snapshotGroupId: latest.snapshot_group_id,
    partial: latest.partial === true,
    unresolvedChainCount: Number(latest.unresolved_chain_count ?? 0),
    totalUsd,
    pnlVsPrev,
    pnlPctVsPrev,
    activeChains: flattenChains(latest.chains),
    at: String(latest.at),
  };
}
