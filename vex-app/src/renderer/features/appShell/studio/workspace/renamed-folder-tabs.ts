/**
 * A RENAMED FOLDER'S OPEN TABS - finding the new token for every file tab that
 * was underneath it.
 *
 * `retargetFileTab` follows a FILE's rename, and one path is all it needs
 * because the explorer hands it both halves. A DIRECTORY rename is the harder
 * half of the same gesture: renaming `src/old` to `src/new` moves every file
 * under it, and a tab open on `src/old/a.ts` is now a tab on a path that is not
 * on disk. VS Code retargets exactly these editors rather than closing them -
 * `editorService.ts` walks every open editor whose resource `isEqualOrParent`
 * of the moved one and re-opens it at the joined target path, preserving the
 * editor's index, its pinned and sticky state and whether it was active
 * (`handleMovedFile`, :259-300) - and this module is the part of that walk our
 * process boundary makes non-trivial.
 *
 * ## Why the renderer cannot do this with a string operation
 *
 * The new PATH is a prefix swap and the renderer could compute it. The new
 * TOKEN is not: `mintFileNodeId` signs `(epoch, projectId, relativePath)` with
 * a key that never leaves main (`main/studio/files/node-id.ts`), so the
 * renderer has no way to derive one, and a tab retargeted to the new path while
 * keeping the old token would read through a token main no longer resolves -
 * a tab that looks right and can never show its file again. So the new path is
 * computed here and the new token is ASKED FOR, through the listing the tree
 * already uses.
 *
 * ## What is asked, and what bounds it
 *
 * Main's rename answers with the renamed DIRECTORY's own node, token included.
 * From that token the child's token is one `listChildren` per path segment:
 * list the renamed directory, find the entry by name, and descend. Nothing new
 * crosses the process boundary - this is `files.listChildren`, the operation
 * the explorer calls on every expand.
 *
 * Three bounds, because this walk is driven by data the user controls:
 *
 *  - the number of walks is the number of OPEN FILE TABS under the folder, at
 *    most `STUDIO_FILE_TABS_MAX`, and it is this module's bound;
 *  - the page bound and the per-walk memo belong to the walk itself
 *    (`resolve-path-token.ts`), which this module and the workspace RESTORE now
 *    share rather than each carrying a copy of the same descent.
 *
 * ## Not finding it is an answer
 *
 * A tab whose new path cannot be resolved - the file was moved again, the
 * directory is past the page bound, the project closed mid-walk - is LEFT
 * ALONE. It keeps the state it has today: the old path, the old token, and the
 * viewer's own orphan answer once the watcher reports the old path gone. That
 * is worse than following and better than either of the alternatives, which are
 * closing a tab the user did not close or pointing it at a token that resolves
 * to nothing.
 */

import type { FileTabTarget } from "./workspace-model.js";
import { createPathTokenWalk, type ListChildrenPage } from "./resolve-path-token.js";
import type { WorkspaceFileTab, WorkspaceTab } from "./types.js";

/** A tab to retarget, in exactly the shape `retargetFileTab` takes. */
export interface RenamedFolderRetarget {
  readonly fromRelativePath: string;
  readonly to: FileTabTarget;
}

export interface ResolveRenamedFolderTabsInput {
  readonly projectId: string;
  /** The directory's path BEFORE the rename. */
  readonly fromRelativePath: string;
  /** The renamed directory's FRESH token, as main confirmed it. */
  readonly toNodeId: string;
  /** The tabs to follow. Use {@link fileTabsUnderFolder} to select them. */
  readonly tabs: readonly WorkspaceFileTab[];
  readonly list: ListChildrenPage;
  /**
   * THE FENCE, checked between every await. True once the workspace this walk
   * was started for is gone - a project switch, a remount, a close - and the
   * walk abandons rather than resolving tokens for a strip that no longer
   * exists.
   */
  readonly isStale: () => boolean;
}

/**
 * The open file tabs that live under a directory.
 *
 * A `/` is appended before the comparison, which is what keeps `src/oldish.ts`
 * out of the set for a rename of `src/old`: prefix matching on a path without
 * its separator matches siblings whose names merely start the same way.
 */
export function fileTabsUnderFolder(
  tabs: readonly WorkspaceTab[],
  folderRelativePath: string,
): readonly WorkspaceFileTab[] {
  const prefix = `${folderRelativePath}/`;
  return tabs.filter(
    (tab): tab is WorkspaceFileTab =>
      tab.kind === "file" && tab.relativePath.startsWith(prefix),
  );
}

/**
 * Resolve the new target for every tab that was under a renamed directory.
 *
 * Returns one entry per tab that RESOLVED, in tab order. A tab that did not is
 * absent rather than reported: the caller's answer to both is the same, and the
 * model refuses an unknown path anyway.
 */
export async function resolveRenamedFolderTabs(
  input: ResolveRenamedFolderTabsInput,
): Promise<readonly RenamedFolderRetarget[]> {
  const walk = createPathTokenWalk({
    projectId: input.projectId,
    list: input.list,
    isStale: input.isStale,
  });
  const retargets: RenamedFolderRetarget[] = [];

  for (const tab of input.tabs) {
    const segments = tab.relativePath
      .slice(input.fromRelativePath.length + 1)
      .split("/");
    const resolved = await walk.resolve(input.toNodeId, segments);
    // THE FENCE at publication as well as inside the walk: a workspace replaced
    // while this loop was awaiting must not gain retargets for a strip that no
    // longer exists, and the walk's own `null` cannot say which of its reasons
    // applied.
    if (input.isStale()) return [];
    if (resolved === null) continue;
    retargets.push({
      fromRelativePath: tab.relativePath,
      // The TITLE is the entry's own name as main minted it, the same field
      // `openFile` takes for a fresh tab: a rename of a parent does not change
      // a child's name, and deriving one here would be a second answer to a
      // question the wire already answers.
      to: { title: resolved.name, relativePath: resolved.path, nodeId: resolved.nodeId },
    });
  }

  return retargets;
}
