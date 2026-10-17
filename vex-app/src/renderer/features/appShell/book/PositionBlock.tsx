/**
 * THE PORTFOLIO PAGE'S TOTAL (docs/design/R3-MINIMAL.md section 9.1): the top
 * of the page. At the left, what the total includes (13 muted), the total in
 * the money headline (mono 34 / 500), the snapshot it compares with and when
 * the figures were loaded (13); at the right, the refresh key and the scope
 * chips the page hands in.
 *
 * SCOPE IS THE ONLY INPUT (`PortfolioPageScope`): the whole inventory, one
 * inventory wallet, the open chat's wallets or the selected project's. The
 * renderer never supplies a wallet address of its own choosing; every read
 * goes to main as the validated scope (or the inventory address main
 * re-authorizes), and no scope ever falls back to a wider one.
 *
 * THE SNAPSHOT LINE SAYS WHAT THE DTO SAYS. `snapshotTotalUsd` is the latest
 * complete snapshot and `pnlVsPrev` is that snapshot against the one before
 * it, so the line names it that way; it is never a live gain computed against
 * the live total (which counts settled balances only, while a snapshot also
 * counts money in transit). The snapshot's AGE is printed beside it (owner
 * measurement 2026-09-04: a delta against a 31-day-old baseline looked like
 * this hour's), and past 24 hours the delta drops to the muted ink. The
 * change is ink, never a trading colour (section 1.2).
 *
 * FRESHNESS: "loaded {time}" is the query's own fetch time, true for the app
 * and not a claim about when the chain was read (the DTO carries no read
 * time). Chain read problems are printed under the total (`ChainReadWarning`).
 *
 * This component also subscribes the portfolio queries to the activity
 * terminalization and progress pushes, so the page's figures follow a pending
 * transaction without waiting for the periodic poll.
 */

import type { JSX, ReactNode } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import {
  useActivityProgressInvalidation,
  useActivityResolvedInvalidation,
} from "../../../lib/api/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ChainReadWarning } from "./portfolio/ChainReadWarning.js";
import { CardStateNote, SectionLink, originOf } from "./portfolio/PortfolioCard.js";
import {
  totalIncludesLine,
  usePageScopePortfolio,
  type PortfolioPageScope,
} from "./portfolio/portfolio-page-scope.js";
import {
  NOT_AVAILABLE,
  clockFromMs,
  usdDeltaFigure,
  usdFigure,
} from "./portfolio/portfolio-format.js";
import { snapshotAge } from "./portfolio/snapshot-age.js";
import { PortfolioRefreshButton } from "./PortfolioRefreshButton.js";

export function PositionBlock({
  scope,
  chips,
}: {
  /** The page's scope - never session or project state read inside. */
  readonly scope: PortfolioPageScope;
  /** The scope chips, owned by the page (their selection is the page's). */
  readonly chips: ReactNode;
}): JSX.Element {
  useActivityResolvedInvalidation();
  useActivityProgressInvalidation();
  const query = usePageScopePortfolio(scope);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;

  let main: JSX.Element;
  if (query.isLoading) {
    main = <CardStateNote tone="loading">Loading your portfolio…</CardStateNote>;
  } else if ((result !== undefined && !result.ok) || query.isError) {
    main = <CardStateNote tone="warn">Couldn&apos;t load your portfolio.</CardStateNote>;
  } else if (portfolio === null || portfolio.walletCount === 0) {
    main = <EmptyScope scope={scope} />;
  } else {
    main = (
      <TotalFigure
        scope={scope}
        portfolio={portfolio}
        loadedAt={query.dataUpdatedAt}
      />
    );
  }

  return (
    <header className="vex-pf-top" data-vex-area="portfolio-total">
      <div className="vex-pf-top__main">{main}</div>
      <div className="vex-pf-top__side">
        <PortfolioRefreshButton />
        {chips}
      </div>
    </header>
  );
}

/**
 * What "this scope holds nothing" says, per scope, and for the whole
 * inventory the way to add a wallet. Exhaustive over the page scope.
 */
function EmptyScope({ scope }: { readonly scope: PortfolioPageScope }): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  switch (scope.kind) {
    case "global":
    case "wallet":
      return (
        <div className="vex-pf-top__empty">
          <CardStateNote>
            No wallets configured yet. Add your first and your total appears here.
          </CardStateNote>
          <SectionLink
            onClick={(event) =>
              setShellRoute({ kind: "settings", origin: originOf(event), section: "wallets" })
            }
          >
            Add wallet
          </SectionLink>
        </div>
      );
    case "session":
      return <CardStateNote>No wallets in this session.</CardStateNote>;
    case "project":
      return <CardStateNote>No wallets selected for this project.</CardStateNote>;
  }
}

function TotalFigure({
  scope,
  portfolio,
  loadedAt,
}: {
  readonly scope: PortfolioPageScope;
  readonly portfolio: PortfolioDto;
  readonly loadedAt: number;
}): JSX.Element {
  const { liveTotalUsd, snapshotTotalUsd, pnlVsPrev, snapshotAt } = portfolio;
  const age = snapshotAt === null ? null : snapshotAge(snapshotAt, Date.now());
  const stale = age !== null && age.stale;
  const delta = usdDeltaFigure(pnlVsPrev);
  const loaded = clockFromMs(loadedAt);
  return (
    <>
      <p className="vex-pf-top__line">
        {totalIncludesLine(scope, portfolio.walletCount)}
      </p>
      <p className="vex-pf-top__big vex-num">{usdFigure(liveTotalUsd) ?? NOT_AVAILABLE}</p>
      {snapshotTotalUsd !== null || loaded !== null ? (
        <p className="vex-pf-top__sub">
          {snapshotTotalUsd !== null ? (
            <span
              data-vex-area="position-snapshot"
              data-stale={stale ? "true" : "false"}
            >
              <span className="vex-pf-top__ink">Snapshot</span>
              {age !== null ? (
                <span data-vex-area="position-snapshot-age"> {age.label}</span>
              ) : null}{" "}
              <span className="vex-num">{usdFigure(snapshotTotalUsd)}</span>
              {delta !== null ? (
                <>
                  {" · "}
                  <span
                    className="vex-pf-top__pnl vex-num"
                    data-stale={stale ? "true" : "false"}
                    aria-label={`Change from the snapshot before ${delta}`}
                  >
                    {delta}
                  </span>{" "}
                  since the snapshot before
                </>
              ) : null}
            </span>
          ) : null}
          {loaded !== null ? (
            <span>
              {snapshotTotalUsd !== null ? " · loaded " : "Loaded "}
              <span className="vex-num">{loaded}</span>
            </span>
          ) : null}
        </p>
      ) : null}
      <ChainReadWarning portfolio={portfolio} />
    </>
  );
}
