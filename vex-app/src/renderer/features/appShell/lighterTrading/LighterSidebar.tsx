/**
 * The Lighter rail: the way back to the mode the desk was entered from, the
 * starred-market watchlist and the desk's own sessions. (The Core | RHC
 * switch lives in the market bar, so it is there with the rail collapsed.)
 * It wears the same glass and collapse choreography as the agent rail
 * (SessionsList) so a mode switch swaps the column's content, not its surface.
 */

import { useMemo, useRef, type JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import {
  IconChevronLeft,
  IconPanelLeft,
  IconPlus,
  IconSettings,
  IconThemeDark,
  IconThemeLight,
} from "../../../components/icons/index.js";
import { useLighterTradingMarkets } from "../../../lib/api/lighter-trading.js";
import { useSessionsList } from "../../../lib/api/sessions.js";
import { useCollapseChoreography } from "../../../lib/useCollapseChoreography.js";
import { useQuietScrollbars } from "../../../lib/useQuietScrollbars.js";
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
import { NO_VALUE, formatNumber, formatPrice } from "./format.js";
import { classifyLighterMarket } from "./market-classification.js";
import { marketIdentity } from "./market-selection.js";

export function LighterSidebar({ collapsed, width, onToggleSidebar }: {
  readonly collapsed: boolean;
  readonly width: number;
  readonly onToggleSidebar: () => void;
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
  const query = useSessionsList();
  const actions = useSessionRowActions();
  const { wide, fading, railIn, frozenWidth } = useCollapseChoreography(collapsed, width);
  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } = useQuietScrollbars(columnRef);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  const groups = useMemo(() => {
    if (!query.data?.ok) return [];
    return groupSessions(filterSessionsByWorkspace(query.data.data, "lighter"));
  }, [query.data]);

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        "vex-sidebar vex-glass-rail relative flex h-full flex-col",
        fading && "vex-sidebar-fading",
        railIn && "vex-sidebar-rail-in",
        quiet && "vex-quiet-bars",
      )}
      style={wide ? { width: collapsed ? frozenWidth : "100%" } : undefined}
      data-vex-area="lighter-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
    >
      <header
        className={cn(
          "relative flex shrink-0",
          wide ? "h-12 items-center justify-between px-3" : "flex-col items-center justify-center gap-0.5 px-2 py-2",
        )}
        data-rail-control
      >
        {wide ? (
          <button
            type="button"
            onClick={() => setRuntimeMode(returnMode)}
            className="flex h-8 items-center gap-1 rounded-[6px] pr-2 pl-1 text-[13px] leading-[20px] font-medium text-[var(--vex-text-2)] transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            <IconChevronLeft size={15} />
            {returnMode === "studio" ? "Studio" : "Agent"}
          </button>
        ) : (
          <SidebarIconButton label={`Back to ${returnMode === "studio" ? "Studio" : "Agent"}`} onClick={() => setRuntimeMode(returnMode)}>
            <IconChevronLeft size={17} />
          </SidebarIconButton>
        )}
        <SidebarIconButton label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"} onClick={onToggleSidebar}>
          <IconPanelLeft size={17} />
        </SidebarIconButton>
      </header>

      {wide ? (
        <div className="flex flex-col gap-2.5 px-3 pb-2">
          <span className="flex items-center gap-2.5">
            <img src="./protocols/lighter.svg" alt="" width="26" height="26" />
            <span className="flex min-w-0 flex-col">
              <b className="text-[15px] leading-[18px] font-semibold tracking-[-0.01em] text-ink-primary">Light it up</b>
              <small className="mt-0.5 text-[10px] leading-[14px] tracking-[0.04em] text-[var(--vex-text-3)]">
                {environment === "rhc" ? "Robinhood Chain · Lighter markets" : "Lighter Core markets"}
              </small>
            </span>
          </span>
        </div>
      ) : null}

      <div className={cn("p-3", !wide && "px-2")} data-rail-control>
        <button
          type="button"
          onClick={() => openCreateSession()}
          aria-label="New session"
          className={cn(
            "vex-micro-label vex-micro-label--wide relative flex h-10 items-center justify-center gap-2 rounded-full bg-button-accent uppercase text-ink-on-button-accent transition-colors duration-150",
            "hover:bg-button-accent-hover",
            "active:scale-[0.99] active:bg-button-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--vex-surface-1)]",
            wide ? "w-full px-4" : "mx-auto w-10",
          )}
        >
          <IconPlus size={15} />
          {wide ? <span>New session</span> : null}
        </button>
      </div>

      <div
        ref={listScrollRef}
        className="vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-clip px-2 py-3"
        data-rail-control
      >
        {wide ? <Watchlist environment={environment} /> : null}
        {wide ? <RailHeading>Sessions</RailHeading> : null}
        {query.isLoading ? (
          <SessionsLoadingPlaceholder sidebarOpen={wide} />
        ) : query.data && query.data.ok === false ? (
          <SessionsErrorPlaceholder sidebarOpen={wide} message={query.data.error.message} />
        ) : query.isError ? (
          <SessionsErrorPlaceholder sidebarOpen={wide} message="Vex could not read your sessions." />
        ) : query.data && query.data.ok ? (
          groups.length === 0 ? (
            <SessionsEmptyPlaceholder sidebarOpen={wide} />
          ) : (
            <SessionGroups
              groups={groups}
              activeSessionId={activeSessionId}
              sidebarOpen={wide}
              onSelect={setActiveSessionId}
              onTogglePin={actions.handleTogglePin}
              onRequestRemove={actions.handleRequestRemove}
              onRename={actions.handleRename}
              pendingPinId={actions.pendingPinId}
              idPrefix="lighter-sessions"
            />
          )
        ) : null}
      </div>

      <footer className="flex flex-col" data-rail-foot>
        {wide ? (
          // Settings (leverage and capital share live there) and the same
          // light/dark switch the Studio rail carries: the desk tokens have
          // both themes, so this flips the app theme, not a Lighter-only one.
          <div className="flex items-center gap-1 px-3 pt-2">
            <SidebarIconButton
              label="Settings"
              onClick={() => { setShellRoute({ kind: "settings", origin: null, section: null }); }}
            >
              <IconSettings size={16} />
            </SidebarIconButton>
            <SidebarIconButton
              label={theme === "chronos" ? "Switch to the light theme" : "Switch to the dark theme"}
              onClick={() => { setThemePreference(theme === "chronos" ? "celeris" : "chronos"); }}
            >
              {theme === "chronos" ? <IconThemeLight size={16} /> : <IconThemeDark size={16} />}
            </SidebarIconButton>
          </div>
        ) : null}
        <SidebarProfile sidebarOpen={wide} />
      </footer>

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
function Watchlist({ environment }: { readonly environment: LighterTradingEnvironment }): JSX.Element {
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
                  onClick={() => saveDesk({ marketId: market.marketId })}
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
