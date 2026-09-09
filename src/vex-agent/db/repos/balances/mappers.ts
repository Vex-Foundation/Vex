/**
 * Balances repo — row mappers (single-sourced).
 */

import type { BalanceRow, PortfolioSnapshot } from "./types.js";

export function mapBalanceRow(r: Record<string, unknown>): BalanceRow {
  return {
    walletFamily: r.wallet_family as string,
    walletAddress: r.wallet_address as string,
    chainId: Number(r.chain_id),
    tokenAddress: r.token_address as string,
    tokenSymbol: r.token_symbol as string | null,
    tokenName: r.token_name as string | null,
    balanceRaw: r.balance_raw as string,
    balanceUsd: r.balance_usd != null ? Number(r.balance_usd) : null,
    priceUsd: r.price_usd != null ? Number(r.price_usd) : null,
    decimals: r.decimals as number | null,
  };
}

export function mapSnapshotRow(r: Record<string, unknown>): PortfolioSnapshot {
  return {
    id: r.id as number,
    walletFamily: r.wallet_family as string,
    walletAddress: r.wallet_address as string,
    snapshotGroupId: r.snapshot_group_id as string,
    partial: r.partial === true,
    unresolvedChainCount: Number(r.unresolved_chain_count ?? 0),
    totalUsd: Number(r.total_usd),
    positions: r.positions as Record<string, unknown>,
    activeChains: r.active_chains as string[],
    pnlVsPrev: r.pnl_vs_prev != null ? Number(r.pnl_vs_prev) : null,
    pnlPctVsPrev: r.pnl_pct_vs_prev != null ? Number(r.pnl_pct_vs_prev) : null,
    source: r.source as string,
    createdAt: r.created_at as string,
  };
}
