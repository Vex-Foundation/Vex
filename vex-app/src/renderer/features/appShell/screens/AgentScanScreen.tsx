/**
 * AGENT SCAN — the full-history ledger of everything Vex has executed
 * on-chain, opened from the profile menu (the whole feed) or from a BOOK
 * rail's Activity card, PRESET to that rail's scope: one session, or one Vex
 * Studio project's own wallets. The preset is a scope, not a user filter - it
 * survives Clear and shows as its own non-clearable chip.
 *
 * Where `TokenHistoryScreen` answers "what happened to THIS token?", this
 * screen answers "what has the agent DONE?" — every `agent_activity` row,
 * newest first, filterable, each carrying its receipt.
 *
 * VIRTUALIZED (`@tanstack/react-virtual`). This is an unbounded feed: it pages
 * forever and must never retain a DOM node per fetched row, or a long-running
 * install's audit page becomes the slowest surface in the app. Only the
 * visible window (plus a small overscan) is mounted; row heights are MEASURED
 * rather than assumed, because a row grows when its audit detail expands.
 *
 * The screen is the GATE only — filters, query, states matrix, windowing.
 * Row rendering, the audit detail, and the honest field readers live beside it
 * in `agent-scan/`.
 *
 * FAIL-CLOSED STATES, following the token-history precedent exactly: a page
 * that timed out arrives as `"unavailable"` and renders the calm try-again
 * note, NEVER the empty state — a timeout must not read as "the agent has done
 * nothing". An empty result while FILTERS ARE ACTIVE says so explicitly, so a
 * narrowed feed is never mistaken for an empty history.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentScanDto, AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import { useAgentScanInfinite } from "../../../lib/api/portfolio.js";
import { useProject } from "../../../lib/api/projects.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import type { AgentScanRouteScope } from "../../../stores/uiStore/shell-route.js";
import { ShellScreen } from "./ShellScreen.js";
import {
  activeFilterCount,
  AgentScanFilterBar,
  EMPTY_FILTER_STATE,
  isFeedNarrowed,
  toAgentScanFilters,
  type AgentScanFilterState,
} from "./agent-scan/AgentScanFilterBar.js";
import { AgentScanRow } from "./agent-scan/AgentScanRow.js";
import { dayKey, dayLabel } from "./agent-scan/agent-scan-display.js";

const SCREEN_TITLE = "Agent Scan";

/**
 * Header subtitle - it must say when, and to WHAT, the feed is narrowed.
 * Exhaustive over the scope union: a new member is a compile error rather than
 * a narrowed feed described as the whole history.
 */
function screenSubtitle(scope: AgentScanRouteScope): string {
  switch (scope.kind) {
    case "global":
      return "Every action Vex executed on-chain, newest first - each row links to its transaction.";
    case "session":
      return "Everything Vex executed on-chain in THIS session, newest first - each row links to its transaction.";
    case "project":
      return "Everything Vex executed on-chain with THIS project's wallets, newest first - each row links to its transaction.";
  }
}

/** Starting height guess per row; real heights are measured after mount. */
const ESTIMATED_ROW_PX = 56;

/** Rows kept mounted beyond the visible window, to cover fast scrolling. */
const OVERSCAN_ROWS = 8;

/** A day divider or one activity — the flat list the virtualizer indexes. */
type FeedRow =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "entry"; readonly key: string; readonly entry: AgentScanEntry };

/** Narrow one query page to its available payload, else null. */
function availablePage(
  page: Result<AgentScanDto> | undefined,
): Extract<AgentScanDto, { status: "available" }> | null {
  if (page === undefined || !page.ok) return null;
  return page.data.status === "available" ? page.data : null;
}

/**
 * Flatten entries into day-grouped rows. Grouping happens HERE, not in the
 * render tree, so the virtualizer can index dividers and rows uniformly —
 * a nested "group → rows" tree cannot be windowed.
 */
function buildFeedRows(entries: readonly AgentScanEntry[]): readonly FeedRow[] {
  const rows: FeedRow[] = [];
  let currentDay: string | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.createdAt);
    if (key !== currentDay) {
      currentDay = key;
      rows.push({ kind: "day", key: `day:${key}`, label: dayLabel(entry.createdAt) });
    }
    rows.push({ kind: "entry", key: `entry:${entry.id}`, entry });
  }
  return rows;
}

export function AgentScanScreen({
  origin,
  scope,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /**
   * SCOPE PRESET - `global` opens the full feed, `session` narrows the read to
   * one session and `project` to one Vex Studio project's own wallets. It
   * seeds the filter state once and is preserved across every filter change
   * and across Clear (`AgentScanFilterBar`), so the scope the caller asked for
   * cannot be lost mid-session. `ShellScreens` remounts this screen when the
   * scope changes, which is why seeding once is safe.
   */
  readonly scope: AgentScanRouteScope;
  readonly onClose: () => void;
}): JSX.Element {
  const [filterState, setFilterState] = useState<AgentScanFilterState>(() => ({
    ...EMPTY_FILTER_STATE,
    scope,
  }));

  // A LABEL for the scope chip, nothing more: it never reaches the read, which
  // is narrowed by the project ID in main. Disabled for every other scope.
  const projectQuery = useProject(scope.kind === "project" ? scope.projectId : null);
  const projectName =
    projectQuery.data !== undefined &&
    projectQuery.data.ok &&
    projectQuery.data.data !== null
      ? projectQuery.data.data.name
      : null;

  // Memoized on the selection: the filters object is part of the query key, so
  // a fresh object per render would refetch the whole feed every render.
  const filters = useMemo(() => toAgentScanFilters(filterState), [filterState]);
  const query = useAgentScanInfinite(filters);

  const pages = query.data?.pages ?? [];
  const firstPage = pages[0];
  const entries = pages.flatMap((page) => availablePage(page)?.entries ?? []);
  const rows = useMemo(() => buildFeedRows(entries), [entries]);

  // A LATER page can fail or time out after rows already rendered — pagination
  // stops and a quiet note appears instead of wiping the feed.
  const lastPage = pages.length > 1 ? pages[pages.length - 1] : undefined;
  const laterPageDegraded =
    lastPage !== undefined && (!lastPage.ok || lastPage.data.status !== "available");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN_ROWS,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // Infinite scroll: reaching the last windowed row pulls the next page.
  const lastVirtualIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;
  useEffect(() => {
    if (lastVirtualIndex < rows.length - 1) return;
    if (!hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [lastVirtualIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const onFiltersChange = useCallback((next: AgentScanFilterState): void => {
    setFilterState(next);
    // A new query means a new list — start it at the top rather than leaving
    // the user mid-feed at an offset that no longer means anything. Plain
    // property assignment, not `scrollTo`: it needs no smooth-scroll support
    // and works in every environment the renderer is exercised in.
    const scroller = scrollRef.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, []);

  // Includes the session preset: an empty SESSION feed must read as "nothing
  // in this session", never as "the agent has never done anything".
  const filtersActive = isFeedNarrowed(filterState);
  const scopeNarrowed = scope.kind !== "global";

  let body: JSX.Element;
  if (query.isLoading) {
    body = <FeedNote tone="quiet">Loading…</FeedNote>;
  } else if (firstPage !== undefined && !firstPage.ok) {
    body = <FeedNote tone="warn">Couldn&apos;t load activity.</FeedNote>;
  } else if (
    firstPage !== undefined &&
    firstPage.ok &&
    firstPage.data.status === "unavailable"
  ) {
    // Timeout degradation: NEVER rendered as an empty history.
    body = (
      <FeedNote tone="calm">
        Activity is unavailable right now - try again shortly.
      </FeedNote>
    );
  } else if (query.isError) {
    body = <FeedNote tone="warn">Couldn&apos;t load activity.</FeedNote>;
  } else if (rows.length === 0) {
    body = filtersActive ? (
      // A narrowed feed must never read as an empty history.
      <FeedNote tone="quiet">
        {scopeNarrowed && activeFilterCount(filterState) === 0
          ? scope.kind === "project"
            ? "Vex hasn't executed anything on-chain for this project yet."
            : "Vex hasn't executed anything on-chain in this session yet."
          : "No activity matches these filters."}
      </FeedNote>
    ) : (
      <FeedNote tone="quiet">
        No activity recorded yet - everything Vex executes appears here.
      </FeedNote>
    );
  } else {
    body = (
      <ul
        aria-label="Activity"
        className="relative w-full list-none"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) return null;
          return (
            <li
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.kind === "day" ? (
                <div className="flex items-center gap-3 pb-1.5 pt-4">
                  <span className="shrink-0 vex-micro-label vex-micro-label--wide uppercase text-ink-secondary">
                    {row.label}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-line-2" />
                </div>
              ) : (
                <AgentScanRow entry={row.entry} />
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ShellScreen
      title={SCREEN_TITLE}
      origin={origin}
      onClose={onClose}
      header={
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-display text-[26px] font-medium leading-8 text-ink-primary">
            {SCREEN_TITLE}
          </h1>
          <p className="text-[11.5px] leading-snug text-ink-tertiary">
            {screenSubtitle(scope)}
          </p>
        </div>
      }
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col gap-3">
        <AgentScanFilterBar
          state={filterState}
          onChange={onFiltersChange}
          projectName={projectName}
        />
        <div ref={scrollRef} className="vex-scroll min-h-0 flex-1 overflow-y-auto">
          {body}
          {laterPageDegraded ? (
            <p className="mt-2 text-[11px] text-ink-tertiary">
              Couldn&apos;t load more activity right now.
            </p>
          ) : null}
          {hasNextPage ? (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mt-3 w-full rounded-xl border border-line-2 py-1.5 vex-micro-label uppercase text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-60"
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      </div>
    </ShellScreen>
  );
}

/** The screen's non-list states, in one voice. */
function FeedNote({
  tone,
  children,
}: {
  readonly tone: "quiet" | "calm" | "warn";
  readonly children: React.ReactNode;
}): JSX.Element {
  if (tone === "warn") {
    return <p className="text-[12.5px] text-warning-label">{children}</p>;
  }
  if (tone === "calm") {
    return (
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">
        {children}
      </p>
    );
  }
  return (
    <p className="text-[12.5px] leading-relaxed text-ink-tertiary">
      {children}
    </p>
  );
}
