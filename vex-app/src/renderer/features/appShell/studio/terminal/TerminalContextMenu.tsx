/**
 * The terminal's right-click menu, on the platforms that get one.
 *
 * VS Code splits right-click by platform: `terminal.integrated.rightClickBehavior`
 * defaults to `copyPaste` on Windows - the conhost gesture, where a right click
 * copies if there is a selection and pastes otherwise, with no menu at all -
 * and to a context menu everywhere else
 * (`terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts:123-165`
 * reads that setting). `terminalRightClickIsCopyPaste` is that split; this
 * component is the other half of it, and `XtermHost` renders it only when the
 * platform asks for a menu.
 *
 * Two rows, no more. A terminal's context menu in VS Code carries clear, split,
 * kill and a dozen contributed commands, and every one of those already has an
 * owner in Studio: the panel header owns split, kill and rename, the tab strip
 * owns close. Repeating them here would be a second, drifting copy of actions
 * whose enabled-ness this component cannot see.
 *
 * It is anchored to a POINT rather than to an element, which is what
 * `Menu`'s `getAnchorRect` exists for: the anchor of a context menu is where
 * the pointer was, and there is no element there to measure.
 */

import { useCallback, type JSX } from "react";
import { Menu, type MenuEntry } from "../../../../components/ui/menu.js";

export interface TerminalContextMenuProps {
  /** Where the pointer was, in viewport coordinates. */
  readonly at: { readonly x: number; readonly y: number };
  /** Whether there is anything to copy right now. */
  readonly hasSelection: boolean;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  readonly onClose: () => void;
}

const COPY_ID = "copy";
const PASTE_ID = "paste";

export function TerminalContextMenu({
  at,
  hasSelection,
  onCopy,
  onPaste,
  onClose,
}: TerminalContextMenuProps): JSX.Element {
  // DISABLED, NOT HIDDEN, when there is nothing selected. A menu whose rows
  // move between openings is a menu whose muscle memory is wrong half the time;
  // VS Code greys `Copy` for the same reason.
  const items: readonly MenuEntry[] = [
    { id: COPY_ID, label: "Copy", disabled: !hasSelection },
    { id: PASTE_ID, label: "Paste" },
  ];

  const onSelect = useCallback(
    (id: string): void => {
      if (id === COPY_ID) onCopy();
      if (id === PASTE_ID) onPaste();
      onClose();
    },
    [onClose, onCopy, onPaste],
  );

  const getAnchorRect = useCallback(
    (): DOMRect =>
      new DOMRect(at.x, at.y, 0, 0),
    [at.x, at.y],
  );

  return (
    <Menu
      open
      portal
      dense
      anchor={null}
      items={items}
      getAnchorRect={getAnchorRect}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
