/**
 * THE WALK: every file name in a project, once, bounded and reported.
 *
 * `listing.ts` reads exactly one directory because a tree is expanded by a
 * human one folder at a time. This is the opposite job - a name index has to
 * see the whole project or it will confidently fail to find a file - so this is
 * the one place in the files feature that descends.
 *
 * It reuses the listing's exclude policy rather than growing a second one:
 * `buildIgnoreChain` and `isPathIgnored` from `excludes.ts` decide what is
 * hidden here exactly as they decide it for a directory page, so a folder the
 * tree hides is a folder search does not offer. A second copy of that policy
 * would be a second answer to "what is in this project".
 *
 * ## Symlinks are not followed, so there are no cycles to defeat
 *
 * VS Code's walker follows links and therefore has to carry a realpath set to
 * escape cycles (`fileSearch.ts`, `walkedPaths` in `doWalk`). Vex does not
 * follow them at all: `listing.ts` reports a symlink AS a symlink with `lstat`
 * and never resolves it, `resolveNodePath` refuses a path with a link component
 * outright, and a token minted for a followed link would name a file outside
 * the project. Keeping that rule here means the walk terminates by
 * construction, needs no cycle bookkeeping, and cannot enumerate a single path
 * the rest of the surface would refuse to open.
 *
 * ## The cap is announced, never silent
 *
 * At `SEARCH_INDEX_FILE_MAX` the walk stops and says `capped`. Every query made
 * against a capped index carries that fact to the user, because a name that was
 * never collected cannot be found and "no matches" would be a lie.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { SEARCH_INDEX_FILE_MAX } from "@shared/schemas/studio-search.js";

import { log } from "../../logger/index.js";
import { buildIgnoreChain, isPathIgnored } from "../files/excludes.js";
import { describeFileFailure } from "../files/node-path.js";

export interface NameWalkResult {
  /** Project-relative POSIX paths of regular files, in walk order. */
  readonly paths: readonly string[];
  /** The walk stopped at the cap; names beyond it were never collected. */
  readonly capped: boolean;
  /** Directories opened, for the log line and for the measurement tests. */
  readonly directoriesWalked: number;
  /** Wall-clock milliseconds the walk took. */
  readonly durationMs: number;
}

export interface NameWalkOptions {
  readonly projectId: string;
  /** The REALPATH of the project directory, already containment-proven. */
  readonly projectDirectory: string;
  /** Stop early. The caller owns the reason; the walk just checks it. */
  readonly isCancelled?: () => boolean;
  /** Test seam. Production leaves this at `SEARCH_INDEX_FILE_MAX`. */
  readonly fileCap?: number;
}

/**
 * Collect every file name in a project.
 *
 * Iterative, not recursive: a project may legitimately nest deeply and a
 * recursive walk over an adversarial tree is a stack the main process does not
 * need to risk. The explicit queue is breadth-first, which also means the cap,
 * when it bites, keeps the SHALLOW files - the ones a user is most likely to be
 * looking for - rather than whatever happened to be first alphabetically at the
 * bottom of one branch.
 */
export async function walkProjectFileNames(
  options: NameWalkOptions,
): Promise<NameWalkResult> {
  const cap = options.fileCap ?? SEARCH_INDEX_FILE_MAX;
  const startedAt = Date.now();
  const paths: string[] = [];
  let capped = false;
  let directoriesWalked = 0;

  // The project root is the empty relative path, exactly as everywhere else in
  // this feature.
  const queue: string[] = [""];

  while (queue.length > 0) {
    if (options.isCancelled?.() === true) break;
    const relativeDirectory = queue.shift() ?? "";
    const absoluteDirectory = relativeDirectory === ""
      ? options.projectDirectory
      : path.join(options.projectDirectory, ...relativeDirectory.split("/"));

    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (cause) {
      // A directory that vanished or refused is SKIPPED, not fatal. The index
      // is a convenience over a tree the user is editing while we read it, and
      // one unreadable folder must not cost them the other 20,000 names.
      log.warn(
        `[studio:search] a directory could not be walked ${describeFileFailure(cause)}`,
      );
      continue;
    }
    directoriesWalked += 1;

    const chain = await buildIgnoreChain(
      options.projectId,
      options.projectDirectory,
      relativeDirectory,
    );

    for (const entry of entries) {
      // THE OS'S OWN BYTES, unnormalised, for the reason `listing.ts` documents
      // at length: normalising a decomposed name mints a token for a path that
      // does not exist. Mint and resolve have to agree, so the walk carries
      // exactly what `readdir` returned.
      const name = entry.name;
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;

      if (entry.isDirectory()) {
        if (isPathIgnored(chain, relativePath, true)) continue;
        queue.push(relativePath);
        continue;
      }
      // Not a directory and not a regular file: a symlink (never followed, and
      // never opened by this surface), a socket, a device. Nothing here can be
      // opened as a file, so offering its name would be offering a dead row.
      if (!entry.isFile()) continue;
      if (isPathIgnored(chain, relativePath, false)) continue;

      if (paths.length >= cap) {
        capped = true;
        break;
      }
      paths.push(relativePath);
    }

    if (capped) break;
  }

  return {
    paths,
    capped,
    directoriesWalked,
    durationMs: Date.now() - startedAt,
  };
}
