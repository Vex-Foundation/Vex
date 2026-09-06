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
 * rules (native account lamports, a zero-capable native row, and a separate
 * wSOL token row) in `tools/solana-ecosystem/balances/wallet-snapshot.ts` -
 * shared with the agent tools, so a live read and this projection can never
 * disagree.
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
  SolanaRpcRateLimitedError,
  type SolanaBalanceRpc,
  type SolanaWalletBalancesRead,
} from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import {
  projectSolanaBalanceRows,
  type SolanaBalanceRow,
} from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import { solanaAssetIdentity } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
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

/**
 * Why a cycle wrote nothing.
 *
 *  - `rate_limited`: the RPC provider answered HTTP 429. A QUOTA fact about the
 *    endpoint, and deliberately not folded into `rpc_failed`: it is the one
 *    skip whose remedy is pacing rather than diagnosis, and the reader stopped
 *    at the FIRST 429 rather than spending its budget inside web3.js's own
 *    retry (see `createDeadlineBoundSolanaRpc`). Nothing retries it here.
 *  - `rpc_failed`: any other transport, deadline or response failure.
 *  - `read_incomplete`: the read succeeded but some token account would not
 *    project, so writing the survivors would DELETE real holdings.
 */
export type SolanaSyncSkipReason = "rate_limited" | "rpc_failed" | "read_incomplete";

export interface SolanaSyncResult {
  chainId: number;
  tokensUpdated: number;
  /** True when nothing was written and the last-good rows were kept. */
  skipped: boolean;
  /**
   * Why it was skipped, or null when the sync wrote.
   *
   * `skipped: true` alone said only "not this cycle", so a rate limit and a
   * dead endpoint reached the caller as the same fact. The reason travels with
   * the flag rather than only into a log line.
   */
  reason: SolanaSyncSkipReason | null;
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
    // A RATE LIMIT IS NOT A FAILURE OF THE ENDPOINT, and the caller is told so
    // rather than left to infer it from an error class name in a log.
    const reason: SolanaSyncSkipReason =
      err instanceof SolanaRpcRateLimitedError ? "rate_limited" : "rpc_failed";
    logger.warn("sync.solana_chain.failed", {
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      address: redactedAddress,
      reason,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true, reason };
  }

  if (read.accountFailures.length > 0) {
    logger.warn("sync.solana_chain.read_incomplete", {
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      address: redactedAddress,
      failedAccounts: read.accountFailures.length,
      scanned: read.stats.accountsScanned,
      reasons: [...new Set(read.accountFailures.map((failure) => failure.reason))],
    });
    return {
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      tokensUpdated: 0,
      skipped: true,
      reason: "read_incomplete",
    };
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
  return {
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    tokensUpdated: count,
    skipped: false,
    reason: null,
  };
}

// ── Row assembly ────────────────────────────────────────────────────

/**
 * Map the canonical Solana rows onto `proj_balances` rows. The shaping rules
 * (native account lamports, native zero row, and separate wSOL balance) are
 * NOT re-implemented here: they live once in
 * `@tools/solana-ecosystem/balances/wallet-snapshot.js`, so this lane and the
 * agent tools can never disagree about what a wallet holds.
 */
function buildBalanceRows(walletAddress: string, read: SolanaWalletBalancesRead): BalanceRow[] {
  return projectSolanaBalanceRows(read).map((row) => toRow(walletAddress, row));
}

function toRow(walletAddress: string, row: SolanaBalanceRow): BalanceRow {
  const identity = solanaAssetIdentity(
    row.isNative ? { kind: "native" } : { kind: "spl", mint: row.mint },
  );
  return {
    walletFamily: SOLANA_WALLET_FAMILY,
    walletAddress,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    // Native SOL needs an address-shaped storage key distinct from wSOL.
    // Asset kind, not this value, decides native identity. SPL mints retain
    // exact base58 case because the DB predicate has no LOWER().
    tokenAddress: identity.persistedAddress,
    tokenSymbol: row.symbol,
    tokenName: row.name,
    balanceRaw: row.amountRaw,
    balanceUsd: row.usdValue,
    priceUsd: row.priceUsd,
    decimals: row.decimals,
  };
}
