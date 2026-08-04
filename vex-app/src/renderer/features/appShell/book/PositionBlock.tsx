/**
 * POSITION — the wallet portfolio card. Card-system grammar (`PortfolioCard`,
 * C3) since the book became one card stack: the serif display total from
 * `PortfolioOverviewCard`'s hero convention, the snapshot/PnL line, and the
 * resolved wallet COUNT in the card's trailing slot.
 *
 * Dual-scope, driven purely by `activeSessionId`:
 *   - `null`     → GLOBAL inventory portfolio, titled "Portfolio".
 *   - non-null   → that session's wallet-scope portfolio, titled "Position".
 *
 * The renderer never supplies a wallet address; `usePortfolio` derives the
 * discriminated scope and main resolves the server-side allow-list. This
 * component only renders the resolved DTO.
 *
 * SESSION scope renders the unified chain switcher (`PositionChains` — one
 * chip row over EVM quick chains + Solana, per-chain top-3 for the selected
 * chain). GLOBAL delegates to `GlobalWalletSwitcher` (WP-L2), which owns the
 * wallet-identity presentation + the flat top-holdings list as the "All
 * wallets" default AND — with more than one wallet configured — a per-wallet
 * chip switcher that swaps in the SAME `PositionChains` presentation scoped to
 * one wallet.
 *
 * The hero Total above `GlobalWalletSwitcher` ALWAYS stays the full
 * cross-wallet aggregate — selecting one wallet in the switcher never changes
 * it; the wallet-scoped body shows that wallet's own total separately.
 *
 * Signal Tape language: serif display figure, semantic up/down on the PnL,
 * `tabular-nums` on every figure.
 */

import type { JSX } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import {
  usePortfolio,
  useActivityProgressInvalidation,
  useActivityResolvedInvalidation,
} from "../../../lib/api/portfolio.js";
import { useSessionWallets } from "../../../lib/api/session-wallets.js";
import { formatUsd, formatUsdDelta } from "../../../lib/format.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { GlobalWalletSwitcher } from "./GlobalWalletSwitcher.js";
import { PositionChains } from "./PositionChains.js";
import { PortfolioRefreshButton } from "./PortfolioRefreshButton.js";

export function PositionBlock({
  activeSessionId,
}: {
  readonly activeSessionId: string | null;
}): JSX.Element {
  // Wave P — subscribe the portfolio queries to the terminalization push. This
  // card is mounted for the whole app shell, so one subscription here covers
  // every portfolio surface without a second listener per screen.
  useActivityResolvedInvalidation();
  // OD-7 — the pending half: an observation of a row that is STILL pending.
  // Without it the 5 s lane cadence reached this block only on the 60 s poll.
  useActivityProgressInvalidation();
  const isSession = activeSessionId !== null;
  const title = isSession ? "Position" : "Portfolio";

  const query = usePortfolio(activeSessionId);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;

  if (query.isLoading) {
    return (
      <PortfolioCard eyebrow={title}>
        <CardStateNote tone="loading">Loading…</CardStateNote>
      </PortfolioCard>
    );
  }

  if ((result !== undefined && !result.ok) || query.isError) {
    return (
      <PortfolioCard eyebrow={title}>
        <CardStateNote tone="warn">
          Couldn&apos;t load your portfolio.
        </CardStateNote>
      </PortfolioCard>
    );
  }

  if (portfolio === null || portfolio.walletCount === 0) {
    return (
      <PortfolioCard eyebrow={title}>
        <CardStateNote>
          {isSession ? "No wallets in this session." : "No wallets configured."}
        </CardStateNote>
      </PortfolioCard>
    );
  }

  return (
    <PortfolioCard
      eyebrow={title}
      trailing={`${portfolio.walletCount} ${
        portfolio.walletCount === 1 ? "wallet" : "wallets"
      }`}
    >
      {isSession && activeSessionId !== null ? (
        <SessionPositionBody
          portfolio={portfolio}
          sessionId={activeSessionId}
        />
      ) : (
        <PositionBody portfolio={portfolio} />
      )}
    </PortfolioCard>
  );
}

/**
 * Session-scope body: the hero total, then the unified chain switcher.
 * `key={sessionId}` remounts the switcher per session so the selected chain
 * always resets to the default.
 */
function SessionPositionBody({
  portfolio,
  sessionId,
}: {
  readonly portfolio: PortfolioDto;
  readonly sessionId: string;
}): JSX.Element {
  const walletsQuery = useSessionWallets(sessionId);
  const scope = walletsQuery.data?.ok ? walletsQuery.data.data : null;
  return (
    <div className="flex flex-col gap-2.5">
      <TotalFigure portfolio={portfolio} />
      <PositionChains
        key={sessionId}
        chains={portfolio.chains}
        hasEvmWallet={scope?.evm != null}
        hasSolanaWallet={scope?.solana != null}
      />
    </div>
  );
}

function PositionBody({
  portfolio,
}: {
  readonly portfolio: PortfolioDto;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <TotalFigure portfolio={portfolio} />
      <GlobalWalletSwitcher portfolio={portfolio} />
    </div>
  );
}

/**
 * The card's ONE display figure: the live total in the serif hero treatment
 * (`PortfolioOverviewCard` grammar, 34px), with the snapshot total and the
 * PnL versus it underneath when the DTO carries them. `snapshotAt` stays
 * UNRENDERED — a second timestamp beside "vs last snapshot" adds a figure the
 * user cannot act on and did not ask for; it has not earned a line.
 */
function TotalFigure({
  portfolio,
}: {
  readonly portfolio: PortfolioDto;
}): JSX.Element {
  const { liveTotalUsd, snapshotTotalUsd, pnlVsPrev } = portfolio;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10.5px] text-[var(--vex-text-3)]">Total value</span>
        <PortfolioRefreshButton />
      </div>
      {/* Serif is rationed to this ONE display figure (typography law, C2). */}
      <span className="font-serif text-[34px] leading-none tracking-[-0.01em] tabular-nums text-foreground">
        {formatUsd(liveTotalUsd)}
      </span>
      {snapshotTotalUsd !== null ? (
        <span className="flex items-baseline gap-1.5 text-[11px] tabular-nums text-[var(--vex-text-3)]">
          <span>snapshot {formatUsd(snapshotTotalUsd)}</span>
          {pnlVsPrev !== null ? (
            <span
              className={pnlToneClass(pnlVsPrev)}
              aria-label={`Profit and loss versus previous snapshot ${formatUsdDelta(pnlVsPrev)}`}
            >
              {formatUsdDelta(pnlVsPrev)}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** Up = success, down = warn, flat/zero = muted. No glow, token colours only. */
function pnlToneClass(pnl: number): string {
  if (pnl > 0) return "text-[var(--color-success)]";
  if (pnl < 0) return "text-[var(--vex-warn-text)]";
  return "text-[var(--vex-text-3)]";
}
