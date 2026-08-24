/**
 * Slash-command menu controller (B9): derives the open/closed combobox state
 * from the live draft + caret, owns the keyboard highlight, and resolves a
 * pick into "remove the token, run the command". Focus never leaves the
 * textarea - the view renders the highlight via aria-activedescendant and
 * picks on mousedown; this hook consumes ArrowUp/ArrowDown/Enter/Tab/Escape
 * while open.
 */

import { useCallback, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { detectSlashCommand, type SlashCommandHit } from "./detect.js";
import {
  filterComposerCommands,
  type ComposerCommand,
} from "./directory.js";

export interface SlashMenuPick {
  readonly command: ComposerCommand;
  /** The draft with the slash token removed. */
  readonly draftWithoutToken: string;
}

export interface SlashCommandMenu {
  readonly open: boolean;
  readonly items: readonly ComposerCommand[];
  readonly highlight: number;
  /** Report the live caret offset (change / select / click events). */
  readonly onCaretChange: (caret: number) => void;
  /** Returns true when the key was consumed by the menu. */
  readonly handleKeyDown: (event: KeyboardEvent) => boolean;
  readonly pickAt: (index: number) => void;
  readonly dismiss: () => void;
}

export function useSlashCommandMenu(
  draft: string,
  onPick: (pick: SlashMenuPick) => void,
): SlashCommandMenu {
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // Escape suppresses the menu for the CURRENT token only: the dismissed
  // token's start index is remembered, and a new "/" (different start)
  // reopens the menu.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const hit = useMemo<SlashCommandHit | null>(
    () => detectSlashCommand(draft, Math.min(caret, draft.length)),
    [draft, caret],
  );
  const items = useMemo(
    () => (hit === null ? [] : filterComposerCommands(hit.query)),
    [hit],
  );
  const open =
    hit !== null && items.length > 0 && dismissedStart !== hit.start;
  const boundedHighlight = Math.min(highlight, Math.max(items.length - 1, 0));

  const onCaretChange = useCallback((next: number): void => {
    setCaret(next);
    setHighlight(0);
    // Leaving the dismissed token re-arms the menu for the next trigger.
    setDismissedStart((current) => {
      if (current === null) return current;
      const liveHit = detectSlashCommand(draft, next);
      return liveHit !== null && liveHit.start === current ? current : null;
    });
  }, [draft]);

  const pickAt = useCallback(
    (index: number): void => {
      if (hit === null) return;
      const command = items[index];
      if (command === undefined) return;
      onPick({
        command,
        draftWithoutToken: draft.slice(0, hit.start) + draft.slice(hit.end),
      });
      setHighlight(0);
    },
    [hit, items, draft, onPick],
  );

  const dismiss = useCallback((): void => {
    if (hit !== null) setDismissedStart(hit.start);
  }, [hit]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!open) return false;
      switch (event.key) {
        case "ArrowDown":
          setHighlight((value) => (value + 1) % items.length);
          return true;
        case "ArrowUp":
          setHighlight((value) => (value - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab":
          pickAt(boundedHighlight);
          return true;
        case "Escape":
          dismiss();
          return true;
        default:
          return false;
      }
    },
    [open, items.length, boundedHighlight, pickAt, dismiss],
  );

  return {
    open,
    items,
    highlight: boundedHighlight,
    onCaretChange,
    handleKeyDown,
    pickAt,
    dismiss,
  };
}
