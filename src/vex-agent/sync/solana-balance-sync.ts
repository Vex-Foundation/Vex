/**
 * Direct-RPC balance sync for Solana - the PRIMARY source for the Solana chain
 * card, with Khalani demoted to a fallback (owner decision 2026-08-26).
 *
 * Why this exists: Khalani's scan answers `scannedChainIds = [20011000000]`
 * with ZERO tokens for Solana, and the Khalani sync path then replaces the
 * chain with an EMPTY row set. The panel showed $0 for a wallet that holds
 * real positions. Reading the chain's own RPC is the fix; this module owns the
 * sync-specific half of it (fail-soft policy, the DB row mapping, the
 * transactional whole-chain replace), exactly as `local-chain-balance-sync.ts`
 * does for local EVM chains. The RPC + pricing half lives in
 * `tools/solana-ecosystem/balances/read-wallet-balances.ts`, and the SHAPING
 * rules (native under the wSOL mint, zero skipped, wSOL folded into native) in
 * `tools/solana-ecosystem/balances/wallet-snapshot.ts` - shared with the agent
 * tools, so a live read and this projection can never disagree.
 *
 * ## Failure semantics, and why a PARTIAL read writes nothing
 *
 * `replaceBalancesForChain` replaces the wallet's WHOLE Solana snapshot. So:
 *  - an RPC/transport failure is fail-soft: nothing is written, the last-good
 *    rows survive, and `skipped: true` tells the caller to fall back to
 *    Khalani for this cycle;
 *  - a read that produced ANY unparseable token account is treated the same
 *    way. Writing the survivors of a partial read would DELETE the holdings
 *    whose accounts failed, and the agent would read that deletion as "you
 *    hold none of it". This is the same doctrine as the local-EVM path's
 *    `tokenFailures` guard;
 *  - DB failures PROPAGATE, so the sync run fails visibly instead of
 *    masquerading as a skipped chain.
 *
 * The raw provider error NEVER reaches the log: an RPC error can carry the
 * configured RPC URL (with its API key) and HTML bodies. Only the error's
 * class name is recorded.
 */

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../constants/solana-chain.js";
import {
  readSolanaWalletBalances,
  type SolanaBalanceRpc,
  type SolanaWalletBalancesRead,
} from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import {
  projectSolanaBalanceRows,
  type SolanaBalanceRow,
} from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import * as balancesRepo from "@vex-agent/db/repos/balances.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import logger from "@utils/logger.js";

/** Solana rows are always written under this family (`familyForChainId` parity). */
const SOLANA_WALLET_FAMILY = "solana";

export interface SolanaSyncOptions {
  /**
   * Injected RPC seam, forwarded to the reader. Production callers omit it and
   * get the shared `getSolanaConnection()` singleton; a test drives a scripted
   * object through the same code path instead of patching a global.
   */
  readonly rpc?: SolanaBalanceRpc;
}

export interface SolanaSyncResult {
  chainId: number;
  tokensUpdated: number;
  /** True when nothing was written and the last-good rows were kept. */
  skipped: boolean;
}

/**
 * Sync the Solana chain for one wallet: read balances direct from RPC, price
 * them, and replace the wallet's Solana rows in `proj_balances`. Address-only -
 * never touches key material.
 */
export async function syncSolanaWalletBalances(
  walletAddress: string,
  options: SolanaSyncOptions = {},
): Promise<SolanaSyncResult> {
  const redactedAddress = walletAddress.slice(0, 10) + "...";

  let read: SolanaWalletBalancesRead;
  try {
    read = await readSolanaWalletBalances(walletAddress, { rpc: options.rpc });
  } catch (err) {
    logger.warn("sync.solana_chain.failed", {
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      address: redactedAddress,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true };
  }

  if (read.accountFailures.length > 0) {
    logger.warn("sync.solana_chain.read_incomplete", {
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      address: redactedAddress,
      failedAccounts: read.accountFailures.length,
      scanned: read.stats.accountsScanned,
      reasons: [...new Set(read.accountFailures.map((failure) => failure.reason))],
    });
    return { chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true };
  }

  const rows = buildBalanceRows(walletAddress, read);

  // DB WRITE - propagates on failure (worker retry semantics).
  const count = await balancesRepo.replaceBalancesForChain(
    walletAddress,
    SOLANA_SYNTHETIC_CHAIN_ID,
    rows,
  );
  logger.info("sync.solana_chain.completed", {
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    address: redactedAddress,
    tokens: count,
    unpriced: read.stats.unpriced,
    frozen: read.stats.frozenAccounts,
    zeroSkipped: read.stats.zeroSkipped,
    metadataMissing: read.stats.metadataMissing,
    // WHY each price was chosen, not just how many are missing: tier 0 is a
    // stablecoin-quoted pool, tier 1 is wSOL-quoted x our SOL price, and
    // `unpriced` is what our own rule refused rather than guessed at.
    priceTiers: read.stats.priceTiers,
  });
  return { chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: count, skipped: false };
}

// ── Row assembly ────────────────────────────────────────────────────

/**
 * Map the canonical Solana rows onto `proj_balances` rows. The three shaping
 * rules (native under `SOL_MINT`, zero skipped, wSOL folded into native) are
 * NOT re-implemented here: they live once in
 * `@tools/solana-ecosystem/balances/wallet-snapshot.js`, so this lane and the
 * agent tools can never disagree about what a wallet holds.
 */
function buildBalanceRows(walletAddress: string, read: SolanaWalletBalancesRead): BalanceRow[] {
  return projectSolanaBalanceRows(read).map((row) => toRow(walletAddress, row));
}

function toRow(walletAddress: string, row: SolanaBalanceRow): BalanceRow {
  return {
    walletFamily: SOLANA_WALLET_FAMILY,
    walletAddress,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    // Base58 case is IDENTITY: the DB predicate compares `token_address`
    // without `LOWER()`, so the mint is stored exactly as the chain spells it.
    tokenAddress: row.mint,
    tokenSymbol: row.symbol,
    tokenName: row.name,
    balanceRaw: row.amountRaw,
    balanceUsd: row.usdValue,
    priceUsd: row.priceUsd,
    decimals: row.decimals,
  };
}
