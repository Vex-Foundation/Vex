/**
 * What a page is called, and where it sits: the title bar's left cell names
 * the open page and, for a subpage, its crumb ("Portfolio / Agent Scan",
 * "Portfolio / All assets / USD Coin history"), each parent a link up to it
 * (docs/design/R3-MINIMAL.md sections 3 and 9.2). The page itself draws no
 * crumb and no close row: its content starts right under the title bar.
 *
 * Pure: a route in, words and parent routes out. The title bar renders them
 * (`RunningHead.tsx`); going up a parent goes through the page trail
 * (`page-trail.ts`), so the way back stays true.
 */

import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { truncateAddress } from "../../../lib/format.js";
import {
  assetsReturnToScope,
  assetsRouteFor,
  assetsRouteScope,
  type AssetsRouteScope,
  type ShellRoute,
  type ShellRouteToken,
} from "../../../stores/uiStore/shell-route.js";

/** One parent in a subpage's crumb: its words and the route it goes up to. */
export interface PageCrumb {
  readonly label: string;
  readonly route: ShellRoute;
}

/** Portfolio, the parent of every money subpage. */
export const PORTFOLIO_CRUMB: PageCrumb = {
  label: "Portfolio",
  route: { kind: "portfolio", origin: null },
};

/** The open page's name and its parents, outermost first (none for a top-level page). */
export interface PageTitle {
  readonly name: string;
  readonly parents: readonly PageCrumb[];
}

/** The All-assets register's name for its scope (a narrowed one never reads as everything). */
export function assetsPageName(scope: AssetsRouteScope): string {
  switch (scope.kind) {
    case "global":
      return "All assets";
    case "session":
      return "Session assets";
    case "project":
      return "Project assets";
  }
}

/**
 * A token's display name: the main-sanitized name, else the sanitized symbol,
 * else the truncated address. Never raw provider text.
 */
export function tokenDisplayName(token: ShellRouteToken): string {
  return token.tokenName ?? sanitizeTokenSymbol(token.symbol) ?? truncateAddress(token.tokenAddress);
}

/** The open page's title, or null with no page open. */
export function titleBarPageOf(route: ShellRoute): PageTitle | null {
  switch (route.kind) {
    case "none":
      return null;
    case "memory":
      return { name: "Memory", parents: [] };
    case "sessions":
      return { name: "Sessions", parents: [] };
    case "howItWorks":
      return { name: "How Vex works", parents: [] };
    case "portfolio":
      return { name: "Portfolio", parents: [] };
    case "board":
      return { name: "Board", parents: [] };
    case "needsYou":
      return { name: "Needs you", parents: [] };
    case "settings":
      return { name: "Settings", parents: [] };
    case "agentScan":
      return { name: "Agent Scan", parents: [PORTFOLIO_CRUMB] };
    case "assets":
      return { name: assetsPageName(assetsRouteScope(route)), parents: [PORTFOLIO_CRUMB] };
    case "tokenHistory": {
      const name = `${tokenDisplayName(route.token)} history`;
      if (route.returnTo.kind !== "assets") return { name, parents: [PORTFOLIO_CRUMB] };
      // Opened from a register: the crumb goes back to THAT scope, never the
      // global one (the same route a close returns to).
      const scope = assetsReturnToScope(route.returnTo);
      return {
        name,
        parents: [
          PORTFOLIO_CRUMB,
          { label: assetsPageName(scope), route: assetsRouteFor(scope, null) },
        ],
      };
    }
  }
}
