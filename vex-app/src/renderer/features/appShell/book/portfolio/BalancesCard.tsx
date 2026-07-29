/**
 * Balances — the top holdings across every configured wallet on the welcome
 * Portfolio tab: the five largest-USD lines from the global portfolio read
 * (unpriced lines sort last), in the shared `TokenHoldingRow` grammar
 * (address-verified marks, sanitized names, em-dash unpriced convention).
 *
 * The "View all assets" footer measures its OWN rect and opens the
 * All-assets ShellScreen morphing out of the exact row pressed — the same
 * expand-from-trigger pattern the profile-menu rows use for Memory/Sessions.
 *
 * Dust (sub-cent priced) rows are filtered out BEFORE the top-5 cut, per the
 * `hideDustBalances` uiStore preference — a dust row must never consume a
 * top-5 slot that a real holding would otherwise take. The card carries NO
 * control of its own; the All-assets screen owns the only checkbox, and this
 * card silently follows the same stored preference.
 */

import type { JSX, MouseEvent } from "react";
import {
  ArrowRight01Icon,
  VexIcon,
} from "../../../../components/icons/index.js";
import { usePortfolio } from "../../../../lib/api/portfolio.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { CardStateNote, PortfolioCard } from "./PortfolioCard.js";
import {
  filterDustTokens,
  sortTokensByUsdDesc,
  tokenLineKey,
  TokenHoldingRow,
} from "./TokenHoldingRow.js";

/** The card shows the top holdings only; the All-assets screen has the rest. */
const TOP_TOKENS = 5;

export function BalancesCard(): JSX.Element {
  const query = usePortfolio(null);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const hideDustBalances = useUiStore((s) => s.hideDustBalances);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;
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
          No balances yet — fund a wallet and your holdings appear here.
        </CardStateNote>
      ) : (
        <>
          <ul className="flex flex-col">
            {top.map((token) => (
              <TokenHoldingRow
                key={tokenLineKey(token)}
                token={token}
                historyReturnTo="shell"
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={openAllAssets}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]"
          >
            View all assets
            <VexIcon icon={ArrowRight01Icon} size={13} aria-hidden />
          </button>
        </>
      )}
    </PortfolioCard>
  );
}
