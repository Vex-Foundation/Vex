import type { PositionTokenDto } from "@shared/schemas/portfolio.js";

/** True when the portfolio contains a held token excluded from its USD sum. */
export function hasUnpricedHoldings(
  tokens: readonly PositionTokenDto[],
): boolean {
  return tokens.some((token) => token.balanceUsd === null);
}
