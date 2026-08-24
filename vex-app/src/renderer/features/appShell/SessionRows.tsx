/**
 * Public session-list building blocks for the sidebar and the library view:
 * the grouped list (`SessionGroups`) mapping session items onto the generic
 * RailGroup/RailRow primitives, the loading / error / empty placeholders,
 * and the small `SidebarIconButton`. The presentational internals — the row,
 * its trash/pin actions, the hover-card body, and the shared placeholder
 * strip — live as co-located subcomponents under `./SessionRows/`.
 */

import type { JSX } from "react";
import { IconArchive, IconWarning } from "../../components/icons/index.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { DotmSquare3 } from "../../components/ui/dotm-square-3.js";
import { RailGroup } from "../../components/ui/rail-list.js";
import { type SessionGroup } from "./sessionListModel.js";
import { ListPlaceholder } from "./SessionRows/ListPlaceholder.js";
import { SessionRow } from "./SessionRows/SessionRow.js";

interface SessionGroupsProps {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  readonly sidebarOpen: boolean;
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
   * with the same group keys (pinned/today/yesterday/older).
   */
  readonly idPrefix: string;
}

export function SessionGroups({
  groups,
  activeSessionId,
  sidebarOpen,
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
            collapsed={!sidebarOpen}
            headingId={`${idPrefix}-${group.key}`}
          >
            {group.rows.map((row) => (
              <li key={row.id}>
                <SessionRow
                  row={row}
                  selected={row.id === activeSessionId}
                  sidebarOpen={sidebarOpen}
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

export function SessionsLoadingPlaceholder({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      text="Loading sessions"
      icon={
        <DotmSquare3
          size={26}
          dotSize={4}
          color="var(--vex-accent)"
          ariaLabel="Loading sessions"
        />
      }
    />
  );
}

export function SessionsErrorPlaceholder({
  sidebarOpen,
  message,
}: {
  readonly sidebarOpen: boolean;
  readonly message: string;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      text={message}
      tone="error"
      icon={<IconWarning size={18} />}
    />
  );
}

export function SessionsEmptyPlaceholder({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
  return (
    <ListPlaceholder
      sidebarOpen={sidebarOpen}
      text="No sessions"
      icon={<IconArchive size={18} />}
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
      className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--vex-text-2)] transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
    >
      {children}
    </button>
  );
}
