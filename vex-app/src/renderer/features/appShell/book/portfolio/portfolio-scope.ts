/**
 * PortfolioCardScope - the vex-studio seam (#3): the Portfolio Overview /
 * Wallets / Balances cards take their wallet scope as an INPUT instead of
 * reading session state inside the card.
 *
 * ## Why the mapper replaced `scopeSessionId`
 *
 * The old adapter answered "which session id does this scope narrow to", and
 * every card fed that `string | null` to `usePortfolio`. That shape can only
 * express two of the three scopes: a project scope has NO session id, so it
 * collapsed to `null` - which is the GLOBAL inventory aggregate. A project card
 * would then have shown the user every wallet Vex knows about instead of the
 * project's own, and the cache key derived from the same `null` would have made
 * two different projects share one entry.
 *
 * A lossy adapter on a money-display path is not a placeholder to be widened in
 * a later stage; it is a wrong answer that compiles. So the scope maps directly
 * to the wire contract's own discriminated union and nothing in between can
 * lose a member: adding an arm to `portfolioReadInputSchema` without adding one
 * here is a compile error, not a silent global read.
 *
 * B0 defines the `project` member and the mapping. Routing a project scope into
 * the cards - which surfaces show it, and when - is stage B4.
 */

import type { PortfolioReadInput } from "@shared/schemas/portfolio.js";

export type PortfolioCardScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  /**
   * One Vex Studio project's own wallet selection (B0). `walletId` narrows to a
   * single selected family wallet; omitted, the read covers the project's whole
   * selection.
   */
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly walletId?: string;
    };

export const GLOBAL_PORTFOLIO_SCOPE: PortfolioCardScope = { kind: "global" };

/**
 * The scope, as the validated read input main actually receives.
 *
 * Total over the union by construction: the switch has no default, so a new
 * `PortfolioCardScope` member fails to compile here instead of falling through
 * to a global read.
 */
export function portfolioReadInputFor(
  scope: PortfolioCardScope,
): PortfolioReadInput {
  switch (scope.kind) {
    case "global":
      return { scope: "global" };
    case "session":
      return { scope: "session", sessionId: scope.sessionId };
    case "project":
      return scope.walletId === undefined
        ? { scope: "project", projectId: scope.projectId }
        : {
            scope: "project",
            projectId: scope.projectId,
            walletId: scope.walletId,
          };
  }
}
