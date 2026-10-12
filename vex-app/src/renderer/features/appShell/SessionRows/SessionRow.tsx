/**
 * One session row, in one of two settings that share every behaviour:
 *
 * - `index` (the left page, docs/design/V10-SPREAD.md section 3): the
 *   whitepaper chapter rail set into the print's sky. A 26px line of the
 *   session's italic 24px ordinal, its title with the state swatch in front,
 *   and the start time in mono caps. The open session reads in blue behind a
 *   solid swatch; a running mission wears the dot screen, a paused one the
 *   hatch. No fill: the row sits on a photograph.
 * - `register` (the Sessions library): the generic 32px RailRow, title and a
 *   quiet trailing time on paper.
 *
 * Both: the time yields to the Remove + Pin cluster on hover and focus, the
 * cluster is a SIBLING of the select button (never nested), the whole row
 * anchors a HoverCard preview (full title, started time, mode, permission),
 * and a double-click swaps the row for an inline rename input (Enter commits
 * via `onRename`, Escape cancels, an empty or unchanged draft is a cancel).
 */

import { useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { cn } from "../../../lib/utils.js";
import { HoverCard } from "../../../components/ui/hover-card.js";
import { RailRow } from "../../../components/ui/rail-list.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import {
  formatSessionTime,
  getMissionActivity,
  getSessionTitle,
} from "../sessionListModel.js";
import { formatOrdinal } from "../leftPage/sessionOrdinals.js";
import { SessionHoverContent } from "./SessionHoverContent.js";
import { RemoveButton } from "./RemoveButton.js";
import { PinToggle } from "./PinToggle.js";

/**
 * The swatch a row carries, if any (docs/design/V10-SPREAD.md section 6):
 * the open session solid, a running mission the dot screen, a paused one the
 * hatch. An idle session and a finished mission carry none.
 */
export function sessionRowFill(
  row: SessionListItem,
  current: boolean,
): SwatchState | null {
  if (current) return "done";
  const activity = getMissionActivity(row);
  if (activity === null || activity.tone === "stopped") return null;
  return activity.tone === "active" ? "ongoing" : "draft";
}

export function SessionRow({
  row,
  selected,
  variant = "register",
  ordinal = null,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pinPending,
}: {
  readonly row: SessionListItem;
  readonly selected: boolean;
  /** `index` on the left page, `register` in the Sessions library. */
  readonly variant?: "index" | "register";
  /** The session's ordinal (index only); null prints no number. */
  readonly ordinal?: number | null;
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
  const index = variant === "index";
  const fill = sessionRowFill(row, index && selected);
  const number = index && ordinal !== null ? formatOrdinal(ordinal) : null;

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
      <RemoveButton onClick={handleRemoveClick} />
      <PinToggle pinned={isPinned} pending={pinPending} onClick={handlePinClick} />
    </>
  );

  // Inline rename replaces the whole row while active: an input nested in
  // the select button would be invalid interactive markup.
  if (editing) {
    return (
      <div
        className={index ? "vex-ix-row" : "flex h-8 items-center bg-interactive-hover px-2"}
        data-vex-ix-item={index ? "row" : undefined}
        data-editing=""
      >
        {index ? (
          <span aria-hidden className="vex-ix-row__n">
            {number}
          </span>
        ) : null}
        <input
          autoFocus
          value={draft}
          maxLength={80}
          aria-label="Rename session"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onBlur={commitRename}
          className={cn(
            "min-w-0 flex-1 focus:outline-none",
            index
              ? "vex-ix-row__input"
              : "border border-line-2 bg-surface-1 px-0.5 text-[14px] leading-[20px] text-ink-primary",
          )}
        />
      </div>
    );
  }

  const anchor = index ? (
    <div
      className="vex-ix-row"
      data-vex-ix-item="row"
      data-current={selected || undefined}
    >
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        onDoubleClick={startRename}
        aria-current={selected ? "true" : undefined}
        className="vex-ix-row__select"
      >
        <span aria-hidden className="vex-ix-row__n">
          {number}
        </span>
        <span className="vex-ix-row__t">
          {fill === null ? null : <Swatch state={fill} size={9} className="vex-ix-row__sw" />}
          <span className="vex-ix-row__title">{title}</span>
        </span>
        <span className="vex-ix-row__time">{formatSessionTime(row.startedAt)}</span>
      </button>
      <div data-rail-actions className="vex-ix-row__actions">
        {actions}
      </div>
    </div>
  ) : (
    <RailRow
      selected={selected}
      title={title}
      onSelect={() => onSelect(row.id)}
      onDoubleClick={startRename}
      leading={fill === null ? undefined : <Swatch state={fill} size={10} />}
      trailing={formatSessionTime(row.startedAt)}
      actions={actions}
    />
  );

  return (
    <HoverCard
      anchor={anchor}
      content={<SessionHoverContent row={row} />}
      openDelayMs={500}
    />
  );
}
