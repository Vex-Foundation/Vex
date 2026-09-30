/**
 * The wallet identities a wake slice can mutate, for the concurrent pool's
 * per-wallet exclusion (`pool.ts`).
 *
 * A slice signs only with its session's SELECTED wallets: engine sessions
 * resolve wallets from the session row alone and a family with no selection
 * fails closed (`engine/core/hydrate.ts` `buildSessionWalletResolution`), and
 * the authority fence re-reads the same two columns before a signature
 * (`tools/internal/wallet/transaction/authority-fence.ts`). So the selected
 * EVM and Solana addresses are the complete set of wallets a slice can move
 * money from.
 *
 * Keys are the on-chain ADDRESS, not the inventory id: two inventory entries
 * with the same public key share one nonce space and one balance, which is
 * exactly what the exclusion protects. EVM addresses are case-insensitive and
 * are lowercased; Solana base58 addresses are case-sensitive and kept as is.
 * A Lighter account is owned by the EVM wallet, so the EVM key covers it.
 *
 * The key set is a snapshot at claim time. A Studio scope edit that re-points
 * the selection mid-slice cannot make the slice sign with the new wallet: the
 * authority fence refuses any signature whose wallet or permission changed
 * since its anchor.
 */

export type WalletKeysFor = (sessionId: string) => Promise<readonly string[]>;

export interface SessionWalletSelection {
  readonly evmAddress: string | null;
  readonly solanaAddress: string | null;
}

export function walletKeysOf(selection: SessionWalletSelection): string[] {
  const keys: string[] = [];
  if (selection.evmAddress !== null && selection.evmAddress.trim() !== "") {
    keys.push(`evm:${selection.evmAddress.trim().toLowerCase()}`);
  }
  if (selection.solanaAddress !== null && selection.solanaAddress.trim() !== "") {
    keys.push(`solana:${selection.solanaAddress.trim()}`);
  }
  return keys;
}

interface SessionWalletRow {
  readonly selected_evm_wallet_address: string | null;
  readonly selected_solana_wallet_address: string | null;
}

/** Production lookup: the session row's two selected addresses. */
export async function sessionWalletKeys(sessionId: string): Promise<readonly string[]> {
  const { queryOne } = await import("@vex-agent/db/client.js");
  const row = await queryOne<SessionWalletRow>(
    `SELECT selected_evm_wallet_address, selected_solana_wallet_address
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (row === null) return [];
  return walletKeysOf({
    evmAddress: row.selected_evm_wallet_address,
    solanaAddress: row.selected_solana_wallet_address,
  });
}
