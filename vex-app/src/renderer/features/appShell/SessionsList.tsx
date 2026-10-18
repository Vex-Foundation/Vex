/**
 * THE LEFT SIDEBAR, in agent mode (docs/design/R3-MINIMAL.md section 4): it
 * says where you are. Paper, a quiet rule on its right, and a width that is
 * the shell track's (264, 224 at the medium tier, the 56px rail closed;
 * `lib/shell-columns.ts`). Nothing in it is wider than the track: every row
 * truncates, so the column reads the same at each seam of the solver.
 *
 * Open, top to bottom:
 *
 *   HEAD     44 high: the vx wordmark and the collapse key
 *            (`AgentSidebarHeader`).
 *   ACTIONS  New chat (500; "New mission" on the Mission tab) and Search, as
 *            nav rows. Search turns its row into the field with the All,
 *            Agent and Mission tabs under it, New chat staying above it;
 *            Escape or the field's Esc key brings back the sections.
 *   NAV      Chat, Missions, Portfolio, Board, Lighter, Studio, Settings,
 *            with a 12px gap above and below (`SidebarNav`).
 *   SESSIONS by name, in Pinned, Today, Yesterday and Older; the one scroller.
 *   ACCOUNT  pinned to the foot behind a quiet rule (`SidebarProfile`).
 *
 * The rail keeps the same order as 40 x 40 keys with their names as tooltips,
 * under the Expand key (the panel icon, the collapse key's twin, the one way
 * back to the open sidebar): New chat, Search, the nav, and the account box
 * at the foot. Chat and Missions pressed on the rail open the sidebar on
 * their list, since a list out of sight cannot show that they did anything.
 * The Lighter desk's rail (`expandable` false) has neither: its drawer opens
 * from the desk's own Markets & sessions key.
 *
 * Row behaviour (pin, remove, inline rename, the hover preview) is the shared
 * `SessionRow`'s; the list model is `sessionListModel.ts`'s. Scrollbars in
 * the column follow the pointer: `useQuietScrollbars` rebinds the scrollbar
 * indirection pair away while the pointer is elsewhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { LineNewChat, LinePanelLeft, LineSearch } from "../../components/icons/line/index.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useQuietScrollbars } from "../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import { useUiStore, type SessionModeFilter } from "../../stores/uiStore.js";
import { AgentSidebarHeader } from "./AgentSidebarHeader.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";
import { SidebarProfile } from "./SidebarProfile.js";
import { setUpdateCardSlot } from "../updates/update-card-slot.js";
import { useSessionRowActions } from "./useSessionRowActions.js";
import {
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
  SidebarSessionGroups,
} from "./SessionRows.js";
import { SessionModeTabs, SessionSearchField } from "./SessionRows/SessionSearch.js";
import { NavKey, SidebarNav } from "./SessionRows/SidebarNav.js";
import {
  filterSessionsByMode,
  filterSessionsByTitle,
  filterSessionsByWorkspace,
  groupSessions,
} from "./sessionListModel.js";

interface SessionsListProps {
  readonly onCreate: () => void;
  /** Open or rail, decided by the shell frame (breakpoint-aware). */
  readonly collapsed: boolean;
  readonly onToggleSidebar: () => void;
  /** Whether the rail opens into the sidebar; false on the Lighter desk. */
  readonly expandable?: boolean;
}

/** Proposal copy (section 4): the search mode's closing hint. */
const SEARCH_HINT = "Esc closes search and brings back the sections.";

export function SessionsList({
  onCreate,
  collapsed,
  onToggleSidebar,
  expandable = true,
}: SessionsListProps): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const sessionModeFilter = useUiStore((s) => s.sessionModeFilter);
  const setSessionModeFilter = useUiStore((s) => s.setSessionModeFilter);
  const query = useSessionsList();
  const {
    pendingPinId,
    removeTarget,
    removeBlocked,
    removePending,
    handleTogglePin,
    handleRename,
    handleRequestRemove,
    handleCancelRemove,
    handleConfirmRemove,
  } = useSessionRowActions();

  const rail = collapsed;

  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } =
    useQuietScrollbars(columnRef);

  // The search mode: a title filter over the SAME resolved titles the rows
  // render. Local and launch-ephemeral; the mode tabs are the store's filter.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect((): void => {
    if (searchOpen && !rail) searchInputRef.current?.focus();
  }, [searchOpen, rail]);

  // The agent workspace, unfiltered: the tabs count it, the search and the
  // mode filter narrow it.
  const agentRows = useMemo(
    () => (query.data?.ok ? filterSessionsByWorkspace(query.data.data, null) : null),
    [query.data],
  );

  const titleRows = useMemo(() => {
    if (agentRows === null) return [];
    return searchOpen ? filterSessionsByTitle(agentRows, searchText) : agentRows;
  }, [agentRows, searchOpen, searchText]);

  // The chat in view, for the nav: a mission chat selects Missions.
  const activeSessionMode = useMemo(
    () =>
      activeSessionId === null || !query.data?.ok
        ? null
        : (query.data.data.find((row) => row.id === activeSessionId)?.mode ?? null),
    [activeSessionId, query.data],
  );

  const visibleRows = useMemo(
    () => filterSessionsByMode(titleRows, sessionModeFilter),
    [titleRows, sessionModeFilter],
  );

  const tabCounts = useMemo(
    (): Readonly<Record<SessionModeFilter, number>> => ({
      all: titleRows.length,
      agent: filterSessionsByMode(titleRows, "agent").length,
      mission: filterSessionsByMode(titleRows, "mission").length,
    }),
    [titleRows],
  );

  const groups = useMemo(() => groupSessions(visibleRows), [visibleRows]);

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  // Escape brings back New chat and the sections. The Agent tab is a search
  // refinement and leaves with the search; the Mission tab stays, because the
  // Missions nav row reads as selected while it holds.
  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
    if (sessionModeFilter === "agent") setSessionModeFilter("all");
  }, [sessionModeFilter, setSessionModeFilter]);

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
    if (rail) onToggleSidebar();
  }, [rail, onToggleSidebar]);

  const openMissions = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  // Chat and Missions on the rail: open the sidebar on the list they filter.
  const showSessionList = useCallback((): void => {
    if (rail && expandable) onToggleSidebar();
  }, [rail, expandable, onToggleSidebar]);

  // The column's one scroller, carrying the overlay bar.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  const listBody = query.isLoading ? (
    <SessionsLoadingPlaceholder sidebarOpen />
  ) : query.data && query.data.ok === false ? (
    <SessionsErrorPlaceholder sidebarOpen message={query.data.error.message} />
  ) : query.isError ? (
    // A TRANSPORT rejection never produces a Result, so without this branch
    // it fell through to `null` and the column went blank: a lie by omission
    // (rule 08: failure is a distinct state, not emptiness).
    <SessionsErrorPlaceholder sidebarOpen message="Vex could not read your sessions." />
  ) : query.data && query.data.ok ? (
    visibleRows.length === 0 ? (
      <SessionsEmptyPlaceholder sidebarOpen />
    ) : (
      <SidebarSessionGroups
        groups={groups}
        activeSessionId={activeSessionId}
        onSelect={handleSelect}
        onTogglePin={handleTogglePin}
        onRequestRemove={handleRequestRemove}
        onRename={handleRename}
        pendingPinId={pendingPinId}
        highlight={searchOpen ? searchText : ""}
      />
    )
  ) : null;

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label="Sessions and agent"
      className={cn("vex-sidebar vex-ls", quiet && "vex-quiet-bars")}
      data-vex-area="sessions-sidebar"
      data-vex-sidebar-open={rail ? "false" : "true"}
      data-rail={rail || undefined}
    >
      {rail ? (
        <>
          {/* The rail's head row is the frame's paper cap; the mark sits on
            * it where the OS draws no traffic lights. */}
          <div className="vex-ls-railhead vex-no-drag">
            <SidebarHomeSigil sidebarOpen={false} />
          </div>
          <div className="vex-ls-body">
            {expandable ? (
              <>
                <Tooltip label="Expand sidebar">
                  <button
                    type="button"
                    aria-label="Expand sessions sidebar"
                    aria-expanded={false}
                    onClick={onToggleSidebar}
                    className="vex-ls-nrow"
                  >
                    <LinePanelLeft className="vex-ls-nrow__i" />
                  </button>
                </Tooltip>
                <div aria-hidden className="vex-ls-rule" />
              </>
            ) : null}
            <NewChatKey rail onCreate={onCreate} />
            <NavKey
              icon={<LineSearch className="vex-ls-nrow__i" />}
              label="Search"
              ariaLabel="Search sessions"
              rail
              onClick={openSearch}
            />
            <div aria-hidden className="vex-ls-gap" />
            <SidebarNav
              rail
              onMissions={openMissions}
              onSessionList={showSessionList}
              activeSessionMode={activeSessionMode}
            />
          </div>
        </>
      ) : (
        <>
          <AgentSidebarHeader onCollapse={onToggleSidebar} />
          <div className="vex-ls-body">
            {searchOpen ? (
              <div className="vex-ls-find">
                {/* The way to start stays above the search, so a list of
                  * missions never hides how to begin one. */}
                <NewChatKey rail={false} onCreate={onCreate} />
                <SessionSearchField
                  value={searchText}
                  onChange={setSearchText}
                  onClose={closeSearch}
                  inputRef={(el) => {
                    searchInputRef.current = el;
                  }}
                />
                <SessionModeTabs
                  value={sessionModeFilter}
                  counts={tabCounts}
                  onChange={setSessionModeFilter}
                />
              </div>
            ) : (
              <>
                <NewChatKey rail={false} onCreate={onCreate} />
                <NavKey
                  icon={<LineSearch className="vex-ls-nrow__i" />}
                  label="Search"
                  ariaLabel="Search sessions"
                  rail={false}
                  onClick={openSearch}
                />
                <div aria-hidden className="vex-ls-gap" />
                <SidebarNav
                  rail={false}
                  onMissions={openMissions}
                  activeSessionMode={activeSessionMode}
                />
                <div aria-hidden className="vex-ls-gap" />
              </>
            )}
            <div
              ref={listScrollRef}
              // `overflow-x-clip`: a bare `overflow-y-auto` computes overflow-x
              // to `auto`, so a row that overshoots would draw a horizontal bar
              // along the list's foot.
              className="vex-scroll vex-scroll-overlay vex-ls-sessions min-h-0 flex-1 overflow-y-auto overflow-x-clip"
              data-rail-control
            >
              {listBody}
              {searchOpen ? <p className="vex-ls-hint">{SEARCH_HINT}</p> : null}
            </div>
          </div>
        </>
      )}

      {/* The update card stands here, above the account row (section 4); the
       * rail has no room for it, so the card floats clear of the rail. */}
      {rail ? null : (
        <div ref={setUpdateCardSlot} className="vex-upd-slot" data-vex-area="update-slot" />
      )}

      <footer className="vex-ls-foot" data-rail-foot>
        <SidebarProfile sidebarOpen={!rail} />
      </footer>

      <SessionDeleteDialog
        session={removeTarget}
        blockedOutcome={removeBlocked}
        pending={removePending}
        onCancel={handleCancelRemove}
        onConfirm={() => {
          void handleConfirmRemove();
        }}
      />
    </aside>
  );
}

/**
 * NEW CHAT: the first nav row (500), never a blue fill (each view keeps one
 * blue fill, and that is the centre's). On the Mission tab it reads "New
 * mission": the session form opens on Mission from that tab, so the word says
 * what the press will start. The signing mechanics are unchanged:
 * a hairline under the label loops while SessionCreator's create is in
 * flight, and the one-shot glint marks success before the key returns to
 * rest.
 */
function NewChatKey({
  rail,
  onCreate,
}: {
  readonly rail: boolean;
  readonly onCreate: () => void;
}): JSX.Element {
  // Signing-stroke state: SessionCreator drives the transitions; this key
  // only renders the stroke and the glint.
  const signingState = useUiStore((s) => s.signingState);
  const setSigningState = useUiStore((s) => s.setSigningState);
  const mission = useUiStore((s) => s.runtimeMode === "agent" && s.sessionModeFilter === "mission");
  return (
    <NavKey
      icon={<LineNewChat className="vex-ls-nrow__i" />}
      label={mission ? "New mission" : "New chat"}
      rail={rail}
      onClick={onCreate}
      className="vex-ls-nrow--new"
    >
      <span
        aria-hidden
        className={cn(
          "vex-sign-stroke vex-ls-new__stroke",
          signingState === "signing" && "vex-sign-stroke--signing",
        )}
      />
      {signingState === "signed" ? (
        <span
          aria-hidden
          onAnimationEnd={() => setSigningState("idle")}
          className="vex-intro-glint vex-ls-new__glint"
        />
      ) : null}
    </NavKey>
  );
}
