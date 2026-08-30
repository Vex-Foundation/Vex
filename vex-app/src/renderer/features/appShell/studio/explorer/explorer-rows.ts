/**
 * THE ROW VOCABULARY - what the explorer can put on a line, as a closed union.
 *
 * Separated from `explorer-model.ts` because these are the CONTRACT and that is
 * the ENGINE. B4's sidebar, the row component and the session all read these
 * shapes; only the model mutates them, and only the model needs the splice
 * machinery, the index maps and the render counts that live next to it.
 *
 * Three kinds, and the two that are not filesystem entries exist because the
 * tree is the wrong shape to say what they say any other way:
 *
 *  - a paged directory has to offer the REST of itself, and a bound that does
 *    not report itself is a silent cut;
 *  - a directory that could not be read, or a project whose watcher is gone,
 *    has to say WHY where the user is looking, not in a log they will not open.
 */

import type { FileNode, FilesErrorCode } from "@shared/schemas/files.js";

/* ------------------------------------------------------------------ *
 * The row union
 * ------------------------------------------------------------------ */

/** How far a directory's own listing has got. Meaningless for a file. */
export type ExplorerLoadState = "idle" | "loading" | "loaded" | "error";

/** How far the "show more" affordance of one directory has got. */
export type ExplorerLoadMoreState = "idle" | "loading" | "error";

interface ExplorerRowBase {
  /** Unique within the tree. A node row's id IS its `nodeId`. */
  readonly id: string;
  /** Depth from the project root, 0-based. `aria-level` is this plus one. */
  readonly level: number;
  /** The owning directory's `nodeId`, or `null` for a row directly at the root. */
  readonly parentId: string | null;
  /** 1-based position among the owning directory's ROWS, tail rows included. */
  readonly posInSet: number;
  /** How many rows the owning directory has, tail rows included. */
  readonly setSize: number;
}

/** A real filesystem entry. */
export interface ExplorerNodeRow extends ExplorerRowBase {
  readonly kind: "node";
  readonly node: FileNode;
  /** Directories only; always false for a file. */
  readonly expanded: boolean;
  /** Whether this directory's children have been listed at least once. */
  readonly resolved: boolean;
  readonly loadState: ExplorerLoadState;
  readonly errorCode: FilesErrorCode | null;
  /** Rows loaded so far. The page size a refresh re-lists with. */
  readonly loadedCount: number;
  /** What main said this directory holds in total, or null before a listing. */
  readonly totalCount: number | null;
  /** What the exclude rules hid, or null before a listing. */
  readonly excludedCount: number | null;
}

/**
 * The "show the rest" row. Exactly one per directory whose last page said
 * `hasMore`, positioned as that directory's LAST child row.
 *
 * It counts itself into `posInSet`/`setSize` on purpose: a screen reader that
 * hears "Show 300 more entries, 201 of 201" has been told the truth about the
 * list it is in. Hiding the row from the set would make the count claim the
 * directory ends where the page does.
 */
export interface ExplorerLoadMoreRow extends ExplorerRowBase {
  readonly kind: "loadMore";
  /** `totalCount` minus what is loaded. Never a guess; main counted it. */
  readonly remaining: number;
  /** Opaque; passed back verbatim. */
  readonly cursor: string;
  readonly state: ExplorerLoadMoreState;
  readonly errorCode: FilesErrorCode | null;
}

/**
 * A sentence in the tree, where the tree itself is the wrong shape to say it:
 * one per directory whose listing failed, and one at the ROOT for the
 * suspended, unavailable and closed watcher states.
 */
export interface ExplorerNoticeRow extends ExplorerRowBase {
  readonly kind: "notice";
  readonly text: string;
  /** `"retry"` renders an affordance and makes Enter mean retry. */
  readonly action: "retry" | null;
  readonly code: FilesErrorCode | null;
  readonly tone: ExplorerNoticeTone;
}

export type ExplorerRow = ExplorerNodeRow | ExplorerLoadMoreRow | ExplorerNoticeRow;

/** How a listing joins what a directory already holds. */
export type SetChildrenMode = "replace" | "append";

/** A directory's load-more tail row, as the session sets it. */
export interface LoadMoreDescriptor {
  readonly remaining: number;
  readonly cursor: string;
  readonly state: ExplorerLoadMoreState;
  readonly errorCode?: FilesErrorCode;
}

/**
 * Whether a notice reports a FAILURE or states a fact.
 *
 * "This project has no files yet" is the tree telling the truth about an empty
 * folder; a warning mark on it would claim something is wrong when nothing is.
 * Every other notice on this surface - suspended, closed, unavailable, and each
 * listing refusal - is a failure and keeps the mark.
 */
export type ExplorerNoticeTone = "info" | "warning";

/** A directory's (or the root's) notice tail row, as the session sets it. */
export interface NoticeDescriptor {
  readonly text: string;
  readonly action: "retry" | null;
  readonly code?: FilesErrorCode;
  readonly tone: ExplorerNoticeTone;
}
