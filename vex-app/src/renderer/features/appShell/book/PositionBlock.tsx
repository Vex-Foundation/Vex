/**
 * THE PORTFOLIO PAGE'S TILES (docs/design/H3-DESKTOP.md sections 1.9, 2.3 and
 * 4.1 item 12; Appendix A.8): the top of the page under its tabs row. A lead
 * line, then the tiles: square cells divided by 1px rules, each a caps label
 * (13, muted), a figure and a muted line under it. H3 draws six (EQUITY,
 * TODAY, 7 DAYS, ALL TIME, DRAWDOWN, RUNNING) in a 3 x 2 grid; desktop draws
 * one tile per figure it can back with a real read, and NO tile for a figure
 * it has no source for. There is never a sample value, a zero standing in for
 * an unknown, or an empty cell.
 *
 * THE TILES DESKTOP DRAWS, and the read behind each:
 *   1. Wallet total: `liveTotalUsd`, the settled balances (sans 33 / 600, the
 *      contract's equity figure). Always, once the read answers.
 *   2. Since the snapshot before: `pnlVsPrev`, the latest complete snapshot
 *      against the one before it, with the snapshot's figure and AGE under it.
 *      Only when the read carries a snapshot; with a snapshot but no earlier
 *      one to compare, the tile is "Last snapshot" and its figure. It is a
 *      change in wallet value, which counts deposits and withdrawals as well
 *      as prices, so it is NOT trading P&L: it keeps the ink and its sign, and
 *      never takes the gain or loss colour (that would call a deposit a gain).
 *      Past 24 hours it drops to the muted ink (owner measurement 2026-09-04:
 *      a delta against a 31-day-old baseline looked like this hour's).
 *   3. Lighter equity and 4. Unrealized PnL: the Lighter account read the
 *      section below reads (`lighterTileFigures`, the same derivations), in the
 *      account's settlement unit. Only for "All wallets" (the account is the
 *      venue's, never narrowed to a wallet, a chat or a project, so it is not
 *      set beside a narrowed total) and only once the account is ready; each
 *      tile only when the read carries its figure. The PnL IS a trading value,
 *      so it takes the gain or loss colour.
 * Left out, with no desktop source (section 4.1 item 12): P&L over today, 7
 * days and all time, drawdown, "of allocated" and the strategies count.
 *
 * THE LEAD LINE (A.8): the quiet hatch and "Mainnet" (Cloud's PD-05: a page
 * shows real money, it decides none, so the solid stamp is not its mark; no
 * paper mode, so no PAPER and LIVE pair), "Real money on mainnet." and what
 * the total includes.
 *
 * SCOPE IS THE ONLY INPUT (`PortfolioPageScope`): the whole inventory, one
 * inventory wallet, the open chat's wallets or the selected project's. The
 * renderer never supplies a wallet address of its own choosing; every read
 * goes to main as the validated scope (or the inventory address main
 * re-authorizes), and no scope ever falls back to a wider one.
 *
 * FRESHNESS: the tabs row's "Updated {time}" is this read's own fetch time,
 * true for the app and not a claim about when the chain was read (the DTO
 * carries no read time). Chain read problems are printed under the tiles
 * (`ChainReadWarning`). A failed refresh keeps the tiles already drawn, with
 * "Couldn't refresh your portfolio." and Retry above them; only a scope that
 * never answered shows the could-not-load block (H3-DESKTOP section 1.9).
 *
 * The activity terminalization and progress pushes that keep these figures
 * following a pending transaction are subscribed once for the whole app, in
 * AppShell; this block mounts none of its own.
 */

import type { JSX, ReactNode } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import { MainnetMark } from "../../../components/ui/stamp.js";
import { useLighterTradingAccount } from "../../../lib/api/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ChainReadWarning } from "./portfolio/ChainReadWarning.js";
import { lighterTileFigures, type LighterTileFigures } from "./portfolio/LighterAccountCard.js";
import { CardStateNote, SectionLink, originOf } from "./portfolio/PortfolioCard.js";
import {
  totalIncludesLine,
  useKeptPageScopePortfolio,
  type PortfolioPageScope,
} from "./portfolio/portfolio-page-scope.js";
import { LoadFailedBlock, RefreshFailedNotice } from "../screens/RefreshNotice.js";
import { NOT_AVAILABLE, usdDeltaFigure, usdFigure } from "./portfolio/portfolio-format.js";
import { snapshotAge } from "./portfolio/snapshot-age.js";

export function PositionBlock({
  scope,
}: {
  /** The page's scope - never session or project state read inside. */
  readonly scope: PortfolioPageScope;
}): JSX.Element {
  const read = useKeptPageScopePortfolio(scope);
  const portfolio = read.portfolio;
  const lighter = useLighterTiles(scope.kind === "global");

  let main: JSX.Element;
  if (read.loading) {
    main = <CardStateNote tone="loading">Loading your portfolio…</CardStateNote>;
  } else if (portfolio === null && read.failed) {
    // Nothing was ever read for this scope: the block, with Retry.
    main = (
      <LoadFailedBlock
        scope="Portfolio"
        text="Couldn't load your portfolio."
        onRetry={read.retry}
      />
    );
  } else if (portfolio === null || portfolio.walletCount === 0) {
    main = <EmptyScope scope={scope} />;
  } else {
    main = <Tiles scope={scope} portfolio={portfolio} lighter={lighter} />;
  }

  return (
    <header className="vex-pf-top" data-vex-area="portfolio-total">
      {/* A failed refresh over figures already read: they stay, and this
          line says the newest read failed (H3-DESKTOP section 1.9). */}
      {portfolio !== null && read.failed ? (
        <RefreshFailedNotice text="Couldn't refresh your portfolio." onRetry={read.retry} />
      ) : null}
      {main}
    </header>
  );
}

/**
 * The Lighter account's tile figures, read only while the page shows "All
 * wallets". The query is the Lighter section's own (the same key: the desk's
 * environment, unscoped), so it is one read for both.
 */
function useLighterTiles(enabled: boolean): LighterTileFigures | null {
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const query = useLighterTradingAccount(environment, enabled, undefined);
  if (!enabled) return null;
  const result = query.data;
  return lighterTileFigures(result?.ok === true ? result.data : null);
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

/** One tile: a caps label, the figure, a muted line. */
function Tile({
  tile,
  label,
  figure,
  sub,
  area,
  stale,
}: {
  /** The tile's identity, for the sheet and the tests. */
  readonly tile: string;
  readonly label: string;
  readonly figure: ReactNode;
  readonly sub: ReactNode;
  readonly area?: string;
  readonly stale?: boolean;
}): JSX.Element {
  return (
    <div
      className="vex-pf-tile"
      data-vex-tile={tile}
      data-vex-area={area}
      data-stale={stale === undefined ? undefined : stale ? "true" : "false"}
    >
      <dt className="vex-pf-tile__l">{label}</dt>
      <dd className="vex-pf-tile__fig">{figure}</dd>
      {sub !== null ? <dd className="vex-pf-tile__sub">{sub}</dd> : null}
    </div>
  );
}

function Tiles({
  scope,
  portfolio,
  lighter,
}: {
  readonly scope: PortfolioPageScope;
  readonly portfolio: PortfolioDto;
  readonly lighter: LighterTileFigures | null;
}): JSX.Element {
  const { liveTotalUsd, snapshotTotalUsd, pnlVsPrev, snapshotAt } = portfolio;
  const age = snapshotAt === null ? null : snapshotAge(snapshotAt, Date.now());
  const stale = age !== null && age.stale;
  const delta = usdDeltaFigure(pnlVsPrev);
  const total = usdFigure(liveTotalUsd);
  const snapshot = usdFigure(snapshotTotalUsd);

  const tiles: JSX.Element[] = [
    <Tile
      key="total"
      tile="total"
      label="Wallet total"
      figure={
        total === null ? (
          <span className="vex-pf-muted">{NOT_AVAILABLE}</span>
        ) : (
          <span className="vex-pf-top__big">{total}</span>
        )
      }
      sub="Settled balances"
    />,
  ];

  if (snapshot !== null) {
    const ageWords =
      age !== null ? <span data-vex-area="position-snapshot-age">{age.label}</span> : null;
    tiles.push(
      delta !== null ? (
        <Tile
          key="change"
          tile="change"
          area="position-snapshot"
          stale={stale}
          label="Since the snapshot before"
          figure={
            <span
              className="vex-pf-top__pnl"
              data-stale={stale ? "true" : "false"}
              aria-label={`Change from the snapshot before ${delta}`}
            >
              {delta}
            </span>
          }
          sub={
            <>
              Snapshot <span className="vex-num">{snapshot}</span>
              {ageWords !== null ? <>{", "}{ageWords}</> : null}
            </>
          }
        />
      ) : (
        <Tile
          key="change"
          tile="snapshot"
          area="position-snapshot"
          stale={stale}
          label="Last snapshot"
          figure={<span>{snapshot}</span>}
          sub={ageWords ?? "Not compared with an earlier snapshot yet"}
        />
      ),
    );
  }

  if (lighter !== null && lighter.equity !== null) {
    tiles.push(
      <Tile
        key="lighter-equity"
        tile="lighter-equity"
        label="Lighter equity"
        figure={
          <>
            {lighter.equity} <span className="vex-pf-tile__u">{lighter.unit}</span>
          </>
        }
        sub="Not in the wallet total"
      />,
    );
  }
  if (lighter !== null && lighter.unrealizedPnl !== null) {
    const open = lighter.openPositions;
    tiles.push(
      <Tile
        key="lighter-pnl"
        tile="lighter-pnl"
        label="Unrealized PnL"
        figure={
          <span data-trade={lighter.pnlDirection ?? undefined}>
            {lighter.unrealizedPnl} <span className="vex-pf-tile__u">{lighter.unit}</span>
          </span>
        }
        sub={
          open === 0
            ? "No open Lighter positions"
            : `${String(open)} open Lighter ${open === 1 ? "position" : "positions"}`
        }
      />,
    );
  }

  return (
    <>
      <p className="vex-pf-lead">
        <MainnetMark className="vex-pf-lead__net" />
        <span className="vex-pf-lead__words">
          <span className="vex-pf-lead__ink">Real money on mainnet.</span>{" "}
          <span className="vex-pf-top__line">{totalIncludesLine(scope, portfolio.walletCount)}</span>
        </span>
      </p>
      <dl className="vex-pf-tiles" data-count={tiles.length} aria-label="Portfolio figures">
        {tiles}
      </dl>
      <ChainReadWarning portfolio={portfolio} />
    </>
  );
}
