/**
 * THE PUBLIC GATE of the Studio explorer.
 *
 * B4 mounts the tree in the Studio sidebar and owns which projects stay alive;
 * B3c replaces what a file row opens into. Everything else here - the model,
 * the session, the keyboard table, the copy, the row - is an implementation
 * detail of this folder and is imported through its own module by its own
 * tests only.
 *
 * The registry is exported as the LIVE INSTANCE plus its class: the instance is
 * what the app uses, the class is what a test constructs so two suites never
 * share one process-wide registry.
 */

import { EXPLORER_TREE_LABEL } from "./explorer-copy.js";

export { ExplorerTree, type ExplorerTreeProps } from "./ExplorerTree.js";
export { ExplorerHeader, type ExplorerHeaderProps } from "./ExplorerHeader.js";
export { ExplorerRegistry, explorerRegistry } from "./explorer-registry.js";
export type { ExplorerSession, ExplorerSessionState } from "./explorer-session.js";
export type {
  ExplorerRow,
  ExplorerNodeRow,
  ExplorerLoadMoreRow,
  ExplorerNoticeRow,
} from "./explorer-rows.js";

/**
 * PUT KEYBOARD FOCUS ON THE PROJECT TREE. `Ctrl+Shift+E`'s owner.
 *
 * Returns whether a tree was there to focus. `false` is an ordinary answer -
 * the rail is collapsed, or no project is open, so there is no tree - and the
 * caller must be able to tell, because a shortcut that did nothing must leave
 * the keystroke alone rather than swallow it.
 *
 * IT FINDS THE TREE BY ITS PUBLIC SEMANTICS, `role="tree"` plus the accessible
 * name the tree gives itself, rather than by a handle the component registers.
 * Two reasons, and the second is the one that decided it: the tree already
 * declares exactly one focusable element by contract (`ExplorerTree`'s
 * container is its ONE tab stop, everything else in it is
 * `aria-activedescendant`), so the element this selects is the element a Tab
 * key would reach; and a registration would be a second source of truth for
 * "which tree is on screen" that the sidebar's own conditional render already
 * answers.
 *
 * `preventScroll`, as `ExplorerTree`'s own pointer handler uses: the tree
 * scrolls itself to the focused row, and a focus that also scrolled would fight
 * that reveal.
 */
export function focusStudioExplorer(): boolean {
  if (typeof document === "undefined") return false;
  const tree = document.querySelector<HTMLElement>(
    `[role="tree"][aria-label="${EXPLORER_TREE_LABEL}"]`,
  );
  if (tree === null) return false;
  tree.focus({ preventScroll: true });
  return true;
}
