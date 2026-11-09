/**
 * Slash-command combobox menu (B9), drawn as VEX Cloud's `/` menu
 * (`SlashMenu`, `.vx-cmp-slash`): the chat column's width, its foot flush on
 * the composer's top, the card ground under the 24% top rule, no shadow. A
 * 32 head "Commands" in caps 11 muted, then each row on a 148 grid: the
 * command in the mono 13 ink, what it does in 14 ink 2. Driven as a LISTBOX
 * rather than a focusable menu - focus stays in the textarea, the highlight
 * is exposed via aria-activedescendant (the wash), and rows pick on
 * mousedown so the textarea never blurs.
 */

import { useEffect, type JSX } from "react";
import type { ComposerCommand } from "./directory.js";

function optionId(id: string): string {
  return `vex-composer-command-${id}`;
}

/** DOM id of the highlighted option (the textarea's aria-activedescendant). */
export function composerCommandActiveDescendant(
  open: boolean,
  items: readonly ComposerCommand[],
  highlight: number,
): string | undefined {
  const active = open ? items[highlight] : undefined;
  return active === undefined ? undefined : optionId(active.id);
}

export interface ComposerCommandMenuProps {
  readonly open: boolean;
  readonly items: readonly ComposerCommand[];
  readonly highlight: number;
  readonly onPickAt: (index: number) => void;
}

export function ComposerCommandMenu({
  open,
  items,
  highlight,
  onPickAt,
}: ComposerCommandMenuProps): JSX.Element | null {
  // Focus stays in the textarea, so the browser never scrolls the active
  // option into view on keyboard moves - do it here.
  const activeId = composerCommandActiveDescendant(open, items, highlight);
  useEffect(() => {
    if (activeId === undefined) return;
    // jsdom has no scrollIntoView - the guard keeps tests honest.
    document
      .getElementById(activeId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  if (!open) return null;
  return (
    <div data-vex-composer-command-menu="" className="vex-slash">
      <div aria-hidden="true" className="vex-slash__head">
        Commands
      </div>
      <div
        id="vex-composer-command-listbox"
        className="vex-slash__list vex-scroll"
        role="listbox"
        aria-label="Composer commands"
      >
        {items.map((command, index) => (
          <button
            key={command.id}
            id={optionId(command.id)}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-active={index === highlight ? "true" : undefined}
            className="vex-slash__row"
            // mousedown, not click: preventing default stops the focus steal
            // so the textarea keeps focus (combobox pattern).
            onMouseDown={(event) => {
              event.preventDefault();
              onPickAt(index);
            }}
          >
            <b className="vex-slash__name">{command.label}</b>
            <span className="vex-slash__what">{command.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
