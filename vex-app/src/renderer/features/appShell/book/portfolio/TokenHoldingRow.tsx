/**
 * The shared helpers of a token holdings list: the sort (largest USD first,
 * unpriced last), the hide-dust filter and the stable line key. The Portfolio
 * page's Balances section and the All assets page both draw their rows with
 * `BalancesTable`, which owns the row grammar and its trust rules (the
 * address-verified `TokenMark`, the main-sanitized name, a provider symbol only
 * after `sanitizeTokenSymbol`).
 */

import type { PositionTokenDto } from "@shared/schemas/portfolio.js";

/**
 * Largest-first by USD, unpriced (`balanceUsd: null`) rows last. Stable and
 * non-mutating. Main already orders the DTO this way; the callers sort
 * defensively so a reordered payload can never scramble a top-N cut.
 */
export function sortTokensByUsdDesc(
  tokens: readonly PositionTokenDto[],
): readonly PositionTokenDto[] {
  return [...tokens].sort((a, b) => {
    if (a.balanceUsd === null && b.balanceUsd === null) return 0;
    if (a.balanceUsd === null) return 1;
    if (b.balanceUsd === null) return -1;
    return b.balanceUsd - a.balanceUsd;
  });
}

/**
 * Smallest |USD| `formatUsd` renders as non-zero. Shared with PositionChains'
 * per-chain top-3 cut (that file imports this constant instead of declaring
 * its own copy) so the sub-cent threshold has exactly one source of truth.
 */
export const MIN_DISPLAY_USD = 0.005;

/**
 * Hide-dust filter for the tab's token lists (owner report: Solana spam
 * airdrops price at $0.00 and clutter Balances + All-assets). Hides a row
 * only when it HAS a price and that price is sub-cent (`|balanceUsd| <
 * MIN_DISPLAY_USD`) - UNPRICED rows (`balanceUsd === null`) always stay
 * visible, since "no price" is not the same claim as "zero value". A no-op
 * when `hideDust` is false. Non-mutating.
 */
export function filterDustTokens(
  tokens: readonly PositionTokenDto[],
  hideDust: boolean,
): readonly PositionTokenDto[] {
  if (!hideDust) return tokens;
  return tokens.filter(
    (token) =>
      token.balanceUsd === null ||
      Math.abs(token.balanceUsd) >= MIN_DISPLAY_USD,
  );
}

/**
 * Stable React key for one aggregated (chain, address, symbol) line - the
 * same composite `GlobalWalletSwitcher` keys the flat list on (the SQL
 * groups by exactly this triple, so no two rows share all three).
 */
export function tokenLineKey(token: PositionTokenDto): string {
  return `${token.chainId ?? "x"}:${token.tokenAddress ?? "x"}:${token.symbol ?? "x"}`;
}
