/**
 * Slash-command combobox menu (B9): the command list floated above the
 * composer card in the Menu primitive's chrome (`.vex-menu` card classes),
 * driven as a LISTBOX rather than a focusable menu - focus stays in the
 * textarea, the highlight is exposed via aria-activedescendant, and rows
 * pick on mousedown so the textarea never blurs.
 */

import { useEffect, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
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
    <div
      id="vex-composer-command-listbox"
      data-vex-composer-command-menu
      className="vex-menu vex-menu-dense vex-menu-scrollable absolute bottom-full left-0 z-50 mb-2 w-72"
      role="listbox"
      aria-label="Composer commands"
    >
      <div className="vex-menu-viewport" role="presentation">
        {items.map((command, index) => (
          <button
            key={command.id}
            id={optionId(command.id)}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-active={index === highlight ? "true" : undefined}
            className={cn("vex-menu-item")}
            // mousedown, not click: preventing default stops the focus steal
            // so the textarea keeps focus (combobox pattern).
            onMouseDown={(event) => {
              event.preventDefault();
              onPickAt(index);
            }}
          >
            <span className="vex-menu-item-label flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-[13px] text-ink-primary">
                {command.label}
              </span>
              <span className="min-w-0 truncate text-[12px] text-ink-tertiary">
                {command.description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
