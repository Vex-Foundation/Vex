/**
 * ONE search over two kinds of thing: the user's projects and the open
 * project's files.
 *
 * Pure, so the whole answer - what matched, what was cut, and what was never
 * looked at - is table-testable without mounting a rail.
 *
 * ## The file half is now a project-wide index
 *
 * It used to be the nodes the explorer had already loaded, which is the folders
 * a human had expanded: a file in an unopened folder could not be found. Main
 * now walks the whole project once per search session and ranks names there
 * (`shared/schemas/studio-search.ts`), and this function MERGES that answer with
 * the loaded nodes rather than replacing them, for two reasons:
 *
 *  - the index takes a moment to build, and the loaded nodes are an honest
 *    answer to show meanwhile instead of an empty list;
 *  - a loaded node is a row the user can already see in the tree, so when both
 *    halves offer the same file the loaded one wins - VS Code orders its
 *    already-open editors ahead of file-search results the same way
 *    (`anythingQuickAccess.ts`: history picks first, then
 *    `additionalPicksExcludes` drops the file result that duplicates one).
 *
 * ## The bounds are part of the answer, not a hidden trim
 *
 * Four limits ride in this result and every one is said out loud by the rail:
 *
 *  - SHOW: at most {@link RAIL_SEARCH_GROUP_LIMIT} rows per group, with the
 *    match counts carrying how many exist;
 *  - SCAN: at most {@link RAIL_SEARCH_SCAN_MAX} loaded nodes are read out of
 *    the explorer model;
 *  - INDEX CAP: the project holds more files than one index may, so a name may
 *    never have been collected at all;
 *  - RANKING: more names matched than main was willing to score.
 */

import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import type {
  SearchFileMatch,
  SearchIndexState,
} from "@shared/schemas/studio-search.js";

/** Rows shown per group before the count line takes over. */
export const RAIL_SEARCH_GROUP_LIMIT = 20;

/** Loaded nodes examined per keystroke. The walk stops here and says so. */
export const RAIL_SEARCH_SCAN_MAX = 2000;

/**
 * What the index behind this answer was doing.
 *
 * Two states beyond main's own: `off` when no project is open (there is nothing
 * to index) and `unavailable` when the query failed. `unavailable` is NOT
 * folded into "no matches" - a search that could not run and a search that ran
 * and found nothing are different statements, and only one of them means the
 * file is not there.
 */
export type RailIndexState = SearchIndexState | "off" | "unavailable";

/** Main's answer for the file half, as the rail holds it. */
export interface RailIndexedFiles {
  readonly state: RailIndexState;
  readonly matches: readonly SearchFileMatch[];
  readonly totalMatches: number;
  /** Ranking scored only a bounded prefix of the matching set. */
  readonly truncated: boolean;
  readonly indexedFileCount: number;
  /** When the walk finished, epoch ms, or null while it has not. */
  readonly indexedAtMs: number | null;
}

/** No project open, so there is nothing to index and nothing to say about one. */
export const RAIL_INDEX_OFF: RailIndexedFiles = {
  state: "off",
  matches: [],
  totalMatches: 0,
  truncated: false,
  indexedFileCount: 0,
  indexedAtMs: null,
};

export interface RailSearchResults {
  /** The trimmed, lower-cased needle. Empty means "no query": both lists are empty. */
  readonly needle: string;
  readonly projects: readonly ProjectDto[];
  /** How many projects matched, including the ones beyond the group limit. */
  readonly projectMatchCount: number;
  readonly files: readonly FileNode[];
  /**
   * How many files matched, including the ones beyond the group limit.
   *
   * When the index answered this is the INDEX's count, because the index covers
   * the whole project and the loaded nodes are a subset of it. Only a CAPPED
   * index can hold fewer names than the tree has loaded, and that case is
   * reported by `indexState` rather than smuggled into this number.
   */
  readonly fileMatchCount: number;
  /**
   * The read of loaded nodes stopped at {@link RAIL_SEARCH_SCAN_MAX}. Only
   * meaningful while the index has not answered: once it has, the loaded nodes
   * are a convenience on top of a project-wide result, not the answer itself.
   */
  readonly scanTruncated: boolean;
  readonly indexState: RailIndexState;
  /** Main ranked only a bounded prefix of the matching names. */
  readonly indexTruncated: boolean;
  /** How many names the index holds. Zero until it has answered. */
  readonly indexedFileCount: number;
  /** When the index was walked, epoch ms, or null when it has not answered. */
  readonly indexedAtMs: number | null;
}

const EMPTY: RailSearchResults = {
  needle: "",
  projects: [],
  projectMatchCount: 0,
  files: [],
  fileMatchCount: 0,
  scanTruncated: false,
  indexState: "off",
  indexTruncated: false,
  indexedFileCount: 0,
  indexedAtMs: null,
};

/**
 * Match projects by name, and files by main's ranking merged with the loaded
 * nodes.
 *
 * Projects are matched here by case-insensitive substring on the NAME: the rail
 * renders names, and matching something the row does not show would produce
 * hits whose reason the user cannot see. FILES are ranked in main, so the order
 * of the indexed half is the fuzzy score and not this function's.
 *
 * @param projects every project the rail knows about, in list order.
 * @param loadedFiles the open project's loaded nodes, in tree order, ALREADY
 *   bounded by their reader. Pass an empty list when no project is open.
 * @param query the raw field text.
 * @param loadedTruncated whether that reader stopped before the end of the
 *   loaded tree. Passed in rather than inferred from `loadedFiles.length`: a
 *   capped array cannot tell a tree of exactly the cap from a far bigger one.
 * @param indexed main's answer, or {@link RAIL_INDEX_OFF} when there is none.
 * @returns the two bounded groups plus everything that describes what was cut.
 */
export function deriveRailSearchResults(
  projects: readonly ProjectDto[],
  loadedFiles: readonly FileNode[],
  query: string,
  loadedTruncated = false,
  indexed: RailIndexedFiles = RAIL_INDEX_OFF,
): RailSearchResults {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return EMPTY;

  const projectHits: ProjectDto[] = [];
  let projectMatchCount = 0;
  for (const project of projects) {
    if (!project.name.toLowerCase().includes(needle)) continue;
    projectMatchCount += 1;
    if (projectHits.length < RAIL_SEARCH_GROUP_LIMIT) projectHits.push(project);
  }

  const fileHits: FileNode[] = [];
  const seenPaths = new Set<string>();
  let loadedMatchCount = 0;
  // Directories are excluded: opening one is a tree action the result row
  // cannot perform, and a row that looks like a hit but does nothing on Enter
  // is worse than no row.
  for (const node of loadedFiles) {
    if (node.kind !== "file") continue;
    if (!node.name.toLowerCase().includes(needle)) continue;
    loadedMatchCount += 1;
    if (seenPaths.has(node.path)) continue;
    seenPaths.add(node.path);
    if (fileHits.length < RAIL_SEARCH_GROUP_LIMIT) fileHits.push(node);
  }

  for (const match of indexed.matches) {
    if (fileHits.length >= RAIL_SEARCH_GROUP_LIMIT) break;
    // The loaded row for the same file is already in the list, and it is the
    // one the user can see in the tree. Both address the same file, so keeping
    // both would be the same row twice.
    if (seenPaths.has(match.relativePath)) continue;
    seenPaths.add(match.relativePath);
    fileHits.push(indexMatchAsNode(match));
  }

  const indexAnswered = indexed.state === "ready" || indexed.state === "capped";

  return {
    needle,
    projects: projectHits,
    projectMatchCount,
    files: fileHits,
    fileMatchCount: indexAnswered
      ? Math.max(indexed.totalMatches, fileHits.length)
      : loadedMatchCount,
    // Once the index has answered, the loaded reader's cap no longer bounds the
    // ANSWER, so repeating it would point the user at a limit that is not the
    // one they are hitting.
    scanTruncated: indexAnswered ? false : loadedTruncated,
    indexState: indexed.state,
    indexTruncated: indexed.truncated,
    indexedFileCount: indexed.indexedFileCount,
    indexedAtMs: indexed.indexedAtMs,
  };
}

/**
 * One ranked match as a tree node.
 *
 * `size` and `modifiedMs` are null and not fabricated: the index holds names,
 * the walk never stat-ed these files, and a zero would be a measurement nobody
 * took. The row renders a name and a path, and Enter opens it through the same
 * token path a tree row uses, so nothing downstream needs the missing fields.
 */
function indexMatchAsNode(match: SearchFileMatch): FileNode {
  const cut = match.relativePath.lastIndexOf("/");
  return {
    nodeId: match.nodeId,
    name: cut === -1 ? match.relativePath : match.relativePath.slice(cut + 1),
    path: match.relativePath,
    kind: "file",
    size: null,
    modifiedMs: null,
  };
}

/** Every hit in keyboard order: projects first, then files. */
export function railSearchHitCount(results: RailSearchResults): number {
  return results.projects.length + results.files.length;
}
