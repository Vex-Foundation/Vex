/**
 * The LIVE local-chain (non-Khalani) lane of `WalletBalances`: enumerate the
 * chain's scan set, read it over RPC, and shape the rows the handler collects.
 *
 * Extracted from `read.ts` when the Blockscout identity union landed, for the
 * same reason `token-trim.ts` was: this owns ONE question with its own reason
 * to change - how a local chain is read live - while the handler owns
 * assembling one answer out of every lane. The file-growth gate at 750 lines
 * is the signal that the two had accumulated in one place.
 *
 * The ENUMERATION is not decided here. `buildLocalChainInventory` performs the
 * pin and indexer reads and the pure `wallet-inventory/local-chain.ts` unions
 * them; this module consumes the resulting set and carries it back out so the
 * handler can report what the enumeration could and could not claim. RPC stays
 * authoritative for every number on a row: the indexer contributes identities
 * and labels, never a balance, a scale or a symbol.
 */

import { formatUnits } from "viem";

import { readLocalChainBalances } from "@tools/evm-chains/balances.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { buildLocalChainInventory } from "@vex-agent/sync/local-chain-balance-sync.js";
import type {
  LocalChainProviderFlags,
  LocalChainScanSet,
} from "@vex-agent/wallet-inventory/local-chain.js";
import { isTokenDecimals, projectBalanceRow } from "../../protocols/amount-display.js";
import type { ConciseKhalaniToken } from "../../protocols/khalani/projectors.js";
import { summarizeProtocolError } from "../../protocols/runtime/errors.js";
import { throwIfAborted } from "@utils/cancellation.js";
import logger from "@utils/logger.js";

/**
 * One token the chain scan could not answer for. Deliberately NOT a
 * `chainError`: the chain itself scanned, and its other tokens and totals are
 * still in the snapshot. Reported so "the read failed" can never be mistaken
 * for "you hold none of it" (the 2026-08-10 incident's core confusion).
 */
export interface TokenReadError {
  chainId: number;
  tokenAddress: string;
  reason: string;
}

export type LocalChainSnapshot = { scan: LocalChainScanSet | null } & (
  | { ok: true; tokens: ConciseKhalaniToken[]; totalUsd: number; tokenErrors: TokenReadError[] }
  | { ok: false; chainName?: string; message: string }
);

/**
 * Matches `DEFAULT_BALANCE_SCAN_CONCURRENCY` in the Khalani scan: the two sides
 * of one `WalletBalances` answer must not race each other into a provider's
 * rate limit.
 */
export const LOCAL_CHAIN_SCAN_CONCURRENCY = 4;

/**
 * Build one local-chain row with its human amount already derived.
 *
 * The conversion is the shared owner's (`projectBalanceRow`), not this file's:
 * the human amount an agent reads and the one the sync writes must come from
 * the same place, or a correction lands in only one of them.
 */
function localChainTokenRow(input: {
  symbol: string;
  name: string;
  address: string;
  chainId: number;
  decimals: number;
  balanceWei: bigint;
  priceUsd: number | null;
  /** Indexer labels for this identity, when it came from one. Never a filter. */
  providerFlags?: LocalChainProviderFlags | null;
}): ConciseKhalaniToken {
  const balanceRaw = input.balanceWei.toString();
  const priceUsd = input.priceUsd !== null ? String(input.priceUsd) : null;
  return {
    symbol: input.symbol,
    name: input.name,
    address: input.address,
    chainId: input.chainId,
    decimals: input.decimals,
    balanceRaw,
    priceUsd,
    ...projectBalanceRow(balanceRaw, input.decimals, priceUsd),
    ...(input.providerFlags ? { providerFlags: input.providerFlags } : {}),
  };
}

/**
 * The numeric contribution one row makes to a snapshot's `totalUsd`.
 *
 * The decimals guard is LOAD-BEARING, not defensive noise: `formatUnits` THROWS
 * on a non-integer scale, and this runs inside the per-chain try, so a single
 * token whose provider reported `Infinity` decimals used to take the whole
 * chain's snapshot down with it and report the wallet as holding nothing there.
 * An unconvertible row contributes 0 to the total and says why in its own
 * `unprojectableReason`; it never removes its neighbours.
 */
function heldUsd(balanceWei: bigint, decimals: number, priceUsd: number | null): number {
  if (priceUsd === null || !isTokenDecimals(decimals)) return 0;
  const human = Number(formatUnits(balanceWei, decimals));
  return Number.isFinite(human) ? human * priceUsd : 0;
}

/**
 * Live-read one local chain into the snapshot token shape. Scans the SAME
 * token set as the background sync (seed ∪ tracked). Failures collapse to a
 * bounded per-chain error - SECURITY: raw provider errors can carry the RPC
 * URL / HTML bodies and never reach the model output.
 */
export async function readLocalChainSnapshot(
  address: string,
  chainId: number,
  signal: AbortSignal | undefined,
): Promise<LocalChainSnapshot> {
  const config = getLocalChain(chainId);
  if (!config) return { ok: false, scan: null, message: "unknown local chain" };
  let scan: LocalChainScanSet | null = null;
  try {
    scan = await buildLocalChainInventory(config, address, { signal });
    const read = await readLocalChainBalances(config, address, scan.addresses);
    // Indexer labels ride to the row by identity. Lowercase key because that is
    // the one spelling every source agrees on.
    const flagsByLower = new Map(
      scan.entries
        .filter((entry) => entry.providerFlags !== null)
        .map((entry) => [entry.address.toLowerCase(), entry.providerFlags]),
    );

    const tokens: ConciseKhalaniToken[] = [];
    let totalUsd = 0;
    // Zero native balances are skipped (Khalani parity, same as the sync path).
    if (read.nativeWei > 0n) {
      tokens.push(
        localChainTokenRow({
          symbol: config.nativeCurrency.symbol,
          name: config.nativeCurrency.name,
          address: NATIVE_TOKEN_ADDRESS,
          chainId: config.id,
          decimals: config.nativeCurrency.decimals,
          balanceWei: read.nativeWei,
          priceUsd: read.nativePriceUsd,
        }),
      );
      totalUsd += heldUsd(read.nativeWei, config.nativeCurrency.decimals, read.nativePriceUsd);
    }
    for (const token of read.tokens) {
      tokens.push(
        localChainTokenRow({
          symbol: token.symbol,
          name: token.symbol,
          address: token.address,
          chainId: config.id,
          decimals: token.decimals,
          balanceWei: token.balanceWei,
          priceUsd: token.priceUsd,
          providerFlags: flagsByLower.get(token.address.toLowerCase()) ?? null,
        }),
      );
      totalUsd += heldUsd(token.balanceWei, token.decimals, token.priceUsd);
    }
    // The balance read itself takes no signal, so a Stop that lands entirely
    // inside it raises nothing. Checked here, at this lane's single publication
    // point, so a cancelled turn can never contribute rows to an answer: the
    // handler publishes a snapshot only from reads that were still wanted.
    throwIfAborted(signal);
    return {
      ok: true,
      scan,
      tokens,
      totalUsd,
      tokenErrors: read.tokenFailures.map((failure) => ({
        chainId: config.id,
        tokenAddress: failure.address,
        reason: failure.reason,
      })),
    };
  } catch (err) {
    // An operator Stop is the CALLER's outcome, never this chain's. It is
    // rethrown BEFORE the fail-soft mapping, because a cancelled read observed
    // nothing: folding it into a degraded chain result would let the caller
    // publish a successful-looking envelope, with this chain merely listed as
    // failed, out of a turn the user stopped (rule 05: cancelled is a distinct
    // state, not an ordinary failure). Same rule as the sibling Solana and
    // Khalani branches in `internal/wallet/read.ts`.
    throwIfAborted(signal);
    // Owner decree (2026-08-02): the REAL cause reaches the agent. This was a
    // bare `catch {}` - the error object was dropped on the floor, so a dead
    // RPC, a bad token in the scan set and a chain misconfiguration were all
    // reported to the model (and logged nowhere) as the same five words. The
    // provider's text is untrusted, so it is scrubbed + bounded by the
    // runtime's canonical summarizer, exactly as the sibling Khalani-scope
    // failure at `partitionBalanceChainScope` surfaces its own cause.
    const summary = summarizeProtocolError(err);
    logger.warn("wallet.local_chain_read.failed", {
      chainId,
      chainName: config.name,
      category: summary.category,
      error: summary.message,
    });
    return {
      ok: false,
      scan,
      chainName: config.name,
      message: `local chain RPC read failed: ${summary.message}`,
    };
  }
}
