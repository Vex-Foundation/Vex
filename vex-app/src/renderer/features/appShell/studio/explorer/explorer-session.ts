/**
 * THE EXPLORER SESSION - the lifecycle owner for ONE project's file tree.
 *
 * It owns the watcher subscription, the event routing, the listing queue, the
 * refresh scheduler, the focus backstop and the selection. It talks to exactly
 * two things: {@link ExplorerModel}, which is pure, and `lib/api/files.ts`,
 * which is the one seam over the bridge. It renders nothing and imports no
 * React, so every rule below is testable without a DOM.
 *
 * ## The state machine
 *
 * | state       | entered by                        | tree shows                        | watching       |
 * |-------------|-----------------------------------|-----------------------------------|----------------|
 * | idle        | construction                      | nothing                           | no             |
 * | activating  | `activate`                        | previous rows (stale), or nothing | pending        |
 * | live        | watch ok + root listed            | rows                              | yes            |
 * | suspended   | status `suspended` (root vanished)| root notice, no rows              | polling (main) |
 * | unavailable | status `unavailable`, or watch failed | rows + root notice with the reason | no         |
 * | closed      | status `closed` (project deleted) | root notice, no rows              | no             |
 * | inactive    | `deactivate` (kept alive, hidden) | rows kept in memory, not rendered | no             |
 * | disposed    | `dispose`                         | nothing                           | no             |
 *
 * ## Activation order, and the gap it closes
 *
 * Watch, THEN listen, THEN list - never the other way round. Between a listing
 * and the watcher going live there is a window in which a change lands and
 * nobody hears it, and a tree that starts life already wrong will stay wrong
 * until something unrelated refreshes it. The bridge's own doc comment names
 * the same order for the project-switch case, and this is that rule applied to
 * a single session's cold start.
 *
 * A session that comes back from `inactive` has missed EVERY event while it was
 * away, so reactivation re-lists every directory that was expanded and
 * resolved. It does not trust what it kept; it keeps it only so the user's
 * expansion, selection and scroll survive the trip.
 *
 * ## Publication identity
 *
 * Every listing is issued under a LISTING GENERATION. A result is published
 * only when that generation still matches AND the row it targets still exists
 * AND is still expanded. Checking at issue time is not enough: the interesting
 * failures all happen during the await (rule 05).
 *
 * The listing generation is bumped everywhere the session generation is
 * (`activate`, `deactivate`, `dispose`) and ALSO when a watcher state clears
 * the tree (`suspended`, `closed`). It is therefore a strict refinement of the
 * session generation rather than a second, independent fence: one counter is
 * read on the publication path, and it invalidates strictly more.
 *
 * `unavailable` is deliberately NOT one of those states. It keeps its rows -
 * they were true when they were read - so a listing already in flight for one
 * of them still describes something the user is looking at and still publishes.
 *
 * ## The 500 ms scheduler is VS Code's, semantics included
 *
 * `explorerService.ts:37,69-111` uses a `RunOnceScheduler` that is armed on the
 * FIRST event and not re-armed while pending, so it fires 500 ms after that
 * first event and processes everything accumulated since. Re-arming on each
 * event would let a steady stream of changes starve the refresh forever, which
 * is precisely the behaviour a file watcher produces during a build.
 */

import {
  FILES_LIST_PAGE_DEFAULT,
  FILES_LIST_PAGE_MAX,
  fileNameRefusal,
  type FileDeleteMode,
  type FileDeleteResult,
  type FileListing,
  type FileNode,
  type FilesErrorCode,
  type FilesEvent,
  type FilesOutcome,
  type FilesSubscription,
  type FilesWatcherWarning,
} from "@shared/schemas/files.js";
import type { Result } from "@shared/ipc/result.js";
import {
  createProjectNode,
  deleteProjectNode,
  listProjectChildren,
  onProjectFilesEvent,
  renameProjectNode,
  unwatchProjectFiles,
  watchProjectFiles,
} from "../../../../lib/api/files.js";
import {
  EMPTY_PROJECT,
  MUTATION_CANCELLED,
  MUTATION_TRANSPORT_FAILED,
  WATCH_FAILED,
  listingErrorText,
  mutationErrorText,
  nameRefusalText,
  nameTakenText,
} from "./explorer-copy.js";
import { publishFileRename } from "../workspace/file-rename-signal.js";
import { SingleFlightQueue } from "./explorer-listing-queue.js";
import { ExplorerModel } from "./explorer-model.js";
import {
  decideListingFailure,
  decideWatcherState,
  watchFailureNotice,
} from "./explorer-outcome-policy.js";
import type { SetChildrenMode } from "./explorer-rows.js";
import {
  ExplorerRefreshScheduler,
  type RefreshPlan,
} from "./explorer-refresh-scheduler.js";

/* ------------------------------------------------------------------ *
 * Bounds and delays, each with its at-bound behaviour
 * ------------------------------------------------------------------ */

/**
 * How long a burst of file changes accumulates before the tree reacts.
 *
 * VS Code's `EXPLORER_FILE_CHANGES_REACT_DELAY` (`explorerService.ts:37`),
 * value included. At the bound the accumulated marks are processed in one pass;
 * events arriving during that pass arm the NEXT window.
 */
export const EXPLORER_REFRESH_DELAY_MS = 500;

/**
 * The shortest gap between two window-focus refreshes.
 *
 * VS Code refreshes on EVERY focus change (`explorerService.ts:136-140`) to
 * compensate for missing file events. Ours is throttled because our refresh is
 * one IPC round trip per expanded directory rather than an in-process model
 * walk, and an alt-tabbing user would otherwise put a burst of them on the
 * bridge. At the bound the focus is ignored; the watcher is still live and the
 * next focus after the window refreshes.
 */
export const EXPLORER_FOCUS_REFRESH_THROTTLE_MS = 2_000;

/** The page a directory is listed with when nothing says otherwise. */
export const EXPLORER_PAGE_SIZE = FILES_LIST_PAGE_DEFAULT;

/**
 * What a path subscriber is told. CODES, and only three of them.
 *
 * `updated` also carries an `added` for the same path, deliberately. VS Code's
 * `textFileEditorModelManager.ts:122-135` treats ADDED exactly like UPDATED for
 * reload, and it is right: a file deleted and recreated by a tool that writes
 * through a temp file arrives as ADDED, and a viewer that ignored it would sit
 * on contents that no longer exist.
 *
 * A `deleted` arrives for the path itself AND for any ancestor of it: main
 * suppresses the descendant events under a deleted directory, so the ancestor's
 * delete is the only one that will ever be sent about the file. `updated` and
 * its `added` stay exact.
 *
 * `resync` is not a statement about the path at all. It says "this session
 * knows it missed events", and the subscriber's remedy is the same as the
 * tree's: read again rather than trust what it holds.
 */
export interface ExplorerPathEvent {
  readonly kind: "updated" | "deleted" | "resync";
}

export type ExplorerPathListener = (event: ExplorerPathEvent) => void;

export type ExplorerSessionState =
  | "idle"
  | "activating"
  | "live"
  | "suspended"
  | "unavailable"
  | "closed"
  | "inactive"
  | "disposed";

/** Why a directory is being listed. Drives the copy and the retry affordance. */
type ListReason = "initial" | "expand" | "refresh" | "page" | "retry";

interface ListRequest {
  readonly parentId: string | null;
  readonly mode: SetChildrenMode;
  readonly limit: number;
  readonly cursor: string | null;
  readonly reason: ListReason;
  /**
   * For a multi-page refresh: how many rows this directory held before, so the
   * refresh keeps paging until it has restored that much or the folder ends.
   */
  readonly targetCount: number;
}

export interface ExplorerSessionOptions {
  readonly projectId: string;
  /** Injected so a test can hold the model it asserts on. */
  readonly model?: ExplorerModel;
}

export class ExplorerSession {
  readonly projectId: string;
  readonly model: ExplorerModel;

  #state: ExplorerSessionState = "idle";
  readonly #stateListeners = new Set<() => void>();

  /**
   * The SESSION generation: bumped by activate, deactivate and dispose.
   *
   * It identifies one activation of this session, and that is all it does: the
   * activation itself and the event routing use it to tell "still me" from "a
   * straggler for the session I used to be". The publication of a listing is
   * fenced by {@link #listingGeneration}, which invalidates strictly more.
   */
  #generation = 0;
  /**
   * The LISTING generation. THE publication fence.
   *
   * Bumped wherever `#generation` is, and additionally whenever a watcher state
   * clears the tree (`suspended`, `closed`). See the module header.
   */
  #listingGeneration = 0;
  #activation: Promise<void> | null = null;

  #subscriptionId: string | null = null;
  #offEvents: (() => void) | null = null;
  #watcherGeneration = 0;
  /** The last `batchSeq` seen in this watcher generation; `null` before the first. */
  #lastBatchSeq: number | null = null;
  #warnings: readonly FilesWatcherWarning[] = [];

  /** FIFO, one request in flight. A resync of a big tree must not stampede. */
  readonly #queue: SingleFlightQueue<ListRequest>;

  /**
   * The LISTING generation the in-flight listing was issued under.
   *
   * The queue is single-flight, so there is exactly one, and it is the fence a
   * REJECTION has to be judged against: by the time the rejection surfaces the
   * session may have deactivated or been suspended, and the CURRENT listing
   * generation alone would no longer say which one asked.
   */
  #inFlightGeneration = 0;

  /** The 500 ms window. Armed on the first event, never re-armed while open. */
  readonly #refresh: ExplorerRefreshScheduler;

  #onWindowFocus: (() => void) | null = null;
  #lastFocusRefreshAt = 0;

  readonly #reportedDuplicates = new Set<string>();

  #focusedRowId: string | null = null;
  #selectedRowId: string | null = null;

  /**
   * ONE counter over everything a consumer renders from: the model's rows AND
   * the session's own focus, selection and state.
   *
   * `useSyncExternalStore` compares snapshots with `Object.is`, so a component
   * that watched only the model's version would miss a focus move (which
   * changes no row) and a component that watched two stores would need two
   * subscriptions to stay consistent. One counter is one source of truth for
   * "something the tree draws has changed".
   */
  #revision = 0;
  readonly #revisionListeners = new Set<() => void>();
  readonly #unsubscribeModel: () => void;

  /**
   * Per-path subscribers, for the file VIEWER (B3c).
   *
   * The viewer follows one open file, and the honest way to do that is through
   * the session that already holds the project's ONE watcher subscription. A
   * second `watchFile` per open tab would be a second refcount on the same
   * native watcher in main and a second event stream to keep consistent with
   * this one - two sources of truth about the same disk.
   *
   * BOUNDED by the open file tabs: a tab subscribes on mount and unsubscribes
   * on close, and `dispose` clears the map. The tree itself never reads it.
   */
  readonly #pathListeners = new Map<string, Set<ExplorerPathListener>>();

  constructor(options: ExplorerSessionOptions) {
    this.projectId = options.projectId;
    this.model =
      options.model ??
      new ExplorerModel({
        // Production drops the duplicate and keeps the tree usable; the model's
        // default (throw) is what a development build should do instead.
        onDuplicateNode: (nodeId) => {
          this.#reportDuplicate(nodeId);
        },
      });
    this.#unsubscribeModel = this.model.subscribe(() => {
      this.#bumpRevision();
    });
    this.#queue = new SingleFlightQueue<ListRequest>({
      // A refresh of one directory coalesces with another; two PAGE requests
      // for it do not, because they carry different cursors and are different
      // work. See `explorer-listing-queue.ts`.
      key: (request) =>
        request.mode === "replace"
          ? `replace:${request.parentId ?? "root"}`
          : `page:${request.parentId ?? "root"}:${request.cursor ?? ""}`,
      run: (request) => this.#performListing(request),
      // A listing that REJECTS is not an answer about the folder, so it takes
      // the same path a transport failure takes. Without this the queue keeps
      // draining (as documented) but the directory stays in `loading` forever,
      // with a spinner no owner will ever clear.
      onError: (_error, request) => {
        this.#failRejectedListing(request, this.#inFlightGeneration);
      },
    });
    this.#refresh = new ExplorerRefreshScheduler(EXPLORER_REFRESH_DELAY_MS, (plan) => {
      this.#applyRefreshPlan(plan);
    });
  }

  getRevision(): number {
    return this.#revision;
  }

  subscribeRevision(listener: () => void): () => void {
    this.#revisionListeners.add(listener);
    return () => {
      this.#revisionListeners.delete(listener);
    };
  }

  #bumpRevision(): void {
    this.#revision += 1;
    for (const listener of this.#revisionListeners) listener();
  }

  /* ----------------------- per-path subscribers ----------------------- */

  /**
   * Follow one project-relative path. Returns an IDEMPOTENT unsubscribe.
   *
   * An `updated` is matched EXACTLY. A viewer watching `src/a.ts` hears nothing
   * about `src/`, which is right: a change to the directory is not a change to
   * the file's bytes, and re-reading on it would put an IPC round trip on every
   * sibling's save. A `deleted` also reaches every subscriber UNDER the deleted
   * path; `#notifyDeleted` says why.
   *
   * Calling the returned function twice removes nothing the second time, and
   * the empty listener set is deleted so the map stays the size of the open
   * tabs rather than the size of every tab ever opened.
   */
  subscribePath(path: string, listener: ExplorerPathListener): () => void {
    let listeners = this.#pathListeners.get(path);
    if (listeners === undefined) {
      listeners = new Set<ExplorerPathListener>();
      this.#pathListeners.set(path, listeners);
    }
    listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#pathListeners.get(path);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#pathListeners.delete(path);
    };
  }

  /** How many paths have a subscriber. The bound, made measurable. */
  pathSubscriptionCount(): number {
    return this.#pathListeners.size;
  }

  /**
   * Tell one path's subscribers.
   *
   * Iterated over a COPY: a listener that unsubscribes itself while being
   * notified (the viewer does exactly this when a delete leads it to dispose)
   * would otherwise mutate the set mid-iteration.
   */
  #notifyPath(path: string, kind: ExplorerPathEvent["kind"]): void {
    const listeners = this.#pathListeners.get(path);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener({ kind });
  }

  /**
   * Tell a deleted path's subscribers AND everyone under it.
   *
   * The one place the exact-path rule does not hold, and it is not a preference:
   * main's coalescer SUPPRESSES descendant events under a deleted directory
   * (`main/studio/files/coalescer.ts` - a deleted `dir` is emitted, its children
   * are not), so a viewer open on `dir/file.ts` would otherwise wait forever for
   * a per-file delete that will never be sent and keep showing a file that is
   * gone.
   *
   * DELETES ONLY. An `updated` stays exact, because a sibling's save is not a
   * change to your file's bytes and re-reading on it would put an IPC round
   * trip on every write in the directory.
   *
   * BOUNDED by the open tabs: the walk is over the path-listener map, which is
   * the size of the file tabs, never of the tree.
   */
  #notifyDeleted(path: string): void {
    const prefix = `${path}/`;
    for (const [listenerPath, listeners] of [...this.#pathListeners]) {
      // The root deleting takes everything with it; below the root, a
      // descendant is a segment-wise prefix match, so `dir2` is not under
      // `dir`.
      const affected = path === "" || listenerPath === path || listenerPath.startsWith(prefix);
      if (!affected) continue;
      for (const listener of [...listeners]) listener({ kind: "deleted" });
    }
  }

  /**
   * Tell EVERY subscriber the session missed events.
   *
   * Emitted from the two places a full refresh begins - the scheduled one and
   * the header's immediate Refresh - so a viewer's re-read is armed by exactly
   * the moments that arm the tree's.
   */
  #notifyResync(): void {
    if (this.#pathListeners.size === 0) return;
    for (const listeners of [...this.#pathListeners.values()]) {
      for (const listener of [...listeners]) listener({ kind: "resync" });
    }
  }

  /* ----------------------- observable state ----------------------- */

  getState(): ExplorerSessionState {
    return this.#state;
  }

  /** The watcher's sticky warnings, for a header badge or a test. */
  getWarnings(): readonly FilesWatcherWarning[] {
    return this.#warnings;
  }

  subscribeState(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  getFocusedRowId(): string | null {
    return this.#focusedRowId;
  }

  getSelectedRowId(): string | null {
    return this.#selectedRowId;
  }

  setFocusedRowId(rowId: string | null): void {
    if (this.#focusedRowId === rowId) return;
    this.#focusedRowId = rowId;
    this.#emitState();
  }

  setSelectedRowId(rowId: string | null): void {
    if (this.#selectedRowId === rowId) return;
    this.#selectedRowId = rowId;
    this.#emitState();
  }

  /* ----------------------- lifecycle ----------------------- */

  /**
   * Bring the session live. IDEMPOTENT and single-flight.
   *
   * A second call while the first is in flight JOINS it rather than opening a
   * second subscription - which is what a React 19 StrictMode double-mount
   * does, and what a project switched to twice in one frame does.
   */
  activate(): Promise<void> {
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#activation !== null) return this.#activation;
    if (this.#subscriptionId !== null) return Promise.resolve();

    this.#generation += 1;
    this.#listingGeneration += 1;
    const generation = this.#generation;
    this.#setState("activating");
    const activation = this.#runActivation(generation)
      .catch((cause: unknown) => {
        // The bridge REJECTED where a Result was expected. Without this the
        // session would sit in `activating` for the life of the tab: the
        // rejection has no other owner, and a watch that never answered is
        // indistinguishable, to the user, from one that answered "no".
        console.warn(`explorer: activating project ${this.projectId} rejected`, cause);
        if (generation !== this.#generation) return;
        this.#setUnavailable(WATCH_FAILED);
      })
      .finally(() => {
        if (this.#activation === activation) this.#activation = null;
      });
    this.#activation = activation;
    return activation;
  }

  /**
   * Stop watching but KEEP the tree.
   *
   * Expansion, selection and scroll are the user's state, not the watcher's, so
   * they survive. What does not survive is TRUST: every resolved directory is
   * marked stale, because an inactive session heard nothing and a listing
   * nobody was watching over is a guess about the disk.
   */
  async deactivate(): Promise<void> {
    if (this.#state === "disposed" || this.#state === "inactive" || this.#state === "idle") {
      return;
    }
    this.#generation += 1;
    this.#listingGeneration += 1;
    await this.#teardownSubscription();
    // THE NAME BOX DOES NOT SURVIVE, even though the rows do.
    //
    // Expansion, selection and scroll are the user's state and are worth
    // keeping; a half-typed name is too, but it CANNOT BE HONOURED - a commit
    // is fenced by the listing generation this line just bumped, so a box left
    // open would take a name, spin, and be dropped in silence. Worse, a commit
    // already in flight leaves the box `submitting` for ever, because the
    // handler that would clear it returns at that same fence. Closing here is
    // what makes the fence safe to return from.
    this.model.closeEdit();
    this.model.markAllStale();
    this.#setState("inactive");
  }

  /** Release everything for good. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#generation += 1;
    this.#listingGeneration += 1;
    await this.#teardownSubscription();
    // Same reason as `deactivate`: a box nothing can commit must not be left
    // holding a spinner that no owner will ever clear.
    this.model.closeEdit();
    this.#setState("disposed");
    this.#unsubscribeModel();
    this.#stateListeners.clear();
    this.#revisionListeners.clear();
    // Every viewer that followed a path in this project is gone with it. A
    // listener left here would be held by a disposed session for the life of
    // the renderer.
    this.#pathListeners.clear();
  }

  /* ----------------------- user intents ----------------------- */

  /** Expand a directory, listing it when it has never been listed or is stale. */
  expand(nodeId: string): void {
    if (!this.model.expand(nodeId)) return;
    if (this.model.isResolved(nodeId) && !this.model.isStale(nodeId)) return;
    this.#requestListing({
      parentId: nodeId,
      mode: "replace",
      limit: EXPLORER_PAGE_SIZE,
      cursor: null,
      reason: "expand",
      // No continuation: one page, then the load-more row.
      targetCount: 0,
    });
  }

  collapse(nodeId: string): void {
    this.model.collapse(nodeId);
  }

  toggle(nodeId: string): void {
    if (this.model.isExpanded(nodeId)) this.collapse(nodeId);
    else this.expand(nodeId);
  }

  /** The load-more row was activated: fetch the next page and APPEND it. */
  loadMore(parentId: string | null): void {
    const cursor = this.model.cursorOf(parentId);
    if (cursor === null) return;
    const current = this.model.loadMoreOf(parentId);
    if (current === null || current.state === "loading") return;
    // Rebuilt rather than spread: a previous attempt's `errorCode` is not a
    // fact about the page now in flight.
    this.model.setLoadMore(parentId, {
      remaining: current.remaining,
      cursor: current.cursor,
      state: "loading",
    });
    this.#requestListing({
      parentId,
      mode: "append",
      limit: EXPLORER_PAGE_SIZE,
      cursor,
      reason: "page",
      targetCount: 0,
    });
  }

  /** A failed directory's notice was activated. */
  retry(parentId: string | null): void {
    this.#requestListing({
      parentId,
      mode: "replace",
      limit: this.#refreshLimitFor(parentId),
      cursor: null,
      reason: "retry",
      targetCount: Math.max(EXPLORER_PAGE_SIZE, this.model.loadedCountOf(parentId)),
    });
  }

  /** The header's Refresh: re-read the whole tree NOW, not in 500 ms. */
  refreshNow(): void {
    this.#refresh.reset();
    this.#notifyResync();
    this.#runFullRefresh();
  }

  /* ----------------------- writes ----------------------- */

  /**
   * Open the name box for a NEW entry under `parentId`.
   *
   * The parent is expanded and LISTED first when it is neither: an edit row
   * inside an unresolved folder would be the only row in it, which reads as
   * "this folder is empty" about a folder nobody has looked in. Awaiting the
   * listing is what makes the box appear beside the names it must not collide
   * with - which is the whole reason VS Code puts it in the tree rather than in
   * a dialog.
   */
  async beginCreate(parentId: string | null, kind: "file" | "directory"): Promise<boolean> {
    if (this.#state === "disposed" || this.#state === "inactive") return false;
    if (parentId !== null) {
      if (!this.model.isExpanded(parentId)) this.expand(parentId);
      if (!this.model.isResolved(parentId)) await this.#queue.whenIdle();
    } else if (!this.model.isResolved(null)) {
      await this.#queue.whenIdle();
    }
    return this.model.openEdit({
      intent: kind === "directory" ? "createFolder" : "createFile",
      parentId,
      targetId: null,
      initialName: "",
    });
  }

  /** Open the name box ON an existing row, seeded with its current name. */
  beginRename(nodeId: string): boolean {
    const node = this.model.nodeOf(nodeId);
    if (node === null) return false;
    return this.model.openEdit({
      intent: "rename",
      parentId: this.model.parentOf(nodeId),
      targetId: nodeId,
      initialName: node.name,
    });
  }

  /** Abandon the open name box. Nothing was written; nothing is undone. */
  cancelEdit(): void {
    this.model.closeEdit();
  }

  /**
   * Live validation for the open name box, as the user types.
   *
   * Returns the sentence to show, or `null`. The SHARED rule decides the
   * characters (`fileNameRefusal`, which main enforces again), and the sibling
   * check is this side's own early message: it reads the rows already listed,
   * so it is exact for a fully loaded directory and can only be too permissive
   * for a paged one - never too strict. Main answers `name_exists` from the
   * disk either way, so a collision this cannot see is still refused.
   */
  validateEditName(name: string): string | null {
    const refusal = fileNameRefusal(name);
    if (refusal !== null) return name === "" ? null : nameRefusalText(refusal);
    const edit = this.model.getEdit();
    if (edit === null) return null;
    const current = edit.targetId === null ? null : this.model.nodeOf(edit.targetId);
    if (current !== null && current.name === name) return null;
    return this.#siblingNamed(edit.parentId, name) ? nameTakenText(name) : null;
  }

  /**
   * COMMIT the open name box: create or rename, then reconcile.
   *
   * The whole state machine for one row lives here, and each transition is a
   * decision rather than a convenience:
   *
   *  - a name the shared rule refuses never reaches main. The box stays open
   *    with the reason on it.
   *  - the box goes `submitting` rather than closing, so the typed name is
   *    still on screen if main refuses and the user has nothing to retype.
   *  - a REFUSAL reopens the box with main's sentence. It is the row's own
   *    state, never a toast: a toast puts the reason somewhere other than the
   *    name that caused it, and disappears before a user reading the tree sees
   *    it.
   *  - a SUCCESS applies main's own `FileNode` - the same shape a listing
   *    produces, from the same `lstat` - so the row that appears now and the row
   *    the watcher's refresh produces in 500 ms are the same row, merged by
   *    node id rather than duplicated.
   *  - the parent is marked for refresh EITHER WAY, because main's order is
   *    main's: a directory that took the row optimistically still needs the
   *    re-list to put it in the right place, and one that refused the insert
   *    (it is paged) needs the re-list to show it at all.
   */
  async commitEdit(name: string): Promise<void> {
    const edit = this.model.getEdit();
    if (edit === null || edit.submitting) return;

    const refusal = fileNameRefusal(name);
    if (refusal !== null) {
      this.model.setEditMessage(nameRefusalText(refusal));
      return;
    }
    // A rename to the name it already has is not a change. Closing is the
    // honest answer: sending it would spend a write and an approval-shaped
    // round trip to do nothing.
    const target = edit.targetId === null ? null : this.model.nodeOf(edit.targetId);
    if (edit.intent === "rename" && target !== null && target.name === name) {
      this.model.closeEdit();
      return;
    }

    const generation = this.#listingGeneration;
    this.model.setEditSubmitting(true);
    if (edit.targetId !== null) this.model.setPending(edit.targetId, "renaming");

    let result: Awaited<ReturnType<typeof createProjectNode>>;
    try {
      result =
        edit.intent === "rename" && edit.targetId !== null
          ? await renameProjectNode({
              projectId: this.projectId,
              nodeId: edit.targetId,
              name,
            })
          : await createProjectNode({
              projectId: this.projectId,
              parentNodeId: edit.parentId,
              name,
              kind: edit.intent === "createFolder" ? "directory" : "file",
            });
    } catch (cause) {
      console.warn(`explorer: ${edit.intent} in project ${this.projectId} rejected`, cause);
      this.#failEdit(edit.targetId, MUTATION_TRANSPORT_FAILED, generation);
      return;
    }

    // THE PUBLICATION FENCE, the same one every listing passes. A session that
    // deactivated, was suspended or was closed while the write was in flight
    // must not reopen a name box over a tree that is gone. The WRITE still
    // happened - main owns that - and the watcher's own event is what shows it
    // when the session comes back.
    if (generation !== this.#listingGeneration) return;

    if (!result.ok) {
      const cancelled = result.error.code === "internal.cancelled";
      this.#failEdit(
        edit.targetId,
        cancelled ? MUTATION_CANCELLED : MUTATION_TRANSPORT_FAILED,
        generation,
      );
      return;
    }
    if (!result.data.ok) {
      this.#failEdit(edit.targetId, mutationErrorText(result.data.code), generation);
      return;
    }

    this.model.closeEdit();
    // THE TAB FOLLOWS THE FILE. Announced from here rather than from
    // `#applyMutatedNode` because this is the only scope that still holds the
    // path the entry had BEFORE the write (`target` was read before the round
    // trip), and announced only now because main has CONFIRMED it: a refused
    // rename renamed nothing. The workspace decides what to do with it - it
    // owns what a tab is - and drops the signal when no tab holds that path.
    // See `workspace/file-rename-signal.ts`.
    if (edit.intent === "rename" && target !== null) {
      publishFileRename(this.projectId, target.path, {
        title: result.data.value.name,
        relativePath: result.data.value.path,
        nodeId: result.data.value.nodeId,
      });
    }
    this.#applyMutatedNode(edit.parentId, edit.targetId, result.data.value);
  }

  /**
   * Delete one node. The CALLER has already confirmed it with the user.
   *
   * This function does not ask: consent is a UI act with a dialog behind it
   * (`ExplorerDeleteDialog`), and a session that could pop its own confirmation
   * would be a second owner of the one decision that must not be automatic.
   * What it owns is the optimistic state and the honest reporting of what came
   * back - including `trash_unavailable`, which means the entry is STILL THERE
   * and the caller may offer permanent removal as a second decision.
   */
  async deleteNode(
    nodeId: string,
    mode: FileDeleteMode,
  ): Promise<
    | { readonly ok: true; readonly value: FileDeleteResult }
    | { readonly ok: false; readonly code: FilesErrorCode | null; readonly message: string }
  > {
    const generation = this.#listingGeneration;
    const parentId = this.model.parentOf(nodeId);
    this.model.setPending(nodeId, "deleting");

    let result: Awaited<ReturnType<typeof deleteProjectNode>>;
    try {
      result = await deleteProjectNode({ projectId: this.projectId, nodeId, mode });
    } catch (cause) {
      console.warn(`explorer: delete in project ${this.projectId} rejected`, cause);
      this.model.setPending(nodeId, null);
      return { ok: false, code: null, message: MUTATION_TRANSPORT_FAILED };
    }

    if (generation !== this.#listingGeneration) {
      // The tree this row belonged to is gone. The DELETE still happened or did
      // not on its own terms; there is no row left to report onto.
      return { ok: false, code: null, message: MUTATION_TRANSPORT_FAILED };
    }
    this.model.setPending(nodeId, null);

    if (!result.ok) {
      const cancelled = result.error.code === "internal.cancelled";
      return {
        ok: false,
        code: null,
        message: cancelled ? MUTATION_CANCELLED : MUTATION_TRANSPORT_FAILED,
      };
    }
    if (!result.data.ok) {
      return {
        ok: false,
        code: result.data.code,
        message: mutationErrorText(result.data.code),
      };
    }

    // The row goes NOW rather than in 500 ms - the same reason the watcher's
    // own `deleted` change removes it immediately - and the parent is refreshed
    // so its counts settle against main's.
    this.model.removeNode(nodeId);
    this.#markRefreshTarget(parentId);
    return { ok: true, value: result.data.value };
  }

  /** Reopen the name box with a refusal on it, and stop showing the row as busy. */
  #failEdit(targetId: string | null, message: string, generation: number): void {
    if (generation !== this.#listingGeneration) return;
    if (targetId !== null) this.model.setPending(targetId, null);
    this.model.setEditSubmitting(false);
    this.model.setEditMessage(message);
  }

  /**
   * Put main's confirmed node into the tree, and schedule the reorder.
   *
   * A RENAME is a remove plus an insert, because the node id is derived from
   * the path and a renamed entry therefore has a NEW token. That is also what
   * the watcher will report (measured on this platform: a rename arrives as
   * `delete <old>` followed by `create <new>`; there is no rename event), so
   * the optimistic path and the authoritative path do the same two things and
   * the second is idempotent.
   */
  #applyMutatedNode(parentId: string | null, targetId: string | null, node: FileNode): void {
    if (targetId !== null) this.model.removeNode(targetId);
    const applied = this.model.applyCreatedNode(parentId, node);
    if (applied) this.setSelectedRowId(node.nodeId);
    // ALWAYS, even when the row was applied: this model never sorts (order is
    // main's), so the row it just appended is in the right folder and the wrong
    // place until the re-list arrives.
    this.#markRefreshTarget(parentId);
  }

  /** Does a listed sibling already carry this name? The optimistic check only. */
  #siblingNamed(parentId: string | null, name: string): boolean {
    for (const child of this.model.childNamesOf(parentId)) {
      if (child === name) return true;
    }
    return false;
  }

  /** The header's Collapse All. Collapsed directories are also forgotten. */
  collapseAll(): void {
    this.model.collapseAll();
    // Every directory is collapsed now, so this snapshot IS "every directory
    // except the root". Forgetting a parent purges its descendants, which makes
    // the later entries no-ops rather than errors.
    for (const nodeId of this.model.collapsedResolvedDirectories()) this.model.forget(nodeId);
  }

  /* ----------------------- activation ----------------------- */

  async #runActivation(generation: number): Promise<void> {
    const watched = await watchProjectFiles({ projectId: this.projectId, nodeId: null });

    if (generation !== this.#generation) {
      // The session was deactivated or disposed while the watch was in flight.
      // The subscription exists and nobody else can name it, so this is the
      // only place that can release it.
      if (watched.ok && watched.data.ok) {
        void unwatchProjectFiles(watched.data.value.subscriptionId);
      }
      return;
    }

    if (!watched.ok) {
      this.#setUnavailable(WATCH_FAILED);
      return;
    }
    if (!watched.data.ok) {
      this.#setUnavailable(listingErrorText(watched.data.code));
      return;
    }

    const subscription: FilesSubscription = watched.data.value;
    this.#subscriptionId = subscription.subscriptionId;
    this.#watcherGeneration = subscription.watcherGeneration;
    this.#lastBatchSeq = null;
    this.#warnings = subscription.warnings;

    // LISTEN BEFORE LISTING. Registering after the first listing would reopen
    // the exact window the watch-first order closed.
    this.#offEvents = onProjectFilesEvent(subscription.subscriptionId, (event) => {
      this.#onEvent(event, generation);
    });
    this.#installFocusBackstop();

    if (!this.#applyWatcherState(subscription.state, subscription.warnings)) return;

    // The root, then every directory the user had open before. Tree order, one
    // request at a time; the queue owns the sequencing.
    //
    // A REACTIVATED root is a REFRESH, not an initial listing. A root that had
    // been paged up to 1200 rows would otherwise come back as one page with a
    // load-more row - the user silently loses what they had open, and only the
    // root, because every other expanded directory goes through
    // `#refreshDirectory` and is paged back correctly. A root that was never
    // listed keeps the one-page initial behaviour.
    const rootResolved = this.model.isResolved(null);
    this.#requestListing({
      parentId: null,
      mode: "replace",
      limit: this.#refreshLimitFor(null),
      cursor: null,
      reason: rootResolved ? "refresh" : "initial",
      targetCount: rootResolved
        ? Math.max(EXPLORER_PAGE_SIZE, this.model.loadedCountOf(null))
        : 0,
    });
    for (const nodeId of this.model.expandedResolvedDirectories()) {
      if (nodeId === null) continue;
      this.#refreshDirectory(nodeId);
    }
  }

  async #teardownSubscription(): Promise<void> {
    this.#refresh.reset();
    this.#queue.clear();
    this.#removeFocusBackstop();

    const off = this.#offEvents;
    this.#offEvents = null;
    if (off !== null) off();

    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = null;
    this.#lastBatchSeq = null;
    if (subscriptionId !== null) await unwatchProjectFiles(subscriptionId);
  }

  /* ----------------------- events ----------------------- */

  #onEvent(event: FilesEvent, generation: number): void {
    if (generation !== this.#generation) return;
    if (event.subscriptionId !== this.#subscriptionId) return;

    // 1. A straggler from a replaced generation describes a tree that no longer
    //    exists. Dropping it here is the last guard against a stale change
    //    repainting a fresh tree.
    if (event.watcherGeneration < this.#watcherGeneration) return;

    // 2. A NEW generation means the watcher restarted or resumed. The explicit
    //    `resync` normally arrives first, but the order across two IPC messages
    //    is not a contract, so adopting it here is what makes either order safe.
    if (event.watcherGeneration > this.#watcherGeneration) {
      this.#watcherGeneration = event.watcherGeneration;
      this.#lastBatchSeq = null;
      // Every subscriber is told it missed events, whatever the tree does next.
      this.#notifyResync();
      // The tree is NOT re-listed on the jump alone. In production a bump never
      // arrives by itself: main's watcher bumps inside `suspend` and inside
      // `resume` and publishes the accompanying status in the same breath
      // (`main/studio/files/watcher.ts`), and that status is what says whether
      // there is a tree to list at all. Arming a blind refresh here would list
      // a root the `suspended` status arriving microseconds later declares
      // gone. A jump into a LIVE session is the restart case and still refreshes
      // immediately; a jump into any other state waits for the status or the
      // `root_resumed` resync to say the tree is back.
      if (this.#state === "live") this.#refresh.scheduleFull();
    }

    if (event.kind === "status") {
      this.#warnings = event.warnings;
      this.#applyWatcherState(event.state, event.warnings);
      return;
    }

    if (event.kind === "resync") {
      if (event.reason === "root_resumed" && this.#state === "suspended") {
        // THE event the suspended state was waiting for: the folder is back and
        // its contents are about to be re-read, so the notice has served out.
        this.model.setNotice(null, null);
        this.#setState("live");
      }
      this.#scheduleFullRefresh();
      return;
    }

    this.#onChanged(event);
  }

  #onChanged(event: Extract<FilesEvent, { kind: "changed" }>): void {
    // Overflow means changes were dropped before this batch, so the tree cannot
    // be brought up to date by applying what DID arrive. Main also sends a
    // `resync overflow` for the same moment; the scheduler coalesces them.
    if (event.overflowed) {
      this.#lastBatchSeq = event.batchSeq;
      this.#scheduleFullRefresh();
      return;
    }

    // A whole-tree subscription's batches are contiguous within a generation, so
    // a gap is a batch this window never received - and its contents are
    // unknowable. Re-list rather than pretend the tree is current.
    const expected = this.#lastBatchSeq === null ? event.batchSeq : this.#lastBatchSeq + 1;
    this.#lastBatchSeq = event.batchSeq;
    if (event.batchSeq !== expected) {
      this.#scheduleFullRefresh();
      return;
    }

    for (const change of event.changes) {
      // The VIEWER hears about every change to a path it follows, whatever the
      // tree does with it. An `added` counts as an update (VS Code reloads on
      // both), and a `deleted` is its own event because the viewer's answer to
      // it is a re-check, not a re-read.
      if (change.kind === "deleted") this.#notifyDeleted(change.path);
      else this.#notifyPath(change.path, "updated");

      if (change.kind === "updated") {
        // The tree shows no size and no mtime, so an update changes nothing it
        // renders. The VIEWER owns file content, and was told above.
        continue;
      }
      const parentPath = parentPathOf(change.path);
      const parentId = this.model.nodeIdOfPath(parentPath);
      if (parentId === undefined) continue;

      if (change.kind === "deleted") {
        // Cheap, exact and immediate: the row goes now rather than in 500 ms.
        const existing = this.model.nodeIdOfPath(change.path);
        if (existing !== undefined && existing !== null) this.model.removeNode(existing);
        this.#markRefreshTarget(parentId);
        continue;
      }

      // ADDED: only when the parent is already resolved. An unresolved parent
      // learns about the new child the moment it is expanded, and refreshing it
      // now would resolve a folder the user never opened.
      // VS Code makes the same call (`explorerService.ts:88-98`).
      if (this.model.isResolved(parentId)) this.#markRefreshTarget(parentId);
    }
    // No explicit arm: marking arms the window, and a batch that marked nothing
    // (every change was an `updated`) has nothing for a window to do.
  }

  /**
   * Apply a watcher state. Returns whether the tree is usable afterwards.
   *
   * The DECISION is `decideWatcherState`'s; this applies it. A record with no
   * `nextState` is the one rule that touches nothing at all.
   */
  #applyWatcherState(
    state: FilesSubscription["state"],
    warnings: readonly FilesWatcherWarning[],
  ): boolean {
    const decision = decideWatcherState(state, warnings, this.#state);
    if (decision.nextState === null) return decision.usable;
    if (decision.clear) {
      // The tree is going away, and every listing about it goes with it: the
      // waiting ones are discarded outright and the one in flight - which the
      // queue cannot recall, because the bridge already owns its promise - is
      // dropped at the publication fence by this bump. Without both, an
      // in-flight root listing would repopulate a suspended tree or overwrite
      // its notice, and a queued one would start after the suspension.
      this.#queue.clear();
      this.#listingGeneration += 1;
      this.model.clear();
    }
    this.model.setNotice(null, decision.rootNotice);
    this.#setState(decision.nextState);
    return decision.usable;
  }

  #setUnavailable(text: string): void {
    this.model.setNotice(null, watchFailureNotice(text));
    this.#setState("unavailable");
  }

  /* ----------------------- refresh scheduling ----------------------- */

  #markRefreshTarget(parentId: string | null): void {
    this.#refresh.markParent(parentId);
  }

  #scheduleFullRefresh(): void {
    this.#refresh.scheduleFull();
    // The tree waits out the 500 ms window; a path subscriber is told NOW.
    // The window exists to stop a burst becoming a burst of listings, and a
    // viewer's answer to a resync is one re-read that its own depth-2 queue
    // already coalesces - so making it wait would only delay the moment the
    // user's open file stops being stale.
    this.#notifyResync();
  }

  /** A window closed. The scheduler decided WHAT; this decides how. */
  #applyRefreshPlan(plan: RefreshPlan): void {
    if (this.#state === "disposed" || this.#state === "inactive") return;
    // THE FIRE-TIME GUARD: only a LIVE session lists on its own.
    //
    // A window armed while the tree was live closes 500 ms later, and every
    // interesting transition happens inside that gap (rule 05): a `suspended`
    // or `closed` status has cleared the tree by then and listing a root that
    // has just vanished is the one request guaranteed to be wrong, while an
    // `unavailable` watcher means nothing more will arrive to justify a
    // scheduled re-read. The user's own Refresh is unaffected - it is an
    // explicit act, and `#runFullRefresh` is reached directly.
    if (this.#state !== "live") return;
    if (plan.full) {
      this.#runFullRefresh();
      return;
    }
    for (const parentId of plan.parents) this.#refreshDirectory(parentId);
  }

  /**
   * Re-list the root and every open directory; forget the closed ones.
   *
   * The ROOT is listed unconditionally, even when it is no longer resolved. A
   * `suspended` watcher CLEARS the tree, so by the time the `root_resumed`
   * resync arrives there is nothing left for a "refresh what is resolved" loop
   * to find - and the folder would come back to an empty panel that never
   * refills.
   */
  #runFullRefresh(): void {
    if (this.#state === "disposed" || this.#state === "inactive") return;
    for (const nodeId of this.model.collapsedResolvedDirectories()) this.model.forget(nodeId);
    this.#requestListing({
      parentId: null,
      mode: "replace",
      limit: this.#refreshLimitFor(null),
      cursor: null,
      reason: "refresh",
      targetCount: Math.max(EXPLORER_PAGE_SIZE, this.model.loadedCountOf(null)),
    });
    for (const parentId of this.model.expandedResolvedDirectories()) {
      if (parentId === null) continue;
      this.#refreshDirectory(parentId);
    }
  }

  #refreshDirectory(parentId: string | null): void {
    if (parentId !== null && !this.model.hasNode(parentId)) return;
    if (parentId !== null && !this.model.isExpanded(parentId)) return;
    if (!this.model.isResolved(parentId)) return;
    const targetCount = Math.max(EXPLORER_PAGE_SIZE, this.model.loadedCountOf(parentId));
    this.#requestListing({
      parentId,
      mode: "replace",
      limit: this.#refreshLimitFor(parentId),
      cursor: null,
      reason: "refresh",
      targetCount,
    });
  }

  /**
   * The page size a refresh re-lists with: what the directory already holds,
   * capped at the wire's maximum. A directory that held more than one page is
   * paged back up to its previous count by the continuation in `#publish`.
   */
  #refreshLimitFor(parentId: string | null): number {
    const loaded = this.model.loadedCountOf(parentId);
    if (loaded === 0) return EXPLORER_PAGE_SIZE;
    return Math.min(Math.max(loaded, 1), FILES_LIST_PAGE_MAX);
  }

  /* ----------------------- the listing queue ----------------------- */

  #requestListing(request: ListRequest): void {
    if (this.#state === "disposed" || this.#state === "inactive") return;
    const accepted = this.#queue.enqueue(request);
    // The loading state is painted only for work that was actually taken, so a
    // coalesced-away request never leaves a spinner nobody owns.
    if (accepted && request.mode === "replace") {
      this.model.setLoadState(request.parentId, "loading");
    }
  }

  /** One listing, start to finish. The queue owns when this runs. */
  async #performListing(request: ListRequest): Promise<void> {
    const generation = this.#listingGeneration;
    this.#inFlightGeneration = generation;
    const result = await listProjectChildren({
      projectId: this.projectId,
      nodeId: request.parentId,
      limit: request.limit,
      cursor: request.cursor,
    });
    this.#publish(request, result, generation);
  }

  /**
   * Publish a listing, or drop it.
   *
   * THE FENCE, and all three parts of it matter: the generation says "this is
   * still the same session", `hasNode` says "the row still exists", and
   * `isExpanded` says "the user still wants to see it". A listing that lost any
   * of the three describes a tree nobody is looking at.
   */
  #publish(
    request: ListRequest,
    result: Result<FilesOutcome<FileListing>>,
    generation: number,
  ): void {
    if (!this.#isPublishable(request, generation)) return;
    const { parentId } = request;

    if (!result.ok) {
      this.#failListing(request, null);
      return;
    }
    if (!result.data.ok) {
      this.#failListing(request, result.data.code);
      return;
    }

    const listing = result.data.value;
    this.model.setChildren(parentId, listing, request.mode);
    if (request.mode === "append") this.model.setLoadState(parentId, "idle");

    // An empty project says so, in a row, so the tree is never a blank panel a
    // user cannot tell from a broken one. Only while `live`: the suspended,
    // unavailable and closed states own the root notice and say something the
    // user needs more.
    if (parentId === null && this.#state === "live") {
      const empty = this.model.loadedCountOf(null) === 0;
      // INFORMATION, not a failure: an empty folder is a fact about the disk,
      // and a warning mark on it would claim something is wrong.
      this.model.setNotice(
        null,
        empty ? { text: EMPTY_PROJECT, action: null, tone: "info" } : null,
      );
    }

    // A directory that held more than one page is paged back up to its previous
    // count, so a refresh never silently shrinks what the user had open.
    //
    // ONLY a refresh or a retry. A FIRST listing stops at one page and shows
    // the load-more row: continuing there would page a 50k-entry folder into
    // the renderer the moment the user opened it, which is the exact thing
    // `hasMore` plus `nextCursor` exist to prevent.
    const loaded = this.model.loadedCountOf(parentId);
    const cursor = this.model.cursorOf(parentId);
    if (
      (request.reason === "refresh" || request.reason === "retry") &&
      cursor !== null &&
      loaded < request.targetCount
    ) {
      this.#queue.enqueue({
        parentId,
        mode: "append",
        limit: Math.min(Math.max(request.targetCount - loaded, 1), FILES_LIST_PAGE_MAX),
        cursor,
        reason: request.reason,
        targetCount: request.targetCount,
      });
    }
  }

  /**
   * THE FENCE, and all three parts of it matter: the LISTING generation says
   * "the tree this describes is still the tree on screen", `hasNode` says "the
   * row still exists", and `isExpanded` says "the user still wants to see it".
   * Shared by the success and the rejection paths, because a rejection that
   * arrives after deactivate is exactly as stale as a listing that does.
   *
   * The listing generation subsumes the session generation - it is bumped
   * wherever that one is - so it is the only counter read here, and it also
   * catches the suspend and close transitions the session generation does not
   * move for.
   */
  #isPublishable(request: ListRequest, generation: number): boolean {
    if (generation !== this.#listingGeneration) return false;
    if (this.#state === "disposed" || this.#state === "inactive") return false;
    const { parentId } = request;
    if (parentId !== null && !this.model.hasNode(parentId)) return false;
    if (parentId !== null && !this.model.isExpanded(parentId)) return false;
    return true;
  }

  /**
   * The listing REJECTED rather than answering.
   *
   * The bridge can produce this where a `Result.error` was expected, and a
   * swallowed rejection leaves the directory in `loading` with a spinner that
   * nothing will ever clear. It is a transport failure by every property that
   * matters, so it takes that path - behind the same fence.
   */
  #failRejectedListing(request: ListRequest, generation: number): void {
    if (!this.#isPublishable(request, generation)) return;
    this.#failListing(request, null);
  }

  /**
   * A listing did not produce children. Every reason gets its own row state:
   * collapsing them would leave the user with one sentence for six situations
   * whose remedies differ.
   *
   * WHICH row says WHAT is `decideListingFailure`'s; this owns the effects.
   */
  #failListing(request: ListRequest, code: FilesErrorCode | null): void {
    const { parentId } = request;
    const decision = decideListingFailure(request, code);

    if (decision.kind === "loadMoreError") {
      const current = this.model.loadMoreOf(parentId);
      if (current !== null) {
        this.model.setLoadMore(parentId, {
          remaining: current.remaining,
          cursor: current.cursor,
          state: "error",
          ...(decision.errorCode === null ? {} : { errorCode: decision.errorCode }),
        });
      }
      this.model.setLoadState(parentId, decision.loadState);
      return;
    }

    if (decision.kind === "transport") {
      this.model.setLoadState(parentId, decision.loadState);
      this.model.setNotice(parentId, decision.notice);
      return;
    }

    if (decision.kind === "projectClosed") {
      this.model.clear();
      this.model.setNotice(null, decision.rootNotice);
      this.#setState("closed");
      return;
    }

    if (decision.kind === "staleRow") {
      this.model.setLoadState(parentId, decision.loadState);
      if (decision.rootNotice !== null) {
        this.model.setNotice(null, decision.rootNotice);
        return;
      }
      // Asking this directory again would ask the same dead question, so the
      // PARENT is what needs re-reading.
      if (parentId !== null) this.#markRefreshTarget(this.model.parentOf(parentId));
      return;
    }

    this.model.setLoadState(parentId, decision.loadState, decision.errorCode);
    this.model.setNotice(parentId, decision.notice);
  }

  /* ----------------------- the focus backstop ----------------------- */

  /**
   * Refresh when the window regains focus.
   *
   * VS Code added this "to compensate for missing file events"
   * (`explorerService.ts:136-140`, issue #126817): every OS watcher drops
   * events under load, and the moment a user looks back at the window is the
   * moment a stale tree is most visible.
   */
  #installFocusBackstop(): void {
    if (this.#onWindowFocus !== null) return;
    if (typeof window === "undefined") return;
    const handler = (): void => {
      const now = Date.now();
      if (now - this.#lastFocusRefreshAt < EXPLORER_FOCUS_REFRESH_THROTTLE_MS) return;
      this.#lastFocusRefreshAt = now;
      this.#scheduleFullRefresh();
    };
    this.#onWindowFocus = handler;
    window.addEventListener("focus", handler);
  }

  #removeFocusBackstop(): void {
    const handler = this.#onWindowFocus;
    this.#onWindowFocus = null;
    if (handler === null || typeof window === "undefined") return;
    window.removeEventListener("focus", handler);
  }

  /* ----------------------- plumbing ----------------------- */

  #setState(state: ExplorerSessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emitState();
  }

  #emitState(): void {
    this.#bumpRevision();
    for (const listener of this.#stateListeners) listener();
  }

  #reportDuplicate(nodeId: string): void {
    // One line, once, with no path in it: the id is enough to find the mint
    // that produced it, and the tree keeps working without the duplicate row.
    if (this.#reportedDuplicates.has(nodeId)) return;
    this.#reportedDuplicates.add(nodeId);
    console.warn(
      `explorer: project ${this.projectId} listed node ${nodeId} under two parents`,
    );
  }

}

/**
 * The parent of a project-relative path.
 *
 * The only path arithmetic in this feature, and it is the whole of it: paths on
 * this surface are POSIX and project-relative, the root is the empty string,
 * and a change carries the path of the thing that changed. Anything more would
 * be the renderer reasoning about a filesystem it deliberately cannot name.
 */
export function parentPathOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
