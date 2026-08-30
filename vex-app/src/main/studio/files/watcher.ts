/**
 * ONE PROJECT'S FILESYSTEM WATCHER: its lifecycle, its failures, and its
 * refusal to lie about either.
 *
 * There is exactly ONE native watch per project no matter how many
 * subscriptions ride it, because a recursive OS watch is an expensive,
 * system-limited resource: on Linux it costs one inotify watch per directory
 * out of `fs.inotify.max_user_watches`, and a second watch of the same tree
 * doubles that for no information. Fan-out to subscribers belongs to the
 * domain; this class owns the OS.
 *
 * ## The pipeline, and why it has three stages
 *
 *     native callback -> raw[]  --75 ms-->  coalesce -> pending
 *     pending  --throttled, <=500 per batch-->  emit
 *
 *  - The 75 ms AGGREGATION window exists so the coalescer has both halves of a
 *    pair to work with. An editor's atomic save writes a temp file and renames
 *    it over the target within a few milliseconds; coalescing each callback in
 *    isolation would emit the delete and the create separately and the pair
 *    would never meet.
 *  - The THROTTLE exists so a burst does not become a message storm. A `git
 *    checkout` of a large branch produces tens of thousands of events; the
 *    consumer needs to know its tree changed, not to receive 30k IPC messages.
 *  - The PENDING BOUND exists because a burst can outrun any consumer, and an
 *    unbounded map is how a watcher becomes a memory leak. At the bound,
 *    further distinct paths are DROPPED AND COUNTED, and the count rides the
 *    next batch - `overflowed: true, droppedCount: n` - so the consumer knows
 *    precisely what it did not get and that its remedy is to re-list. VS Code
 *    drops overflow silently here; this is the one place this implementation
 *    deliberately departs from its reference, because a tree that quietly stops
 *    matching the disk is worse than a tree that says so.
 *
 * ## Generations
 *
 * Every batch carries a GENERATION and a `batchSeq` that is monotonic within
 * it. The generation bumps whenever the watcher stopped seeing changes for a
 * while - a restart, a suspend and resume - because that is exactly the moment
 * a consumer's picture can be wrong in ways no change event will ever correct.
 * A consumer that has been told generation 4 began must drop a straggling batch
 * from generation 3: it describes a tree that no longer exists.
 *
 * ## Restart policy
 *
 * Adopted from VS Code's parcel watcher, including the parts that are refusals:
 *
 *  - at most `FILES_WATCHER_MAX_RESTARTS`, then `unavailable` FOR THE LIFE OF
 *    THIS WATCHER INSTANCE, with a sticky warning, because a watcher that
 *    restarts forever burns a core and never recovers. Terminal means terminal:
 *    a later `start()` on this instance - and every file a user opens is
 *    another subscription joining the same instance - returns immediately
 *    without touching the OS again, because re-subscribing recursively over a
 *    whole tree per file open is unbounded work asking for the resource that
 *    was just refused. THE RECOVERY PATH, and the only one, is a NEW instance:
 *    the domain disposes a project's watcher when its last subscriber leaves,
 *    and the next first subscription builds a fresh watcher with a fresh
 *    restart budget;
 *  - NEVER for ENOSPC or EMFILE. Those are exhausted system resources, and
 *    restarting immediately asks for the resource that was just refused. The
 *    remedy is the user raising a limit, so the fact is reported to them -
 *    logged ONCE per process (a retrying watcher logs it thousands of times
 *    otherwise) and carried as a DURABLE sticky warning on every status event,
 *    because a fact that lives only in a log the user will never open is a fact
 *    the product does not have;
 *  - never for a vanished root, which is not a failure at all: it is a folder
 *    the user moved or a branch that has not been checked out yet, and the
 *    answer is to SUSPEND and poll for its return;
 *  - stop before restart. The old subscription is unsubscribed and awaited
 *    before the new one is created, so the process never holds two recursive
 *    watches of the same tree.
 *
 * ## Suspend and resume
 *
 * A missing root is polled for with `fs.watchFile`, at a deliberately odd
 * interval, exactly as VS Code's `baseWatcher` does. When it returns, the
 * watcher resumes on a NEW generation and emits a SYNTHETIC ADDED for the root
 * itself, because everything under it is new to a consumer that watched it
 * disappear - and a consumer that received no event would keep showing the
 * empty tree it was left with.
 *
 * ## What crosses the boundary
 *
 * Nothing this class emits carries an absolute path. Every path is mapped back
 * to its project-relative, NFC-normalised form and anything that does not land
 * inside the project is dropped, because a change outside the project is not
 * this project's change.
 */

import {
  FILES_AGGREGATION_MS,
  FILES_EMIT_MAX_ITEMS,
  FILES_EMIT_THROTTLE_MS,
  FILES_PENDING_CHANGES_MAX,
  FILES_WATCHER_MAX_RESTARTS,
  FILES_WATCHER_RESTART_DELAY_MS,
  type FileChangeKind,
  type FilesResyncReason,
  type FilesWatcherReason,
  type FilesWatcherState,
  type FilesWatcherWarning,
} from "@shared/schemas/files.js";

import { log } from "../../logger/index.js";
import {
  coalesceFileEvents,
  suppressUnderDeletedParents,
  type CoalescedChanges,
  type RawFileEvent,
} from "./coalescer.js";
import { PROJECT_ROOT_RELATIVE, toProjectRelative } from "./node-path.js";

/* ------------------------------------------------------------------ *
 * The collaborators, so the policy above is testable without an OS
 * ------------------------------------------------------------------ */

export interface NativeSubscription {
  unsubscribe: () => Promise<void>;
}

export interface NativeEvent {
  readonly path: string;
  readonly type: "create" | "update" | "delete";
}

export type NativeSubscribe = (
  directory: string,
  callback: (error: Error | null, events: NativeEvent[]) => void,
  options: { readonly ignore: string[] },
) => Promise<NativeSubscription>;

/** Watch for a vanished root's return. Returns an idempotent stop. */
export type RootPoller = (
  directory: string,
  onAppeared: () => void,
) => () => void;

export interface WatcherEmission {
  readonly generation: number;
  readonly payload:
    | {
      readonly kind: "changed";
      readonly batchSeq: number;
      readonly changes: ReadonlyArray<{ path: string; kind: FileChangeKind }>;
      readonly overflowed: boolean;
      readonly droppedCount: number;
    }
    | {
      readonly kind: "resync";
      readonly reason: FilesResyncReason;
      readonly droppedCount: number;
    }
    | {
      readonly kind: "status";
      readonly state: FilesWatcherState;
      readonly reason: FilesWatcherReason;
      readonly warnings: readonly FilesWatcherWarning[];
    };
}

export interface ProjectFileWatcherOptions {
  readonly projectId: string;
  /** The REALPATH of the project directory. Every mapping is relative to it. */
  readonly realRoot: string;
  readonly ignore: string[];
  readonly subscribeNative: NativeSubscribe;
  readonly pollForRoot: RootPoller;
  readonly rootExists: (directory: string) => Promise<boolean>;
  readonly emit: (emission: WatcherEmission) => void;
}

/* ------------------------------------------------------------------ *
 * ENOSPC is logged ONCE per process
 * ------------------------------------------------------------------ */

const loggedOnce = new Set<FilesWatcherWarning>();

function logLimitOnce(warning: FilesWatcherWarning, projectId: string): void {
  if (loggedOnce.has(warning)) return;
  loggedOnce.add(warning);
  log.warn(
    `[studio:files] the operating system refused a file watch (${warning}); `
      + `file watching is unavailable for this session projectId=${projectId}. `
      + "On Linux this is fs.inotify.max_user_watches; on macOS and Windows it "
      + "is the process file-descriptor limit.",
  );
}

/** Test seam: forget which limits have already been logged. */
export function resetFileWatcherLogOnceForTests(): void {
  loggedOnce.clear();
}

/**
 * Classify a native watcher failure.
 *
 * CODE FIRST, message second. @parcel/watcher 2.6.0's inotify backend was
 * probed and its `subscribe` rejection for a missing directory carries NO
 * `code` at all (the message is "Bad file descriptor"), so a classifier that
 * trusted `code` alone would call an exhausted-resource failure an ordinary one
 * and restart into it five times. The message match is a fallback for exactly
 * that gap and is anchored on the errno NAMES, which the backends do put in
 * their text.
 */
export function classifyWatcherFailure(
  cause: unknown,
): "os_watch_limit" | "os_file_limit" | "root_missing" | "io_error" {
  const code = typeof cause === "object" && cause !== null
    ? (cause as { code?: unknown }).code
    : undefined;
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (code === "ENOSPC" || message.includes("ENOSPC")) return "os_watch_limit";
  if (code === "EMFILE" || code === "ENFILE"
    || message.includes("EMFILE") || message.includes("ENFILE")) {
    return "os_file_limit";
  }
  if (code === "ENOENT" || message.includes("ENOENT")) return "root_missing";
  return "io_error";
}

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

export class ProjectFileWatcher {
  private readonly options: ProjectFileWatcherOptions;

  private generation = 0;
  private batchSeq = 0;
  private state: FilesWatcherState = "unavailable";
  private readonly warnings = new Set<FilesWatcherWarning>();

  private subscription: NativeSubscription | null = null;
  /** The generation a native callback must belong to for its events to count. */
  private liveGeneration = -1;

  private raw: RawFileEvent[] = [];
  private pending: CoalescedChanges = new Map();
  private droppedCount = 0;
  private overflowReported = false;

  private aggregateTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopPolling: (() => void) | null = null;
  private lastEmitMs = 0;

  private restarts = 0;
  /**
   * Set when this instance landed in `unavailable` through the restart cap or
   * an exhausted OS limit. Never cleared: see the restart policy in the header.
   */
  private terminal = false;
  private disposed = false;
  /** Single-flight for `start`, so two subscribers cannot create two watches. */
  private starting: Promise<void> | null = null;

  constructor(options: ProjectFileWatcherOptions) {
    this.options = options;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentState(): FilesWatcherState {
    return this.state;
  }

  get currentWarnings(): readonly FilesWatcherWarning[] {
    return [...this.warnings];
  }

  /**
   * Begin watching. Idempotent and joinable.
   *
   * Two subscribers arriving in the same tick join ONE start rather than
   * creating two recursive watches - the same single-flight discipline the
   * preload port acquisition uses, for the same reason.
   */
  async start(): Promise<void> {
    if (this.disposed || this.terminal) return;
    if (this.state === "watching" || this.state === "suspended") return;
    this.starting ??= this.subscribeNow("started").finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async subscribeNow(reason: FilesWatcherReason): Promise<void> {
    if (this.disposed) return;

    // A root that is not there is not a failure; it is a suspend.
    if (!(await this.options.rootExists(this.options.realRoot))) {
      this.suspend();
      return;
    }

    const generation = this.generation;
    try {
      const subscription = await this.options.subscribeNative(
        this.options.realRoot,
        (error, events) => {
          this.onNative(generation, error, events);
        },
        { ignore: this.options.ignore },
      );
      if (this.disposed) {
        // Disposed while the subscription was being created. It exists, so it
        // must be released; publishing it would leave a live OS watch behind a
        // watcher nobody holds.
        void subscription.unsubscribe().catch(() => undefined);
        return;
      }
      this.subscription = subscription;
      this.liveGeneration = generation;
      this.state = "watching";
      this.publishStatus(reason);
    } catch (cause) {
      this.handleFailure(cause);
    }
  }

  private onNative(
    generation: number,
    error: Error | null,
    events: NativeEvent[],
  ): void {
    // A callback from a superseded subscription describes a tree we have
    // already told consumers is gone.
    if (this.disposed || generation !== this.liveGeneration) return;
    if (error !== null) {
      this.handleFailure(error);
      return;
    }
    for (const event of events) {
      const relative = toProjectRelative(this.options.realRoot, event.path);
      if (relative === null) continue;
      if (relative === PROJECT_ROOT_RELATIVE) {
        // The ROOT itself. A delete of it is the vanish signal; probed against
        // @parcel/watcher 2.6.0, removing a watched directory emits exactly
        // this and no error.
        if (event.type === "delete") {
          this.suspend();
          return;
        }
        continue;
      }
      this.raw.push({ path: relative, type: event.type });
    }
    this.scheduleAggregation();
  }

  private scheduleAggregation(): void {
    if (this.aggregateTimer !== null || this.raw.length === 0) return;
    this.aggregateTimer = setTimeout(() => {
      this.aggregateTimer = null;
      this.aggregate();
    }, FILES_AGGREGATION_MS);
    this.aggregateTimer.unref?.();
  }

  private aggregate(): void {
    if (this.disposed) return;
    const window = this.raw;
    this.raw = [];
    const folded = coalesceFileEvents(window, FILES_PENDING_CHANGES_MAX, this.pending);
    this.pending = folded.changes;
    if (folded.dropped > 0) {
      this.droppedCount += folded.dropped;
      if (!this.overflowReported) {
        this.overflowReported = true;
        log.warn(
          `[studio:files] the pending change buffer overflowed projectId=`
            + `${this.options.projectId}; consumers are being told to re-list`,
        );
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.pending.size === 0) return;
    const elapsed = Date.now() - this.lastEmitMs;
    const wait = elapsed >= FILES_EMIT_THROTTLE_MS
      ? 0
      : FILES_EMIT_THROTTLE_MS - elapsed;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.disposed || this.pending.size === 0) return;
    this.lastEmitMs = Date.now();

    // The suppression post-pass runs again here and not only at aggregation:
    // a parent's delete and a child's delete can arrive in DIFFERENT 75 ms
    // windows, and a suppression applied only within a window would let the
    // child through in the earlier batch.
    suppressUnderDeletedParents(this.pending);

    const changes: Array<{ path: string; kind: FileChangeKind }> = [];
    for (const [changePath, kind] of this.pending) {
      if (changes.length >= FILES_EMIT_MAX_ITEMS) break;
      changes.push({ path: changePath, kind });
    }
    for (const change of changes) this.pending.delete(change.path);

    const dropped = this.droppedCount;
    this.droppedCount = 0;
    const overflowed = dropped > 0;
    if (overflowed) {
      this.overflowReported = false;
      this.options.emit({
        generation: this.generation,
        payload: { kind: "resync", reason: "overflow", droppedCount: dropped },
      });
    }

    if (changes.length > 0) {
      this.options.emit({
        generation: this.generation,
        payload: {
          kind: "changed",
          batchSeq: this.batchSeq,
          changes,
          overflowed,
          droppedCount: dropped,
        },
      });
      this.batchSeq += 1;
    }

    // More than one batch's worth remains: drain it on the next throttle tick
    // rather than in one oversized message.
    this.scheduleFlush();
  }

  /* ---------------------------------------------------------------- *
   * Failure, restart, suspend
   * ---------------------------------------------------------------- */

  private handleFailure(cause: unknown): void {
    if (this.disposed) return;
    const classified = classifyWatcherFailure(cause);

    if (classified === "root_missing") {
      this.suspend();
      return;
    }

    if (classified === "os_watch_limit" || classified === "os_file_limit") {
      // NEVER restarted. The resource that was refused is exactly the one a
      // restart would ask for again.
      const warning: FilesWatcherWarning = classified === "os_watch_limit"
        ? "os_watch_limit_reached"
        : "os_file_limit_reached";
      logLimitOnce(warning, this.options.projectId);
      this.warnings.add(warning);
      void this.stopNative();
      this.terminal = true;
      this.state = "unavailable";
      this.publishStatus(classified);
      return;
    }

    log.warn(
      `[studio:files] the native watcher failed projectId=${this.options.projectId} `
        + `restarts=${String(this.restarts)}`,
    );

    if (this.restarts >= FILES_WATCHER_MAX_RESTARTS) {
      this.warnings.add("restart_cap_reached");
      void this.stopNative();
      this.terminal = true;
      this.state = "unavailable";
      this.publishStatus("restart_cap_reached");
      return;
    }

    this.restarts += 1;
    this.restart();
  }

  /** STOP BEFORE RESTART: never two recursive watches of one tree. */
  private restart(): void {
    if (this.restartTimer !== null) return;
    void this.stopNative().then(() => {
      if (this.disposed) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.bumpGeneration();
        void this.subscribeNow("restarted").then(() => {
          // Read through the public getter: `subscribeNow` mutates `state`
          // across an await, and a direct `this.state` read here still carries
          // the narrowing from the guard that entered this path.
          if (this.currentState !== "watching") return;
          this.options.emit({
            generation: this.generation,
            payload: {
              kind: "resync",
              reason: "watcher_restarted",
              droppedCount: 0,
            },
          });
        });
      }, FILES_WATCHER_RESTART_DELAY_MS);
      this.restartTimer.unref?.();
    });
  }

  /**
   * The root is not there. Stop watching, start polling, and say so.
   *
   * Pending changes are DISCARDED rather than emitted: they describe a tree
   * that has just vanished, and the resume's synthetic ADDED plus the new
   * generation tell the consumer to start over, which is the only honest answer.
   */
  private suspend(): void {
    if (this.state === "suspended" || this.disposed) return;
    void this.stopNative();
    this.raw = [];
    this.pending.clear();
    this.droppedCount = 0;
    this.bumpGeneration();
    this.state = "suspended";
    this.publishStatus("root_missing");

    this.stopPolling?.();
    this.stopPolling = this.options.pollForRoot(this.options.realRoot, () => {
      void this.resume();
    });
  }

  private async resume(): Promise<void> {
    if (this.disposed || this.state !== "suspended") return;
    if (!(await this.options.rootExists(this.options.realRoot))) return;
    this.stopPolling?.();
    this.stopPolling = null;
    // A resumed root is a NEW tree as far as any consumer is concerned.
    this.restarts = 0;
    this.bumpGeneration();
    await this.subscribeNow("root_returned");
    // The public getter, for the reason the restart path documents.
    if (this.currentState !== "watching") return;
    this.options.emit({
      generation: this.generation,
      payload: { kind: "resync", reason: "root_resumed", droppedCount: 0 },
    });
    // THE SYNTHETIC ADDED. Without it a consumer that watched the root vanish
    // receives nothing at all when it comes back and keeps showing an empty
    // tree over a populated directory.
    this.options.emit({
      generation: this.generation,
      payload: {
        kind: "changed",
        batchSeq: this.batchSeq,
        changes: [{ path: PROJECT_ROOT_RELATIVE, kind: "added" }],
        overflowed: false,
        droppedCount: 0,
      },
    });
    this.batchSeq += 1;
  }

  private bumpGeneration(): void {
    this.generation += 1;
    this.batchSeq = 0;
  }

  private publishStatus(reason: FilesWatcherReason): void {
    this.options.emit({
      generation: this.generation,
      payload: {
        kind: "status",
        state: this.state,
        reason,
        warnings: [...this.warnings],
      },
    });
  }

  private async stopNative(): Promise<void> {
    const current = this.subscription;
    this.subscription = null;
    this.liveGeneration = -1;
    if (current === null) return;
    try {
      await current.unsubscribe();
    } catch {
      // The OS may have released it already (a vanished root does exactly
      // that). The reference is gone either way, which is the obligation.
    }
  }

  /**
   * Tear down. Idempotent, and safe after a partial start.
   *
   * Admission is closed FIRST (`disposed`), so a native callback or a resume
   * that is already in flight publishes nothing, and only then are the timers
   * and the subscription released.
   */
  async dispose(reason: FilesWatcherReason = "released"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.aggregateTimer !== null) clearTimeout(this.aggregateTimer);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.aggregateTimer = null;
    this.flushTimer = null;
    this.restartTimer = null;
    this.stopPolling?.();
    this.stopPolling = null;
    this.raw = [];
    this.pending.clear();
    const wasStarting = this.starting;
    if (wasStarting !== null) await wasStarting.catch(() => undefined);
    await this.stopNative();
    this.state = reason === "project_deleted" ? "closed" : "unavailable";
  }
}
