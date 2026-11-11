/**
 * Public session-list building blocks: the left sidebar's grouped sessions
 * (`SidebarSessionGroups`, docs/design/R3-MINIMAL.md section 4), the Sessions
 * library's grouped register (`SessionGroups`, on the generic RailGroup and
 * RailRow primitives), the loading, error and empty placeholders, and the
 * small `SidebarIconButton`. The chats column and the chats panel speak their
 * list's states in H3's own lines (`ChatsLoadingLine`, `ChatsFailedLine`,
 * `ChatsEmptyLine`); the Lighter desk's drawer keeps the placeholders until
 * its own restyle. Both lists render the shared `SessionRow`, in
 * its `sidebar` and `register` settings. The presentational internals (the
 * row, its pin and remove keys, the hover-card body, the search mode, the
 * nav and the shared placeholder strip) live as co-located subcomponents
 * under `./SessionRows/`.
 */

import { useEffect, useState, type JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { Button } from "../../components/ui/button.js";
import { StateSquare } from "../../components/ui/state-square.js";
import { Swatch } from "../../components/ui/swatch.js";
import { RailGroup } from "../../components/ui/rail-list.js";
import { type SessionGroup } from "./sessionListModel.js";
import { ListPlaceholder } from "./SessionRows/ListPlaceholder.js";
import { SessionRow } from "./SessionRows/SessionRow.js";

interface SessionGroupsProps {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  /** Inline-rename persist; omit to disable double-click rename (library). */
  readonly onRename?: (id: string, name: string) => void;
  readonly pendingPinId: string | null;
  /**
   * Namespace for `<section aria-labelledby>` / `<h2 id>` pairs so the
   * sidebar and the library view can coexist on the same page without
   * duplicate IDs. Required because both screens render `SessionGroups`
   * with the same group keys (pinned/today/yesterday/earlier).
   */
  readonly idPrefix: string;
}

interface SidebarSessionGroupsProps {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly pendingPinId: string | null;
  /** The sidebar search's text, marked in each title. */
  readonly highlight: string;
  /**
   * A query is applied: the groups are the search's results, and they are
   * named so (VEX Cloud's `aria-label="Search results"`).
   */
  readonly searching?: boolean;
}

/**
 * The chats column's chats (docs/design/H3-DESKTOP.md section 1.4), under
 * the column's CHATS heading: "Pinned", "Today", "Yesterday", "Earlier", each
 * a group head (12, caps, tracked, muted) over its rows on the 36 pitch.
 * Empty groups are not drawn. The heads are level 3, under the CHATS heading
 * (`SessionsList`), which is level 2.
 */
export function SidebarSessionGroups({
  groups,
  activeSessionId,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pendingPinId,
  highlight,
  searching = false,
}: SidebarSessionGroupsProps): JSX.Element {
  return (
    <div
      className="vex-ls-groups"
      role={searching ? "group" : undefined}
      aria-label={searching ? SEARCH_RESULTS_LABEL : undefined}
    >
      {groups.map((group) => {
        if (group.rows.length === 0) return null;
        const headingId = `ls-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h3 id={headingId} className="vex-ls-group">
              {group.title}
            </h3>
            <ul className="vex-ls-group__rows">
              {group.rows.map((row) => (
                <li key={row.id}>
                  <SessionRow
                    row={row}
                    variant="sidebar"
                    selected={row.id === activeSessionId}
                    highlight={highlight}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onRequestRemove={onRequestRemove}
                    onRename={onRename}
                    pinPending={pendingPinId === row.id}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function SessionGroups({
  groups,
  activeSessionId,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pendingPinId,
  idPrefix,
}: SessionGroupsProps): JSX.Element {
  return (
    // gap-3 (12px) between sections; rows inside a group sit on RailGroup's
    // 2px column.
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        if (group.rows.length === 0) return null;
        return (
          <RailGroup
            key={group.key}
            title={group.title}
            headingId={`${idPrefix}-${group.key}`}
          >
            {group.rows.map((row) => (
              <li key={row.id}>
                <SessionRow
                  row={row}
                  selected={row.id === activeSessionId}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  onRequestRemove={onRequestRemove}
                  onRename={onRename}
                  pinPending={pendingPinId === row.id}
                />
              </li>
            ))}
          </RailGroup>
        );
      })}
    </div>
  );
}

/**
 * The chats list's words (VEX Cloud's REAL `shell/sidebar/chat-list.tsx`):
 * "chat", never "session", in every word a person reads. A failed read says
 * so in Cloud's words, followed by main's own reason when its Result carries
 * one (`chatsFailedWords`); a transport failure has no reason to add.
 */
export const CHATS_LOADING_COPY = "Loading chats";
export const CHATS_FAILED_COPY = "Chats could not load.";
export const CHATS_EMPTY_COPY = "No chats yet.";
export const CHATS_NO_MATCH_COPY = "No chats match your search.";

/** The name of the chats while a query narrows them (Cloud's). */
export const SEARCH_RESULTS_LABEL = "Search results";

/** How long a query rests before its result is spoken (Cloud's 250 ms debounce, D25). */
export const SEARCH_ANNOUNCE_DELAY_MS = 250;

/** "1 chat found", "{n} chats found", or none match (Cloud's words). */
export function searchResultWords(count: number): string {
  if (count === 0) return CHATS_NO_MATCH_COPY;
  return count === 1 ? "1 chat found" : `${String(count)} chats found`;
}

/**
 * THE SEARCH'S RESULT, SPOKEN (VEX Cloud's `chat-list.tsx`, 9.7): once a
 * typed query rests for 250 ms, a polite live region says how many chats it
 * found, or that none match. Nothing is said while no query is typed or the
 * list has not loaded. A new query that finds the same count is spoken again:
 * the words alternate a trailing no-break space, so the region changes.
 */
export function SearchAnnouncer({
  query,
  count,
}: {
  /** The applied query, trimmed; "" while none is typed. */
  readonly query: string;
  /** The chats the query leaves; null while the list has not loaded. */
  readonly count: number | null;
}): JSX.Element {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (query === "" || count === null) {
      setSaid("");
      return undefined;
    }
    const timer = setTimeout(() => {
      const words = searchResultWords(count);
      setSaid((last) => (last === words ? `${words}\u00a0` : words));
    }, SEARCH_ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, count]);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-vex-area="chats-search-announcer">
      {said}
    </div>
  );
}

/** "Chats could not load." and main's reason after it, when it gave one. */
export function chatsFailedWords(reason: string | null | undefined): string {
  const cause = reason?.trim() ?? "";
  return cause.length === 0 ? CHATS_FAILED_COPY : `${CHATS_FAILED_COPY} ${cause}`;
}

/**
 * THE CHATS LIST'S STATES (docs/design/H3-DESKTOP.md section 1.4; VEX
 * Cloud's `shell/sidebar/chat-list.tsx` and `styles/left.css`, `.vx-lc-msg`
 * and `.vx-lc-error`): one sentence at 14 / 1.4 in the muted ink, set 24 in
 * where a row's title starts, padding 6 24 10.
 *
 * - Loading: the stepping hatch (14 square, aria-hidden) and "Loading chats",
 *   a status, never a pulse.
 * - Failed: the cross and the sentence (an alert), then an outline Retry key
 *   40 high, 24 in from both edges, reading "Retrying…" while the refetch
 *   runs.
 * - Empty or no match: the sentence alone.
 */
export function ChatsLoadingLine(): JSX.Element {
  return (
    <p role="status" className="vex-ls-msg">
      <span aria-hidden className="vex-ls-msg__hatch" />
      {CHATS_LOADING_COPY}
    </p>
  );
}

export function ChatsFailedLine({
  message = CHATS_FAILED_COPY,
  onRetry,
  retrying,
}: {
  /** The words; Cloud's sentence, then main's own reason when it gave one. */
  readonly message?: string;
  /** Reads the chats list again (the list query's refetch). */
  readonly onRetry: () => void;
  /**
   * The refetch is running: the key says so and takes no second press. It
   * stays focusable (`aria-disabled`, never `disabled`), so a keyboard press
   * keeps its place while the read runs.
   */
  readonly retrying: boolean;
}): JSX.Element {
  return (
    <div className="vex-ls-fail">
      <p role="alert" className="vex-ls-fail__line">
        <StateSquare state="error" />
        {message}
      </p>
      <Button
        variant="quiet"
        onClick={() => {
          if (!retrying) onRetry();
        }}
        aria-disabled={retrying || undefined}
        className="vex-ls-fail__retry"
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

export function ChatsEmptyLine({
  searching = false,
}: {
  /** A search or a tab narrowed a list that has chats: none match it. */
  readonly searching?: boolean;
}): JSX.Element {
  return <p className="vex-ls-msg">{searching ? CHATS_NO_MATCH_COPY : CHATS_EMPTY_COPY}</p>;
}

export function SessionsLoadingPlaceholder({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      register="sentence"
      text={CHATS_LOADING_COPY}
      icon={<Swatch state="listening" size={10} />}
    />
  );
}

export function SessionsErrorPlaceholder({
  sidebarOpen,
  message = CHATS_FAILED_COPY,
}: {
  readonly sidebarOpen: boolean;
  /** The words; Cloud's "Chats could not load." unless the owner names others. */
  readonly message?: string;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      register="sentence"
      text={message}
      tone="error"
      icon={<Swatch state="error" size={10} />}
    />
  );
}

export function SessionsEmptyPlaceholder({
  sidebarOpen,
  searching = false,
}: {
  readonly sidebarOpen: boolean;
  /** A search or a tab narrowed a list that has chats: none match it. */
  readonly searching?: boolean;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      register="sentence"
      text={searching ? CHATS_NO_MATCH_COPY : CHATS_EMPTY_COPY}
    />
  );
}

export function SidebarIconButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center text-[var(--vex-text-2)] transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
    >
      {children}
    </button>
  );
}
