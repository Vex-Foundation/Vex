/**
 * Portfolio Overview — the welcome tab's hero card: the Total Value figure
 * (the tab's ONE display number, Inter Tight 600 tabular), the snapshot
 * delta in the existing solid
 * direction-color convention (no shimmer, no washing), and the wallet-scope
 * chips: "All wallets" + one chip per configured wallet, family primaries
 * wearing the Primary badge.
 *
 * Selecting a wallet chip narrows the numbers through the SAME validated
 * `portfolio.read` wallet filter the session rail's switcher uses
 * (`useWalletPortfolio` — main authorizes the address against the
 * configured inventory server-side, never trusting the renderer);
 * "All wallets" restores the global aggregate. The chip row appears only
 * with more than one configured wallet (the established switcher rule — a
 * single wallet's aggregate already IS that wallet). No sparkline/chart:
 * deferred until a real history feed exists — never a fake curve.
 */

import { useState, type JSX } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import {
  usePortfolio,
  useWalletPortfolio,
} from "../../../../lib/api/portfolio.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { formatUsd, formatUsdDelta } from "../../../../lib/format.js";
import { cn } from "../../../../lib/utils.js";
import { ChainIcon } from "../../../../components/common/ChainIcon.js";
import { CardStateNote, PortfolioCard } from "./PortfolioCard.js";
import { PrimaryBadge } from "./WalletsCard.js";
import {
  flattenPortfolioWallets,
  type PortfolioWallet,
} from "./wallet-scope.js";
import {
  portfolioReadInputFor,
  type PortfolioCardScope,
} from "./portfolio-scope.js";

export function PortfolioOverviewCard({
  scope,
}: {
  /** Wallet scope this card reads (studio seam #3) — never session state read inside. */
  readonly scope: PortfolioCardScope;
}): JSX.Element {
  const globalQuery = usePortfolio(portfolioReadInputFor(scope));
  const walletsQuery = useAvailableWallets();
  const inventory = walletsQuery.data?.ok ? walletsQuery.data.data : null;
  const wallets = inventory !== null ? flattenPortfolioWallets(inventory) : [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A wallet that dropped out of the inventory between renders falls back to
  // "All wallets" instead of rendering a dead selection (switcher precedent).
  const selected =
    selectedId === null
      ? null
      : (wallets.find((entry) => entry.wallet.id === selectedId) ?? null);
  // Unconditional hook call (stable order); `null` disables the wallet read
  // while "All wallets" is active.
  const walletQuery = useWalletPortfolio(selected?.wallet.address ?? null);

  const activeQuery = selected === null ? globalQuery : walletQuery;
  const activeResult = activeQuery.data;
  const activePortfolio = activeResult?.ok ? activeResult.data : null;

  const globalResult = globalQuery.data;
  const globalPortfolio = globalResult?.ok ? globalResult.data : null;
  const trailing =
    globalPortfolio !== null && globalPortfolio.walletCount > 0
      ? `${globalPortfolio.walletCount} ${
          globalPortfolio.walletCount === 1 ? "wallet" : "wallets"
        }`
      : undefined;

  return (
    <PortfolioCard eyebrow="Portfolio Overview" trailing={trailing}>
      {globalQuery.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (globalResult !== undefined && !globalResult.ok) ||
        globalQuery.isError ? (
        <CardStateNote tone="warn">
          Couldn&apos;t load your portfolio.
        </CardStateNote>
      ) : globalPortfolio === null || globalPortfolio.walletCount === 0 ? (
        <CardStateNote>
          No wallets configured yet - add your first below and your total
          appears here.
        </CardStateNote>
      ) : (
        <div className="flex flex-col gap-2.5">
          <TotalFigure portfolio={activePortfolio} />
          {wallets.length > 1 ? (
            <ScopeChipRow
              wallets={wallets}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}
        </div>
      )}
    </PortfolioCard>
  );
}

/**
 * The scoped total + snapshot delta. `portfolio` is the ACTIVE read (global
 * aggregate, or one wallet after a chip selection); while a wallet-scoped
 * read resolves the figure holds the em dash — never a stale or fabricated
 * number.
 */
function TotalFigure({
  portfolio,
}: {
  readonly portfolio: PortfolioDto | null;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="vex-micro-label uppercase text-ink-secondary">
        Total value
      </span>
      {/* Display figure: Inter Tight 600 tabular — the serif retired to the
        * gate voice (tokens v2 typography law). */}
      <span className="font-display text-[30px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink-primary">
        {formatUsd(portfolio?.liveTotalUsd ?? null)}
      </span>
      {portfolio !== null &&
      portfolio.snapshotTotalUsd !== null &&
      portfolio.pnlVsPrev !== null ? (
        <span className="flex items-baseline gap-1.5 text-[11px] tabular-nums">
          <span className={deltaToneClass(portfolio.pnlVsPrev)}>
            {formatUsdDelta(portfolio.pnlVsPrev)}
          </span>
          <span className="text-ink-tertiary">vs last snapshot</span>
        </span>
      ) : null}
    </div>
  );
}

/** Solid direction colors, same convention as the rail's PnL readout
 * (`PositionBlock.pnlToneClass`): up = success, down = warn, flat = muted. */
function deltaToneClass(pnl: number): string {
  if (pnl > 0) return "text-success";
  if (pnl < 0) return "text-warning-label";
  return "text-ink-tertiary";
}

function ScopeChipRow({
  wallets,
  selectedId,
  onSelect,
}: {
  readonly wallets: readonly PortfolioWallet[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Portfolio scope"
      className="flex flex-wrap items-center gap-1"
    >
      <ScopeChip
        label="All wallets"
        pressed={selectedId === null}
        onClick={() => onSelect(null)}
      />
      {wallets.map((entry) => (
        <ScopeChip
          key={entry.wallet.id}
          label={entry.displayLabel}
          title={entry.wallet.label.length > 0 ? entry.wallet.address : undefined}
          chainId={entry.chainId}
          primary={entry.showPrimaryBadge}
          pressed={entry.wallet.id === selectedId}
          onClick={() => onSelect(entry.wallet.id)}
        />
      ))}
    </div>
  );
}

function ScopeChip({
  label,
  title,
  chainId,
  primary = false,
  pressed,
  onClick,
}: {
  readonly label: string;
  readonly title?: string;
  readonly chainId?: number;
  readonly primary?: boolean;
  readonly pressed: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 max-w-[150px] items-center gap-1.5 rounded-full border px-2 text-[10.5px] transition-colors",
        pressed
          ? "border-accent-primary text-ink-primary"
          : "border-line-2 text-ink-tertiary hover:border-line-3 hover:text-ink-secondary",
      )}
    >
      {chainId !== undefined ? <ChainIcon chainId={chainId} size={11} /> : null}
      <span className="truncate">{label}</span>
      {primary ? <PrimaryBadge /> : null}
    </button>
  );
}
