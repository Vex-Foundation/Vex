/**
 * Inventory wallet resolution — the GLOBAL configured wallet allow-list
 * (EVM + Solana), shared by the main-process history reads that aggregate
 * across "all of the user's wallets" rather than one session's scope.
 *
 * `listInventoryWalletEntries` is the one-entry-per-wallet view used for
 * membership and counting. `resolveInventoryWalletAddressLookupVariants` is
 * deliberately different: it builds the exact-string variants history tables
 * may contain, without changing the logical inventory or weakening Solana identity.
 */

import { listWallets, type WalletInventoryEntry } from "@vex-lib/wallet.js";

/** Every configured wallet entry (EVM then Solana), unfiltered. */
export function listInventoryWalletEntries(): readonly WalletInventoryEntry[] {
  return [...listWallets("evm"), ...listWallets("solana")];
}

/**
 * Indexed lookup variants across the whole configured inventory.
 *
 * A shape-valid EVM address contributes its stored form AND lowercase.
 * Producers in this repository legitimately use both: wallet inventory is checksummed,
 * while receipt/intent writers commonly canonicalize to lowercase. Binding
 * both exact values keeps `wallet_address = ANY(...)` indexable and makes a
 * new producer casing choice unable to hide the user's own history.
 *
 * Solana base58 remains exact and case-sensitive. An invalid EVM-shaped value
 * also remains exact (fail closed); it is never broadened by lowercasing.
 * Callers that need logical wallet counts or per-entry membership checks must
 * use `listInventoryWalletEntries` instead, because this function returns DB
 * lookup variants rather than one element per wallet.
 */
export function resolveInventoryWalletAddressLookupVariants(): readonly string[] {
  const addresses: string[] = [];
  for (const entry of listWallets("evm")) {
    addresses.push(entry.address);
    if (/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
      addresses.push(entry.address.toLowerCase());
    }
  }
  for (const entry of listWallets("solana")) {
    addresses.push(entry.address);
  }
  return [...new Set(addresses)];
}
