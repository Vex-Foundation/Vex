/**
 * Public type surface for the Khalani balances modules.
 *
 * Moved VERBATIM from the original `balances.ts` god-file. Re-exported through
 * the `../balances.js` barrel so external importers keep the identical types.
 */

import type {
  ChainFamily,
  KhalaniRejectedTokenBalanceEntry,
  KhalaniToken,
} from "../types.js";

export interface BalanceChainError {
  chainId: number;
  chainName?: string;
  message: string;
}

export interface BalanceChainSelection {
  rawProvided: boolean;
  byFamily: ReadonlyMap<ChainFamily, readonly number[]>;
}

export interface TokenBalanceScanResult {
  address: string;
  family: ChainFamily;
  tokens: KhalaniToken[];
  scannedChainIds: number[];
  chainErrors: BalanceChainError[];
  totalUsd: number;
  /**
   * Entries the Khalani balances boundary refused for their `decimals` alone,
   * carried through with per-chain attribution (`entry.chainId`) so nothing the
   * provider reported is silently dropped.
   *
   * ALWAYS populated by {@link getTokenBalancesAcrossChains} - the field is
   * optional only so a caller may still write an empty placeholder scan result
   * without listing it. Read it as `rejectedEntries ?? []`.
   */
  rejectedEntries?: KhalaniRejectedTokenBalanceEntry[];
}
