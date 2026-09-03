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

import type {
  FileDeleteMode,
  FileNameRefusal,
  FileNodeKind,
  FilesErrorCode,
  FilesWatcherWarning,
} from "@shared/schemas/files.js";

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

  // The mutation codes. A LISTING never produces one, and they are here because
  // the table is exhaustive over the wire's enum on purpose: adding a code to
  // the shared schema without deciding what the tree says about it is a compile
  // error, which is exactly how these six arrived. The sentences the user
  // actually reads for a failed create, rename or delete come from
  // `mutationErrorText` below, which is aimed at the row being edited rather
  // than at a folder that could not be read.
  name_invalid: "That name cannot be used.",
  name_exists: "Something with that name is already here.",
  vex_managed: "Vex manages this file. Use Repair to change it.",
  write_denied: "This project folder is not writable.",
  trash_unavailable: "This system has no trash available.",
  mutation_busy: "Another change to this project is still running. Try again.",
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

/* ------------------------------------------------------------------ *
 * Creating, renaming and deleting
 * ------------------------------------------------------------------ */

export const EXPLORER_NEW_FILE_LABEL = "New file";
export const EXPLORER_NEW_FOLDER_LABEL = "New folder";
export const EXPLORER_RENAME_LABEL = "Rename";
export const EXPLORER_DELETE_LABEL = "Delete";
export const EXPLORER_DELETE_PERMANENT_LABEL = "Delete permanently";

export const EXPLORER_NEW_FILE_TOOLTIP = "Create a file in this project";
export const EXPLORER_NEW_FOLDER_TOOLTIP = "Create a folder in this project";

/** The accessible name of the row context menu, which names its subject. */
export function rowMenuLabel(name: string): string {
  return `Actions for ${name}`;
}

/**
 * The edit row's accessible name.
 *
 * It states the two keys, because the input replaces the row it names and a
 * screen-reader user who cannot see that has no other way to learn how to
 * commit or abandon it. VS Code's own input box does the same
 * (`explorerViewer.ts:1075`: "Type file name. Press Enter to confirm or Escape
 * to cancel.").
 */
export const EXPLORER_EDIT_ARIA_LABEL =
  "Type a name. Press Enter to confirm or Escape to cancel.";

/**
 * Why a typed name cannot be used. Shown LIVE, under the input, as it is typed.
 *
 * One sentence per refusal the shared rule can produce, because a user who is
 * told only "invalid name" has to guess which character offended. Exhaustive
 * over `FileNameRefusal` for the same reason the listing table is exhaustive
 * over `FilesErrorCode`.
 */
const NAME_REFUSAL_COPY: Readonly<Record<FileNameRefusal, string>> = {
  empty: "A name is required.",
  separator: "A name cannot contain a slash. Create the folder first, then the file inside it.",
  relative: "A name cannot be \".\" or \"..\".",
  trailing: "A name cannot start or end with a space, or end with a dot.",
  reserved: "That name is reserved by Windows and would not survive a checkout there.",
  control: "A name cannot contain < > : \" | ? * or a control character.",
  too_long: "That name is too long.",
};

export function nameRefusalText(refusal: FileNameRefusal): string {
  return NAME_REFUSAL_COPY[refusal];
}

/** The sibling collision the renderer can see before main is even asked. */
export function nameTakenText(name: string): string {
  return `"${name}" is already here. Choose a different name.`;
}

/**
 * What a failed create, rename or delete says ON THE ROW.
 *
 * Aimed at the entry the user was editing, which is why it is not
 * `listingErrorText`: "This folder could not be read" is the wrong sentence for
 * a rename that was refused, and a user who reads it looks for the wrong
 * problem. Every code a mutation can answer with has a row here; anything else
 * falls to the listing table, which is total over the enum.
 */
const MUTATION_ERROR_COPY: Partial<Readonly<Record<FilesErrorCode, string>>> = {
  name_invalid: "That name cannot be used.",
  name_exists: "Something with that name is already here.",
  vex_managed:
    "Vex writes this file, so it cannot be renamed or deleted here. Change the project's agents, or use Repair.",
  write_denied: "Vex is not allowed to write here. Check the folder's permissions.",
  trash_unavailable:
    "This system has no trash available, so nothing was deleted. You can delete it permanently instead.",
  mutation_busy: "Another change to this project is still running. Try again in a moment.",
  not_found: "This is no longer on disk.",
  invalid_node: "This row is out of date. Refresh the tree and try again.",
  not_a_directory: "This is not a folder any more.",
  symlinked_path: "This is a symbolic link. Vex does not follow links out of a project.",
  outside_project: "Vex will not change anything outside the project folder.",
  project_closed: ROOT_CLOSED,
  io_error: "The filesystem refused the change.",
};

/** The one sentence for a mutation that did not complete at all. */
export const MUTATION_TRANSPORT_FAILED = "Vex could not reach the file service. Try again.";

/** The sentence for a mutation the user cancelled. Stated, never silent. */
export const MUTATION_CANCELLED = "That change was cancelled. Nothing was written.";

export function mutationErrorText(code: FilesErrorCode): string {
  return MUTATION_ERROR_COPY[code] ?? listingErrorText(code);
}

/* ---- the delete confirmation's consent grammar ---- */

export const EXPLORER_DELETE_TITLE = "Delete from this project";
export const EXPLORER_DELETE_CANCEL = "Cancel";

/**
 * WHAT is being deleted, and it names the entry rather than counting rows.
 *
 * VS Code says "Are you sure you want to delete 'x'?" for a file and "...'x' and
 * its contents?" for a folder (`fileActions.ts:278-282`). The folder half is
 * kept verbatim in meaning, because "and its contents" is the whole difference
 * between the two actions and a user who skims the title must still meet it.
 */
export function deleteConsequenceWhat(name: string, kind: FileNodeKind): string {
  return kind === "directory"
    ? `Delete "${name}" and everything inside it`
    : `Delete "${name}"`;
}

/** WHERE it goes. The user chose this, and the sentence proves which. */
export function deleteDispositionLine(mode: FileDeleteMode): string {
  return mode === "trash"
    ? "It moves to this system's trash."
    : "It is removed from disk immediately.";
}

/**
 * WHETHER it can be undone. The half of the grammar that decides the register.
 *
 * VS Code's two sentences, split the same way: "You can restore this file from
 * the Trash" (`fileActions.ts:175-177`) against "This action is irreversible!"
 * (`fileActions.ts:162`).
 */
export function deleteUndoLine(mode: FileDeleteMode): string {
  return mode === "trash"
    ? "You can restore it from the trash."
    : "This cannot be undone. Vex has no way to bring it back.";
}

/** The confirm button, which says the disposition rather than "OK". */
export function deleteConfirmLabel(mode: FileDeleteMode): string {
  return mode === "trash" ? "Move to trash" : "Delete permanently";
}

export const EXPLORER_DELETE_PENDING = "Deleting...";

/**
 * The offer made when the trash refused, and the reason it is an OFFER.
 *
 * The entry is untouched at this point. Deleting it anyway would remove
 * something the user was told they could restore, so the second disposition is
 * a second decision, with its own irreversible sentence and its own press.
 */
export const EXPLORER_TRASH_UNAVAILABLE_OFFER =
  "This system has no trash available, so nothing was deleted. Delete it permanently instead?";

/** Announced after a delete lands, so the outcome is not only a vanished row. */
export function deletedAnnouncement(name: string, mode: FileDeleteMode): string {
  return mode === "trash"
    ? `Moved "${name}" to the trash.`
    : `Permanently deleted "${name}".`;
}
