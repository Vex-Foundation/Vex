/**
 * THE FILES DOMAIN: who may read what, which projects are watched, and when
 * every one of those stops.
 *
 * `watcher.ts` owns the operating system. `listing.ts` and `read.ts` own one
 * syscall each. THIS owns the policy: authority, leases, refcounts, fan-out and
 * the four ways a watcher ends.
 *
 * ## Authority is re-established on every call
 *
 * A node token proves a NAME was issued by this process (see `node-id.ts`). It
 * proves nothing about whether the project still exists, so every operation
 * here starts by resolving the project's directory through `getProject`, which
 * serves ACTIVE projects only. A tombstoned project therefore resolves to
 * nothing and every read of it is refused with `project_closed` - without this
 * module needing to know what a tombstone is, which is the same posture
 * `terminal-domain.ts` takes for a terminal's cwd.
 *
 * The directory is REALPATHED on every call as well, not cached from the
 * subscription: between two reads a project folder can be replaced by a symlink
 * to somewhere else, and a containment check against a remembered path would
 * compare against a place that is no longer there.
 *
 * ## One native watcher, many subscriptions
 *
 * A project's watcher is refcounted by its subscriptions. The first
 * subscription starts it and takes the lifecycle gate's `watcher` lease; the
 * last one to leave stops it and releases the lease. Opening a file starts NO
 * second watch - a per-file subscription is a FILTER over the project's
 * existing stream - because a recursive OS watch is a system-limited resource
 * and a user with eight files open should not be holding nine of them.
 *
 * ## The four ends of a watcher, and their ordering
 *
 * SELECTION CHANGE. The new project's watcher goes live BEFORE the old one is
 * torn down, and this is a deliberate choice with a named cost. The renderer
 * subscribes to the new project and only then releases the old subscription;
 * because watchers are refcounted per project, the old native watch survives
 * until that release. The reason is the list-then-watch gap: a tree that
 * listed a directory before its watcher was live can miss a change that lands
 * between the two and show a stale row indefinitely, with nothing to correct
 * it. Starting first closes that window. The cost is a bounded interval in
 * which two projects are watched at once, which `FILES_WATCHERS_MAX` bounds
 * and which is cheap next to a tree that is silently wrong.
 *
 * PROJECT DELETION. The lifecycle gate's close hook runs AFTER the tombstone
 * commits. It tears the watcher down, tells every subscriber the project is
 * `closed`, releases the lease, and BUMPS THE PROJECT'S NODE EPOCH - which
 * spends every token that project ever issued, so a renderer still showing the
 * old tree cannot read a byte out of it even before it learns the project is
 * gone.
 *
 * WINDOW RELEASE. Every subscription a window owned is dropped when that window
 * closes or its renderer crashes, exactly as `terminal-domain.ts` releases that
 * window's terminals. Refcounts fall, and a project nobody is looking at stops
 * being watched.
 *
 * APP SHUTDOWN. `dispose` closes admission first, then unregisters the close
 * hook, then disposes every watcher and releases every lease, in that order:
 * a hook that fired mid-dispose would ask a disposed domain to close a project.
 *
 * ## Fan-out
 *
 * The watcher emits once; this module maps that one emission onto each
 * subscription, minting node tokens under the CURRENT epoch and filtering
 * changes to the subscription's scope. `resync` and `status` are never
 * filtered: a subscriber watching one file still needs to know the watcher
 * restarted, because its file may have changed while nothing was looking.
 */

import { randomUUID } from "node:crypto";

import {
  FILES_SUBSCRIPTIONS_PER_WINDOW_MAX,
  FILES_WATCHERS_MAX,
  type FileListing,
  type FileContent,
  type FilesEvent,
  type FilesErrorCode,
  type FilesOutcome,
  type FilesSubscription,
} from "@shared/schemas/files.js";

import { log } from "../../logger/index.js";
import {
  acquireProjectLease,
  registerProjectCloseHook,
  type ProjectLease,
} from "../project-lifecycle-gate.js";
import { nativeWatcherIgnores } from "./excludes.js";
import { listDirectoryPage } from "./listing.js";
import {
  invalidateProjectNodes,
  mintFileNodeId,
  projectNodeEpoch,
  resolveFileNodeId,
} from "./node-id.js";
import { PROJECT_ROOT_RELATIVE, realProjectDirectory, resolveNodePath } from "./node-path.js";
import { readFileForViewer } from "./read.js";
import {
  ProjectFileWatcher,
  type NativeSubscribe,
  type RootPoller,
  type WatcherEmission,
} from "./watcher.js";

/**
 * Where a project's files live, and the root that makes that answer meaningful.
 *
 * The DIRECTORY alone is not enough. Every containment check downstream is made
 * against it, so a directory that is a symbolic link would nominate its target
 * as the confinement root; `realProjectDirectory` refuses that, and it can only
 * refuse it against an ANCHOR. The anchor is the projects root as
 * `resolveProjectsRoot` resolved it - a realpath - and the directory is the
 * lexical `<root>/<slug>` beneath it, unproven until this module proves it.
 */
export interface ProjectFilesLocation {
  /** The projects root, ALREADY a realpath. The anchor for every check below. */
  readonly anchoredRoot: string;
  /** `<anchoredRoot>/<slug>`, lexically joined and not yet resolved. */
  readonly projectDirectory: string;
}

export interface FilesDomainDependencies {
  /**
   * Where the project's files are as the DATABASE says, or `null` when the
   * project has no active row. This is the authority; nothing else here is.
   */
  readonly resolveProjectDirectory: (
    projectId: string,
  ) => Promise<ProjectFilesLocation | null>;
  readonly subscribeNative: NativeSubscribe;
  readonly pollForRoot: RootPoller;
  readonly rootExists: (directory: string) => Promise<boolean>;
  /** Deliver one event to one window. A destroyed window is the caller's problem. */
  readonly publish: (windowId: string, event: FilesEvent) => void;
}

interface Subscription {
  readonly subscriptionId: string;
  readonly windowId: string;
  readonly projectId: string;
  /** `null` watches the whole tree; a path watches exactly that one file. */
  readonly relativePath: string | null;
}

interface ProjectEntry {
  readonly projectId: string;
  readonly lease: ProjectLease;
  readonly watcher: ProjectFileWatcher;
  readonly subscriptions: Map<string, Subscription>;
  /**
   * How many `watchFile` calls are between "this entry is mine" and "my
   * subscription is on it". DELIBERATELY the one mutable field on this entry.
   *
   * A native subscribe takes milliseconds, and for the whole of that window the
   * entry carries ZERO subscriptions - so `collect`, which reaps anything with
   * no subscribers, would otherwise reap an entry another window is still
   * joining and leave that window holding a subscription id nothing will ever
   * find or feed. The count is a reservation: it is taken BEFORE the await in
   * `entryFor` and released by `watchFile` only AFTER the subscription is
   * published, never in between (rule 05: the owner does not release an
   * exclusive reservation until the work it protects has committed).
   */
  joining: number;
}

export class FilesDomain {
  private readonly deps: FilesDomainDependencies;
  private readonly projects = new Map<string, ProjectEntry>();
  /**
   * The watches a window has ASKED FOR and not yet been given, by window id.
   *
   * A `watchFile` spends milliseconds inside a native subscribe, and for the
   * whole of that window the window that asked owns nothing this domain can
   * find: `releaseWindow` walks settled subscriptions and there is not one yet,
   * so a window that closes mid-acquisition is released and the acquisition
   * then publishes a subscription for it anyway - an orphan holding a native OS
   * watch that no `unwatchFile` will ever arrive for.
   *
   * So the intent is tracked from BEFORE the first await, and `releaseWindow`
   * drops the whole set. A publication whose own id is no longer in the set
   * knows its window left while it was working. Entries exist only while a
   * watch is in flight, so the map is bounded by concurrent requests, not by
   * the number of windows the process has ever seen.
   */
  private readonly inFlightWatches = new Map<string, Set<string>>();
  private readonly unregisterCloseHook: () => void;
  private admitting = true;

  constructor(deps: FilesDomainDependencies) {
    this.deps = deps;
    // Step 6 of a project delete closes this project's watcher, AFTER the
    // tombstone has committed.
    this.unregisterCloseHook = registerProjectCloseHook((projectId) =>
      this.closeProject(projectId),
    );
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  /**
   * Resolve a request's project directory and node, or say why it cannot be.
   *
   * The whole authority chain in one place, so no handler can skip a link of
   * it: active row -> realpath -> token verification -> symlink-free walk ->
   * containment.
   */
  private async locate(
    projectId: string,
    nodeId: string | null,
  ): Promise<
    | {
      readonly ok: true;
      readonly projectDirectory: string;
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly kind: "file" | "directory" | "symlink" | "other";
      /** The node epoch this request resolved under. See `stillAuthorised`. */
      readonly epoch: number;
    }
    | { readonly ok: false; readonly code: FilesErrorCode }
  > {
    // THE REQUEST'S EPOCH, taken synchronously before the first await, so every
    // later check compares against the identity this request actually resolved
    // under rather than against whatever the world looks like when it finishes.
    const epoch = projectNodeEpoch(projectId);

    const declared = await this.deps.resolveProjectDirectory(projectId);
    if (declared === null) return { ok: false, code: "project_closed" };
    // The authority was read across an await. A delete that committed while it
    // was in flight has already bumped the epoch, and the answer that came back
    // describes a project this process no longer serves.
    if (!this.stillAuthorised(projectId, epoch)) {
      return { ok: false, code: "project_closed" };
    }
    const real = await realProjectDirectory(
      declared.anchoredRoot,
      declared.projectDirectory,
    );
    if (!real.ok) {
      // A directory that is not a real directory directly under the anchored
      // root is not a project this process serves. `project_closed` is the
      // honest code: the surface has no project here, and naming the symlink
      // would tell a renderer something about main's filesystem that it has no
      // way to act on.
      return {
        ok: false,
        code: real.reason === "io_error" ? "io_error" : "project_closed",
      };
    }

    let relativePath = PROJECT_ROOT_RELATIVE;
    if (nodeId !== null) {
      const token = resolveFileNodeId(projectId, nodeId);
      if (!token.ok) return { ok: false, code: "invalid_node" };
      relativePath = token.relativePath;
    }

    const resolved = await resolveNodePath(real.directory, relativePath);
    if (!resolved.ok) return { ok: false, code: resolved.reason };
    return {
      ok: true,
      projectDirectory: real.directory,
      relativePath,
      absolutePath: resolved.absolutePath,
      kind: resolved.kind,
      epoch,
    };
  }

  /**
   * IS THE PROJECT THIS REQUEST RESOLVED UNDER STILL THE LIVE ONE?
   *
   * `locate` establishes authority through `getProject`, which serves ACTIVE
   * projects only - and then the request does filesystem work across several
   * awaits. A request parked in that work while a delete commits would finish
   * against a project whose tombstone is already durable, and would PUBLISH
   * bytes out of it, because the check it passed is minutes of scheduler time
   * behind the answer it is about to return.
   *
   * The node epoch is the fence. `closeProject` bumps it after the tombstone
   * commits, so an epoch that moved since `locate` took its snapshot is a
   * conclusive statement that this project was closed underneath this request.
   * It needs no lease and no lock: it is the same generation discipline the
   * watcher uses on its own native callbacks, applied at PUBLICATION rather
   * than only at the start.
   */
  private stillAuthorised(projectId: string, epoch: number): boolean {
    return projectNodeEpoch(projectId) === epoch;
  }

  async listChildren(input: {
    readonly projectId: string;
    readonly nodeId: string | null;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<FilesOutcome<FileListing>> {
    const located = await this.locate(input.projectId, input.nodeId);
    if (!located.ok) return { ok: false, code: located.code };
    if (located.kind === "symlink") return { ok: false, code: "symlinked_path" };
    if (located.kind !== "directory") return { ok: false, code: "not_a_directory" };

    const listing = await listDirectoryPage({
      projectId: input.projectId,
      projectDirectory: located.projectDirectory,
      absoluteDirectory: located.absolutePath,
      relativeDirectory: located.relativePath,
      // The cursor is bound to the DIRECTORY, and its relative path names that
      // directory uniquely without depending on a token that the epoch could
      // have spent between two pages.
      nodeKey: located.relativePath,
      limit: input.limit,
      cursor: input.cursor,
    });
    // THE PUBLICATION FENCE. Nothing above this line has left the process.
    if (!this.stillAuthorised(input.projectId, located.epoch)) {
      return { ok: false, code: "project_closed" };
    }
    return listing;
  }

  async readFile(input: {
    readonly projectId: string;
    readonly nodeId: string;
  }): Promise<FilesOutcome<FileContent>> {
    const located = await this.locate(input.projectId, input.nodeId);
    if (!located.ok) return { ok: false, code: located.code };
    if (located.kind === "symlink") return { ok: false, code: "symlinked_path" };
    if (located.kind === "directory") return { ok: false, code: "not_a_file" };

    const content = await readFileForViewer({
      nodeId: input.nodeId,
      relativePath: located.relativePath,
      absolutePath: located.absolutePath,
    });
    // THE PUBLICATION FENCE. The bytes are in this process and have gone
    // nowhere; a project closed while they were being read does not get to
    // publish them.
    if (!this.stillAuthorised(input.projectId, located.epoch)) {
      return { ok: false, code: "project_closed" };
    }
    return content;
  }

  /* ---------------------------------------------------------------- *
   * Subscriptions
   * ---------------------------------------------------------------- */

  async watchFile(
    windowId: string,
    input: { readonly projectId: string; readonly nodeId: string | null },
  ): Promise<FilesOutcome<FilesSubscription>> {
    if (!this.admitting) return { ok: false, code: "watcher_unavailable" };
    // The cap counts what this window HOLDS plus what it has in flight, because
    // a burst of concurrent requests would otherwise all pass a check made only
    // against settled subscriptions and land together above the bound.
    if (this.windowSubscriptionLoad(windowId) >= FILES_SUBSCRIPTIONS_PER_WINDOW_MAX) {
      log.warn(
        `[studio:files] refusing a subscription: window ${windowId} already holds `
          + `${String(FILES_SUBSCRIPTIONS_PER_WINDOW_MAX)}`,
      );
      return { ok: false, code: "watcher_limit" };
    }

    // THE INTENT IS RECORDED BEFORE THE FIRST AWAIT, so a `releaseWindow` that
    // lands during the acquisition has something to invalidate.
    const watchId = randomUUID();
    const inFlight = this.inFlightWatches.get(windowId) ?? new Set<string>();
    inFlight.add(watchId);
    this.inFlightWatches.set(windowId, inFlight);

    try {
      return await this.acquireSubscription(windowId, watchId, input);
    } finally {
      const remaining = this.inFlightWatches.get(windowId);
      if (remaining !== undefined) {
        remaining.delete(watchId);
        if (remaining.size === 0) this.inFlightWatches.delete(windowId);
      }
    }
  }

  /** Everything a window holds or is waiting on, across every project. */
  private windowSubscriptionLoad(windowId: string): number {
    let held = this.inFlightWatches.get(windowId)?.size ?? 0;
    for (const entry of this.projects.values()) {
      for (const subscription of entry.subscriptions.values()) {
        if (subscription.windowId === windowId) held += 1;
      }
    }
    return held;
  }

  /** True while `watchId` is still a watch this window is waiting for. */
  private isWatchStillWanted(windowId: string, watchId: string): boolean {
    return this.inFlightWatches.get(windowId)?.has(watchId) === true;
  }

  private async acquireSubscription(
    windowId: string,
    watchId: string,
    input: { readonly projectId: string; readonly nodeId: string | null },
  ): Promise<FilesOutcome<FilesSubscription>> {
    const located = await this.locate(input.projectId, input.nodeId);
    if (!located.ok) return { ok: false, code: located.code };

    const acquired = await this.entryFor(input.projectId, located.projectDirectory);
    if (!acquired.ok) return { ok: false, code: acquired.code };

    // `entryFor` hands the entry back with a JOIN RESERVATION still held. It is
    // released here, after publication, and never earlier.
    const entry = acquired.entry;
    let windowGone = false;
    try {
      // THE PUBLICATION FENCE. `entryFor` awaited a native subscribe, and a
      // project delete or an app shutdown during that await removes and
      // disposes the entry. Publishing onto it now would hand this window a
      // subscription id no `unwatchFile` can find and no event will reach, so
      // identity is re-checked HERE, at publication, and not only at start.
      if (this.projects.get(input.projectId) !== entry) {
        // Which of the two removed it is what the caller needs to hear: a
        // deleted project is a statement about the project, a disposing domain
        // is a statement about the watcher. `admitting` is the domain's own
        // synchronous record of the difference - the watcher's state is set
        // across awaits inside its `dispose`, so it is not yet settled here.
        return { ok: false, code: this.admitting ? "project_closed" : "watcher_unavailable" };
      }
      // THE SECOND HALF OF THE SAME FENCE, on the other party. The entry can be
      // perfectly alive while the WINDOW that asked for this watch has gone;
      // publishing then leaves a native watch held for a dead renderer, and the
      // release that would have collected it has already run.
      if (!this.isWatchStillWanted(windowId, watchId)) {
        windowGone = true;
        return { ok: false, code: "watcher_unavailable" };
      }

      const subscription: Subscription = {
        subscriptionId: randomUUID(),
        windowId,
        projectId: input.projectId,
        relativePath: input.nodeId === null ? null : located.relativePath,
      };
      entry.subscriptions.set(subscription.subscriptionId, subscription);

      return {
        ok: true,
        value: {
          subscriptionId: subscription.subscriptionId,
          watcherGeneration: entry.watcher.currentGeneration,
          state: entry.watcher.currentState,
          warnings: [...entry.watcher.currentWarnings],
        },
      };
    } finally {
      entry.joining -= 1;
      // THE ENTRY IS THIS PATH'S TO CLEAN UP. The two refusals above it were
      // raised by a delete or a dispose, and both removed and disposed the
      // entry themselves; this one is the only refusal that leaves a live
      // entry standing with nothing holding it - a native watch and a lease
      // taken for a window that has gone. `collect` is the owner of that.
      if (windowGone) await this.collect(entry);
    }
  }

  /**
   * Release a subscription. Idempotent, and ONLY for the window that owns it.
   *
   * The ownership check is what makes the subscription id safe to hold in a
   * renderer: a compromised window that guessed another window's id cannot
   * silently blind it.
   */
  async unwatchFile(
    windowId: string,
    subscriptionId: string,
  ): Promise<FilesOutcome<null>> {
    for (const entry of this.projects.values()) {
      const subscription = entry.subscriptions.get(subscriptionId);
      if (subscription === undefined) continue;
      if (subscription.windowId !== windowId) {
        return { ok: false, code: "unknown_subscription" };
      }
      entry.subscriptions.delete(subscriptionId);
      await this.collect(entry);
      return { ok: true, value: null };
    }
    return { ok: false, code: "unknown_subscription" };
  }

  /**
   * Take (or join) this project's watcher.
   *
   * The lease is acquired SYNCHRONOUSLY relative to the entry's creation - no
   * await between the acquisition and the `set` - so a delete that closes
   * admission cannot slip between the two and leave a watcher running with no
   * lease behind it.
   *
   * ON SUCCESS THIS RETURNS WITH `entry.joining` INCREMENTED, and the caller
   * owns that reservation until its subscription is published. See the field's
   * own note: without it, the zero-subscription window around the native
   * subscribe is reapable by any concurrent `collect`.
   */
  private async entryFor(
    projectId: string,
    projectDirectory: string,
  ): Promise<
    | { readonly ok: true; readonly entry: ProjectEntry }
    | { readonly ok: false; readonly code: "project_closed" | "watcher_limit" }
  > {
    const existing = this.projects.get(projectId);
    if (existing !== undefined) {
      existing.joining += 1;
      // The reservation outlives this function ONLY on the success path; a
      // rejected start must not strand a count that would make the entry
      // permanently uncollectable.
      try {
        await existing.watcher.start();
      } catch (cause) {
        existing.joining -= 1;
        throw cause;
      }
      return { ok: true, entry: existing };
    }

    if (this.projects.size >= FILES_WATCHERS_MAX) {
      log.warn(
        `[studio:files] refusing a watcher: ${String(FILES_WATCHERS_MAX)} already `
          + `running projectId=${projectId}`,
      );
      return { ok: false, code: "watcher_limit" };
    }

    const leased = acquireProjectLease(projectId, "watcher");
    if (!leased.ok) return { ok: false, code: "project_closed" };

    const watcher = new ProjectFileWatcher({
      projectId,
      realRoot: projectDirectory,
      ignore: nativeWatcherIgnores(),
      subscribeNative: this.deps.subscribeNative,
      pollForRoot: this.deps.pollForRoot,
      rootExists: this.deps.rootExists,
      emit: (emission) => {
        this.fanOut(projectId, emission);
      },
    });
    const entry: ProjectEntry = {
      projectId,
      lease: leased.lease,
      watcher,
      subscriptions: new Map(),
      joining: 1,
    };
    this.projects.set(projectId, entry);

    try {
      await watcher.start();
    } catch (cause) {
      entry.joining -= 1;
      throw cause;
    }
    return { ok: true, entry };
  }

  /** Stop a watcher nobody is subscribed to any more. */
  private async collect(entry: ProjectEntry): Promise<void> {
    if (entry.subscriptions.size > 0) return;
    // An entry somebody is still joining is not garbage. Its subscription count
    // is zero only because the native subscribe it is waiting on has not
    // returned yet.
    if (entry.joining > 0) return;
    this.projects.delete(entry.projectId);
    await entry.watcher.dispose("released");
    entry.lease.release();
  }

  /* ---------------------------------------------------------------- *
   * Fan-out
   * ---------------------------------------------------------------- */

  private fanOut(projectId: string, emission: WatcherEmission): void {
    const entry = this.projects.get(projectId);
    if (entry === undefined) return;
    for (const subscription of entry.subscriptions.values()) {
      const event = this.toEvent(subscription, emission);
      if (event === null) continue;
      this.deps.publish(subscription.windowId, event);
    }
  }

  private toEvent(
    subscription: Subscription,
    emission: WatcherEmission,
  ): FilesEvent | null {
    const base = {
      subscriptionId: subscription.subscriptionId,
      projectId: subscription.projectId,
      watcherGeneration: emission.generation,
    } as const;

    if (emission.payload.kind === "status") {
      return {
        kind: "status",
        ...base,
        state: emission.payload.state,
        reason: emission.payload.reason,
        warnings: [...emission.payload.warnings],
      };
    }
    if (emission.payload.kind === "resync") {
      return {
        kind: "resync",
        ...base,
        reason: emission.payload.reason,
        droppedCount: emission.payload.droppedCount,
      };
    }

    const scope = subscription.relativePath;
    const changes = emission.payload.changes
      .filter((change) => scope === null || change.path === scope)
      .map((change) => ({
        path: change.path,
        kind: change.kind,
        nodeId: mintFileNodeId(subscription.projectId, change.path),
      }));
    // An empty batch is not sent. `batchSeq` is the WATCHER's sequence, so a
    // filtered subscriber sees it advance by more than one; it is monotonic,
    // which is what a consumer needs to drop a straggler, and it is
    // deliberately not contiguous.
    if (changes.length === 0 && !emission.payload.overflowed) return null;
    return {
      kind: "changed",
      ...base,
      batchSeq: emission.payload.batchSeq,
      changes,
      overflowed: emission.payload.overflowed,
      droppedCount: emission.payload.droppedCount,
    };
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  /** A window went away. Every subscription it owned goes with it. */
  async releaseWindow(windowId: string): Promise<void> {
    // The in-flight intents go FIRST and unconditionally: a watch still inside
    // its native subscribe has no subscription to delete, and this is the only
    // record of it. Dropping it is what makes the publication fence refuse.
    this.inFlightWatches.delete(windowId);
    for (const entry of [...this.projects.values()]) {
      for (const [id, subscription] of [...entry.subscriptions]) {
        if (subscription.windowId === windowId) entry.subscriptions.delete(id);
      }
      await this.collect(entry);
    }
  }

  /**
   * The lifecycle gate's close hook. Runs only AFTER the tombstone committed.
   *
   * The node epoch is bumped LAST, after subscribers have been told, so the
   * `closed` status they receive is minted under an identity they can still
   * correlate with the tokens they hold.
   */
  async closeProject(projectId: string): Promise<void> {
    const entry = this.projects.get(projectId);
    if (entry !== undefined) {
      this.projects.delete(projectId);
      await entry.watcher.dispose("project_deleted");
      for (const subscription of entry.subscriptions.values()) {
        this.deps.publish(subscription.windowId, {
          kind: "status",
          subscriptionId: subscription.subscriptionId,
          projectId,
          watcherGeneration: entry.watcher.currentGeneration,
          state: "closed",
          reason: "project_deleted",
          warnings: [...entry.watcher.currentWarnings],
        });
      }
      entry.subscriptions.clear();
      entry.lease.release();
    }
    const epoch = invalidateProjectNodes(projectId);
    log.info(
      `[studio:files] every file token for projectId=${projectId} is spent `
        + `(epoch=${String(epoch)})`,
    );
  }

  /** Watchers this domain believes are running. Exposed for its own tests. */
  get watchedProjectCount(): number {
    return this.projects.size;
  }

  /** Tear the domain down at app quit. Idempotent. */
  async dispose(): Promise<void> {
    this.admitting = false;
    this.unregisterCloseHook();
    for (const entry of [...this.projects.values()]) {
      this.projects.delete(entry.projectId);
      entry.subscriptions.clear();
      await entry.watcher.dispose("released");
      entry.lease.release();
    }
  }
}
