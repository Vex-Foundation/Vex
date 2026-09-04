/**
 * THE PER-SEGMENT WALK: turning a project-relative PATH into a main-minted
 * node token, one `files.listChildren` per segment.
 *
 * ## Why a path is not a token, and why this walk is the only bridge
 *
 * `mintFileNodeId` signs `(epoch, projectId, relativePath)` with a key that
 * never leaves main (`main/studio/files/node-id.ts`), so the renderer cannot
 * derive a token for a path it holds. It can only ASK, through the listing the
 * explorer already calls on every expand. Nothing new crosses the process
 * boundary here: a walk is `files.listChildren`, N times, under main's own
 * validation.
 *
 * That is also the SECURITY ARGUMENT for persisting a path at all. A path read
 * back from user-writable localStorage names nothing by itself: before a tab
 * can exist for it, main must list each of its segments and hand back a token
 * it signed. An injected path can therefore only ever name a file main's own
 * walk confirms inside the project, and a path that names anything else - an
 * absolute path, a `..` escape, a file outside the root, a file that is gone -
 * simply fails to resolve and produces no tab.
 *
 * ## One walk, two callers
 *
 * Both callers ask the same question from a different starting point:
 *
 *  - `renamed-folder-tabs.ts` starts at the RENAMED DIRECTORY's fresh token and
 *    walks the tail of each open tab's path;
 *  - the workspace RESTORE starts at the project ROOT (`nodeId: null`) and walks
 *    a whole persisted path.
 *
 * They were one function inside the rename module and the restore would have
 * been a second copy of it, which is the duplication rule 03 names: one shared
 * invariant (page bound, memo, staleness fence), one owner.
 *
 * ## What bounds it
 *
 *  - a directory is paged at most {@link PATH_WALK_PAGES_MAX} times, so a walk
 *    through a folder holding a build output does not page through 50,000
 *    entries looking for one name;
 *  - every page read is REMEMBERED for the life of ONE walk, so N tabs under
 *    one directory cost one listing rather than N;
 *  - the number of walks is the caller's bound, and both callers have one
 *    (`STUDIO_FILE_TABS_MAX` open tabs, or that many persisted entries).
 *
 * ## Not finding it is an answer
 *
 * `null` is returned for every reason a name cannot be reached - it is not
 * there, the directory is past the page bound, the listing failed, the bridge
 * rejected, the workspace went stale mid-walk - because every caller's response
 * to all of them is the same. Distinguishing them here would invent a
 * vocabulary nobody reads.
 */

import type { Result } from "@shared/ipc/result.js";
import type { FileListing, FileNode, FilesOutcome } from "@shared/schemas/files.js";

/**
 * Pages of ONE directory a walk will read before giving up on a name.
 *
 * Twenty pages of `FILES_LIST_PAGE_DEFAULT` is 4,000 entries, which is past
 * every hand-maintained directory and short of the generated ones. The bound is
 * on the WALK rather than on the listing because the listing is already paged
 * for its own reasons; what is bounded here is how long a resolution may spend
 * looking, and the at-bound behaviour is `null`.
 */
export const PATH_WALK_PAGES_MAX = 20;

/** One page of one directory. `listProjectChildren`, narrowed to what is used. */
export type ListChildrenPage = (input: {
  projectId: string;
  nodeId: string | null;
  cursor?: string | null;
}) => Promise<Result<FilesOutcome<FileListing>>>;

export interface PathTokenWalkInput {
  readonly projectId: string;
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
 * A walk with a MEMO that spans every resolution made through it.
 *
 * The memo is the reason this is a factory rather than a bare function: the
 * rename case resolves a dozen tabs that share their first segments, and a
 * per-call cache would list the same directory a dozen times. One walk per
 * gesture, and the caller decides what a gesture is.
 */
export interface PathTokenWalk {
  /**
   * Resolve `segments` under `fromNodeId` (`null` = the project root).
   *
   * Returns the entry main described, or `null` for every reason it could not
   * be reached. Empty segments resolve to `null`: there is no entry to name.
   */
  resolve(
    fromNodeId: string | null,
    segments: readonly string[],
  ): Promise<FileNode | null>;
}

export function createPathTokenWalk(input: PathTokenWalkInput): PathTokenWalk {
  // `directoryNodeId + " " + name` -> the entry, or `null` for "this directory
  // was read to its bound and does not hold that name". `undefined` from the
  // map therefore means "not asked yet", which is a third state the walk needs.
  const entries = new Map<string, FileNode | null>();
  // The project root has no token, so it needs a key of its own that no minted
  // token can collide with (tokens are non-empty by schema).
  const ROOT_KEY = "";

  const findChild = async (
    directoryNodeId: string | null,
    name: string,
  ): Promise<FileNode | null> => {
    const key = `${directoryNodeId ?? ROOT_KEY} ${name}`;
    const remembered = entries.get(key);
    if (remembered !== undefined) return remembered;
    let cursor: string | null = null;
    for (let page = 0; page < PATH_WALK_PAGES_MAX; page += 1) {
      let answer: Result<FilesOutcome<FileListing>>;
      try {
        answer = await input.list({
          projectId: input.projectId,
          nodeId: directoryNodeId,
          cursor,
        });
      } catch (cause: unknown) {
        // The bridge rejected where a Result was expected. The caller's answer
        // is the same as for a missing name; swallowing it silently would be
        // that same outcome without the record.
        console.warn(
          `studio workspace: listing ${directoryNodeId ?? "the project root"} failed`,
          cause,
        );
        break;
      }
      if (input.isStale()) return null;
      if (!answer.ok || !answer.data.ok) break;
      const listing = answer.data.value;
      for (const child of listing.children) {
        entries.set(`${directoryNodeId ?? ROOT_KEY} ${child.name}`, child);
      }
      const hit = listing.children.find((child) => child.name === name);
      if (hit !== undefined) return hit;
      if (!listing.hasMore || listing.nextCursor === null) break;
      cursor = listing.nextCursor;
    }
    entries.set(key, null);
    return null;
  };

  return {
    resolve: async (fromNodeId, segments) => {
      if (segments.length === 0) return null;
      let directoryNodeId = fromNodeId;
      for (const [index, segment] of segments.entries()) {
        const child = await findChild(directoryNodeId, segment);
        if (input.isStale()) return null;
        if (child === null) return null;
        if (index === segments.length - 1) return child;
        directoryNodeId = child.nodeId;
      }
      return null;
    },
  };
}
