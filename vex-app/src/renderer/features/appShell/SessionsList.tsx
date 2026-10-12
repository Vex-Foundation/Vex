/**
 * THE LEFT PAGE, in agent mode (docs/design/V10-SPREAD.md section 3): the
 * furniture set on the print (`ShellBackdrop`, with the eagle and its flock in
 * the band). Width comes from the shell grid (AppShell + lib/shell-columns.ts):
 * the open 300px page, or the 56px spine when `collapsed`.
 *
 * The open page, top to bottom:
 *
 *   MAST    the 44px head row on the print: traffic lights, vx mark, the
 *           `Agent | Studio` capsule (`AgentSidebarHeader`).
 *   SKY     from the head row to just above the horizon: the 112px italic
 *           counter (the open session's ordinal; on the welcome stage the
 *           session count, captioned SESSIONS), New session, the All | Agent |
 *           Mission tabs with search and collapse at their right, and the
 *           session index. Only the index scrolls; a row the horizon would cut
 *           is not drawn, and the dotted fold counts the rows below it.
 *   BAND    the flock (painted by the print layer, not here).
 *   GROUND  $VEX and its spark, the white hairline, the profile row.
 *
 * The spine keeps New session, the ordinals, an open control and the profile
 * box. Ordinals come from `useSessionOrdinals` over the UNFILTERED agent
 * rows, so neither the tabs, the search, a pin nor a removal renumbers a
 * session. Row behaviour (pin, remove, inline rename, the hover preview) is
 * the shared `SessionRow`'s; the list model is `sessionListModel.ts`'s.
 *
 * Scrollbars in the column follow the pointer: `useQuietScrollbars` rebinds
 * the scrollbar indirection pair away while the pointer is elsewhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  IconClose,
  IconPanelLeft,
  IconPlus,
  IconSearch,
} from "../../components/icons/index.js";
import { Counter } from "../../components/ui/counter.js";
import { cn } from "../../lib/utils.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useQuietScrollbars } from "../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import { useUiStore } from "../../stores/uiStore.js";
import { RailSearchField } from "../../components/ui/rail-list.js";
import { AgentSidebarHeader } from "./AgentSidebarHeader.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import { SidebarProfile } from "./SidebarProfile.js";
import { useSessionRowActions } from "./useSessionRowActions.js";
import { VexTokenCardCompact } from "./market/VexTokenCardCompact.js";
import {
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
} from "./SessionRows.js";
import { IndexFold, SessionIndex } from "./leftPage/SessionIndex.js";
import { SpineIndex } from "./leftPage/SpineIndex.js";
import { useIndexFold } from "./leftPage/useIndexFold.js";
import { ordinalDigits, useSessionOrdinals } from "./leftPage/sessionOrdinals.js";
import {
  filterSessionsByMode,
  filterSessionsByTitle,
  filterSessionsByWorkspace,
  groupSessions,
  SESSION_MODE_FILTERS,
} from "./sessionListModel.js";

interface SessionsListProps {
  readonly onCreate: () => void;
  /** Page or spine, decided by the shell frame (breakpoint-aware). */
  readonly collapsed: boolean;
  readonly onToggleSidebar: () => void;
}

export function SessionsList({
  onCreate,
  collapsed,
  onToggleSidebar,
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

  const wide = !collapsed;

  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } =
    useQuietScrollbars(columnRef);

  // Rail search: a title filter over the SAME resolved titles the rows
  // render, toggled by the tabs row's magnifier. Local, launch-ephemeral.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect((): void => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // The agent workspace, unfiltered: what the ordinals, the counter and the
  // spine read. The tabs and the search narrow only the open page's index.
  const agentRows = useMemo(
    () => (query.data?.ok ? filterSessionsByWorkspace(query.data.data, null) : null),
    [query.data],
  );
  const ordinals = useSessionOrdinals(agentRows);

  const visibleRows = useMemo(() => {
    if (agentRows === null) return [];
    const byMode = filterSessionsByMode(agentRows, sessionModeFilter);
    return searchOpen ? filterSessionsByTitle(byMode, searchText) : byMode;
  }, [agentRows, sessionModeFilter, searchOpen, searchText]);

  const groups = useMemo(() => groupSessions(visibleRows), [visibleRows]);
  const spineGroups = useMemo(() => groupSessions(agentRows ?? []), [agentRows]);

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
  }, []);

  const toggleSearch = useCallback((): void => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  }, [searchOpen, closeSearch]);

  // The browsing region: the index on the open page, the ordinals on the
  // spine. It is the column's one scroller and carries the overlay bar.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);
  const foldRevision = useMemo(
    () => [wide, wide ? groups : spineGroups, query.isLoading, query.isError, searchOpen],
    [wide, groups, spineGroups, query.isLoading, query.isError, searchOpen],
  );
  const fold = useIndexFold(listScrollRef, foldRevision, activeSessionId);

  // The counter: the open session's ordinal; on the welcome stage the number
  // of sessions. Nothing until the list has been read.
  const counterNumber =
    agentRows === null
      ? null
      : activeSessionId === null
        ? agentRows.length
        : (ordinals.get(activeSessionId) ?? null);
  const counterValue = counterNumber === null ? null : ordinalDigits(counterNumber);

  const listBody = query.isLoading ? (
    <SessionsLoadingPlaceholder sidebarOpen={wide} />
  ) : query.data && query.data.ok === false ? (
    <SessionsErrorPlaceholder
      sidebarOpen={wide}
      message={query.data.error.message}
    />
  ) : query.isError ? (
    // A TRANSPORT rejection never produces a Result, so without this branch
    // it fell through to `null` and the page went blank: a lie by omission
    // (rule 08: failure is a distinct state, not emptiness).
    <SessionsErrorPlaceholder
      sidebarOpen={wide}
      message="Vex could not read your sessions."
    />
  ) : query.data && query.data.ok ? (
    wide ? (
      visibleRows.length === 0 ? (
        <SessionsEmptyPlaceholder sidebarOpen />
      ) : (
        <SessionIndex
          groups={groups}
          activeSessionId={activeSessionId}
          ordinals={ordinals}
          onSelect={handleSelect}
          onTogglePin={handleTogglePin}
          onRequestRemove={handleRequestRemove}
          onRename={handleRename}
          pendingPinId={pendingPinId}
        />
      )
    ) : (
      <SpineIndex
        groups={spineGroups}
        activeSessionId={activeSessionId}
        ordinals={ordinals}
        onSelect={handleSelect}
      />
    )
  ) : null;

  const scroller = (
    <div
      ref={listScrollRef}
      // `overflow-x-clip`: a bare `overflow-y-auto` computes overflow-x to
      // `auto`, so a row that overshoots the page would draw a horizontal
      // bar along the index's foot.
      className={cn(
        "vex-scroll vex-scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-clip",
        wide ? "vex-lp-index" : "vex-lp-spine__index",
      )}
      data-rail-control
    >
      {listBody}
    </div>
  );

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label="Sessions and agent"
      className={cn(
        // No surface of its own: the left page's print is the ground.
        "vex-sidebar vex-lp",
        quiet && "vex-quiet-bars",
      )}
      data-vex-area="sessions-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
    >
      {wide ? (
        <>
          <AgentSidebarHeader />

          <div className="vex-lp-sky">
            <div className="vex-lp-head">
              <Counter
                value={counterValue ?? "00"}
                className={cn("vex-lp-counter", counterValue === null && "invisible")}
                data-digits={counterValue !== null && counterValue.length > 2 ? "3" : undefined}
              />
              {activeSessionId === null ? (
                <span className="vex-lp-cap">Sessions</span>
              ) : null}
            </div>

            <NewSessionKey onCreate={onCreate} />

            <div className="vex-lp-tabs">
              <div role="tablist" aria-label="Filter sessions" className="vex-lp-tabs__list">
                {SESSION_MODE_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    role="tab"
                    aria-selected={sessionModeFilter === filter.value}
                    onClick={() => setSessionModeFilter(filter.value)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <span className="vex-lp-tabs__tools" data-rail-control>
                <button
                  type="button"
                  aria-label={searchOpen ? "Close session search" : "Search sessions"}
                  aria-pressed={searchOpen}
                  onClick={toggleSearch}
                  className="vex-lp-tool"
                >
                  <IconSearch size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Collapse sessions sidebar"
                  onClick={onToggleSidebar}
                  className="vex-lp-tool"
                >
                  <IconPanelLeft size={16} />
                </button>
              </span>
            </div>

            {searchOpen ? (
              <div className="vex-lp-search">
                <RailSearchField
                  value={searchText}
                  onChange={setSearchText}
                  onClose={closeSearch}
                  placeholder="Search sessions"
                  label="Search sessions"
                  closeLabel="Close search"
                  inputRef={(el) => {
                    searchInputRef.current = el;
                  }}
                  icon={<IconSearch size={16} />}
                  closeIcon={<IconClose size={16} />}
                />
              </div>
            ) : null}

            {scroller}
            <IndexFold hidden={fold.hiddenBelow} onPageDown={fold.pageDown} />
          </div>

          {/* The ground: $VEX, the hairline, the profile row. */}
          <div className="vex-lp-ground">
            <VexTokenCardCompact />
            <div aria-hidden className="vex-lp-ground__rule" />
            <footer data-rail-foot>
              <SidebarProfile sidebarOpen ground="print" />
            </footer>
          </div>
        </>
      ) : (
        <div className="vex-lp-spine">
          <NewSessionKey onCreate={onCreate} compact />
          <div className="vex-lp-spine__sky">
            {scroller}
            <IndexFold hidden={fold.hiddenBelow} onPageDown={fold.pageDown} compact />
          </div>
          <div className="vex-lp-spine__foot">
            <button
              type="button"
              aria-label="Expand sessions sidebar"
              onClick={onToggleSidebar}
              className="vex-lp-tool vex-lp-tool--ground"
            >
              <IconPanelLeft size={16} />
            </button>
            <footer data-rail-foot>
              <SidebarProfile sidebarOpen={false} ground="print" />
            </footer>
          </div>
        </div>
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
 * NEW SESSION: a label box on the sky (36px across the page, 32 square on the
 * spine). Not a blue fill: each view keeps one blue fill, and that is the
 * centre's. The signing mechanics are unchanged: a hairline under the label
 * loops while SessionCreator's create is in flight, and the one-shot glint
 * marks success before the key returns to rest.
 */
function NewSessionKey({
  onCreate,
  compact = false,
}: {
  readonly onCreate: () => void;
  readonly compact?: boolean;
}): JSX.Element {
  // Signing-stroke state: SessionCreator drives the transitions; this key
  // only renders the stroke and the glint.
  const signingState = useUiStore((s) => s.signingState);
  const setSigningState = useUiStore((s) => s.setSigningState);
  return (
    <button
      type="button"
      onClick={onCreate}
      aria-label="New session"
      title={compact ? "New session" : undefined}
      className={compact ? "vex-lp-new vex-lp-new--compact" : "vex-lp-new"}
      data-rail-control
    >
      <IconPlus size={16} />
      {compact ? null : <span>New session</span>}
      <span
        aria-hidden
        className={cn(
          "vex-sign-stroke vex-lp-new__stroke",
          signingState === "signing" && "vex-sign-stroke--signing",
        )}
      />
      {signingState === "signed" ? (
        <span
          aria-hidden
          onAnimationEnd={() => setSigningState("idle")}
          className="vex-intro-glint vex-lp-new__glint"
        />
      ) : null}
    </button>
  );
}
