/**
 * One session row, in one of two settings that share every behaviour:
 *
 * - `sidebar` (the left sidebar, docs/design/R3-MINIMAL.md section 4): a 34px
 *   row, the name at 14 with an ellipsis, then at the right the start time in
 *   mono 11.5 muted, or a swatch and a word in 12 muted while a mission has a
 *   state (Running, Waiting, Sleeping, Paused, Error). The open session takes
 *   the selection wash, blue type and weight 500. A search marks its match
 *   with a blue wash.
 * - `register` (the Sessions library): the generic 32px RailRow, the title,
 *   the state swatch in front and a quiet trailing time.
 *
 * Both: the time yields to the Pin and Remove keys on hover and focus, the
 * keys are SIBLINGS of the select button (never nested), the whole row
 * anchors a HoverCard preview, and a double-click swaps the row for an inline
 * rename input (Enter commits via `onRename`, Escape cancels, an empty or
 * unchanged draft is a cancel).
 */

import { useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { HoverCard } from "../../../components/ui/hover-card.js";
import { RailRow } from "../../../components/ui/rail-list.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { formatSessionTime, getSessionTitle } from "../sessionListModel.js";
import { SessionHoverContent } from "./SessionHoverContent.js";
import { RemoveButton } from "./RemoveButton.js";
import { PinToggle } from "./PinToggle.js";
import { sessionRowState } from "./session-row-state.js";

/**
 * The title with every case-insensitive occurrence of `needle` marked. An
 * empty needle returns the title as it is.
 */
export function MarkedTitle({
  title,
  needle,
}: {
  readonly title: string;
  readonly needle: string;
}): JSX.Element {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) return <>{title}</>;
  const lower = title.toLowerCase();
  // The unmarked runs stay bare text, so the row's accessible name keeps the
  // spaces at a mark's edges.
  const parts: (JSX.Element | string)[] = [];
  let from = 0;
  let at = lower.indexOf(query, from);
  while (at !== -1) {
    if (at > from) parts.push(title.slice(from, at));
    parts.push(<mark key={`m${String(at)}`}>{title.slice(at, at + query.length)}</mark>);
    from = at + query.length;
    at = lower.indexOf(query, from);
  }
  if (from < title.length) parts.push(title.slice(from));
  return <>{parts}</>;
}

export function SessionRow({
  row,
  selected,
  variant = "register",
  highlight = "",
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pinPending,
}: {
  readonly row: SessionListItem;
  readonly selected: boolean;
  /** `sidebar` in the left sidebar, `register` in the Sessions library. */
  readonly variant?: "sidebar" | "register";
  /** The sidebar search's text, marked in the title (sidebar only). */
  readonly highlight?: string;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  /** Persist a new display title (trimmed, non-empty, <= 80 chars). Absent = rename unavailable. */
  readonly onRename?: (id: string, name: string) => void;
  readonly pinPending: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = getSessionTitle(row);
  const isPinned = row.pinnedAt !== null;
  const sidebar = variant === "sidebar";
  const state = sessionRowState(row);

  const handlePinClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    if (pinPending) return;
    onTogglePin(row.id, !isPinned);
  };

  const handleRemoveClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    onRequestRemove(row);
  };

  const commitRename = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    // Empty or unchanged drafts are a cancel, not a write.
    if (trimmed.length === 0 || trimmed === title) return;
    onRename?.(row.id, trimmed);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  };

  const startRename =
    onRename === undefined
      ? undefined
      : (): void => {
          setDraft(title);
          setEditing(true);
        };

  const actions = (
    <>
      <PinToggle pinned={isPinned} pending={pinPending} onClick={handlePinClick} />
      <RemoveButton onClick={handleRemoveClick} />
    </>
  );

  // Inline rename replaces the whole row while active: an input nested in
  // the select button would be invalid interactive markup.
  if (editing) {
    return (
      <div
        className={sidebar ? "vex-ls-row" : "flex h-8 items-center bg-interactive-hover px-2"}
        data-vex-ls-item={sidebar ? "row" : undefined}
        data-editing=""
      >
        <input
          autoFocus
          value={draft}
          maxLength={80}
          aria-label="Rename session"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onBlur={commitRename}
          className={
            sidebar
              ? "vex-ls-row__input"
              : "min-w-0 flex-1 border border-line-2 bg-surface-1 px-0.5 text-[14px] leading-[20px] text-ink-primary focus:outline-none"
          }
        />
      </div>
    );
  }

  const anchor = sidebar ? (
    <div
      className="vex-ls-row"
      data-vex-ls-item="row"
      data-selected={selected || undefined}
    >
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        onDoubleClick={startRename}
        aria-current={selected ? "true" : undefined}
        className="vex-ls-row__select"
      >
        <span className="vex-ls-row__t">
          <MarkedTitle title={title} needle={highlight} />
        </span>
        {/* A bare space: no width in the flex row, a word break in the
          * select button's accessible name. */}
        {" "}
        {state === null ? (
          <span className="vex-ls-row__time vex-num">{formatSessionTime(row.startedAt)}</span>
        ) : (
          <span className="vex-ls-row__state">
            <Swatch state={state.fill} size={10} />
            {state.word}
          </span>
        )}
      </button>
      <div data-rail-actions className="vex-ls-row__actions">
        {actions}
      </div>
    </div>
  ) : (
    <RailRow
      selected={selected}
      title={title}
      onSelect={() => onSelect(row.id)}
      onDoubleClick={startRename}
      leading={state === null ? undefined : <Swatch state={state.fill} size={10} label={state.word} />}
      trailing={formatSessionTime(row.startedAt)}
      actions={actions}
    />
  );

  return (
    <HoverCard
      anchor={anchor}
      content={<SessionHoverContent row={row} hint={onRename !== undefined} />}
      openDelayMs={500}
    />
  );
}
