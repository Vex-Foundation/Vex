/**
 * THE ROW CONTEXT MENU: the same actions, reached by pointer or by keyboard.
 *
 * Two openings, one menu, which is the property that matters: a right click and
 * the Menu key (or Shift+F10) produce the same list in the same order, so the
 * pointer route is not a superset of the keyboard route. The deepseek reference
 * (`ui-workspace/src/client/rows/Rows.tsx`) reveals row actions on hover behind
 * an ellipsis button; REJECTED here for the same reason VS Code's explorer has
 * no per-row button: this tree renders thousands of rows through a virtualizer,
 * and a control per row is a control per row to mount, memoize and keep out of
 * the arrow-key sequence a screen reader walks. What was ADOPTED from it is the
 * shape of the list - `rename`, then a separated `delete` marked `danger` - and
 * the rule that an unknown id leaves before the dispatch rather than falling
 * through to the destructive branch.
 *
 * The menu is positioned from a zero-size anchor placed at the pointer, because
 * `components/ui/menu.tsx` positions from an anchor rect and a context menu
 * belongs where the pointer is. A KEYBOARD opening has no pointer, so it
 * anchors on the focused row's own rectangle - the menu appears attached to the
 * row it acts on rather than at the last place a mouse happened to be.
 */

import { useEffect, useState, type JSX } from "react";
import { Menu, type MenuEntry } from "../../../../components/ui/menu.js";
import {
  IconEdit,
  IconFile,
  IconFolderClose,
  IconTrash,
} from "../../../../components/icons/index.js";
import {
  EXPLORER_DELETE_LABEL,
  EXPLORER_DELETE_PERMANENT_LABEL,
  EXPLORER_NEW_FILE_LABEL,
  EXPLORER_NEW_FOLDER_LABEL,
  EXPLORER_RENAME_LABEL,
  rowMenuLabel,
} from "./explorer-copy.js";

/** Every action the menu can dispatch. A closed union, exhaustively handled. */
export type ExplorerMenuAction =
  | "newFile"
  | "newFolder"
  | "rename"
  | "delete"
  | "deletePermanent";

/** Where the menu is, and what it is about. `null` closes it. */
export interface ExplorerMenuRequest {
  /** The row the menu acts on. */
  readonly rowId: string;
  readonly name: string;
  /** Viewport coordinates to anchor at. */
  readonly x: number;
  readonly y: number;
}

export interface ExplorerRowMenuProps {
  readonly request: ExplorerMenuRequest | null;
  readonly onSelect: (action: ExplorerMenuAction, rowId: string) => void;
  readonly onClose: () => void;
}

export function ExplorerRowMenu({
  request,
  onSelect,
  onClose,
}: ExplorerRowMenuProps): JSX.Element | null {
  // The menu remounts per opening so its own internal focus and position start
  // fresh; keying on the coordinates plus the row is what makes a second right
  // click on a different row a new menu rather than a moved one.
  const [mountKey, setMountKey] = useState(0);
  useEffect(() => {
    if (request !== null) setMountKey((current) => current + 1);
  }, [request]);

  if (request === null) return null;

  // THE CREATE ROWS ARE ON EVERY ROW, not only on directories.
  //
  // VS Code's rule, which the tree's own handler already implements: a
  // directory takes the new entry, a FILE gives it to its parent
  // (`fileActions.ts:931-938`). Showing them only on folders looked tidier and
  // was measured wrong in the end-to-end walk: a fresh project's root holds
  // nothing but Vex's own artifacts, so every row is either a file or a managed
  // folder and there is NO row from which the user can create at the root at
  // all. The header's own two actions are optional props a host may not pass,
  // so the menu cannot assume they are there.
  const items: MenuEntry[] = [
    { id: "newFile", label: EXPLORER_NEW_FILE_LABEL, icon: <IconFile size={14} /> },
    {
      id: "newFolder",
      label: EXPLORER_NEW_FOLDER_LABEL,
      icon: <IconFolderClose size={14} />,
    },
    { type: "separator", id: "after-create" },
  ];
  items.push(
    { id: "rename", label: EXPLORER_RENAME_LABEL, icon: <IconEdit size={14} /> },
    { type: "separator", id: "before-delete" },
    // Both dispositions are on the menu, because a menu that offered only the
    // recoverable one would leave permanent deletion reachable ONLY by a
    // modifier key nobody discovers.
    { id: "delete", label: EXPLORER_DELETE_LABEL, icon: <IconTrash size={14} />, danger: true },
    {
      id: "deletePermanent",
      label: EXPLORER_DELETE_PERMANENT_LABEL,
      icon: <IconTrash size={14} />,
      danger: true,
    },
  );

  return (
    <Menu
      key={mountKey}
      open
      onClose={onClose}
      items={items}
      portal
      side="bottom"
      align="start"
      dense
      onSelect={(id) => {
        onClose();
        // An unknown id leaves BEFORE the dispatch: a row added to this menu
        // later must not inherit the destructive branch as a fallback.
        if (!isMenuAction(id)) return;
        onSelect(id, request.rowId);
      }}
      anchor={
        <span
          aria-label={rowMenuLabel(request.name)}
          data-vex-explorer-menu-anchor="true"
          style={{
            position: "fixed",
            left: `${String(request.x)}px`,
            top: `${String(request.y)}px`,
            width: 0,
            height: 0,
          }}
        />
      }
    />
  );
}

function isMenuAction(id: string): id is ExplorerMenuAction {
  return (
    id === "newFile"
    || id === "newFolder"
    || id === "rename"
    || id === "delete"
    || id === "deletePermanent"
  );
}
