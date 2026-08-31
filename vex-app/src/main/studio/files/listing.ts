/**
 * ONE PAGE OF ONE DIRECTORY, in the tree's own order.
 *
 * ## Lazy per directory, and only per directory
 *
 * A project tree is expanded a folder at a time by a human, so this reads
 * exactly the folder that was asked for and never descends. A recursive walk
 * would be a repository-sized amount of I/O to draw forty rows, and on a large
 * repository it is the difference between a tree that opens instantly and one
 * that appears to hang.
 *
 * ## Sort first, stat the page only
 *
 * `readdir` with `withFileTypes` gives the name and the kind of every entry
 * from the directory block itself, with no per-entry syscall. That is enough to
 * apply the exclude rules and to SORT, so the expensive part - a `lstat` per
 * entry for its size and modification time - is paid only for the rows this
 * page actually returns. A directory with 50k entries therefore costs one
 * `readdir` and at most `FILES_LIST_PAGE_MAX` stats, not 50k.
 *
 * ## `lstat`, never `stat`
 *
 * A symlink is reported AS a symlink, with the size of the link rather than of
 * its target. Following it would silently show the user a file outside their
 * project as though it were inside it, and would let a link to `/dev/zero` be
 * described as a file of unbounded size.
 *
 * ## Nothing is silently omitted
 *
 * Every row this page does not carry is reachable: `hasMore` says more exist
 * and `nextCursor` is the position to resume from, in the same total order.
 * `totalCount` is the whole directory after exclusions and `excludedCount` is
 * how many the exclude rules hid - so a user who cannot find `node_modules`
 * learns it was hidden rather than concluding it is missing.
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  FILES_LIST_PAGE_DEFAULT,
  FILES_LIST_PAGE_MAX,
  type FileListing,
  type FileNode,
  type FileNodeKind,
  type FilesOutcome,
} from "@shared/schemas/files.js";

import { log } from "../../logger/index.js";
import { buildIgnoreChain, isPathIgnored } from "./excludes.js";
import { mintFileNodeId } from "./node-id.js";
import { describeFileFailure, isEnoentLike } from "./node-path.js";
import {
  compareSortKeys,
  decodeCursor,
  encodeCursor,
  sortKeyFor,
  type SortKey,
} from "./ordering.js";

/** The pre-sort shape: everything `readdir` alone can tell us. */
interface Candidate {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: FileNodeKind;
  readonly key: SortKey;
}

function kindOfDirent(entry: {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): FileNodeKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/**
 * List the children of one directory.
 *
 * `absoluteDirectory` has already been resolved and containment-checked by
 * `resolveNodePath`; this function performs no path arithmetic on caller input
 * beyond joining the names the operating system itself just returned.
 */
export async function listDirectoryPage(options: {
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly absoluteDirectory: string;
  readonly relativeDirectory: string;
  readonly nodeKey: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}): Promise<FilesOutcome<FileListing>> {
  const limit = Math.min(
    Math.max(options.limit ?? FILES_LIST_PAGE_DEFAULT, 1),
    FILES_LIST_PAGE_MAX,
  );

  let after: SortKey | null = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    after = decodeCursor(options.nodeKey, options.cursor);
    if (after === null) return { ok: false, code: "invalid_cursor" };
  }

  let entries;
  try {
    entries = await readdir(options.absoluteDirectory, { withFileTypes: true });
  } catch (cause) {
    if (isEnoentLike(cause)) return { ok: false, code: "not_found" };
    if (
      typeof cause === "object"
      && cause !== null
      && (cause as { code?: unknown }).code === "ENOTDIR"
    ) {
      return { ok: false, code: "not_a_directory" };
    }
    log.warn(
      `[studio:files] a directory could not be listed ${describeFileFailure(cause)}`,
    );
    return { ok: false, code: "io_error" };
  }

  const chain = await buildIgnoreChain(
    options.projectDirectory,
    options.relativeDirectory,
  );

  const candidates: Candidate[] = [];
  let excludedCount = 0;
  for (const entry of entries) {
    // THE OS'S OWN BYTES, unnormalised. This used to normalise to NFC, and that
    // was a defect with a measurement behind it: on Linux a file created with a
    // DECOMPOSED name is stored decomposed, `readdir` returns it decomposed, and
    // the composed spelling names NOTHING - probed on this filesystem, `lstat`
    // of the NFC form of a real NFD file is ENOENT. So normalising here minted a
    // token for a path that does not exist and stat-ed a path that does not
    // exist: the row appeared with null metadata and opening it was `not_found`.
    //
    // Both spellings render identically, so nothing a user sees changes. What
    // changes is that ONE form - the operating system's - is now the form the
    // token carries, the form `resolveNodePath` walks, and the form the watcher
    // reports (see `toProjectRelative`), so mint and resolve cannot disagree.
    const name = entry.name;
    const relativePath = options.relativeDirectory === ""
      ? name
      : `${options.relativeDirectory}/${name}`;
    const kind = kindOfDirent(entry);
    if (isPathIgnored(chain, relativePath, kind === "directory")) {
      excludedCount += 1;
      continue;
    }
    candidates.push({ name, relativePath, kind, key: sortKeyFor(kind, name) });
  }

  candidates.sort((a, b) => compareSortKeys(a.key, b.key));

  const start = after === null
    ? 0
    : lowerBoundAfter(candidates, after);
  const page = candidates.slice(start, start + limit);
  const hasMore = start + page.length < candidates.length;

  const children: FileNode[] = [];
  for (const candidate of page) {
    children.push(await describe(options, candidate));
  }

  const last = page.at(-1);
  return {
    ok: true,
    value: {
      children,
      hasMore,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor(options.nodeKey, last.key)
        : null,
      totalCount: candidates.length,
      excludedCount,
    },
  };
}

/**
 * The index of the first candidate strictly AFTER `after`.
 *
 * A binary search over a sorted array, so resuming deep into a large directory
 * costs a logarithmic number of comparisons rather than a scan. The cursor's
 * own row may no longer exist - it could have been deleted between pages - and
 * that is exactly why the search is for "strictly after this key" rather than
 * for the key itself: a missing anchor resumes at the right place instead of
 * failing.
 */
function lowerBoundAfter(candidates: readonly Candidate[], after: SortKey): number {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidate = candidates[mid];
    if (candidate === undefined) break;
    if (compareSortKeys(candidate.key, after) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Add the facts that cost a syscall.
 *
 * An entry that vanished between the `readdir` and this `lstat` is reported
 * with null metadata rather than dropped: it was in the directory when the
 * directory was read, and the watcher will deliver its deletion. Dropping it
 * here would make the page shorter than `totalCount` promised and put the
 * cursor's arithmetic out of step with what the consumer received.
 */
async function describe(
  options: { readonly projectId: string; readonly absoluteDirectory: string },
  candidate: Candidate,
): Promise<FileNode> {
  const nodeId = mintFileNodeId(options.projectId, candidate.relativePath);
  try {
    const stats = await lstat(path.join(options.absoluteDirectory, candidate.name));
    return {
      nodeId,
      name: candidate.name,
      path: candidate.relativePath,
      kind: candidate.kind,
      size: candidate.kind === "file" ? stats.size : null,
      modifiedMs: Math.trunc(stats.mtimeMs),
    };
  } catch {
    return {
      nodeId,
      name: candidate.name,
      path: candidate.relativePath,
      kind: candidate.kind,
      size: null,
      modifiedMs: null,
    };
  }
}
