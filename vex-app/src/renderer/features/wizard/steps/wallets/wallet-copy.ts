/**
 * Shared per-chain display copy for the Wallets step family.
 *
 * `chainLabel` and `importHint` were previously duplicated verbatim in
 * `ChainActions.tsx` and `WalletInventoryPanel.tsx` - one source now,
 * so a future copy edit cannot drift the two import forms apart.
 */

import type { WalletChain } from "@shared/schemas/wallets.js";

export const chainLabel = (chain: WalletChain): string =>
  chain === "evm" ? "EVM" : "Solana";

export const importHint = (chain: WalletChain): string =>
  chain === "evm"
    ? "Paste a 0x-prefixed 64-character private key."
    : "Paste a base58 secret key OR a JSON byte array of 64 integers.";
