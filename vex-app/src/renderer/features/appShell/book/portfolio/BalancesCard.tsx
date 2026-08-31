/**
 * Balances - the top holdings of a portfolio read, in the shared
 * `TokenHoldingRow` grammar (address-verified marks, sanitized names, em-dash
 * unpriced convention). ONE card serves both stages, driven by its
 * `PortfolioCardScope` input (studio seam #3):
 *
 *  - global scope - the welcome Portfolio tab: the five largest-USD
 *    lines across every configured wallet.
 *  - session scope - the session rail: the five largest-USD lines of
 *    THAT session's wallet scope, flat across chains (the session DTO's
 *    `portfolio.tokens[]`; a `chainId: null` row is a real aggregate line and
 *    renders without a chain suffix, it is never dropped).
 *  - project scope (B4c) - the Studio rail: the same top-5, read through the
 *    `project` arm so the figures cover the project's own selected wallets.
 *
 * The "View all" footer measures its OWN rect and opens the All-assets
 * ShellScreen morphing out of the exact row pressed - carrying the SAME scope
 * this card is showing, so the full register can never be wider than the card
 * that led to it. The All-assets ROUTE still carries a `string | null` session
 * id and cannot express a project, so under a project scope the footer is not
 * rendered at all: `sessionId: null` on that route means the GLOBAL aggregate,
 * and offering a door that silently widens a project's money view to every
 * wallet Vex knows about is worse than not offering the door.
 *
 * Dust (sub-cent priced) rows are filtered out BEFORE the top-5 cut, per the
 * `hideDustBalances` uiStore preference - a dust row must never consume a
 * top-5 slot that a real holding would otherwise take. The card carries NO
 * control of its own; the All-assets screen owns the only checkbox, and this
 * card silently follows the same stored preference.
 */

import type { JSX, MouseEvent } from "react";
import {
  IconChevronRight,
} from "../../../../components/icons/index.js";
import { usePortfolio } from "../../../../lib/api/portfolio.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { CardStateNote, PortfolioCard } from "./PortfolioCard.js";
import {
  portfolioReadInputFor,
  type PortfolioCardScope,
} from "./portfolio-scope.js";
import {
  filterDustTokens,
  sortTokensByUsdDesc,
  tokenLineKey,
  TokenHoldingRow,
} from "./TokenHoldingRow.js";

/** The card shows the top holdings only; the All-assets screen has the rest. */
const TOP_TOKENS = 5;

export function BalancesCard({
  scope,
}: {
  /** Wallet scope this card reads (studio seam #3) - never session state read inside. */
  readonly scope: PortfolioCardScope;
}): JSX.Element {
  const query = usePortfolio(portfolioReadInputFor(scope));
  // The All-assets SHELL ROUTE still carries a `string | null` session id.
  // Derived here, locally and visibly, rather than through a shared adapter:
  // a project scope has no session id, and the one thing that must not happen
  // is a general helper quietly turning one into the global aggregate for
  // every caller. See the module doc for why a project scope hides the door
  // instead of walking through it.
  const routeSessionId = scope.kind === "session" ? scope.sessionId : null;
  const canOpenAllAssets = scope.kind !== "project";
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const hideDustBalances = useUiStore((s) => s.hideDustBalances);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;
  // Dust filter runs BEFORE the cut - see the module doc.
  const top =
    portfolio !== null
      ? filterDustTokens(
          sortTokensByUsdDesc(portfolio.tokens),
          hideDustBalances,
        ).slice(0, TOP_TOKENS)
      : [];

  const openAllAssets = (event: MouseEvent<HTMLButtonElement>): void => {
    // The footer row's own viewport rect anchors the screen's expand morph.
    const rect = event.currentTarget.getBoundingClientRect();
    setShellRoute({
      kind: "assets",
      origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      sessionId: routeSessionId,
    });
  };

  return (
    <PortfolioCard eyebrow="Balances">
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">
          Couldn&apos;t load your balances.
        </CardStateNote>
      ) : top.length === 0 ? (
        <CardStateNote>
          {scope.kind === "project"
            ? "No balances in this project's wallets yet - fund them and your holdings appear here."
            : routeSessionId === null
              ? "No balances yet - fund a wallet and your holdings appear here."
              : "No balances in this session's wallets yet - fund them and your holdings appear here."}
        </CardStateNote>
      ) : (
        <>
          <ul className="flex flex-col">
            {top.map((token) => (
              <TokenHoldingRow
                key={tokenLineKey(token)}
                token={token}
                historyReturnTo={{ kind: "shell" }}
              />
            ))}
          </ul>
          {canOpenAllAssets ? (
          <button
            type="button"
            onClick={openAllAssets}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary"
          >
            View all assets
            <IconChevronRight size={13} />
          </button>
          ) : null}
        </>
      )}
    </PortfolioCard>
  );
}
