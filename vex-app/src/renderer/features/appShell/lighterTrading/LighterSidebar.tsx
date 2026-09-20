/**
 * Lighter's horizontal navigation bar. It keeps the route back, desk actions,
 * profile and a drop-down market/session navigator above the trading grid so
 * the chart never pays for a permanent left rail.
 */

import { useEffect, useId, useMemo, useRef, type JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import {
  IconChevronLeft,
  IconFullscreen,
  IconPanelLeft,
  IconPlus,
  IconSettings,
  IconThemeDark,
  IconThemeLight,
} from "../../../components/icons/index.js";
import { VexMark } from "../../../components/common/VexMark.js";
import { useLighterTradingMarkets } from "../../../lib/api/lighter-trading.js";
import { useSessionsList } from "../../../lib/api/sessions.js";
import { useScrollbarVisibility } from "../../../lib/useScrollbarVisibility.js";
import { cn } from "../../../lib/utils.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionDeleteDialog } from "../SessionDeleteDialog.js";
import {
  SessionGroups,
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
  SidebarIconButton,
} from "../SessionRows.js";
import { SidebarProfile } from "../SidebarProfile.js";
import { filterSessionsByWorkspace, groupSessions } from "../sessionListModel.js";
import { useSessionRowActions } from "../useSessionRowActions.js";
import { EnvironmentSwitch } from "./EnvironmentSwitch.js";
import { NO_VALUE, formatNumber, formatPrice } from "./format.js";
import { classifyLighterMarket } from "./market-classification.js";
import { marketIdentity } from "./market-selection.js";

export const LIGHTER_TOPBAR_HEIGHT = 44;

export function LighterSidebar({
  collapsed,
  onToggleSidebar,
  zenMode,
  zenAssistantOpen,
  onToggleZen,
  onToggleZenAssistant,
}: {
  readonly collapsed: boolean;
  readonly onToggleSidebar: () => void;
  readonly zenMode: boolean;
  readonly zenAssistantOpen: boolean;
  readonly onToggleZen: () => void;
  readonly onToggleZenAssistant: () => void;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const returnMode = useUiStore((s) => s.lighterReturn?.mode ?? "agent");
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const theme = useUiStore((s) => s.theme);
  const setThemePreference = useUiStore((s) => s.setThemePreference);
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

  return (
    <aside
      ref={rootRef}
      className="lit-chat-frame lit-desk-topbar absolute inset-x-0 top-0 z-40"
      style={{ height: LIGHTER_TOPBAR_HEIGHT }}
      data-vex-area="lighter-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
      data-lighter-theme={theme}
      data-lighter-environment={environment}
      data-lighter-zen={zenMode ? "true" : undefined}
      aria-label="Lighter navigation"
    >
      <header className="lit-desk-topbar-header">
        <button
          type="button"
          onClick={() => setRuntimeMode(returnMode)}
          className="lit-topbar-button"
        >
          <IconChevronLeft size={15} />
          <span className="lit-topbar-button-label">{returnMode === "studio" ? "Studio" : "Agent"}</span>
        </button>
        <span className="lit-topbar-divider" aria-hidden="true" />
        <span className="lit-topbar-brand">
          <img src="./protocols/lighter.svg" alt="" width="20" height="20" />
          <b>Lighter</b>
        </span>
        {zenMode && activeMarket !== null ? (
          <span className="lit-topbar-zen-market" aria-label={`Viewing ${activeMarket.symbol} ${resolution} chart`}>
            {activeMarket.symbol} · {resolution}
          </span>
        ) : null}
        <button
          type="button"
          className="lit-topbar-button lit-topbar-distraction"
          aria-expanded={!collapsed}
          aria-controls={drawerId}
          onClick={onToggleSidebar}
        >
          <IconPanelLeft size={16} />
          <span className="lit-topbar-button-label">Markets & sessions</span>
        </button>
        <button
          type="button"
          onClick={() => openCreateSession()}
          className="lit-topbar-primary lit-topbar-distraction"
        >
          <IconPlus size={15} />
          <span className="lit-topbar-button-label">New session</span>
        </button>
        <div className="lit-topbar-center">
          <button
            type="button"
            className="lit-zen-toggle"
            aria-label={zenMode ? "Exit Zen Mode" : "Enter Zen Mode"}
            aria-pressed={zenMode}
            title={zenMode ? "Exit Zen Mode · Esc" : "Open a distraction-free chart"}
            onClick={onToggleZen}
          >
            <IconFullscreen size={15} />
            <span>{zenMode ? "Exit Zen" : "Zen Mode"}</span>
          </button>
        </div>
        <span className="lit-topbar-spacer" />
        {zenMode ? (
          <button
            type="button"
            className="lit-topbar-ask"
            aria-label={zenAssistantOpen ? "Close Vex" : "Ask Vex"}
            aria-pressed={zenAssistantOpen}
            title={zenAssistantOpen ? "Close Vex · Esc" : "Ask Vex about this chart · ⌘K"}
            onClick={onToggleZenAssistant}
          >
            <VexMark size={14} />
            <span>{zenAssistantOpen ? "Close Vex" : "Ask Vex"}</span>
          </button>
        ) : null}
        <EnvironmentSwitch
          environment={environment}
          onSelect={(next) => saveDesk({ environment: next, marketId: null })}
        />
        <span className="lit-topbar-distraction">
          <SidebarIconButton
            label="Settings"
            onClick={() => { setShellRoute({ kind: "settings", origin: null, section: null }); }}
          >
            <IconSettings size={16} />
          </SidebarIconButton>
        </span>
        <SidebarIconButton
          label={theme === "chronos" ? "Switch to the light theme" : "Switch to the dark theme"}
          onClick={() => { setThemePreference(theme === "chronos" ? "celeris" : "chronos"); }}
        >
          {theme === "chronos" ? <IconThemeLight size={16} /> : <IconThemeDark size={16} />}
        </SidebarIconButton>
        <div className="lit-topbar-profile lit-topbar-distraction">
          <SidebarProfile sidebarOpen={false} menuSide="bottom" />
        </div>
      </header>

      {!collapsed ? (
        <div id={drawerId} className="lit-desk-nav-drawer">
          <div
            ref={listScrollRef}
            className="vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-clip p-3"
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
                  sidebarOpen
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

function RailHeading({ children }: { readonly children: string }): JSX.Element {
  return <h2 className="vex-micro-label px-2 uppercase text-[var(--vex-text-3)]">{children}</h2>;
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
    <section aria-label="Watchlist" className="flex flex-col gap-1">
      <RailHeading>Watchlist</RailHeading>
      {rows.length === 0 ? (
        <p className="px-2 text-[12px] leading-[18px] text-[var(--vex-text-3)]">
          Star markets in the market picker to keep them here.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((market) => {
            const change = market.statistics?.priceChange24h ?? null;
            const active = market.marketId === marketId;
            return (
              <li key={market.marketId}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    saveDesk({ marketId: market.marketId });
                    onSelect();
                  }}
                  className={cn(
                    "flex h-8 w-full items-center justify-between gap-2 rounded-[6px] px-2 text-[12.5px] transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
                    active ? "bg-interactive-hover text-foreground" : "text-[var(--vex-text-2)]",
                  )}
                >
                  <span className="truncate font-medium">{classifyLighterMarket(environment, market).ticker}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[11.5px] tabular-nums">
                    <span>{formatPrice(market.statistics?.lastTradePrice ?? null, market.decimals.price)}</span>
                    <span
                      className={cn(
                        "min-w-[52px] text-right",
                        change === null ? "" : change >= 0 ? "text-success" : "text-danger",
                      )}
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
