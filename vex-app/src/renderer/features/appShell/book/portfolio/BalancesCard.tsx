/**
 * BALANCES on the Portfolio page (docs/design/R3-MINIMAL.md section 9.1): the
 * top holdings of the page scope's read as a table of Asset, Network,
 * Quantity, Price and Value, figures in mono and right aligned, with "View all
 * assets" at the right of the head.
 *
 *  - whole inventory: the five largest-USD lines across every wallet;
 *  - one wallet: the same, from that wallet's validated read;
 *  - this chat, this project: the five largest-USD lines of that scope's own
 *    wallets (a `chainId: null` row is a real aggregate line and keeps its
 *    place without a network, it is never dropped).
 *
 * The table and its row grammar are `BalancesTable` (shared with the All
 * assets page): the trust rules, "Not available" instead of $0.00, and the
 * Value column that never clips.
 *
 * Dust (sub-cent priced) rows are filtered out BEFORE the top-5 cut, per the
 * `hideDustBalances` preference, so a dust row never takes a real holding's
 * slot; a scope holding only dust says "No priced balances." and still offers
 * the full register. The token history opens from a row's menu, only for a row
 * with an exact `(chainId, tokenAddress)` identity.
 *
 * "View all assets" opens the All assets page carrying the SAME scope, so the
 * register is never wider than the table that led to it; a single wallet has
 * no register of its own, so under that scope the link is not offered.
 */

import type { JSX } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  RETURN_TO_SHELL,
  assetsRouteFor,
  type AssetsRouteScope,
} from "../../../../stores/uiStore/shell-route.js";
import {
  CardStateNote,
  PortfolioCard,
  SectionLink,
  originOf,
} from "./PortfolioCard.js";
import { BalancesTable } from "./BalancesTable.js";
import {
  usePageScopePortfolio,
  type PortfolioPageScope,
} from "./portfolio-page-scope.js";
import { filterDustTokens, sortTokensByUsdDesc } from "./TokenHoldingRow.js";

/** The table shows the top holdings only; the All assets page has the rest. */
const TOP_TOKENS = 5;

export function BalancesCard({
  scope,
}: {
  /** The page scope - never session or project state read inside. */
  readonly scope: PortfolioPageScope;
}): JSX.Element {
  const query = usePageScopePortfolio(scope);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const hideDustBalances = useUiStore((s) => s.hideDustBalances);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;
  // Dust filter runs BEFORE the cut - see the module doc.
  const top =
    portfolio !== null
      ? filterDustTokens(sortTokensByUsdDesc(portfolio.tokens), hideDustBalances).slice(
          0,
          TOP_TOKENS,
        )
      : [];
  const register = assetsScopeOf(scope);
  // Holdings exist but every one is sub-cent dust the preference hides: say
  // so, and keep the door to the full register, where the dust toggle lives.
  const onlyDust = portfolio !== null && portfolio.tokens.length > 0 && top.length === 0;

  return (
    <PortfolioCard
      title="Balances"
      action={
        register !== null && (top.length > 0 || onlyDust) ? (
          <SectionLink
            onClick={(event) => setShellRoute(assetsRouteFor(register, originOf(event)))}
          >
            View all assets
          </SectionLink>
        ) : null
      }
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t load your balances.</CardStateNote>
      ) : onlyDust ? (
        <CardStateNote>No priced balances.</CardStateNote>
      ) : top.length === 0 ? (
        <CardStateNote>{emptyNote(scope)}</CardStateNote>
      ) : (
        <BalancesTable tokens={top} historyReturnTo={RETURN_TO_SHELL} />
      )}
    </PortfolioCard>
  );
}

/** What an empty scope says. Exhaustive over the page scope. */
function emptyNote(scope: PortfolioPageScope): string {
  switch (scope.kind) {
    case "global":
      return "No balances yet - fund a wallet and your holdings appear here.";
    case "wallet":
      return "No balances in this wallet yet.";
    case "session":
      return "No balances in this session's wallets yet - fund them and your holdings appear here.";
    case "project":
      return "No balances in this project's wallets yet - fund them and your holdings appear here.";
  }
}

/**
 * The register a scope's "View all assets" opens, or null for a single
 * wallet (the register has no wallet narrowing, and a wider one would not be
 * the same answer).
 */
function assetsScopeOf(scope: PortfolioPageScope): AssetsRouteScope | null {
  switch (scope.kind) {
    case "global":
      return { kind: "global" };
    case "wallet":
      return null;
    case "session":
      return { kind: "session", sessionId: scope.sessionId };
    case "project":
      return { kind: "project", projectId: scope.projectId };
  }
}
