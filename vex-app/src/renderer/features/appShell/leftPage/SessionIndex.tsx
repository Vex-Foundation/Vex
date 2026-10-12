/**
 * THE SESSION INDEX on the open left page (docs/design/V10-SPREAD.md
 * section 3): the whitepaper's chapter rail set into the print's sky. Group
 * heads in 10px mono caps (17px), rows of 26px: the italic ordinal, the title
 * behind its state swatch, the start time. Each row is the shared
 * `SessionRow` in its `index` setting, so pin, remove, inline rename and the
 * hover preview behave exactly as they do in the Sessions library.
 *
 * The scroller itself and its fold belong to the page (`SessionsList`): the
 * index only lays out its items, each marked `data-vex-ix-item` for the fold
 * (`useIndexFold`).
 */

import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { SessionRow } from "../SessionRows/SessionRow.js";
import type { SessionGroup } from "../sessionListModel.js";

export function SessionIndex({
  groups,
  activeSessionId,
  ordinals,
  onSelect,
  onTogglePin,
  onRequestRemove,
  onRename,
  pendingPinId,
}: {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  /** Every session's ordinal, by id (`useSessionOrdinals`). */
  readonly ordinals: ReadonlyMap<string, number>;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (id: string, nextPinned: boolean) => void;
  readonly onRequestRemove: (row: SessionListItem) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly pendingPinId: string | null;
}): JSX.Element {
  return (
    <nav aria-label="Sessions" className="vex-ix">
      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <section key={group.key} aria-labelledby={`left-page-sessions-${group.key}`}>
            <h2
              id={`left-page-sessions-${group.key}`}
              className="vex-ix__g"
              data-vex-ix-item="head"
            >
              {group.title}
            </h2>
            <ol>
              {group.rows.map((row) => (
                <li key={row.id}>
                  <SessionRow
                    row={row}
                    variant="index"
                    ordinal={ordinals.get(row.id) ?? null}
                    selected={row.id === activeSessionId}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onRequestRemove={onRequestRemove}
                    onRename={onRename}
                    pinPending={pendingPinId === row.id}
                  />
                </li>
              ))}
            </ol>
          </section>
        ),
      )}
    </nav>
  );
}

/**
 * The fold: a dotted ink rule with `n more` under the last whole row the
 * horizon allows. Rendered only while rows sit below it; a press scrolls the
 * index one page. `compact` is the spine's form, the count alone.
 */
export function IndexFold({
  hidden,
  onPageDown,
  compact = false,
}: {
  readonly hidden: number;
  readonly onPageDown: () => void;
  readonly compact?: boolean;
}): JSX.Element | null {
  if (hidden <= 0) return null;
  const label = `Show ${hidden} more ${hidden === 1 ? "session" : "sessions"}`;
  return (
    <button
      type="button"
      onClick={onPageDown}
      aria-label={label}
      title={compact ? label : undefined}
      className="vex-ix-fold"
      data-compact={compact || undefined}
    >
      <b>{compact ? `+${hidden}` : hidden}</b>
      {compact ? null : <span>more</span>}
      {compact ? null : <span aria-hidden>↓</span>}
    </button>
  );
}
