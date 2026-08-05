import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  PlusIcon,
  XIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  VexIcon,
} from "../../components/icons/index.js";
import type {
  SessionDeleteOutcome,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import { cn } from "../../lib/utils.js";
import {
  useDeleteSession,
  useSessionsList,
  useSetSessionPinned,
} from "../../lib/api/sessions.js";
import { useUiStore } from "../../stores/uiStore.js";
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
import { computeVisibleGroups } from "./sessionListLayout.js";

interface SessionsListProps {
  readonly onCreate: () => void;
}

export function SessionsList({ onCreate }: SessionsListProps): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const sessionModeFilter = useUiStore((s) => s.sessionModeFilter);
  const setSessionModeFilter = useUiStore((s) => s.setSessionModeFilter);
  // Signing-stroke state for the New-session key: SessionCreator drives
  // the transitions; this component only renders ink + glint.
  const signingState = useUiStore((s) => s.signingState);
  const setSigningState = useUiStore((s) => s.setSigningState);
  const query = useSessionsList();
  const pinMutation = useSetSessionPinned();
  const deleteMutation = useDeleteSession();
  // TanStack Query exposes the last variables sent to the mutation; we
  // use it to disable the star button on the in-flight row only.
  const pendingPinId =
    pinMutation.isPending && pinMutation.variables
      ? pinMutation.variables.id
      : null;
  const [removeTarget, setRemoveTarget] = useState<SessionListItem | null>(null);
  const [removeBlocked, setRemoveBlocked] =
    useState<SessionDeleteOutcome | null>(null);

  // Rail search (Chronos): a title filter over the SAME resolved titles the
  // rows render (`filterSessionsByTitle`), toggled by the header magnifier.
  // Local, launch-ephemeral state — closing the field clears the filter.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);

  useEffect((): void => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect((): (() => void) | undefined => {
    const el = scrollContainerRef.current;
    if (el === null) return undefined;
    // jsdom (tests) does not implement ResizeObserver. We leave
    // containerHeight at 0 so computeVisibleGroups returns the full list.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleRows = useMemo(() => {
    if (!query.data?.ok) return [];
    const byMode = filterSessionsByMode(query.data.data, sessionModeFilter);
    return searchOpen ? filterSessionsByTitle(byMode, searchText) : byMode;
  }, [query.data, sessionModeFilter, searchOpen, searchText]);

  const groups = useMemo(() => groupSessions(visibleRows), [visibleRows]);

  // hiddenCount is intentionally dropped: the retired "Browse all" row was
  // its only consumer — overflow now lives on the Sessions screen.
  const { visible: visibleGroups } = useMemo(
    () => computeVisibleGroups(groups, containerHeight),
    [groups, containerHeight],
  );

  const handleSelect = useCallback(
    (id: string): void => {
      // The center panel is always the session panel (Chronos screens
      // redesign) — selecting a row only needs to point it at the session.
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

  const toggleSidebar = useCallback((): void => {
    setSidebarOpen(!sidebarOpen);
  }, [setSidebarOpen, sidebarOpen]);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
  }, []);

  // The magnifier on a collapsed rail expands it first — a search field has
  // no room on the 72px spine (the ChatGPT-sidebar gesture).
  const toggleSearch = useCallback((): void => {
    if (!sidebarOpen) {
      setSidebarOpen(true);
      setSearchOpen(true);
      return;
    }
    if (searchOpen) {
      closeSearch();
    } else {
      setSearchOpen(true);
    }
  }, [sidebarOpen, searchOpen, setSidebarOpen, closeSearch]);

  return (
    <aside
      className={cn(
        // Rail over the Eclipse backdrop: softer translucent ink (--vex-rail)
        // so the artwork shows through and the sidebar merges with the center
        // column into ONE canvas — pure glass, NO separating stroke of any
        // kind (owner review round 2: even the edge-fading hairline still
        // read as a dividing line). Backdrop-blur stays guard-whitelisted for
        // this rail. z-20 (one step above the center section's z-10) so the
        // profile menu — wider than the rail by design — paints ABOVE the
        // center column where it overflows instead of sliding under the
        // later flex sibling. NO overflow clipping on this aside for the
        // same reason. macOS-clean ink glass (owner decree, 2026-07-20): the
        // rail carries ONLY the ink tint + blur, no grain overlay — a prior
        // grain layer greyed the glass out and is retired.
        "relative z-20 flex h-full shrink-0 flex-col bg-[var(--vex-rail)] backdrop-blur-xl transition-[width] duration-300 ease-[var(--vex-ease-out)]",
        sidebarOpen ? "w-[296px]" : "w-[72px]",
      )}
      data-vex-area="sessions-sidebar"
      data-vex-sidebar-open={sidebarOpen ? "true" : "false"}
    >
      <header
        className={cn(
          // Owner decree — uniform sidebar glass: the header no longer
          // carries its own rail-strong fill; it shares the aside's own
          // bg-[var(--vex-rail)] so the whole rail reads as ONE glass tint,
          // not a stronger strip sitting over a softer body.
          // Chronos grammar (the ChatGPT/Grok sidebar reference): the mark
          // sits LEFT as the sole brand (doubling as "Back to welcome" —
          // SidebarHomeSigil), the magnifier + collapse arrow sit RIGHT.
          // Collapsed, the spine stacks mark → magnifier → expand arrow.
          "relative flex shrink-0",
          sidebarOpen
            ? "h-12 items-center justify-between px-3"
            : "flex-col items-center justify-center gap-0.5 px-2 py-2",
        )}
      >
        <SidebarHomeSigil sidebarOpen={sidebarOpen} />
        <div
          className={cn(
            "flex items-center",
            sidebarOpen ? "gap-0.5" : "flex-col gap-0.5",
          )}
        >
          <SidebarIconButton
            label={searchOpen ? "Close session search" : "Search sessions"}
            onClick={toggleSearch}
          >
            <VexIcon icon={SearchIcon} size={16} aria-hidden />
          </SidebarIconButton>
          <SidebarIconButton
            label={sidebarOpen ? "Collapse sessions sidebar" : "Expand sessions sidebar"}
            onClick={toggleSidebar}
          >
            <VexIcon
              icon={sidebarOpen ? PanelLeftCloseIcon : PanelLeftOpenIcon}
              size={17}
              aria-hidden
            />
          </SidebarIconButton>
        </div>
      </header>

      {sidebarOpen && searchOpen ? (
        // Search field — glass well under the brand strip. Escape (or the
        // clear button on an empty query) closes and clears; typing filters
        // the rail live via filterSessionsByTitle.
        <div className="px-3 pt-3">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--vex-line-strong)] bg-white/[0.04] px-2.5 transition-colors focus-within:border-[var(--vex-accent-border)]">
            <VexIcon
              icon={SearchIcon}
              size={14}
              aria-hidden
              className="shrink-0 text-[var(--vex-text-3)]"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="Search sessions"
              aria-label="Search sessions"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-[var(--vex-text-3)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={closeSearch}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--vex-text-3)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
            >
              <VexIcon icon={XIcon} size={12} aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      <div className={cn("p-3", !sidebarOpen && "px-2")}>
        {/* The signing key: the sidebar's primary CTA — the landing's filled
         * cobalt pill (mono uppercase micro-type, radius 100px), standing
         * alone (owner decree, 2026-07-20: the "signing key on a plinth"
         * story is retired — no hairline or accent tick behind the pill).
         * The signing mechanics are unchanged: the ink stroke draws on
         * hover/focus (globals.css owns the draw) and loops while
         * SessionCreator's mutation is in flight; the glint is the one-shot
         * success light. Both paint the accent-contrast ink. */}
        <div>
          <button
            type="button"
            onClick={onCreate}
            aria-label="New session"
            className={cn(
              "vex-sign-key relative flex h-10 items-center justify-center gap-2 rounded-full bg-[var(--vex-accent)] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--vex-accent-contrast)] transition-colors duration-150",
              "hover:bg-[var(--vex-accent-hover)]",
              "active:scale-[0.99] active:bg-[var(--vex-accent-active)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--vex-surface-1)]",
              sidebarOpen ? "w-full px-4" : "mx-auto w-10",
            )}
          >
            <VexIcon icon={PlusIcon} size={15} aria-hidden />
            {sidebarOpen ? <span>New session</span> : null}
            <span
              aria-hidden
              className={cn(
                "vex-sign-stroke absolute bottom-[6px] h-[1.5px] rounded-full bg-[color-mix(in_oklab,var(--vex-accent-contrast)_90%,transparent)]",
                sidebarOpen ? "inset-x-4" : "inset-x-3",
                signingState === "signing" && "vex-sign-stroke--signing",
              )}
            />
            {signingState === "signed" ? (
              <span
                aria-hidden
                onAnimationEnd={() => setSigningState("idle")}
                className="vex-intro-glint absolute bottom-[3px] right-4 h-1.5 w-1.5 rounded-full bg-[var(--vex-accent-contrast)]"
              />
            ) : null}
          </button>
        </div>
      </div>

      {sidebarOpen ? (
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
                  // Landing micro-label grammar: mono 9.5px, wide-tracked,
                  // accent underline carries the active state.
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

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-hidden px-2 py-3"
      >
        {query.isLoading ? (
          <SessionsLoadingPlaceholder sidebarOpen={sidebarOpen} />
        ) : query.data && query.data.ok === false ? (
          <SessionsErrorPlaceholder
            sidebarOpen={sidebarOpen}
            message={query.data.error.message}
          />
        ) : query.data && query.data.ok ? (
          visibleRows.length === 0 ? (
            <SessionsEmptyPlaceholder sidebarOpen={sidebarOpen} />
          ) : (
            <SessionGroups
              groups={visibleGroups}
              activeSessionId={activeSessionId}
              sidebarOpen={sidebarOpen}
              onSelect={handleSelect}
              onTogglePin={handleTogglePin}
              onRequestRemove={handleRequestRemove}
              pendingPinId={pendingPinId}
              idPrefix="sidebar-sessions"
            />
          )
        ) : null}
      </div>

      {/* The "Browse all" ledger row is retired (Chronos screens redesign):
       * the full register now lives on the Sessions screen, opened from the
       * profile menu. `hiddenCount` from computeVisibleGroups still trims the
       * rail to its visible budget. */}

      {/* LIVE $VEX — the slim market widget (price · shimmer delta ·
       * sparkline) rides the rail between the session groups and the profile
       * footer. Hidden when the rail is collapsed: the icon-only rail has no
       * room for a price figure. */}
      {sidebarOpen ? (
        <div className="border-t border-[var(--vex-line)] px-3 py-3">
          <VexTokenCardCompact />
        </div>
      ) : null}

      {/* Footer — the Chronos profile element: one avatar row whose side-panel
       * menu owns Personalize / Memory / Sessions / How Vex works / Settings
       * and the runtime status row.
       * Report issue intentionally hidden for now; ReportIssueButton/Dialog
       * retained for re-enable. */}
      <footer className="flex flex-col">
        <SidebarProfile sidebarOpen={sidebarOpen} />
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
