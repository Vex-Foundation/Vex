/**
 * ONE search over two kinds of thing: the user's projects and the files the
 * open project's explorer has already loaded.
 *
 * Pure, so the whole answer - what matched, what was cut, and what was never
 * looked at - is table-testable without mounting a rail.
 *
 * ## The bound is part of the answer, not a hidden trim
 *
 * There is no main-side file-name index behind this. The file half runs over
 * the nodes the explorer session holds, which is exactly the folders the user
 * has expanded. Two separate limits therefore ride in the result and are said
 * out loud by the rail:
 *
 *  - SCAN: at most {@link RAIL_SEARCH_SCAN_MAX} loaded nodes are read out of the
 *    explorer model, so a project with an enormous expanded tree cannot make one
 *    keystroke walk an unbounded list. The MODEL reports that its read stopped
 *    early (`ExplorerModel.loadedNodes` returns `truncated`) and that fact
 *    travels through here to the screen: a scan that stopped may have missed a
 *    matching file entirely, which is a worse fact than an unshown match.
 *  - SHOW: at most {@link RAIL_SEARCH_GROUP_LIMIT} rows are returned per group,
 *    with `projectMatchCount` / `fileMatchCount` carrying how many matched in
 *    total, so the rail can say "showing 20 of 57" rather than pretending the
 *    list ended.
 *
 * Neither is a silent cut: every row not shown is reachable by narrowing the
 * query, and the counts say how many there are.
 */

import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";

/** Rows shown per group before the count line takes over. */
export const RAIL_SEARCH_GROUP_LIMIT = 20;

/** Loaded nodes examined per keystroke. The walk stops here and says so. */
export const RAIL_SEARCH_SCAN_MAX = 2000;

export interface RailSearchResults {
  /** The trimmed, lower-cased needle. Empty means "no query": both lists are empty. */
  readonly needle: string;
  readonly projects: readonly ProjectDto[];
  /** How many projects matched, including the ones beyond the group limit. */
  readonly projectMatchCount: number;
  readonly files: readonly FileNode[];
  /** How many loaded files matched, including the ones beyond the group limit. */
  readonly fileMatchCount: number;
  /**
   * The read of loaded nodes stopped at {@link RAIL_SEARCH_SCAN_MAX}, so files
   * beyond it were never examined and a match among them is not in `files`.
   */
  readonly scanTruncated: boolean;
}

const EMPTY: RailSearchResults = {
  needle: "",
  projects: [],
  projectMatchCount: 0,
  files: [],
  fileMatchCount: 0,
  scanTruncated: false,
};

/**
 * Match projects by name and loaded files by name.
 *
 * Case-insensitive substring on the NAME in both halves, deliberately: the rail
 * renders names, and matching a path segment the row does not show would
 * produce hits whose reason the user cannot see. A file's path is still shown
 * on its result row, so a matched name is always locatable.
 *
 * @param projects every project the rail knows about, in list order.
 * @param loadedFiles the open project's loaded nodes, in tree order, ALREADY
 *   bounded by their reader. Pass an empty list when no project is open - there
 *   is nothing loaded to search.
 * @param query the raw field text.
 * @param loadedTruncated whether that reader stopped before the end of the
 *   loaded tree. Passed in rather than inferred from `loadedFiles.length`: a
 *   capped array cannot tell a tree of exactly the cap from a far bigger one.
 * @returns the two bounded groups plus the counts that describe what was cut.
 */
export function deriveRailSearchResults(
  projects: readonly ProjectDto[],
  loadedFiles: readonly FileNode[],
  query: string,
  loadedTruncated = false,
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
  let fileMatchCount = 0;
  // Directories are excluded: opening one is a tree action the result row
  // cannot perform, and a row that looks like a hit but does nothing on Enter
  // is worse than no row.
  for (const node of loadedFiles) {
    if (node.kind !== "file") continue;
    if (!node.name.toLowerCase().includes(needle)) continue;
    fileMatchCount += 1;
    if (fileHits.length < RAIL_SEARCH_GROUP_LIMIT) fileHits.push(node);
  }

  return {
    needle,
    projects: projectHits,
    projectMatchCount,
    files: fileHits,
    fileMatchCount,
    scanTruncated: loadedTruncated,
  };
}

/** Every hit in keyboard order: projects first, then files. */
export function railSearchHitCount(results: RailSearchResults): number {
  return results.projects.length + results.files.length;
}
