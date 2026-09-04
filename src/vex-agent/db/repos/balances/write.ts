/**
 * Balances repo - write paths (proj_balances upsert / full-replace).
 */

import { execute, executeWith, withTransaction } from "../../client.js";
import type { BalanceRow } from "./types.js";

/** Columns per row in the batched INSERT below - the parameter-budget divisor. */
const COLUMNS_PER_ROW = 10;

/**
 * Rows per statement. Postgres caps a statement at 65535 bind parameters, so
 * the hard ceiling is 6553 rows; 500 keeps the ceiling far away while turning a
 * 1100-token chain from 1100 round trips into three. The round trips mattered:
 * they all happened inside the open replace transaction, holding its row locks
 * for the whole duration.
 */
const ROWS_PER_STATEMENT = 500;

/** Upsert a single balance row. */
export async function upsertBalance(row: BalanceRow): Promise<void> {
  await execute(
    `INSERT INTO proj_balances (wallet_family, wallet_address, chain_id, token_address, token_symbol, token_name, balance_raw, balance_usd, price_usd, decimals, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (wallet_address, chain_id, token_address)
     DO UPDATE SET wallet_family = $1, token_symbol = $5, token_name = $6, balance_raw = $7, balance_usd = $8, price_usd = $9, decimals = $10, synced_at = NOW()`,
    [row.walletFamily, row.walletAddress, row.chainId, row.tokenAddress,
     row.tokenSymbol, row.tokenName, row.balanceRaw, row.balanceUsd, row.priceUsd, row.decimals],
  );
}

/**
 * Transactional full-replace for (walletAddress, chainId).
 * Deletes all existing rows for this wallet+chain, then inserts new ones.
 * Tokens absent from Khalani response are removed - no "ghost" balances.
 *
 * Runs through the repo's `withTransaction` owner rather than a hand-rolled
 * BEGIN/ROLLBACK, so a failing ROLLBACK cannot mask the original error and the
 * client is released on every path.
 */
export async function replaceBalancesForChain(
  walletAddress: string,
  chainId: number,
  newRows: BalanceRow[],
): Promise<number> {
  return withTransaction(async (client) => {
    // Delete all existing for this wallet+chain
    await client.query(
      "DELETE FROM proj_balances WHERE wallet_address = $1 AND chain_id = $2",
      [walletAddress, chainId],
    );

    for (let offset = 0; offset < newRows.length; offset += ROWS_PER_STATEMENT) {
      const chunk = newRows.slice(offset, offset + ROWS_PER_STATEMENT);
      await executeWith(client, insertStatement(chunk.length), bindParams(chunk));
    }

    return newRows.length;
  });
}

/** `VALUES ($1,…,$10,NOW()), ($11,…)` for `rowCount` rows. */
function insertStatement(rowCount: number): string {
  const tuples: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * COLUMNS_PER_ROW;
    const placeholders: string[] = [];
    for (let c = 1; c <= COLUMNS_PER_ROW; c++) placeholders.push(`$${base + c}`);
    tuples.push(`(${placeholders.join(", ")}, NOW())`);
  }
  return `INSERT INTO proj_balances (wallet_family, wallet_address, chain_id, token_address, token_symbol, token_name, balance_raw, balance_usd, price_usd, decimals, synced_at)
     VALUES ${tuples.join(", ")}`;
}

function bindParams(rows: readonly BalanceRow[]): unknown[] {
  const params: unknown[] = [];
  for (const row of rows) {
    params.push(
      row.walletFamily, row.walletAddress, row.chainId, row.tokenAddress,
      row.tokenSymbol, row.tokenName, row.balanceRaw, row.balanceUsd, row.priceUsd, row.decimals,
    );
  }
  return params;
}
