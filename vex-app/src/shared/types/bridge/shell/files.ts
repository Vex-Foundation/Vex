import type { Result } from "../../../ipc/result.js";
import type {
  FileContent,
  FileDeleteMode,
  FileDeleteResult,
  FileListing,
  FileNode,
  FilesEvent,
  FilesOutcome,
  FilesSubscription,
} from "../../../schemas/files.js";

/**
 * `vex.files.*` - Vex Studio project files, as the RENDERER sees them.
 *
 * DOMAIN METHODS ONLY. The renderer never sends a path, never receives one, and
 * never learns a channel name. Every node is addressed by an opaque token main
 * minted, and main re-derives and re-checks the real path behind that token on
 * every single call - so a token is a NAME the tree can hold, never an
 * authority it can spend.
 *
 * THREE METHODS WRITE (stage EXP-1). This block used to say "READ-ONLY...
 * mutating a user's repository from a file tree is an approval-gated action and
 * no approval for it exists yet", and the gate arrived with the methods rather
 * than after them: the actor is the USER in their own window (main reads the
 * sender, never a payload field), a delete is sent only from an explicit
 * confirmation whose disposition travels with it, Vex's own artifacts are
 * refused by name, and nothing here takes a path - a create names a parent and
 * an entry name, a rename names a node and an entry name, so neither can move
 * anything or address a destination outside the project.
 *
 * These are NOT model-callable. No tool proposes them and no agent surface
 * reaches them; they exist for a person clicking in a tree.
 *
 * Every method answers with a DISCRIMINATED OUTCOME inside a successful
 * `Result`: "this file is binary", "this file is larger than the viewer will
 * open", "this project was deleted" are answers the UI renders as statements
 * about the file or the project. Only genuine infrastructure failure travels as
 * `Result.error`.
 */
export interface FilesBridge {
  /**
   * One page of one directory's children, in the tree's own total order.
   *
   * `nodeId: null` lists the project root. Nothing is silently omitted: when
   * `hasMore` is true, `nextCursor` is the exact position to resume from, and
   * `totalCount` and `excludedCount` say how many rows exist and how many the
   * exclude rules hid.
   */
  readonly listChildren: (input: {
    projectId: string;
    nodeId: string | null;
    limit?: number;
    cursor?: string | null;
  }) => Promise<Result<FilesOutcome<FileListing>>>;

  /**
   * A file's WHOLE contents, decoded as UTF-8, or a typed reason there are
   * none to show.
   *
   * Never a prefix: a file over the viewer's byte bound is refused with its
   * real size rather than served truncated, and a file whose first bytes
   * contain a NUL is refused as `binary` before the rest is ever read.
   */
  readonly readFile: (input: {
    projectId: string;
    nodeId: string;
  }) => Promise<Result<FilesOutcome<FileContent>>>;

  /**
   * Subscribe to changes.
   *
   * `nodeId: null` subscribes to the whole project tree; a node subscribes to
   * that one open file. Both ride ONE native watcher per project - opening a
   * file starts no second OS watch - and the returned `state` and `warnings`
   * are the watcher's honest condition, including the durable `unavailable`
   * that an exhausted OS watch limit produces.
   *
   * Changing the selected project should subscribe to the NEW project before
   * releasing the old subscription: watchers are refcounted per project, and
   * subscribing first is what closes the window in which a change lands between
   * a listing and its watcher.
   */
  readonly watchFile: (input: {
    projectId: string;
    nodeId: string | null;
  }) => Promise<Result<FilesOutcome<FilesSubscription>>>;

  /** Release a subscription. Idempotent; refuses a subscription another window owns. */
  readonly unwatchFile: (input: {
    subscriptionId: string;
  }) => Promise<Result<FilesOutcome<null>>>;

  /**
   * Create one entry inside a directory. `parentNodeId: null` is the root.
   *
   * `name` is a SINGLE entry name: a separator in it is refused rather than
   * creating intermediate directories, because a path arriving through this
   * surface is the one thing its design rules out. On success the node comes
   * back described exactly as a listing would describe it, so the tree can show
   * the row immediately instead of waiting for the watcher.
   *
   * `name_exists` comes from the kernel (`O_CREAT|O_EXCL`, `mkdir`), not from a
   * check main made a moment earlier, so it cannot be wrong about a race.
   */
  readonly createNode: (input: {
    projectId: string;
    parentNodeId: string | null;
    name: string;
    kind: "file" | "directory";
  }) => Promise<Result<FilesOutcome<FileNode>>>;

  /**
   * Rename one entry IN PLACE. The parent directory never changes.
   *
   * There is no destination parameter, so this cannot move anything and cannot
   * name a target outside the project. A case-only rename (`readme.md` ->
   * `README.md`) is a rename, not a collision, on every platform.
   */
  readonly renameNode: (input: {
    projectId: string;
    nodeId: string;
    name: string;
  }) => Promise<Result<FilesOutcome<FileNode>>>;

  /**
   * Delete one entry. A directory goes with its contents.
   *
   * `mode` is the disposition the user's confirmation described and main
   * honours exactly it. A `trash` the platform refuses answers
   * `trash_unavailable` with the entry UNTOUCHED - it never falls through to a
   * permanent delete, because the sentence the user read said they could
   * restore it. Offering permanent removal after that refusal is the caller's
   * job, and it is a second decision the person makes.
   */
  readonly deleteNode: (input: {
    projectId: string;
    nodeId: string;
    mode: FileDeleteMode;
  }) => Promise<Result<FilesOutcome<FileDeleteResult>>>;

  /**
   * Events for ONE subscription. Returns an idempotent cleanup.
   *
   * Three kinds arrive here and a consumer that handles only the first is
   * wrong in ways it will not notice:
   *
   *  - `changed` carries a bounded batch. `overflowed` means changes were
   *    dropped and `droppedCount` says how many - the remedy is a re-list, not
   *    a retry.
   *  - `resync` means changes provably happened that no batch carried (the
   *    watcher restarted, the project root came back, the buffer overflowed).
   *    Re-list.
   *  - `status` is the watcher's state and its sticky warnings. A tree over an
   *    `unavailable` watcher must say so rather than looking live.
   *
   * `watcherGeneration` bumps whenever the watcher stopped seeing changes;
   * a batch from a superseded generation describes a tree that no longer
   * exists and should be dropped. `batchSeq` is monotonic within a generation
   * and deliberately not contiguous for a single-file subscription, where a
   * batch that held nothing for this consumer is not sent at all.
   */
  readonly onFilesEvent: (
    subscriptionId: string,
    cb: (event: FilesEvent) => void,
  ) => () => void;
}
