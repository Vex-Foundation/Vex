/**
 * Balances repo - portfolio snapshot insert + latest read.
 *
 * proj_portfolio_snapshots: time-series of portfolio value with per-chain breakdown.
 *
 * ## Why both functions take an optional `Executor`
 *
 * A snapshot GROUP (one row per inventory wallet, sharing a `snapshotGroupId`)
 * has to be published whole-or-not-at-all, inside the same transaction that
 * holds the serialization lock proving no transaction was in flight
 * (`sync/balance-sync/snapshot-publication.ts`). Both the prior-state read and
 * the insert must therefore be able to JOIN the caller's transaction rather
 * than reach for an arbitrary pool client - on the pool, the `pnl_vs_prev`
 * baseline is read outside the lock that makes it meaningful, and a mid-group
 * failure leaves a half-written group behind.
 *
 * ## Why a trailing optional parameter, not a `…With` sibling
 *
 * This DELIBERATELY differs from the repo's usual pattern
 * (`confirmActivityEventWith`, `queryOneWith`). A sibling would need its own
 * entry in the `balances.ts` facade, and that facade's export key set is frozen
 * by `__tests__/vex-agent/db/repos/balances-surface.test.ts` as a REVIEWED
 * CONTRACT ARTIFACT. Widening a reviewed contract to satisfy a naming
 * convention is a contract change made for cosmetic reasons, so the optional
 * parameter was chosen instead: every existing caller and the facade's export
 * set are byte-unaffected. Owner decision, 2026-08-31 - a deliberate exception,
 * not drift.
 */

import { getPool, queryOneWith, type Executor } from "../../client.js";
import { jsonb } from "../../params.js";
import { mapSnapshotRow } from "./mappers.js";
import type {
  InsertSnapshotArgs,
  InsertSnapshotResult,
  PortfolioSnapshot,
  SnapshotWalletFilter,
} from "./types.js";

export async function insertSnapshot(
  args: InsertSnapshotArgs,
  executor: Executor = getPool(),
): Promise<InsertSnapshotResult> {
  const prev = await getLatestSnapshot(
    { walletFamily: args.walletFamily, walletAddress: args.walletAddress },
    executor,
  );
  let pnlVsPrev: number | null = null;
  let pnlPctVsPrev: number | null = null;
  if (prev && prev.totalUsd > 0) {
    pnlVsPrev = args.totalUsd - prev.totalUsd;
    pnlPctVsPrev = (pnlVsPrev / prev.totalUsd) * 100;
  }

  const row = await queryOneWith<{ id: number }>(
    executor,
    `INSERT INTO proj_portfolio_snapshots
       (wallet_family, wallet_address, snapshot_group_id, total_usd, positions, active_chains, pnl_vs_prev, pnl_pct_vs_prev, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
    [args.walletFamily, args.walletAddress, args.snapshotGroupId, args.totalUsd,
     jsonb(args.positions), args.activeChains, pnlVsPrev, pnlPctVsPrev, args.source ?? "sync"],
  );
  return { snapshotId: row?.id ?? 0, pnlVsPrev };
}

/**
 * Latest snapshot. With `filter` (atomic family+address) returns the latest for
 * that wallet; without it, the latest row across all wallets (legacy/global).
 */
export async function getLatestSnapshot(
  filter?: SnapshotWalletFilter,
  executor: Executor = getPool(),
): Promise<PortfolioSnapshot | null> {
  const row = filter !== undefined
    ? await queryOneWith<Record<string, unknown>>(
        executor,
        "SELECT * FROM proj_portfolio_snapshots WHERE wallet_family = $1 AND wallet_address = $2 ORDER BY created_at DESC LIMIT 1",
        [filter.walletFamily, filter.walletAddress],
      )
    : await queryOneWith<Record<string, unknown>>(
        executor,
        "SELECT * FROM proj_portfolio_snapshots ORDER BY created_at DESC LIMIT 1",
      );
  return row ? mapSnapshotRow(row) : null;
}
