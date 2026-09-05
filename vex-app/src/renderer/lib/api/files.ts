/**
 * Vex Studio project files - the renderer's data-access layer (stage B3a).
 *
 * TYPED FUNCTIONS ONLY, deliberately, for the same reason `terminal.ts` in this
 * directory is: a file tree is not a query. It is a live subscription with its
 * own lifetime, and the component that owns the subscription owns the
 * invalidation. Wrapping it in a cache now would put the watcher's lifecycle
 * under a cache's rules, which is the ownership mistake the frontend state
 * matrix warns about.
 *
 * A LISTING, on the other hand, IS a query - one page of one directory, keyed
 * by (project, node, cursor) - and stage B3b's tree is where that hook belongs,
 * beside the component that knows when a `resync` should invalidate it. This
 * file is the one honest seam over `window.vex.files.*`, so B3b's components do
 * not each reach for the global and a bridge change surfaces as one compile
 * error here.
 */

import type { Result } from "@shared/ipc/result.js";
import type {
  FileContent,
  FileDeleteMode,
  FileDeleteResult,
  FileListing,
  FileNode,
  FilesEvent,
  FilesOutcome,
  FilesSubscription,
} from "@shared/schemas/files.js";

/** One page of a directory. `nodeId: null` lists the project root. */
export function listProjectChildren(input: {
  projectId: string;
  nodeId: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<Result<FilesOutcome<FileListing>>> {
  return window.vex.files.listChildren(input);
}

/** A file's whole contents, or a typed reason there are none to show. */
export function readProjectFile(
  projectId: string,
  nodeId: string,
): Promise<Result<FilesOutcome<FileContent>>> {
  return window.vex.files.readFile({ projectId, nodeId });
}

/**
 * Subscribe to changes. `nodeId: null` watches the whole tree.
 *
 * On a project switch, call this for the NEW project BEFORE releasing the old
 * subscription: watchers are refcounted per project, and subscribing first is
 * what closes the window in which a change lands between a listing and its
 * watcher going live.
 */
export function watchProjectFiles(input: {
  projectId: string;
  nodeId: string | null;
}): Promise<Result<FilesOutcome<FilesSubscription>>> {
  return window.vex.files.watchFile(input);
}

/** Release a subscription. Idempotent. */
export function unwatchProjectFiles(
  subscriptionId: string,
): Promise<Result<FilesOutcome<null>>> {
  return window.vex.files.unwatchFile({ subscriptionId });
}

/**
 * Show one node in the operating system's file manager.
 *
 * The renderer never learns where the project is on disk: it names the node it
 * is already displaying and main resolves the rest. A refusal is a statement
 * about that node - it is gone, its path leaves the project, the project was
 * closed - and the caller says so rather than retrying.
 */
export function revealProjectNodeInFileManager(input: {
  projectId: string;
  nodeId: string;
}): Promise<Result<FilesOutcome<null>>> {
  return window.vex.files.revealInFileManager(input);
}

/**
 * Create one entry in a directory. `parentNodeId: null` is the project root.
 *
 * DELIBERATELY NOT A MUTATION HOOK. The explorer session already owns this
 * project's tree, its watcher subscription and its optimistic state, and a
 * cache layer here would be a second owner deciding when that tree is stale -
 * the ownership mistake the read side of this file already refuses for the same
 * reason.
 */
export function createProjectNode(input: {
  projectId: string;
  parentNodeId: string | null;
  name: string;
  kind: "file" | "directory";
}): Promise<Result<FilesOutcome<FileNode>>> {
  return window.vex.files.createNode(input);
}

/** Rename one entry in place. The parent directory never changes. */
export function renameProjectNode(input: {
  projectId: string;
  nodeId: string;
  name: string;
}): Promise<Result<FilesOutcome<FileNode>>> {
  return window.vex.files.renameNode(input);
}

/**
 * Delete one entry, with the disposition the user's confirmation described.
 *
 * `trash_unavailable` means the entry is still there: the caller offers
 * permanent removal as a SECOND decision rather than retrying with a different
 * mode on the user's behalf.
 */
export function deleteProjectNode(input: {
  projectId: string;
  nodeId: string;
  mode: FileDeleteMode;
}): Promise<Result<FilesOutcome<FileDeleteResult>>> {
  return window.vex.files.deleteNode(input);
}

/** Events for one subscription. Returns an idempotent cleanup. */
export function onProjectFilesEvent(
  subscriptionId: string,
  cb: (event: FilesEvent) => void,
): () => void {
  return window.vex.files.onFilesEvent(subscriptionId, cb);
}
