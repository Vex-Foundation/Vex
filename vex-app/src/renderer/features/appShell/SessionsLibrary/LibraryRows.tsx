/**
 * The Sessions library's register (docs/design/R3-MINIMAL.md section 9.6):
 * sessions in "Pinned", "Today", "Yesterday" and "Older", each group a 12 / 500
 * muted head over a 1px rule and its rows. A row is two lines: the title at
 * 14 / 500 over a 12.5 muted line that names the mode and the permission, and
 * at the right the session's state (a swatch and its word, when a mission has
 * one) and its start time in mono.
 *
 * The row keeps every behaviour of the sidebar's row: a click selects, a
 * double-click swaps the row for an inline rename input (Enter commits, Escape
 * cancels, blur commits, an empty or unchanged draft is a cancel), and the Pin
 * and Remove keys are SIBLINGS of the select button (never nested) that take
 * the place of the time on hover and focus.
 */

import { useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { cn } from "../../../lib/utils.js";
import {
  formatSessionTime,
  getSessionTitle,
  type SessionGroup,
} from "../sessionListModel.js";
import { PinToggle } from "../SessionRows/PinToggle.js";
import { RemoveButton } from "../SessionRows/RemoveButton.js";
import { sessionRowState } from "../SessionRows/session-row-state.js";

/** The longest title a rename may carry (the session schema's own cap). */
const RENAME_MAX_LENGTH = 80;

/** "Mission · Restricted": the facts under the title, in plain words. */
function sessionFacts(row: SessionListItem): string {
  const mode = row.mode === "mission" ? "Mission" : "Agent";
  const permission = row.permission === "full" ? "Full access" : "Restricted";
  return `${mode} · ${permission}`;
}

export function LibraryGroups({
  groups,
  activeSessionId,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pendingPinId,
  idPrefix,
}: {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly pendingPinId: string | null;
  /**
   * Namespace for the `<section aria-labelledby>` and `<h2 id>` pairs, so the
   * library and the sidebar never share an id.
   */
  readonly idPrefix: string;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      {groups.map((group) => {
        if (group.rows.length === 0) return null;
        const headingId = `${idPrefix}-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h2
              id={headingId}
              className="m-0 pb-1 pt-3.5 text-[12px] font-medium leading-[1.4] text-ink-tertiary"
            >
              {group.title}
            </h2>
            <ul className="m-0 list-none border-t border-rule p-0">
              {group.rows.map((row) => (
                <li key={row.id} className="border-b border-rule-quiet">
                  <LibraryRow
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
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function LibraryRow({
  row,
  selected,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pinPending,
}: {
  readonly row: SessionListItem;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly pinPending: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = getSessionTitle(row);
  const isPinned = row.pinnedAt !== null;
  const state = sessionRowState(row);

  const commitRename = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    // Empty or unchanged drafts are a cancel, not a write.
    if (trimmed.length === 0 || trimmed === title) return;
    onRename(row.id, trimmed);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      // Taken here so the page's own Escape (back to the previous page) does
      // not also run.
      event.preventDefault();
      setEditing(false);
    }
  };

  const onPinClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    if (pinPending) return;
    onTogglePin(row.id, !isPinned);
  };

  const onRemoveClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    onRequestRemove(row);
  };

  // Inline rename replaces the whole row while it is active: an input nested
  // in the select button would be invalid interactive markup.
  if (editing) {
    return (
      <div className="flex items-center py-[7px]" data-editing="">
        <input
          autoFocus
          value={draft}
          maxLength={RENAME_MAX_LENGTH}
          aria-label="Rename session"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onBlur={commitRename}
          className="h-9 min-w-0 flex-1 border border-accent-primary bg-surface-field px-2.5 text-[14px] text-ink-primary focus-visible:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/lib relative -mx-2.5 flex px-2.5",
        selected ? "bg-interactive-active" : "hover:bg-interactive-hover",
      )}
      data-vex-library-row=""
    >
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        onDoubleClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        aria-current={selected ? "true" : undefined}
        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-[3px] pb-[11px] pt-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
      >
        <span
          className={cn(
            "min-w-0 truncate text-[14px] font-medium leading-[1.45]",
            selected ? "text-accent-primary" : "text-ink-primary",
          )}
        >
          {title}
        </span>
        <span className="col-start-2 row-span-2 row-start-1 inline-flex items-center gap-2.5 self-center whitespace-nowrap text-[12.5px] text-ink-tertiary group-focus-within/lib:opacity-0 group-hover/lib:opacity-0">
          {state === null ? null : (
            <StateWord
              state={state.fill}
              word={state.word}
              className="text-[12.5px] text-ink-primary"
            />
          )}
          <span className="vex-num">{formatSessionTime(row.startedAt)}</span>
        </span>
        {/* A bare space: no width in the grid, a word break in the select
         * button's accessible name. */}
        {" "}
        <span className="col-start-1 text-[12.5px] leading-[1.4] text-ink-tertiary">
          {sessionFacts(row)}
        </span>
      </button>
      <div
        className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-focus-within/lib:opacity-100 group-hover/lib:opacity-100"
      >
        <PinToggle pinned={isPinned} pending={pinPending} onClick={onPinClick} />
        <RemoveButton onClick={onRemoveClick} />
      </div>
    </div>
  );
}
