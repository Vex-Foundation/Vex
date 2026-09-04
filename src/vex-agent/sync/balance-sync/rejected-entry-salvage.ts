/**
 * Salvage policy for wallet-balance entries the Khalani boundary REFUSED.
 *
 * The boundary (`@tools/khalani/validation/chains-tokens.ts`) admits only
 * entries whose `decimals` are a whole number in [0, 36], and reports the rest
 * as {@link KhalaniRejectedTokenBalanceEntry} instead of failing the chain.
 * This module owns the one decision the SYNC path has to make about them: what
 * a rejection costs the durable rows.
 */

import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import type { ChainFamily, KhalaniRejectedTokenBalanceEntry } from "@tools/khalani/types.js";
import logger from "@utils/logger.js";

/**
 * Fold the boundary's rejected balance entries into the per-chain write plan.
 *
 * A rejection is an entry whose `decimals` alone failed the strict rule, so its
 * identity and (when the provider gave an exact integer) its atomic amount are
 * still true facts about the wallet. Two cases, and they cost different things:
 *
 * - EXACT `balanceRaw`: the holding is retained as a row with `decimals: null`
 *   and `balanceUsd: null`. The INVENTORY stays complete - the wallet still
 *   shows it holds this token, at this atomic amount - while the VALUATION for
 *   that row is honestly unknown. The bad scale is never stored and never
 *   guessed as 18 (frozen contract C1.2).
 * - NO exact `balanceRaw`: the size of a holding on that chain is unknown, so
 *   the chain's inventory cannot be reconstructed. Its chain id is returned as
 *   BLOCKED and the caller performs no `replaceBalancesForChain` for it: a
 *   destructive replace from an inventory known to be incomplete would delete
 *   last-good rows and refresh their timestamps into a lie (C3.5). Every other
 *   chain in the same scan is written normally.
 *
 * A VALID row already present for the same chain and address wins: the salvage
 * row is residue, never an overwrite of a fully parsed holding.
 *
 * @returns chain ids whose destructive replace must be skipped this cycle.
 */
export function salvageRejectedEntries(input: {
  family: ChainFamily;
  address: string;
  rejectedEntries: readonly KhalaniRejectedTokenBalanceEntry[];
  byChain: Map<number, BalanceRow[]>;
}): ReadonlySet<number> {
  const blockedChainIds = new Set<number>();
  if (input.rejectedEntries.length === 0) return blockedChainIds;

  for (const entry of input.rejectedEntries) {
    if (entry.balanceRaw === null) {
      blockedChainIds.add(entry.chainId);
      continue;
    }

    const rows = input.byChain.get(entry.chainId) ?? [];
    const alreadyValid = rows.some(
      (row) => row.tokenAddress.toLowerCase() === entry.address.toLowerCase(),
    );
    if (alreadyValid) continue;

    rows.push({
      walletFamily: input.family,
      walletAddress: input.address,
      chainId: entry.chainId,
      tokenAddress: entry.address,
      tokenSymbol: entry.symbol,
      tokenName: entry.name,
      balanceRaw: entry.balanceRaw,
      balanceUsd: null,
      priceUsd: null,
      decimals: null,
    });
    input.byChain.set(entry.chainId, rows);
  }

  for (const chainId of blockedChainIds) {
    const withheld = input.byChain.get(chainId)?.length ?? 0;
    input.byChain.delete(chainId);
    logger.warn("sync.balance.replace_blocked_by_rejected_entry", {
      chainId,
      reason: "rejected_entry_without_exact_balance",
      rowsWithheld: withheld,
      rejectedOnChain: input.rejectedEntries.filter((entry) => entry.chainId === chainId).length,
    });
  }

  const salvaged = input.rejectedEntries.filter(
    (entry) => entry.balanceRaw !== null && !blockedChainIds.has(entry.chainId),
  ).length;
  if (salvaged > 0) {
    logger.info("sync.balance.rejected_entries_salvaged", {
      salvaged,
      rejectedTotal: input.rejectedEntries.length,
      reason: "token_decimals_invalid",
    });
  }

  return blockedChainIds;
}
