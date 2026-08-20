/**
 * PortfolioCardScope — the vex-studio seam (#3): the Portfolio Overview /
 * Wallets / Balances cards take their wallet scope as an INPUT instead of
 * reading session state inside the card. Today the members are "global"
 * (inventory aggregate) and "session"; a future project scope becomes one
 * more union member, never a card fork.
 */

export type PortfolioCardScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string };

export const GLOBAL_PORTFOLIO_SCOPE: PortfolioCardScope = { kind: "global" };

/** The session id a scope narrows to; `null` = the global aggregate. */
export function scopeSessionId(scope: PortfolioCardScope): string | null {
  return scope.kind === "session" ? scope.sessionId : null;
}
