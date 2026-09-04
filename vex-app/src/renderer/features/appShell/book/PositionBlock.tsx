/**
 * POSITION — the wallet portfolio card. Card-system grammar (`PortfolioCard`,
 * C3) since the book became one card stack: the display total from
 * `PortfolioOverviewCard`'s hero convention (Inter Tight 600 tabular), the snapshot/PnL line, and the
 * resolved wallet COUNT in the card's trailing slot.
 *
 * TRI-SCOPE, driven purely by its `scope` input (the studio seam, #3 - the
 * card never reads session state inside):
 *   - `global`   → the whole inventory, titled "Portfolio".
 *   - `session`  → that session's wallet-scope portfolio, titled "Position".
 *   - `project`  → that Vex Studio project's SELECTED wallets, also titled
 *                  "Position": to the user it is the same instrument, and the
 *                  headline of the rail already names the project.
 *
 * The renderer never supplies a wallet address; `usePortfolio` takes the
 * discriminated scope straight to the wire and main resolves the server-side
 * allow-list (`project_wallets` for the project arm). This component only
 * renders the resolved DTO, and no arm ever falls back to a wider scope - a
 * project card showing every wallet Vex knows about would be a wrong answer
 * about whose funds are on screen, not a degraded one.
 *
 * SESSION and PROJECT scope render the unified chain switcher
 * (`PositionChains` - one chip row over EVM quick chains + Solana, per-chain
 * top-3 for the selected chain); they differ only in WHERE the pair of wallet
 * families comes from (`useSessionWallets` vs the project's own selection).
 * GLOBAL delegates to `GlobalWalletSwitcher` (WP-L2), which owns the
 * wallet-identity presentation + the flat top-holdings list as the "All
 * wallets" default AND — with more than one wallet configured — a per-wallet
 * chip switcher that swaps in the SAME `PositionChains` presentation scoped to
 * one wallet.
 *
 * The hero Total above `GlobalWalletSwitcher` ALWAYS stays the full
 * cross-wallet aggregate — selecting one wallet in the switcher never changes
 * it; the wallet-scoped body shows that wallet's own total separately.
 *
 * Signal Tape language: one display figure, semantic up/down on the PnL,
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
import { useProject } from "../../../lib/api/projects.js";
import { formatUsd, formatUsdDelta } from "../../../lib/format.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import {
  portfolioReadInputFor,
  type PortfolioCardScope,
} from "./portfolio/portfolio-scope.js";
import { snapshotAge } from "./portfolio/snapshot-age.js";
import { GlobalWalletSwitcher } from "./GlobalWalletSwitcher.js";
import { PositionChains } from "./PositionChains.js";
import { PortfolioRefreshButton } from "./PortfolioRefreshButton.js";

export function PositionBlock({
  scope,
}: {
  /** Wallet scope this card reads - never session state read inside. */
  readonly scope: PortfolioCardScope;
}): JSX.Element {
  // Wave P — subscribe the portfolio queries to the terminalization push. This
  // card is mounted for the whole app shell, so one subscription here covers
  // every portfolio surface without a second listener per screen.
  useActivityResolvedInvalidation();
  // OD-7 — the pending half: an observation of a row that is STILL pending.
  // Without it the 5 s lane cadence reached this block only on the 60 s poll.
  useActivityProgressInvalidation();
  const scoped = scope.kind !== "global";
  const title = scoped ? "Position" : "Portfolio";

  const query = usePortfolio(portfolioReadInputFor(scope));
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
        <CardStateNote>{emptyScopeNote(scope)}</CardStateNote>
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
      {scope.kind === "session" ? (
        <SessionPositionBody portfolio={portfolio} sessionId={scope.sessionId} />
      ) : scope.kind === "project" ? (
        <ProjectPositionBody portfolio={portfolio} projectId={scope.projectId} />
      ) : (
        <PositionBody portfolio={portfolio} />
      )}
    </PortfolioCard>
  );
}

/**
 * What "this scope holds nothing" says, per scope. Each arm names the scope the
 * user is looking at, so an empty project rail never reads as an empty wallet.
 * Exhaustive over `PortfolioCardScope`: a new member fails to compile here.
 */
function emptyScopeNote(scope: PortfolioCardScope): string {
  switch (scope.kind) {
    case "global":
      return "No wallets configured.";
    case "session":
      return "No wallets in this session.";
    case "project":
      return "No wallets selected for this project.";
  }
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

/**
 * Project-scope body: the same hero total and the same chain switcher, with
 * the wallet families taken from the PROJECT'S OWN selection
 * (`ProjectDto.wallets`, the same read `WalletPairCard` uses) rather than from
 * a session. `key={projectId}` remounts the switcher per project so the
 * selected chain always resets to the default, exactly as a session switch
 * does on the agent rail.
 *
 * A failed or unknown project read leaves both families FALSE, which renders
 * no chip row at all rather than a row of chains this project may not hold.
 */
function ProjectPositionBody({
  portfolio,
  projectId,
}: {
  readonly portfolio: PortfolioDto;
  readonly projectId: string;
}): JSX.Element {
  const projectQuery = useProject(projectId);
  const result = projectQuery.data;
  const project = result !== undefined && result.ok ? result.data : null;
  return (
    <div className="flex flex-col gap-2.5">
      <TotalFigure portfolio={portfolio} />
      <PositionChains
        key={projectId}
        chains={portfolio.chains}
        hasEvmWallet={project?.wallets.evm != null}
        hasSolanaWallet={project?.wallets.solana != null}
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
 * PnL versus it underneath when the DTO carries them.
 *
 * `snapshotAt` IS RENDERED, as an AGE beside the snapshot value (owner
 * measurement 2026-09-04: a "+$0.41" in the gain tone against a 31-day-old
 * baseline, because publication had been withheld). The age is what tells
 * the reader whether the delta is this hour's or last month's, and past 24
 * hours the delta drops its gain/loss tone for the muted one - a PnL versus
 * a stale baseline is not a live gain (rule 08: never stale success as
 * fresh). The clock is read at render; a portfolio refresh re-renders it.
 */
function TotalFigure({
  portfolio,
}: {
  readonly portfolio: PortfolioDto;
}): JSX.Element {
  const { liveTotalUsd, snapshotTotalUsd, pnlVsPrev, snapshotAt } = portfolio;
  const age = snapshotAt === null ? null : snapshotAge(snapshotAt, Date.now());
  const stale = age !== null && age.stale;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10.5px] text-ink-tertiary">Total value</span>
        <PortfolioRefreshButton />
      </div>
      {/* Display figure: Inter Tight 600 tabular — the serif retired to the
        * gate voice (tokens v2 typography law). */}
      <span className="font-display text-[30px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink-primary">
        {formatUsd(liveTotalUsd)}
      </span>
      {snapshotTotalUsd !== null ? (
        <span
          data-vex-area="position-snapshot"
          data-stale={stale ? "true" : "false"}
          className="flex items-baseline gap-1.5 text-[11px] tabular-nums text-ink-tertiary"
        >
          <span>snapshot {formatUsd(snapshotTotalUsd)}</span>
          {age !== null ? (
            <span data-vex-area="position-snapshot-age">
              <span aria-hidden>| </span>
              {age.label}
            </span>
          ) : null}
          {pnlVsPrev !== null ? (
            <span
              className={stale ? "text-ink-tertiary" : pnlToneClass(pnlVsPrev)}
              aria-label={
                age === null
                  ? `Profit and loss versus previous snapshot ${formatUsdDelta(pnlVsPrev)}`
                  : `Profit and loss versus snapshot taken ${age.label} ${formatUsdDelta(pnlVsPrev)}`
              }
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
  if (pnl > 0) return "text-success";
  if (pnl < 0) return "text-warning-label";
  return "text-ink-tertiary";
}
