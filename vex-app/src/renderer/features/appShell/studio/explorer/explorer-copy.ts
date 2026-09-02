/**
 * EVERY user-visible string this feature can show, in one place.
 *
 * Not a style preference: a refusal the user cannot act on is the failure mode
 * the product rules name explicitly, and the only way to keep sixteen distinct
 * `FilesErrorCode`s from collapsing into "something went wrong" is to make the
 * mapping a TABLE that a reviewer can read end to end.
 *
 * Two conventions hold throughout:
 *
 *  - a sentence says what could not be done and what the person can do next,
 *    never what Vex failed at internally;
 *  - nothing here interpolates a path, a provider message or an errno. Main
 *    logs the sentence with the real cause; the wire carries a code, and this
 *    file turns the code into English.
 */

import type { FilesErrorCode, FilesWatcherWarning } from "@shared/schemas/files.js";

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

export const EXPLORER_SECTION_LABEL = "Explorer";

/** The accessible name of the tree itself, announced on focus. */
export const EXPLORER_TREE_LABEL = "Project files";

export const EXPLORER_REFRESH_LABEL = "Refresh";
export const EXPLORER_REFRESH_TOOLTIP = "Re-read this project from disk";
export const EXPLORER_COLLAPSE_ALL_LABEL = "Collapse all";
export const EXPLORER_COLLAPSE_ALL_TOOLTIP = "Collapse every open folder";

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** The load-more row's visible text and its accessible name. */
export function showMoreLabel(remaining: number): string {
  return remaining === 1 ? "Show 1 more entry" : `Show ${String(remaining)} more entries`;
}

/** Said while the next page is in flight. */
export const SHOW_MORE_LOADING = "Loading more entries...";

/** Said when the next page failed. Enter retries. */
export const SHOW_MORE_FAILED = "The rest of this folder could not be read. Press Enter to retry.";

/**
 * The description attached to a directory whose exclude rules hid entries.
 *
 * A description rather than a row: there is no action yet that could un-hide
 * them, and a row the user cannot act on is noise in a list they navigate by
 * arrow key. The COUNT still has to be said, because a directory that silently
 * omits `node_modules` is a directory lying about its contents.
 */
export function hiddenEntriesDescription(count: number): string {
  return count === 1
    ? "1 entry hidden by ignore rules"
    : `${String(count)} entries hidden by ignore rules`;
}

/** An empty project root. A directory that lists to zero children shows nothing. */
export const EMPTY_PROJECT = "This project has no files yet";

/* ------------------------------------------------------------------ *
 * Watcher state, at the root
 * ------------------------------------------------------------------ */

export const ROOT_SUSPENDED =
  "This project folder is not on disk right now. Vex is watching for it to come back.";

export const ROOT_CLOSED = "This project was deleted.";

/**
 * The `unavailable` states, one sentence each.
 *
 * They are separate members on the wire precisely because the remedy differs -
 * a system watch limit, a process descriptor limit and a spent restart budget
 * are three different problems - so collapsing them here would throw away the
 * distinction main went to the trouble of preserving.
 */
const WATCHER_WARNING_COPY: Readonly<Record<FilesWatcherWarning, string>> = {
  os_watch_limit_reached:
    "This system has no file-watch slots left, so the tree will not update on its own. Use Refresh to see the current files, or raise the system's file-watch limit.",
  os_file_limit_reached:
    "Vex has no open-file slots left, so the tree will not update on its own. Use Refresh to see the current files, or raise the process file limit.",
  restart_cap_reached:
    "The file watcher failed repeatedly and has stopped. Use Refresh to see the current files.",
};

/**
 * What to say about an unavailable watcher.
 *
 * Warnings are STICKY and can arrive several at once; the first is reported
 * because it is the one that caused the state, and the fallback covers an
 * `unavailable` that carried no warning at all rather than saying nothing.
 */
export function watcherUnavailableText(
  warnings: readonly FilesWatcherWarning[],
): string {
  const first = warnings[0];
  if (first === undefined) {
    return "The file watcher is not running, so the tree will not update on its own. Use Refresh to see the current files.";
  }
  return WATCHER_WARNING_COPY[first];
}

/* ------------------------------------------------------------------ *
 * Listing refusals
 * ------------------------------------------------------------------ */

/**
 * One sentence per code a `listChildren` can answer with.
 *
 * The table is exhaustive over `FilesErrorCode` on purpose: adding a code to
 * the shared schema without deciding what the tree says about it should be a
 * compile error, not a silent fallthrough to a generic string.
 */
const LISTING_ERROR_COPY: Readonly<Record<FilesErrorCode, string>> = {
  invalid_node: "This folder is no longer where Vex left it. Refreshing the tree will find it.",
  invalid_cursor: "The rest of this folder could not be read. Press Enter to retry.",
  not_found: "This folder is no longer on disk.",
  outside_project: "This folder resolves outside the project, so Vex will not open it.",
  symlinked_path: "This is a symbolic link. Vex does not follow links out of a project.",
  path_changed: "This changed on disk while Vex was opening it. Refreshing will read it again.",
  not_a_directory: "This is not a folder any more.",
  not_a_file: "This is not a file.",
  too_large: "This file is larger than Vex will open.",
  binary: "This file is binary.",
  invalid_utf8: "This file is not valid UTF-8 text.",
  project_closed: ROOT_CLOSED,
  root_unavailable: "The projects folder could not be read. Restart Vex to try again.",
  watcher_limit:
    "Vex is watching the maximum number of projects. Close a project to watch this one.",
  subscription_limit:
    "This window holds the maximum number of file subscriptions. Close some open files to add more.",
  watcher_unavailable:
    "The file watcher is not running for this project, so the tree will not update on its own.",
  unknown_subscription: "This project's file subscription ended. Refreshing will start a new one.",
  io_error: "This folder could not be read.",
};

export function listingErrorText(code: FilesErrorCode): string {
  return LISTING_ERROR_COPY[code];
}

/**
 * A listing that failed as INFRASTRUCTURE rather than as an answer about the
 * folder: the call itself did not complete. Distinct from every code above,
 * because "Vex could not ask" and "the folder cannot be read" are different
 * facts and only one of them is about the user's disk.
 */
export const LISTING_TRANSPORT_FAILED =
  "Vex could not reach the file service. Press Enter to retry.";

/** The watcher could not be started at all, so nothing can be listed either. */
export const WATCH_FAILED =
  "Vex could not open this project's files. Use Refresh to try again.";
