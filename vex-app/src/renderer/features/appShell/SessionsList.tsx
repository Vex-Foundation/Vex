/**
 * Sessions sidebar column. Width comes from the shell grid track (AppShell +
 * lib/shell-columns.ts); this component owns the collapse CHOREOGRAPHY, not
 * the geometry: on collapse the content freezes at its expanded width
 * (inline style) and fades in place for 150ms while the sliding track clips
 * it, then the rail controls enter the 56px spine from the same horizontal
 * offset (translateX(49px), backwards fill) over the transition's second
 * half. A cold-collapsed render is static; expand remounts wide content on a
 * 200ms fade (asymmetry is deliberate). Scrollbars in the column follow the
 * pointer: `useQuietScrollbars` rebinds the scrollbar indirection pair away
 * while the pointer is elsewhere (2s linger).
 *
 * The rail reads the shell backdrop through its glass tint (--vex-rail,
 * guard-whitelisted backdrop-blur) — no separating stroke.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  IconClose,
  IconPanelLeft,
  IconPlus,
  IconSearch,
} from "../../components/icons/index.js";
import type {
  SessionDeleteOutcome,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import { cn } from "../../lib/utils.js";
import {
  useDeleteSession,
  useRenameSession,
  useSessionsList,
  useSetSessionPinned,
} from "../../lib/api/sessions.js";
import { useCollapseChoreography } from "../../lib/useCollapseChoreography.js";
import { useQuietScrollbars } from "../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import { useUiStore } from "../../stores/uiStore.js";
import { RailSearchField } from "../../components/ui/rail-list.js";
import { SessionDeleteDialog } from "./SessionDeleteDialog.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";
import { SidebarProfile } from "./SidebarProfile.js";
import { VexTokenCardCompact } from "./market/VexTokenCardCompact.js";
import {
  SessionGroups,
  SessionsEmptyPlaceholder,
  SessionsErrorPlaceholder,
  SessionsLoadingPlaceholder,
  SidebarIconButton,
} from "./SessionRows.js";
import {
  filterSessionsByMode,
  filterSessionsByTitle,
  groupSessions,
  SESSION_MODE_FILTERS,
} from "./sessionListModel.js";

interface SessionsListProps {
  readonly onCreate: () => void;
  /** Rail state decided by the shell frame (breakpoint-aware). */
  readonly collapsed: boolean;
  /** Rendered track width from the concession solve. */
  readonly width: number;
  readonly onToggleSidebar: () => void;
}

export function SessionsList({
  onCreate,
  collapsed,
  width,
  onToggleSidebar,
}: SessionsListProps): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const sessionModeFilter = useUiStore((s) => s.sessionModeFilter);
  const setSessionModeFilter = useUiStore((s) => s.setSessionModeFilter);
  // Signing-stroke state for the New-session key: SessionCreator drives
  // the transitions; this component only renders ink + glint.
  const signingState = useUiStore((s) => s.signingState);
  const setSigningState = useUiStore((s) => s.setSigningState);
  const query = useSessionsList();
  const pinMutation = useSetSessionPinned();
  const deleteMutation = useDeleteSession();
  const renameMutation = useRenameSession();
  // TanStack Query exposes the last variables sent to the mutation; we
  // use it to disable the star button on the in-flight row only.
  const pendingPinId =
    pinMutation.isPending && pinMutation.variables
      ? pinMutation.variables.id
      : null;
  const [removeTarget, setRemoveTarget] = useState<SessionListItem | null>(null);
  const [removeBlocked, setRemoveBlocked] =
    useState<SessionDeleteOutcome | null>(null);

  // Wide content stays mounted while a live collapse fades, unmounts at
  // settle, remounts right away on expand; the frozen width keeps the
  // sliding track clipping instead of reflowing (lib/useCollapseChoreography).
  const { wide, fading, railIn, frozenWidth } = useCollapseChoreography(
    collapsed,
    width,
  );

  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } =
    useQuietScrollbars(columnRef);
  // The browsing region is the column's one scroller; it carries the overlay
  // treatment like the other three long lists.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  // Rail search: a title filter over the SAME resolved titles the rows
  // render, toggled by the header magnifier. Local, launch-ephemeral state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect((): void => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const visibleRows = useMemo(() => {
    if (!query.data?.ok) return [];
    const byMode = filterSessionsByMode(query.data.data, sessionModeFilter);
    return searchOpen ? filterSessionsByTitle(byMode, searchText) : byMode;
  }, [query.data, sessionModeFilter, searchOpen, searchText]);

  const groups = useMemo(() => groupSessions(visibleRows), [visibleRows]);

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  const handleTogglePin = useCallback(
    (id: string, nextPinned: boolean): void => {
      pinMutation.mutate({ id, pinned: nextPinned });
    },
    [pinMutation],
  );

  const handleRename = useCallback(
    (id: string, name: string): void => {
      renameMutation.mutate({ id, name });
    },
    [renameMutation],
  );

  const handleRequestRemove = useCallback((row: SessionListItem): void => {
    setRemoveTarget(row);
    setRemoveBlocked(null);
  }, []);

  const handleCancelRemove = useCallback((): void => {
    setRemoveTarget(null);
    setRemoveBlocked(null);
  }, []);

  const handleConfirmRemove = useCallback(async (): Promise<void> => {
    if (removeTarget === null) return;
    const result = await deleteMutation.mutateAsync({ id: removeTarget.id });
    if (!result.ok) {
      setRemoveBlocked("state_changed");
      return;
    }
    const outcome = result.data.outcome;
    if (
      outcome === "removed" ||
      outcome === "not_found" ||
      outcome === "already_removed"
    ) {
      setRemoveTarget(null);
      setRemoveBlocked(null);
      return;
    }
    // blocked_active_mission | blocked_pending_approval | state_changed
    setRemoveBlocked(outcome);
  }, [deleteMutation, removeTarget]);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
  }, []);

  // The magnifier on a collapsed rail expands it first — a search field has
  // no room on the 56px spine.
  const toggleSearch = useCallback((): void => {
    if (collapsed) {
      onToggleSidebar();
      setSearchOpen(true);
      return;
    }
    if (searchOpen) {
      closeSearch();
    } else {
      setSearchOpen(true);
    }
  }, [collapsed, searchOpen, onToggleSidebar, closeSearch]);

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        // Glass over the shell backdrop: translucent ink (--vex-rail) +
        // guard-whitelisted backdrop-blur; NO separating stroke.
        "vex-sidebar relative flex h-full flex-col bg-[var(--vex-rail)] backdrop-blur-xl",
        fading && "vex-sidebar-fading",
        railIn && "vex-sidebar-rail-in",
        quiet && "vex-quiet-bars",
      )}
      style={wide ? { width: collapsed ? frozenWidth : "100%" } : undefined}
      data-vex-area="sessions-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
    >
      <header
        className={cn(
          // The mark sits LEFT as the sole brand (doubling as "Back to
          // welcome"), the magnifier + collapse arrow sit RIGHT. Collapsed,
          // the spine stacks mark → magnifier → expand arrow.
          "relative flex shrink-0",
          wide
            ? "h-12 items-center justify-between px-3"
            : "flex-col items-center justify-center gap-0.5 px-2 py-2",
        )}
      >
        <SidebarHomeSigil sidebarOpen={wide} />
        <div
          className={cn(
            "flex items-center",
            wide ? "gap-0.5" : "flex-col gap-0.5",
          )}
          data-rail-control
        >
          <SidebarIconButton
            label={searchOpen ? "Close session search" : "Search sessions"}
            onClick={toggleSearch}
          >
            <IconSearch size={16} />
          </SidebarIconButton>
          <SidebarIconButton
            label={collapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"}
            onClick={onToggleSidebar}
          >
            <IconPanelLeft size={17} />
          </SidebarIconButton>
        </div>
      </header>

      {wide && searchOpen ? (
        <div className="px-3 pt-1 pb-2">
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
            icon={<IconSearch size={14} />}
            closeIcon={<IconClose size={12} />}
          />
        </div>
      ) : null}

      <div className={cn("p-3", !wide && "px-2")} data-rail-control>
        {/* The signing key: the sidebar's primary CTA — the app's one
         * accent-FILLED key, so it wears the accent-CTA pair (owner decision
         * 3, ratified 2026-08-21) rather than the accent-as-text family: a
         * deep brand-blue plate with white ink under chronos, a light accent
         * plate with near-black ink under celeris. Label is the app-wide
         * small-caps register; the old `font-mono` uppercase micro-label was
         * the last one of its kind in the rail.
         * The signing mechanics are unchanged: the ink stroke draws on
         * hover/focus and loops while SessionCreator's mutation is in
         * flight; the glint is the one-shot success light. */}
        <button
          type="button"
          onClick={onCreate}
          aria-label="New session"
          className={cn(
            "vex-sign-key vex-micro-label vex-micro-label--wide relative flex h-10 items-center justify-center gap-2 rounded-full bg-button-accent uppercase text-ink-on-button-accent transition-colors duration-150",
            "hover:bg-button-accent-hover",
            "active:scale-[0.99] active:bg-button-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--vex-surface-1)]",
            wide ? "w-full px-4" : "mx-auto w-10",
          )}
        >
          <IconPlus size={15} />
          {wide ? <span>New session</span> : null}
          <span
            aria-hidden
            className={cn(
              "vex-sign-stroke absolute bottom-[6px] h-[1.5px] rounded-full bg-[color-mix(in_oklab,var(--color-ink-on-button-accent)_90%,transparent)]",
              wide ? "inset-x-4" : "inset-x-3",
              signingState === "signing" && "vex-sign-stroke--signing",
            )}
          />
          {signingState === "signed" ? (
            <span
              aria-hidden
              onAnimationEnd={() => setSigningState("idle")}
              className="vex-intro-glint absolute bottom-[3px] right-4 h-1.5 w-1.5 rounded-full bg-ink-on-button-accent"
            />
          ) : null}
        </button>
      </div>

      {wide ? (
        <div
          role="tablist"
          aria-label="Filter sessions"
          className="flex items-end gap-5 border-b border-[var(--vex-line)] px-3"
        >
          {SESSION_MODE_FILTERS.map((filter) => {
            const active = sessionModeFilter === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSessionModeFilter(filter.value)}
                className={cn(
                  "relative pb-2 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.2em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
                  active
                    ? "text-foreground"
                    : "text-[var(--vex-text-3)] hover:text-foreground",
                )}
              >
                {filter.label}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--vex-accent)]"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The browsing region scrolls; quiet bars keep the scrollbar a pointer
       * affordance. (The fit-to-height packer is retired with the rebuild —
       * every row is reachable in place; the Sessions screen remains the
       * full register.) */}
      <div
        ref={listScrollRef}
        // `overflow-x-clip`: a bare `overflow-y-auto` computes overflow-x to
        // `auto`, so any row that overshoots the rail width draws a
        // horizontal bar along the bottom of the column.
        className="vex-scroll vex-scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-clip px-2 py-3"
        data-rail-control
      >
        {query.isLoading ? (
          <SessionsLoadingPlaceholder sidebarOpen={wide} />
        ) : query.data && query.data.ok === false ? (
          <SessionsErrorPlaceholder
            sidebarOpen={wide}
            message={query.data.error.message}
          />
        ) : query.isError ? (
          // A TRANSPORT rejection never produces a Result, so without this
          // branch it fell through to `null` and the rail went blank - a lie
          // by omission (rule 08: failure is a distinct state, not emptiness).
          <SessionsErrorPlaceholder
            sidebarOpen={wide}
            message="Vex could not read your sessions."
          />
        ) : query.data && query.data.ok ? (
          visibleRows.length === 0 ? (
            <SessionsEmptyPlaceholder sidebarOpen={wide} />
          ) : (
            <SessionGroups
              groups={groups}
              activeSessionId={activeSessionId}
              sidebarOpen={wide}
              onSelect={handleSelect}
              onTogglePin={handleTogglePin}
              onRequestRemove={handleRequestRemove}
              onRename={handleRename}
              pendingPinId={pendingPinId}
              idPrefix="sidebar-sessions"
            />
          )
        ) : null}
      </div>

      {/* LIVE $VEX — the slim market widget rides the rail between the
       * session groups and the profile footer. Hidden on the rail: the
       * icon-only spine has no room for a price figure. */}
      {wide ? (
        <div className="border-t border-[var(--vex-line)] px-3 py-3">
          <VexTokenCardCompact />
        </div>
      ) : null}

      {/* Footer — the profile element; the collapsed spine keeps the avatar
       * and only fades (no horizontal entry), matching the reference foot. */}
      <footer className="flex flex-col" data-rail-foot>
        <SidebarProfile sidebarOpen={wide} />
      </footer>

      <SessionDeleteDialog
        session={removeTarget}
        blockedOutcome={removeBlocked}
        pending={deleteMutation.isPending}
        onCancel={handleCancelRemove}
        onConfirm={() => {
          void handleConfirmRemove();
        }}
      />
    </aside>
  );
}
