/**
 * Address reconciliation for `dexscreener.tokens` (batch pricing).
 *
 * THE DEFECT THIS CLOSES — provider-side silent truncation
 *
 * Measured 2026-07-27 against `/tokens/v1/ethereum/…`: 40 distinct addresses
 * requested, **30 rows returned, 10 addresses simply absent**, HTTP 200, no
 * error, no indication which ones resolved. The tool is described as
 * "batch-price up to 30 token addresses … use for portfolio pricing", so a
 * 40-holding portfolio was priced 30-deep and reported as complete.
 *
 * Vex cannot widen the provider's cap. It can refuse to pass silent truncation
 * on as a complete answer, which is what this echo does.
 *
 * MATCHING SIDE — deliberately strict
 *
 * A requested token is counted resolved only when it is the BASE token of a
 * returned row. Measured 30/30 rows carry the requested token as base. Matching
 * the quote side too would let token A's pool mark token B as "resolved" merely
 * because B was A's quote asset — reporting a token as priced when the provider
 * returned no row for it, which is the exact failure this module exists to
 * expose. Comparison is case-insensitive because EVM addresses arrive in mixed
 * checksum casing; the ECHO preserves the caller's casing, because Solana base58
 * addresses are case-SENSITIVE and lowercasing one would corrupt it.
 */

import type { DexPair } from "@tools/dexscreener/types.js";

import { PROVIDER_PAIR_CAP } from "./pair-list/index.js";

export interface TokenBatchAddressEcho {
  requestedAddresses: string[];
  resolvedAddresses: string[];
  /** Requested and NOT returned by the provider. Non-empty means truncation. */
  unresolvedAddresses: string[];
  /** `true` when more addresses were requested than DexScreener will answer. */
  addressCapApplied: boolean;
}

/** Split the comma-separated param exactly as it will be sent upstream. */
export function splitRequestedAddresses(tokenAddresses: string): string[] {
  return tokenAddresses
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function reconcileTokenBatchAddresses(
  tokenAddresses: string,
  providerPairs: readonly DexPair[],
): TokenBatchAddressEcho {
  const requestedAddresses = splitRequestedAddresses(tokenAddresses);
  const returnedBaseAddresses = new Set<string>();
  for (const pair of providerPairs) {
    const address = pair.baseToken?.address;
    if (typeof address === "string" && address !== "") {
      returnedBaseAddresses.add(address.toLowerCase());
    }
  }

  const resolvedAddresses: string[] = [];
  const unresolvedAddresses: string[] = [];
  for (const requested of requestedAddresses) {
    if (returnedBaseAddresses.has(requested.toLowerCase())) resolvedAddresses.push(requested);
    else unresolvedAddresses.push(requested);
  }

  return {
    requestedAddresses,
    resolvedAddresses,
    unresolvedAddresses,
    addressCapApplied: requestedAddresses.length > PROVIDER_PAIR_CAP,
  };
}
