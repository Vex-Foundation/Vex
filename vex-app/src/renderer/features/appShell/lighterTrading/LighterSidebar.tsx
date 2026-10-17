/**
 * THE LIGHTER TITLE ROW (docs/design/R3-MINIMAL.md sections 3 and 9.3): the
 * centre column's 44px head row on the desk, and the window's drag region.
 *
 *   - the LEFT cell says where you are: "Lighter", then the desk's section
 *     and network in muted ("Perps · Robinhood Chain"); in Zen, the market
 *     and interval the chart shows;
 *   - the RIGHT cluster (gap 8): Markets & sessions, New session, Core | RHC
 *     and the Zen key, then the title bar's own cluster (export, Notices,
 *     Needs you, the token chip), portalled in from `RunningHead` through
 *     `shellStripSlot.ts`. The slot stays mounted in every state, so the
 *     cluster never remounts when Zen folds the row.
 *
 * Navigation, Settings and the account live in the left rail, which the desk
 * always uses; the rail's Chats key and Markets & sessions open the same
 * drawer (a paper sheet hung from the row's rule: the watchlist and the
 * desk's sessions).
 *
 * Zen keeps the chart in the whole window: the row folds to a small handle
 * and comes back as an overlay without moving the chart.
 */

import { useEffect, useId, useMemo, useRef, type JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import { LIGHTER_ENVIRONMENT_NAMES } from "@shared/lighter-environment-labels.js";
import {
  LineChevronDown,
  LineChevronUp,
  LinePanelLeft,
  LinePlus,
  LineZen,
} from "../../../components/icons/line/index.js";
import { VexMark } from "../../../components/common/VexMark.js";
import { useLighterTradingMarkets } from "../../../lib/api/lighter-trading.js";
import { useSessionsList } from "../../../lib/api/sessions.js";
import { useScrollbarVisibility } from "../../../lib/useScrollbarVisibility.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionDeleteDialog } from "../SessionDeleteDialog.js";
import {
  SessionGroups,
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
} from "../SessionRows.js";
import { filterSessionsByWorkspace, groupSessions } from "../sessionListModel.js";
import { useSessionRowActions } from "../useSessionRowActions.js";
import { EnvironmentSwitch } from "./EnvironmentSwitch.js";
import { NO_VALUE, formatNumber, formatPrice } from "./format.js";
import { classifyLighterMarket, type LighterMarketSection } from "./market-classification.js";
import { marketIdentity } from "./market-selection.js";
import { setShellStripSlot } from "./shellStripSlot.js";

/** The section words of the market bar's Perps | Stocks | Spot control. */
const SECTION_WORDS: Readonly<Record<LighterMarketSection, string>> = {
  perp: "Perps",
  stocks: "Stocks",
  spot: "Spot",
};

export function LighterSidebar({
  collapsed,
  onToggleSidebar,
  zenMode,
  zenAssistantOpen,
  zenControlsOpen,
  onToggleZen,
  onToggleZenControls,
  onToggleZenAssistant,
}: {
  readonly collapsed: boolean;
  readonly onToggleSidebar: () => void;
  readonly zenMode: boolean;
  readonly zenAssistantOpen: boolean;
  readonly zenControlsOpen: boolean;
  readonly onToggleZen: () => void;
  readonly onToggleZenControls: () => void;
  readonly onToggleZenAssistant: () => void;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const theme = useUiStore((s) => s.theme);
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const marketId = useLighterAnalysisStore((s) => s.desk.marketId);
  const resolution = useLighterAnalysisStore((s) => s.desk.resolution);
  const saveDesk = useLighterAnalysisStore((s) => s.saveDesk);
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

  // The left cell's muted words: the section and the network; in Zen, the
  // chart's market and interval instead.
  const section = activeMarket === null ? null : classifyLighterMarket(environment, activeMarket).section;
  const place = [section === null ? null : SECTION_WORDS[section], LIGHTER_ENVIRONMENT_NAMES[environment]]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const zenFolded = zenMode && !zenControlsOpen;

  return (
    <aside
      ref={rootRef}
      className="lit-chat-frame lit-desk-topbar"
      data-vex-area="lighter-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
      data-lighter-theme={theme}
      data-lighter-environment={environment}
      data-lighter-zen={zenMode ? "true" : undefined}
      data-zen-controls={zenMode ? zenControlsOpen ? "open" : "closed" : undefined}
      aria-label="Lighter navigation"
    >
      <header className="lit-desk-topbar-header vex-drag">
        {zenFolded ? (
          <button
            type="button"
            className="lit-zen-controls-reveal"
            aria-label="Show Zen controls"
            aria-expanded="false"
            title="Show Zen controls"
            onClick={onToggleZenControls}
          >
            <LineChevronDown size={16} />
          </button>
        ) : (
          <>
            <span className="vex-tb-title lit-topbar-title">
              <span className="vex-tb-title__name">Lighter</span>
              {zenMode && activeMarket !== null ? (
                <span
                  className="vex-tb-title__sub lit-topbar-zen-market"
                  aria-label={`Viewing ${activeMarket.symbol} ${resolution} chart`}
                >
                  {activeMarket.symbol} · {resolution}
                </span>
              ) : (
                <span className="vex-tb-title__sub">{place}</span>
              )}
            </span>
            <span className="lit-topbar-spacer" />
            <div className="lit-topbar-keys">
              <button
                type="button"
                className="lit-topbar-pill lit-topbar-distraction"
                aria-expanded={!collapsed}
                aria-controls={drawerId}
                onClick={onToggleSidebar}
              >
                <LinePanelLeft size={16} />
                <span className="lit-topbar-button-label">Markets & sessions</span>
              </button>
              <button
                type="button"
                onClick={() => openCreateSession()}
                className="lit-topbar-pill lit-topbar-distraction"
              >
                <LinePlus size={16} />
                <span className="lit-topbar-button-label">New session</span>
              </button>
              <EnvironmentSwitch
                environment={environment}
                onSelect={(next) => saveDesk({ environment: next, marketId: null })}
              />
              <button
                type="button"
                className="lit-topbar-key lit-zen-toggle"
                aria-label={zenMode ? "Exit Zen Mode" : "Enter Zen Mode"}
                aria-pressed={zenMode}
                title={zenMode ? "Exit Zen Mode · Esc" : "Zen Mode: a distraction-free chart"}
                onClick={onToggleZen}
              >
                <LineZen size={16} />
              </button>
              {zenMode ? (
                <>
                  <button
                    type="button"
                    className="lit-topbar-key lit-zen-controls-hide"
                    aria-label="Hide Zen controls"
                    aria-expanded="true"
                    title="Hide Zen controls · Esc"
                    onClick={onToggleZenControls}
                  >
                    <LineChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    className="lit-topbar-pill lit-topbar-ask"
                    aria-label={zenAssistantOpen ? "Close Vex" : "Ask Vex"}
                    aria-pressed={zenAssistantOpen}
                    title={zenAssistantOpen ? "Close Vex · Esc" : "Ask Vex about this chart · ⌘K"}
                    onClick={onToggleZenAssistant}
                  >
                    <VexMark size={16} />
                    <span className="lit-topbar-button-label">{zenAssistantOpen ? "Close Vex" : "Ask Vex"}</span>
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}
        {/* The title bar's cluster lands here (see shellStripSlot.ts). The
          * slot keeps its place in the row in every state, so a folded Zen
          * row hides the cluster without remounting it. */}
        <div className="lit-desk-top-shell" ref={setShellStripSlot} hidden={zenFolded} />
      </header>

      {!collapsed ? (
        <div id={drawerId} className="lit-desk-nav-drawer">
          <div
            ref={listScrollRef}
            className="vex-scroll vex-scroll-overlay lit-desk-nav-list"
          >
            <Watchlist environment={environment} onSelect={onToggleSidebar} />
            <RailHeading>Sessions</RailHeading>
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

/** A group head of the drawer: 12 / 500 muted, sentence case. */
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
