/**
 * THE LIGHTER TITLE ROW IN H3's HEADER CELLS (docs/design/H3-DESKTOP.md
 * sections 1.3 and 4.9; the owner-approved `lighter-desk` plate, plan row
 * S8-07): the desk's part of the shell's one header row, drawn in the
 * header's title cell (`ShellHeader` hands it to the running head as the
 * desk's head), between the logo cell over the rail and the Mainnet cell.
 *
 *   - WHERE YOU ARE, 24 in from the cell's left edge: "Lighter" (sans 15)
 *     over the desk's section and deployment in muted caps ("Perps · Lighter
 *     Core"), as a chat's title carries its kind and access. While a page
 *     stands over the desk (Settings from the rail, Portfolio, a register),
 *     the page's own title as the title bar draws it (`OpenPageTitle`).
 *   - THE DESK'S THREE KEYS at the cell's right end, each a 76-wide icon
 *     cell behind a 1px rule, as the sidebar key is one: Markets and
 *     sessions (the desk's drawer), New desk session, and Zen. Under 1024 New
 *     desk session moves into the drawer, at the head of its sessions.
 *
 * The row draws no way out: Exit Lighter left it, and the nav on the rail is
 * the way out. Needs you is the console's (her column), never a header
 * control, and the Vex key stands over her column at the header's right end.
 * Core and RHC are the market bar's.
 *
 * THE DRAWER, Markets and sessions: a flat panel hung from the header's
 * rule under the title cell (the watchlist and the desk's sessions), a
 * 1px chosen rule, never a shadow. Escape or a press outside closes it.
 *
 * ZEN is the third key: the chart in the whole window under Zen's own row,
 * the chart's toolbar (`ZenRow.tsx`). The header does not stand in Zen.
 */

import { useEffect, useId, useMemo, useRef, type JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import { LIGHTER_ENVIRONMENT_NAMES } from "@shared/lighter-environment-labels.js";
import { LineMarkets, LinePlus, LineZen } from "../../../components/icons/line/index.js";
import { useLighterTradingMarkets } from "../../../lib/api/lighter-trading.js";
import { useSessionsList } from "../../../lib/api/sessions.js";
import { useScrollbarVisibility } from "../../../lib/useScrollbarVisibility.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { OpenPageTitle } from "../RunningHead.js";
import { SessionDeleteDialog } from "../SessionDeleteDialog.js";
import {
  SessionGroups,
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
} from "../SessionRows.js";
import { filterSessionsByWorkspace, groupSessions } from "../sessionListModel.js";
import { useSessionRowActions } from "../useSessionRowActions.js";
import { NO_VALUE, formatNumber, formatPrice } from "./format.js";
import { classifyLighterMarket, type LighterMarketSection } from "./market-classification.js";
import { marketIdentity } from "./market-selection.js";

/** The section words: the market picker's Perps, Stocks and Spot. */
const SECTION_WORDS: Readonly<Record<LighterMarketSection, string>> = {
  perp: "Perps",
  stocks: "Stocks",
  spot: "Spot",
};

/** The three keys' names, which are also their tooltips. */
export const DESK_HEAD_KEYS = {
  drawer: "Markets and sessions",
  session: "New desk session",
  zen: "Enter Zen Mode",
} as const;

export function LighterSidebar({
  collapsed,
  onToggleSidebar,
  band = false,
  onEnterZen,
}: {
  /** The drawer (Markets and sessions) is closed. */
  readonly collapsed: boolean;
  /** Open or close the drawer. */
  readonly onToggleSidebar: () => void;
  /** Under 1024: New desk session moves into the drawer. */
  readonly band?: boolean;
  /** The Zen key: the chart in the whole window. */
  readonly onEnterZen: () => void;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const marketId = useLighterAnalysisStore((s) => s.desk.marketId);
  const marketsQuery = useLighterTradingMarkets(environment, true);
  const activeMarket = marketsQuery.data?.ok === true
    ? marketsQuery.data.data.markets.find((market) => market.marketId === marketId) ?? null
    : null;
  const query = useSessionsList();
  const actions = useSessionRowActions();
  const rootRef = useRef<HTMLElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const drawerId = useId();
  useScrollbarVisibility(listScrollRef);

  const groups = useMemo(() => {
    if (!query.data?.ok) return [];
    return groupSessions(filterSessionsByWorkspace(query.data.data, "lighter"));
  }, [query.data]);

  useEffect(() => {
    if (collapsed) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onToggleSidebar();
    };
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        onToggleSidebar();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [collapsed, onToggleSidebar]);

  // The muted line: the section and the deployment.
  const section = activeMarket === null ? null : classifyLighterMarket(environment, activeMarket).section;
  const place = [section === null ? null : SECTION_WORDS[section], LIGHTER_ENVIRONMENT_NAMES[environment]]
    .filter((part): part is string => part !== null)
    .join(" · ");
  // A page over the desk is named in this cell, the desk's title bar.
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");

  const newSession = (): void => {
    if (!collapsed) onToggleSidebar();
    openCreateSession();
  };

  return (
    <aside
      ref={rootRef}
      className="lit-desk-head"
      data-vex-area="lighter-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
      data-lighter-environment={environment}
      aria-label="Lighter navigation"
    >
      {/* Where you are: the desk, or the page over it. */}
      <span className="lit-desk-head__title">
        {pageOpen ? (
          <OpenPageTitle />
        ) : (
          <>
            <span className="lit-desk-head__name">Lighter</span>
            <span className="lit-desk-head__sub">{place}</span>
          </>
        )}
      </span>
      {/* The desk's three keys, 76-wide icon cells at the cell's end. */}
      <span className="lit-desk-head__keys">
        <button
          type="button"
          className="lit-desk-head__key"
          aria-label={DESK_HEAD_KEYS.drawer}
          title={DESK_HEAD_KEYS.drawer}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : drawerId}
          onClick={onToggleSidebar}
        >
          <LineMarkets size={16} />
        </button>
        {band ? null : (
          <button
            type="button"
            className="lit-desk-head__key"
            aria-label={DESK_HEAD_KEYS.session}
            title={DESK_HEAD_KEYS.session}
            onClick={newSession}
          >
            <LinePlus size={16} />
          </button>
        )}
        <button
          type="button"
          className="lit-desk-head__key lit-zen-toggle"
          aria-label={DESK_HEAD_KEYS.zen}
          title="Zen: the chart in the whole window"
          onClick={onEnterZen}
        >
          <LineZen size={16} />
        </button>
      </span>

      {!collapsed ? (
        <div id={drawerId} className="lit-desk-nav-drawer">
          <div
            ref={listScrollRef}
            className="vex-scroll vex-scroll-overlay lit-desk-nav-list"
          >
            <Watchlist environment={environment} onSelect={onToggleSidebar} />
            <RailHeading>Sessions</RailHeading>
            {band ? (
              <button type="button" className="lit-desk-nav-new" onClick={newSession}>
                <LinePlus size={16} />
                <span>{DESK_HEAD_KEYS.session}</span>
              </button>
            ) : null}
            {query.isLoading ? (
              <SessionsLoadingPlaceholder sidebarOpen />
            ) : query.data && query.data.ok === false ? (
              <SessionsErrorPlaceholder sidebarOpen message={query.data.error.message} />
            ) : query.isError ? (
              <SessionsErrorPlaceholder sidebarOpen message="Vex could not read your sessions." />
            ) : query.data && query.data.ok ? (
              groups.length === 0 ? (
                <SessionsEmptyPlaceholder sidebarOpen />
              ) : (
                <SessionGroups
                  groups={groups}
                  activeSessionId={activeSessionId}
                  onSelect={(sessionId) => {
                    setActiveSessionId(sessionId);
                    onToggleSidebar();
                  }}
                  onTogglePin={actions.handleTogglePin}
                  onRequestRemove={actions.handleRequestRemove}
                  onRename={actions.handleRename}
                  pendingPinId={actions.pendingPinId}
                  idPrefix="lighter-sessions"
                />
              )
            ) : null}
          </div>
        </div>
      ) : null}

      <SessionDeleteDialog
        session={actions.removeTarget}
        blockedOutcome={actions.removeBlocked}
        pending={actions.removePending}
        onCancel={actions.handleCancelRemove}
        onConfirm={() => { void actions.handleConfirmRemove(); }}
      />
    </aside>
  );
}

/** A group head of the drawer: muted caps, the console's register. */
function RailHeading({ children }: { readonly children: string }): JSX.Element {
  return <h2 className="lit-desk-nav-heading">{children}</h2>;
}

/** Starred markets for the current environment; a row swaps the desk's market. */
function Watchlist({ environment, onSelect }: {
  readonly environment: LighterTradingEnvironment;
  readonly onSelect: () => void;
}): JSX.Element {
  const favorites = useLighterAnalysisStore((s) => s.favorites);
  const marketId = useLighterAnalysisStore((s) => s.desk.marketId);
  const saveDesk = useLighterAnalysisStore((s) => s.saveDesk);
  const marketsQuery = useLighterTradingMarkets(environment, true);
  const rows = useMemo(() => {
    if (marketsQuery.data?.ok !== true) return [];
    const starred = new Set(favorites);
    return marketsQuery.data.data.markets.filter((market) => starred.has(marketIdentity(environment, market)));
  }, [environment, favorites, marketsQuery.data]);
  return (
    <section aria-label="Watchlist" className="lit-watchlist">
      <RailHeading>Watchlist</RailHeading>
      {rows.length === 0 ? (
        <p className="lit-watchlist-empty">
          Star markets in the market picker to keep them here.
        </p>
      ) : (
        <ul className="lit-watchlist-rows">
          {rows.map((market) => {
            const change = market.statistics?.priceChange24h ?? null;
            const active = market.marketId === marketId;
            return (
              <li key={market.marketId}>
                <button
                  type="button"
                  className="lit-watchlist-row"
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    saveDesk({ marketId: market.marketId });
                    onSelect();
                  }}
                >
                  <span className="lit-watchlist-ticker">{classifyLighterMarket(environment, market).ticker}</span>
                  <span className="lit-watchlist-figures">
                    <span>{formatPrice(market.statistics?.lastTradePrice ?? null, market.decimals.price)}</span>
                    <span
                      className="lit-watchlist-change"
                      data-tone={change === null ? undefined : change >= 0 ? "up" : "down"}
                    >
                      {change === null ? NO_VALUE : `${change >= 0 ? "+" : ""}${formatNumber(change)}%`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
