/**
 * Shared PRIVATE helpers for the Khalani balances modules.
 *
 * Extracted VERBATIM from the original `balances.ts` god-file so every consumer
 * reuses exactly ONE definition (no duplication). Nothing here is re-exported
 * from the public `../balances.js` barrel.
 *
 * - `tokenUsd` is used by both the scan path (token sort) and the aggregate path
 *   (totalUsd reduce).
 * - `chainNotInRegistryError` reproduces the IDENTICAL
 *   `VexError(KHALANI_UNSUPPORTED_CHAIN, …)` thrown by the selection parser and
 *   the scan target resolver when a requested chain id is absent from the
 *   current Khalani registry.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import type { KhalaniToken } from "../types.js";

export function chainNotInRegistryError(chainId: number): VexError {
  return new VexError(
    ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
    `Chain ${chainId} is not in the current Khalani registry.`,
    "The registry is fetched per run; if the chain was expected, retry this tool later. "
    + "Otherwise use a chain the registry covers.",
  );
}

export function tokenUsd(token: KhalaniToken): number {
  const balanceRaw = token.extensions?.balance;
  const priceUsd = token.extensions?.price?.usd;
  if (!balanceRaw || !priceUsd) return 0;

  try {
    const balanceHuman = Number(BigInt(balanceRaw)) / Math.pow(10, token.decimals);
    const price = Number(priceUsd);
    if (!Number.isFinite(balanceHuman) || !Number.isFinite(price)) return 0;
    return balanceHuman * price;
  } catch {
    return 0;
  }
}
