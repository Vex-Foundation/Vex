/**
 * THE SPINE'S INDEX (docs/design/V10-SPREAD.md section 3): the closed left
 * page keeps the sessions as their italic ordinals alone, 24px at a 27px
 * pitch, a 22px rule between groups, the open one in blue behind a 2px bar.
 * Each ordinal is the session's select button, named by its title (a 56px
 * column has no room for one, so the title is the tooltip too).
 *
 * The spine lists every agent session in the page's group order; the tabs and
 * the search belong to the open page and do not narrow it.
 */

import type { JSX } from "react";
import { getSessionTitle, type SessionGroup } from "../sessionListModel.js";
import { formatOrdinal } from "./sessionOrdinals.js";

export function SpineIndex({
  groups,
  activeSessionId,
  ordinals,
  onSelect,
}: {
  readonly groups: readonly SessionGroup[];
  readonly activeSessionId: string | null;
  readonly ordinals: ReadonlyMap<string, number>;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const filled = groups.filter((group) => group.rows.length > 0);
  return (
    <nav aria-label="Sessions" className="vex-sp-ix">
      {filled.map((group, at) => (
        <div key={group.key} className="contents">
          {at > 0 ? <i aria-hidden className="vex-sp-ix__sep" data-vex-ix-item="head" /> : null}
          {group.rows.map((row) => {
            const title = getSessionTitle(row);
            const ordinal = ordinals.get(row.id);
            const current = row.id === activeSessionId;
            return (
              <button
                key={row.id}
                type="button"
                aria-label={title}
                title={title}
                aria-current={current ? "true" : undefined}
                onClick={() => onSelect(row.id)}
                className="vex-sp-ix__n"
                data-vex-ix-item="row"
                data-current={current || undefined}
              >
                <span aria-hidden>{ordinal === undefined ? null : formatOrdinal(ordinal)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
