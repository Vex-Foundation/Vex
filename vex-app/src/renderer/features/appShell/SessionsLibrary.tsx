/**
 * Sessions library: the full session register, mounted inside the Sessions
 * page (docs/design/R3-MINIMAL.md section 9.6). The page sheet owns the title
 * bar crumb and the serif page head, so this is pure flow content: a count
 * line, the title search with the All, Agent and Mission filter, and the
 * register by day. Renders the full session list (DB cap 100), the same
 * bounded read the sidebar scrolls over: the sidebar is one scroller by name,
 * so this page is the register to search, filter and read by day.
 * Selecting a row closes the page and opens that session.
 *
 * The rows (`SessionsLibrary/LibraryRows.tsx`) share the sidebar row's
 * behaviour and its state words: pin, remove, rename and the swatch with its
 * word come from the same hooks and helpers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { EmptyBlock } from "../../components/ui/empty-block.js";
import { useSessionsList } from "../../lib/api/sessions.js";
import { useUiStore } from "../../stores/uiStore.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import { LibraryGroups } from "./SessionsLibrary/LibraryRows.js";
import {
  filterSessionsByMode,
  filterSessionsByTitle,
  groupSessions,
  SESSION_MODE_FILTERS,
} from "./sessionListModel.js";
import { useSessionRowActions } from "./useSessionRowActions.js";

const EMPTY_SESSIONS: readonly SessionListItem[] = [];

/** How the register's keys work (the design's line under the list). */
const LIBRARY_KEYS_NOTE =
  "Double click a title to rename it. Pin and Remove session appear on hover; removing hides a session from the app, local message history stays on your disk.";

export function SessionsLibrary(): JSX.Element {
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
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const allRows = query.data?.ok === true ? query.data.data : EMPTY_SESSIONS;
  const totalRows = allRows.length;
  const filteredRows = useMemo(
    () =>
      filterSessionsByTitle(
        filterSessionsByMode(allRows, sessionModeFilter),
        search,
      ),
    [allRows, search, sessionModeFilter],
  );

  const groups = useMemo(() => {
    return groupSessions(filteredRows);
  }, [filteredRows]);

  const visibleRows = filteredRows.length;
  const searchActive = search.trim().length > 0;
  const filtersActive = searchActive || sessionModeFilter !== "all";
  const countLabel =
    totalRows === 0
      ? "No sessions yet"
      : filtersActive
        ? `${visibleRows} of ${totalRows} sessions`
        : `${totalRows} session${totalRows === 1 ? "" : "s"} stored locally`;

  const clearFilters = useCallback((): void => {
    setSearch("");
    setSessionModeFilter("all");
    searchRef.current?.focus();
  }, [setSessionModeFilter]);

  const handleSelect = useCallback(
    (id: string): void => {
      // Row click closes the Sessions page and opens the session.
      setActiveSessionId(id);
      setShellRoute({ kind: "none" });
    },
    [setActiveSessionId, setShellRoute],
  );

  return (
    <div
      className="flex w-full flex-col"
      data-vex-screen="sessions-library"
      aria-label="Sessions library"
    >
      {/* The register counter sits under the page head, a figure line in the
       * mono at 13 muted. */}
      <p
        aria-live="polite"
        aria-atomic="true"
        className="vex-num m-0 mb-[22px] text-[13px] leading-[1.4] text-ink-tertiary"
      >
        {countLabel}
      </p>

      <div
        data-vex-sessions-library-toolbar
        className="mb-3.5 flex flex-wrap items-center gap-2.5"
      >
        <div className="relative min-w-[220px] max-w-[340px] flex-1">
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search session titles"
            aria-label="Search session titles"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full border border-line-input bg-surface-field pl-3 pr-14 text-[14px] text-ink-primary placeholder:text-ink-tertiary focus-visible:border-accent-primary focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {searchActive ? (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] font-medium text-accent-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div
          role="group"
          aria-label="Filter sessions by mode"
          className="vex-seg"
        >
          {SESSION_MODE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={sessionModeFilter === filter.value}
              onClick={() => setSessionModeFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {query.isLoading ? (
        <EmptyBlock scope="Sessions" title="Loading sessions" loading />
      ) : query.data && query.data.ok === false ? (
        <EmptyBlock
          scope="Sessions"
          state="error"
          title={query.data.error.message}
        />
      ) : totalRows === 0 ? (
        <EmptyBlock
          scope="Sessions"
          title="Create a session from the sidebar to get started."
        />
      ) : visibleRows === 0 ? (
        <EmptyBlock
          scope="Sessions"
          title="No sessions match your current search and filters."
          action={{ label: "Reset filters", onClick: clearFilters }}
        />
      ) : (
        <>
          <LibraryGroups
            groups={groups}
            activeSessionId={activeSessionId}
            onSelect={handleSelect}
            onTogglePin={handleTogglePin}
            onRequestRemove={handleRequestRemove}
            onRename={handleRename}
            pendingPinId={pendingPinId}
            idPrefix="library-sessions"
          />
          <p className="m-0 mt-[18px] text-[13px] leading-[1.5] text-ink-tertiary">
            {LIBRARY_KEYS_NOTE}
          </p>
        </>
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
    </div>
  );
}
