/**
 * One session row on the generic RailRow primitive: leading state slot (the
 * pixel-chase dot while a mission runs, a solid warn dot while paused),
 * single-line title, quiet trailing time that yields to the Remove + Pin
 * cluster on hover. The whole row anchors a HoverCard preview (full title,
 * started time, mode, permission) — the sidebar's truncation stops costing
 * information. Double-click swaps the row for an inline rename input (Enter
 * commits via `onRename`, Escape cancels, empty/unchanged drafts are a
 * cancel). Collapsed rail: the mode glyph is the row's entire content plus
 * the activity dot.
 */

import { useState, type JSX, type KeyboardEvent, type MouseEvent } from "react";
import { IconGoal, IconNewChat } from "../../../components/icons/index.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { cn } from "../../../lib/utils.js";
import { HoverCard } from "../../../components/ui/hover-card.js";
import { RailRow } from "../../../components/ui/rail-list.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import {
  formatSessionTime,
  getMissionActivity,
  getSessionTitle,
} from "../sessionListModel.js";
import { SessionHoverContent } from "./SessionHoverContent.js";
import { RemoveButton } from "./RemoveButton.js";
import { PinToggle } from "./PinToggle.js";

export function SessionRow({
  row,
  selected,
  sidebarOpen,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pinPending,
}: {
  readonly row: SessionListItem;
  readonly selected: boolean;
  readonly sidebarOpen: boolean;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  /** Persist a new display title (trimmed, non-empty, <= 80 chars). Absent = rename unavailable (library view). */
  readonly onRename?: (id: string, name: string) => void;
  readonly pinPending: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = getSessionTitle(row);
  const activity = getMissionActivity(row);
  const isPinned = row.pinnedAt !== null;
  const Icon = row.mode === "mission" ? IconGoal : IconNewChat;

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

  // Inline rename replaces the whole row while active: an input nested in
  // the select button would be invalid interactive markup.
  if (editing && sidebarOpen) {
    return (
      <div className="flex h-8 items-center rounded-lg bg-interactive-hover px-2">
        <input
          autoFocus
          value={draft}
          maxLength={80}
          aria-label="Rename session"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onBlur={commitRename}
          className="min-w-0 flex-1 rounded border border-line-2 bg-surface-1 px-0.5 text-[14px] leading-[20px] text-ink-primary focus:outline-none"
        />
      </div>
    );
  }

  const railRow = (
    <RailRow
      selected={selected}
      collapsed={!sidebarOpen}
      label={title}
      title={title}
      onSelect={() => onSelect(row.id)}
      onDoubleClick={
        sidebarOpen && onRename !== undefined
          ? () => {
              setDraft(title);
              setEditing(true);
            }
          : undefined
      }
      icon={
        <span className="relative flex h-7 w-7 items-center justify-center">
          <Icon size={15} />
          {activity !== null ? (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full",
                activity.dotClass,
              )}
            />
          ) : null}
        </span>
      }
      leading={
        activity !== null && activity.tone !== "stopped" ? (
          <StateDot
            state={activity.tone === "active" ? "ongoing" : "warning"}
            size={10}
          />
        ) : undefined
      }
      trailing={formatSessionTime(row.startedAt)}
      actions={
        <>
          <RemoveButton onClick={handleRemoveClick} />
          <PinToggle
            pinned={isPinned}
            pending={pinPending}
            onClick={handlePinClick}
          />
        </>
      }
    />
  );

  // Collapsed rail rows keep the native title tooltip instead of the card —
  // a 56px anchor pushes the card over the content column.
  if (!sidebarOpen) return railRow;
  return (
    <HoverCard
      anchor={railRow}
      content={<SessionHoverContent row={row} />}
      openDelayMs={500}
    />
  );
}
