/**
 * THE CHATS COLUMN, in agent mode (docs/design/H3-DESKTOP.md section 1.4;
 * R3-MINIMAL.md section 4 for what H3 does not redraw): it says where you
 * are. The ground, a rule on its right, and a width that is the shell
 * track's (248 open, the 76px rail folded; `lib/shell-columns.ts`). Nothing
 * in it is wider than the track: every row truncates, so the column reads
 * the same at each seam of the solver.
 *
 * Open, top to bottom:
 *
 *   HEAD     the logo cell and the sidebar key (`AgentSidebarHeader`): the
 *            frame's header draws them in its cells over this column
 *            (`headless`), so the column itself starts with ACTIONS.
 *   ACTIONS  two H3 cells, edge to edge: NEW CHAT, 55 high on the cell fill
 *            ("New mission" on the Mission tab), and the Search chats field,
 *            48 high, always open (VEX Cloud's), each behind its rule. A
 *            typed query enters the search mode: the All, Agent and Mission
 *            tabs take the nav's place under the field, New chat staying
 *            above it; Escape clears a query, then brings back the sections.
 *   NAV      Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio,
 *            Board, Settings: nine H3 rows on the 40 pitch between two rules
 *            (`SidebarNav`; H3-DESKTOP.md section 4.6).
 *   CHATS    the CHATS heading (13, 600, caps, ink), then the chats by name
 *            in Pinned, Today, Yesterday and Earlier on the 36 pitch; the one
 *            scroller, under the heading, which stays put. In the search mode
 *            the tabs head the list instead.
 *   ACCOUNT  pinned to the foot behind a quiet rule (`SidebarProfile`); under
 *            the frame's header it is the bottom row's account cell
 *            instead (`headless`).
 *
 * THE RAIL (76 wide; H3-DESKTOP.md sections 1.10 and 4.12) keeps the same
 * order in H3 cells, each the rail's whole width, icon only, its name the
 * tooltip and the accessible name: the Expand key (the panel icon, the
 * sidebar key's twin, the one way back to the open column), 48 high behind
 * its rule; NEW CHAT, 55 high on the cell fill; Search chats, 48; the nav
 * keys on the 40 pitch between their rules; the account cell's disc at the
 * foot. Chat and Missions pressed on the rail open the column on their list,
 * since a list out of sight cannot show that they did anything. Under 1280
 * (`chatsPanel`) the rail stays the rail: its Expand key, Search chats and
 * Chat and Missions open the CHATS PANEL over Vex's column instead
 * (`ChatsPanel.tsx`, section 4.12), Search with the panel's field focused.
 * The Lighter desk's rail (`expandable` false) has no Expand key: the desk's
 * drawer opens from its own Markets & sessions key.
 *
 * Row behaviour (pin, remove, inline rename, the hover preview) is the shared
 * `SessionRow`'s; the list model is `sessionListModel.ts`'s. Scrollbars in
 * the column follow the pointer: `useQuietScrollbars` rebinds the scrollbar
 * indirection pair away while the pointer is elsewhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { LineH3NewChat, LinePanelLeft, LineSearch } from "../../components/icons/line/index.js";
import { isDialogOnScreen } from "../../components/ui/dialog.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useQuietScrollbars } from "../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import { useUiStore, type SessionModeFilter } from "../../stores/uiStore.js";
import { AgentSidebarHeader } from "./AgentSidebarHeader.js";
import { CHATS_PANEL_KEY_ATTR, type ChatsPanelFocus } from "./ChatsPanel.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";
import { SidebarProfile } from "./SidebarProfile.js";
import { setUpdateCardSlot } from "../updates/update-card-slot.js";
import { useSessionRowActions } from "./useSessionRowActions.js";
import {
  ChatsEmptyLine,
  ChatsFailedLine,
  ChatsLoadingLine,
  chatsFailedWords,
  SearchAnnouncer,
  SidebarSessionGroups,
} from "./SessionRows.js";
import {
  SEARCH_FIELD_LABEL,
  SessionModeTabs,
  SessionSearchField,
} from "./SessionRows/SessionSearch.js";
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
  /**
   * The frame draws this column's head and foot cells: the logo cell and
   * the sidebar key in its header (`ShellHeader`), the account cell in its
   * bottom row. The column holds only its body. The Lighter desk's rail
   * keeps its own head on the rail's cap and its own account row.
   */
  readonly headless?: boolean;
  /**
   * Under 1280 the rail's keys open the chats panel over Vex's column
   * (`ChatsPanel`, section 4.12): whether it is open, its id for the keys'
   * `aria-controls`, and the opener, which says where its focus lands. The
   * Expand key still toggles through `onToggleSidebar`.
   */
  readonly chatsPanel?: {
    readonly open: boolean;
    readonly id: string;
    readonly onOpen: (focus: ChatsPanelFocus) => void;
  };
}

/** Proposal copy (section 4): the search mode's closing hint. */
const SEARCH_HINT = "Esc closes search and brings back the sections.";

/**
 * The search cell's word, H3's own (Appendix A.2): the row, its rail key's
 * name and the field it opens all say it, so the name a screen reader hears
 * is the word on screen (`SEARCH_FIELD_LABEL` in SessionSearch.tsx).
 */
const SEARCH_LABEL = SEARCH_FIELD_LABEL;

export function SessionsList({
  onCreate,
  collapsed,
  onToggleSidebar,
  expandable = true,
  headless = false,
  chatsPanel,
}: SessionsListProps): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
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
  // The field is always open; a typed query (or Missions) enters the mode.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // The rail's search key opens the column with the field focused.
  const [focusField, setFocusField] = useState(false);

  useEffect((): void => {
    if (!focusField || rail) return;
    searchInputRef.current?.focus();
    setFocusField(false);
  }, [focusField, rail]);

  const changeSearch = useCallback((next: string): void => {
    setSearchText(next);
    if (next !== "") setSearchOpen(true);
  }, []);
  const clearSearch = useCallback((): void => setSearchText(""), []);

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

  // The query the rows are narrowed by, as the announcer speaks it.
  const appliedQuery = searchOpen ? searchText.trim() : "";

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id);
      // A chat opens in the centre: a page standing there (Portfolio, Board,
      // Settings) closes, the way a row on the Sessions page closes it.
      setShellRoute({ kind: "none" });
    },
    [setActiveSessionId, setShellRoute],
  );

  // Escape brings back New chat and the sections. The Agent tab is a search
  // refinement and leaves with the search; the Mission tab stays, because the
  // Missions nav row reads as selected while it holds.
  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
    if (sessionModeFilter === "agent") setSessionModeFilter("all");
  }, [sessionModeFilter, setSessionModeFilter]);

  // Escape closes the search wherever the focus is, not only in its field: a
  // press on a tab, a row or the centre moved the focus out and left the
  // keycap's promise dead. A key another surface already took (a popover, the
  // slash menu) or one under a modal dialog is not the search's.
  useEffect(() => {
    if (!searchOpen || rail) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isDialogOnScreen(document)) return;
      event.preventDefault();
      closeSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, rail, closeSearch]);

  // The rail's search key (the open column has the field itself).
  const openSearch = useCallback((): void => {
    // Under 1280 the rail's search opens the chats panel, its field focused.
    if (rail && chatsPanel !== undefined) {
      chatsPanel.onOpen("search");
      return;
    }
    setFocusField(true);
    if (rail) onToggleSidebar();
  }, [rail, onToggleSidebar, chatsPanel]);

  const openMissions = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  // Chat and Missions on the rail: open the sidebar on the list they filter.
  const showSessionList = useCallback((): void => {
    if (rail && chatsPanel !== undefined) chatsPanel.onOpen("list");
    else if (rail && expandable) onToggleSidebar();
  }, [rail, expandable, onToggleSidebar, chatsPanel]);

  // The column's one scroller, carrying the overlay bar.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  // A failed read offers Retry, which reads the list again (Cloud's
  // `ErrorState` with its Retry key, H3-DESKTOP.md section 1.4).
  const refetchList = query.refetch;
  const retry = useCallback((): void => {
    void refetchList();
  }, [refetchList]);

  const listBody = query.isLoading ? (
    <ChatsLoadingLine />
  ) : query.data && query.data.ok === false ? (
    // Cloud's words first, then main's own reason for the failed read (for
    // example "Vault is locked."): the person learns what to do about it.
    <ChatsFailedLine
      message={chatsFailedWords(query.data.error.message)}
      onRetry={retry}
      retrying={query.isFetching}
    />
  ) : query.isError ? (
    // A TRANSPORT rejection never produces a Result, so without this branch
    // it fell through to `null` and the column went blank: a lie by omission
    // (rule 08: failure is a distinct state, not emptiness).
    <ChatsFailedLine onRetry={retry} retrying={query.isFetching} />
  ) : query.data && query.data.ok ? (
    visibleRows.length === 0 ? (
      // "No chats yet." only when there are none; a search or a tab that
      // narrowed a list with chats says none match it.
      <ChatsEmptyLine searching={(agentRows?.length ?? 0) > 0} />
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
        searching={appliedQuery !== ""}
      />
    )
  ) : null;

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label="Chats"
      className={cn("vex-sidebar vex-ls", quiet && "vex-quiet-bars")}
      data-vex-area="sessions-sidebar"
      data-vex-sidebar-open={rail ? "false" : "true"}
      data-rail={rail || undefined}
    >
      {rail ? (
        <>
          {/* The rail's head row is the frame's paper cap; the mark sits on
            * it where the OS draws no traffic lights. Under the frame's
            * header the logo cell is the header's. */}
          {headless ? null : (
            <div className="vex-ls-railhead vex-no-drag">
              <SidebarHomeSigil sidebarOpen={false} />
            </div>
          )}
          <div className="vex-ls-body">
            {/* The rail's cells, the open column's in the same order, each
              * 76 wide: the Expand key behind its rule, then New chat,
              * Search chats and the nav block between its rules. */}
            {expandable ? (
              <Tooltip label={chatsPanel?.open === true ? "Collapse sidebar" : "Expand sidebar"}>
                <button
                  type="button"
                  aria-label={chatsPanel?.open === true ? "Collapse sidebar" : "Expand sidebar"}
                  aria-expanded={chatsPanel?.open ?? false}
                  aria-controls={chatsPanel?.id}
                  onClick={onToggleSidebar}
                  className="vex-ls-nrow vex-ls-nrow--expand"
                  {...(chatsPanel === undefined ? {} : { [CHATS_PANEL_KEY_ATTR]: "toggle" })}
                >
                  <LinePanelLeft className="vex-ls-nrow__i" />
                </button>
              </Tooltip>
            ) : null}
            <NewChatKey rail onCreate={onCreate} />
            <NavKey
              icon={<LineSearch className="vex-ls-nrow__i" />}
              label={SEARCH_LABEL}
              rail
              onClick={openSearch}
              className="vex-ls-nrow--search"
            />
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
          {headless ? null : <AgentSidebarHeader onCollapse={onToggleSidebar} />}
          <div className="vex-ls-body">
            {/* New chat and the field hold their places in both modes, so
              * the field keeps its focus as a typed query enters the search
              * mode; the tabs then take the nav's place. The way to start
              * stays above the search, so a list of missions never hides
              * how to begin one. */}
            <NewChatKey rail={false} onCreate={onCreate} />
            <SessionSearchField
              value={searchText}
              onChange={changeSearch}
              onClear={clearSearch}
              inputRef={searchInputRef}
            />
            {searchOpen ? (
              <SessionModeTabs
                value={sessionModeFilter}
                counts={tabCounts}
                onChange={setSessionModeFilter}
              />
            ) : (
              // The nav block stands between two rules, the field's and its
              // own, so no gap sets it apart.
              <SidebarNav
                rail={false}
                onMissions={openMissions}
                activeSessionMode={activeSessionMode}
              />
            )}
            {/* CHATS (section 1.4): the list's section head, under the nav's
              * rule. The words stay in sentence case; the class sets caps.
              * The search mode heads its matches with the tabs instead. */}
            {searchOpen ? null : (
              <h2 id="ls-chats" className="vex-ls-chats">
                Chats
              </h2>
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
            {/* The search's result, spoken once the query rests. */}
            <SearchAnnouncer
              query={appliedQuery}
              count={agentRows === null ? null : visibleRows.length}
            />
          </div>
        </>
      )}

      {/* The update card stands here, above the account row (section 4); the
       * rail has no room for it, so the card floats clear of the rail. */}
      {rail ? null : (
        <div ref={setUpdateCardSlot} className="vex-upd-slot" data-vex-area="update-slot" />
      )}

      {/* The account row: the frame's bottom row draws it under this column
        * (its account cell) when the header draws the head. */}
      {headless ? null : (
        <footer className="vex-ls-foot" data-rail-foot>
          <SidebarProfile sidebarOpen={!rail} />
        </footer>
      )}

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
      icon={<LineH3NewChat className="vex-ls-nrow__i" />}
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
