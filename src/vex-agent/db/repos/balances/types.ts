/**
 * Balances repo — public row + domain types.
 *
 * proj_balances rows + portfolio snapshot / aggregate-cycle shapes.
 */

export interface BalanceRow {
  walletFamily: string;
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  balanceRaw: string;
  balanceUsd: number | null;
  priceUsd: number | null;
  decimals: number | null;
}

export interface ChainSummary {
  chainId: number;
  totalUsd: number;
  tokenCount: number;
}

export interface PortfolioSnapshot {
  partial: boolean;
  unresolvedChainCount: number;
  id: number;
  walletFamily: string;
  walletAddress: string;
  snapshotGroupId: string;
  totalUsd: number;
  positions: Record<string, unknown>;
  activeChains: string[];
  pnlVsPrev: number | null;
  pnlPctVsPrev: number | null;
  source: string;
  createdAt: string;
}

/** Atomic wallet identity for per-wallet snapshot reads. */
export interface SnapshotWalletFilter {
  walletFamily: string;
  walletAddress: string;
}

export interface InsertSnapshotArgs {
  partial?: boolean;
  unresolvedChainCount?: number;
  walletFamily: string;
  walletAddress: string;
  /** Shared across every wallet row written in one fullBalanceSync cycle. */
  snapshotGroupId: string;
  totalUsd: number;
  positions: Record<string, unknown>;
  activeChains: string[];
  source?: string;
}

/**
 * Insert a PER-WALLET portfolio snapshot. PnL is computed against the previous
 * snapshot for the SAME (walletFamily, walletAddress); the first row for a
 * wallet has null PnL. All wallet rows from one fullBalanceSync cycle share
 * `snapshotGroupId` so an aggregate view can stitch a cycle back together
 * (puzzle 5 phase 5E-1).
 */
export interface InsertSnapshotResult {
  snapshotId: number;
  pnlVsPrev: number | null;
}

/** One full-sync CYCLE aggregated across a wallet set (puzzle 5 phase 5E-2). */
export interface AggregateSnapshot {
  partial: boolean;
  unresolvedChainCount: number;
  snapshotGroupId: string;
  totalUsd: number;
  pnlVsPrev: number | null;
  pnlPctVsPrev: number | null;
  activeChains: string[];
  at: string;
}
