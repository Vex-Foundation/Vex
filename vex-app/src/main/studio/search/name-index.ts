/**
 * THE NAME INDEX and its lifetime owner.
 *
 * One index per project, built on the FIRST QUERY of a search session, reused
 * for every keystroke of that session, and disposed when the session is
 * released, when the project closes, when it has gone unused for
 * `SEARCH_INDEX_IDLE_MS`, or when a fifth project wants one.
 *
 * ## Why a session and not a subscription
 *
 * VS Code's Go to File keeps no watcher-reconciled index either: it builds a
 * `FileQueryCacheState` when the picker opens, reuses it for the picker's whole
 * life, and clears it when the picker closes. This is that lifetime.
 *
 * The alternative - reconciling from the project's file watcher - is not
 * available without a new seam on the files domain, which owns that watcher and
 * fans it out to exactly one consumer; and standing up a SECOND recursive OS
 * watch would double the watch descriptors on a path whose own code treats
 * descriptor exhaustion as terminal (`watcher.ts`, `os_watch_limit`). Measured,
 * the walk it would save is 131 ms warm / 216 ms cold over 20,000 files. That
 * is not a price worth a second watcher, and the staleness it leaves is bounded
 * by a fact this module puts ON THE WIRE - `indexedAtMs` - so the consumer can
 * tell the user when the answer was collected instead of implying it is live.
 *
 * ## Ownership
 *
 * This class is the single named owner of every index, every idle timer and the
 * close-hook registration. Nothing else holds a reference to an index, so
 * disposal is a delete from one map plus a cleared timer, and it is idempotent.
 *
 * ## Authority is re-established per query, never cached
 *
 * An index is a list of NAMES; it is not permission to read anything. Every
 * query re-resolves the project through the database (which serves ACTIVE rows
 * only), re-proves the directory with `realProjectDirectory`, and mints node
 * tokens for the rows it is about to return under the CURRENT epoch. A project
 * deleted while an index is alive therefore answers `project_closed` on the
 * next query, and the tokens it previously handed out stopped verifying at the
 * instant the delete bumped the epoch.
 */

import {
  SEARCH_INDEX_IDLE_MS,
  SEARCH_INDEX_PROJECT_MAX,
  SEARCH_RESULT_LIMIT_DEFAULT,
  type SearchFileMatch,
  type SearchFileNamesInput,
  type SearchFileNamesValue,
  type SearchIndexState,
  type SearchOutcome,
  type SearchReleaseSessionInput,
} from "@shared/schemas/studio-search.js";

import { log } from "../../logger/index.js";
import type { ProjectFilesLocation } from "../files/files-domain.js";
import { mintFileNodeId, projectNodeEpoch } from "../files/node-id.js";
import { realProjectDirectory } from "../files/node-path.js";
import {
  acquireProjectLease,
  registerProjectCloseHook,
} from "../project-lifecycle-gate.js";
import { rankFileNames } from "./name-ranking.js";
import { walkProjectFileNames, type NameWalkResult } from "./name-walk.js";

export interface NameIndexDependencies {
  /**
   * Where the project's files are as the DATABASE says, or `null` when it has
   * no active row. The authority; nothing cached here is.
   */
  readonly resolveProjectDirectory: (
    projectId: string,
  ) => Promise<ProjectFilesLocation | null>;
  /** Test seam over the real walk. */
  readonly walk?: typeof walkProjectFileNames;
  /** Test seam over the clock, so idle expiry is provable without waiting. */
  readonly now?: () => number;
}

/** One project's index, in exactly one of two conditions. */
interface IndexEntry {
  readonly projectId: string;
  readonly sessionId: string;
  /** In flight while the walk runs. Every query joins it: single-flight. */
  building: Promise<NameWalkResult | null>;
  /** Settled result, or null while `building` has not resolved. */
  result: NameWalkResult | null;
  /** When the walk finished, epoch ms, or null while it is still running. */
  builtAtMs: number | null;
  /** Last query or release touch, for idle expiry and LRU eviction. */
  lastUsedMs: number;
  idleTimer: NodeJS.Timeout | null;
  /** Set by `dispose`, so a walk that is still running publishes nothing. */
  disposed: boolean;
}

export class ProjectNameIndexes {
  private readonly deps: NameIndexDependencies;
  private readonly entries = new Map<string, IndexEntry>();
  private readonly unregisterCloseHook: () => void;
  private admitting = true;

  constructor(deps: NameIndexDependencies) {
    this.deps = deps;
    // Step 6 of a project delete drops this project's index, AFTER the
    // tombstone has committed. An index of a deleted project's file names is
    // exactly the kind of thing that must not outlive it.
    this.unregisterCloseHook = registerProjectCloseHook((projectId) => {
      this.dropProject(projectId, "project_closed");
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /* ---------------------------------------------------------------- *
   * The query
   * ---------------------------------------------------------------- */

  /**
   * Rank the project's file names against a query.
   *
   * The FIRST call of a session starts the walk and answers `building` without
   * waiting for it: a rail that blocked its first keystroke for 200 ms would
   * feel broken, and "the file half is still arriving" is a state the UI can
   * render honestly. Every later call ranks against the settled index.
   */
  async fileNames(
    input: SearchFileNamesInput,
  ): Promise<SearchOutcome<SearchFileNamesValue>> {
    if (!this.admitting) return { ok: false, code: "project_closed" };

    // The lease is `fileOperation` for the same reason `listChildren` takes
    // one: this does filesystem work across awaits, and a delete must WAIT for
    // it rather than race the epoch fence at the end.
    const leased = acquireProjectLease(input.projectId, "fileOperation");
    if (!leased.ok) return { ok: false, code: "project_closed" };
    try {
      return await this.fileNamesUnderLease(input);
    } finally {
      leased.lease.release();
    }
  }

  private async fileNamesUnderLease(
    input: SearchFileNamesInput,
  ): Promise<SearchOutcome<SearchFileNamesValue>> {
    // THE REQUEST'S EPOCH, taken before the first await, so the fence at the
    // end compares against the identity this request actually resolved under.
    const epoch = projectNodeEpoch(input.projectId);

    const located = await this.locate(input.projectId);
    if (!located.ok) return { ok: false, code: located.code };

    const entry = this.entryFor(input, located.directory);
    entry.lastUsedMs = this.now();
    this.armIdleTimer(entry);

    // A query that arrives while the walk is running answers from what is
    // known: nothing yet. It does NOT await the walk, so the first keystroke
    // of a session is never slower than an empty answer.
    const settled = entry.result;
    const limit = input.limit ?? SEARCH_RESULT_LIMIT_DEFAULT;

    let value: SearchFileNamesValue;
    if (settled === null) {
      value = {
        matches: [],
        totalMatches: 0,
        truncated: false,
        indexState: "building",
        indexedFileCount: 0,
        indexedAtMs: null,
      };
    } else {
      const ranked = rankFileNames(settled.paths, input.query, limit);
      const state: SearchIndexState = settled.capped ? "capped" : "ready";
      value = {
        // Tokens are minted HERE, per response row, and never stored in the
        // index. A token binds the project's CURRENT epoch, so minting at walk
        // time would hand out tokens that a delete-and-recreate had already
        // invalidated; minting at most `limit` of them per query costs nothing.
        matches: ranked.matches.map(
          (match): SearchFileMatch => ({
            relativePath: match.relativePath,
            nodeId: mintFileNodeId(input.projectId, match.relativePath),
            score: match.score,
          }),
        ),
        totalMatches: ranked.totalMatches,
        truncated: ranked.truncated,
        indexState: state,
        indexedFileCount: settled.paths.length,
        indexedAtMs: entry.builtAtMs,
      };
    }

    // THE PUBLICATION FENCE. Nothing above this line has left the process, and
    // a delete that committed while this request was in flight has already
    // bumped the epoch - so the tokens just minted would be dead on arrival.
    if (projectNodeEpoch(input.projectId) !== epoch) {
      return { ok: false, code: "project_closed" };
    }
    return { ok: true, value };
  }

  /**
   * Give a session's index up.
   *
   * Idempotent and deliberately forgiving: releasing a session that was already
   * retired (by an idle timer, an eviction or a delete) is a successful no-op,
   * because the caller's intent - "I am done with this" - is satisfied either
   * way and there is nothing different for it to do.
   */
  releaseSession(input: SearchReleaseSessionInput): SearchOutcome<null> {
    const entry = this.entries.get(input.projectId);
    if (entry !== undefined && entry.sessionId === input.sessionId) {
      this.dispose(entry, "released");
    }
    return { ok: true, value: null };
  }

  /* ---------------------------------------------------------------- *
   * Authority
   * ---------------------------------------------------------------- */

  /**
   * Prove where this project's files are, on every query.
   *
   * The same chain the files domain proves for a listing: an active database
   * row, then a realpath that must be a real directory DIRECTLY under the
   * anchored projects root. An index never substitutes for it.
   */
  private async locate(
    projectId: string,
  ): Promise<
    | { readonly ok: true; readonly directory: string }
    | { readonly ok: false; readonly code: "project_closed" | "io_error" }
  > {
    const declared = await this.deps.resolveProjectDirectory(projectId);
    if (declared === null) return { ok: false, code: "project_closed" };
    const real = await realProjectDirectory(
      declared.anchoredRoot,
      declared.projectDirectory,
    );
    if (!real.ok) {
      return {
        ok: false,
        code: real.reason === "io_error" ? "io_error" : "project_closed",
      };
    }
    return { ok: true, directory: real.directory };
  }

  /* ---------------------------------------------------------------- *
   * Lifetime
   * ---------------------------------------------------------------- */

  /**
   * The entry for this session, building one if the session is new.
   *
   * A query carrying a session id this project has not seen RETIRES the
   * previous index and starts a fresh walk. That is the whole staleness remedy:
   * the rail mints a session id each time the search opens, so reopening the
   * search is what a user does when a file they just created is missing, and it
   * is what the rail's copy tells them to do.
   */
  private entryFor(input: SearchFileNamesInput, directory: string): IndexEntry {
    const existing = this.entries.get(input.projectId);
    if (existing !== undefined) {
      if (existing.sessionId === input.sessionId) return existing;
      this.dispose(existing, "superseded");
    }

    // Evict before inserting, so the bound holds on the map that will exist
    // rather than on the one that did.
    this.evictWhileOverCapacity();

    const entry: IndexEntry = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      building: Promise.resolve(null),
      result: null,
      builtAtMs: null,
      lastUsedMs: this.now(),
      idleTimer: null,
      disposed: false,
    };
    // Published BEFORE the walk starts so a second keystroke joins this entry
    // rather than starting a second walk of the same tree.
    this.entries.set(input.projectId, entry);
    entry.building = this.build(entry, directory);
    return entry;
  }

  /** Run the walk and publish it onto the entry, unless the entry died first. */
  private async build(entry: IndexEntry, directory: string): Promise<NameWalkResult | null> {
    const walk = this.deps.walk ?? walkProjectFileNames;
    try {
      const result = await walk({
        projectId: entry.projectId,
        projectDirectory: directory,
        isCancelled: () => entry.disposed,
      });
      // The entry was released, evicted or superseded while the walk ran. Its
      // names describe a session nobody is looking at any more.
      if (entry.disposed) return null;
      entry.result = result;
      entry.builtAtMs = this.now();
      log.info(
        `[studio:search] indexed ${String(result.paths.length)} file names in `
          + `${String(result.durationMs)}ms across `
          + `${String(result.directoriesWalked)} directories `
          + `projectId=${entry.projectId} capped=${String(result.capped)}`,
      );
      return result;
    } catch {
      // A walk that failed outright leaves the entry BUILDING rather than
      // claiming an empty project: "no matches" and "the walk broke" are
      // different statements and only one of them is true.
      if (!entry.disposed) {
        log.warn(
          `[studio:search] a name index could not be built projectId=${entry.projectId}`,
        );
      }
      return null;
    }
  }

  private armIdleTimer(entry: IndexEntry): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    // The BACKSTOP, not the primary release. The rail releases its session when
    // the search closes; this is what collects an index whose renderer crashed
    // or whose window went away without ever saying so.
    const timer = setTimeout(() => {
      this.dispose(entry, "idle");
    }, SEARCH_INDEX_IDLE_MS);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  /** Drop least-recently-used indexes until one more will fit. */
  private evictWhileOverCapacity(): void {
    while (this.entries.size >= SEARCH_INDEX_PROJECT_MAX) {
      let oldest: IndexEntry | null = null;
      for (const candidate of this.entries.values()) {
        if (oldest === null || candidate.lastUsedMs < oldest.lastUsedMs) {
          oldest = candidate;
        }
      }
      if (oldest === null) return;
      this.dispose(oldest, "evicted");
    }
  }

  private dropProject(projectId: string, reason: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    this.dispose(entry, reason);
  }

  /**
   * Stop admitting and tear every index down. Idempotent, and called at app
   * quit by the composition that owns this instance.
   */
  disposeAll(): void {
    this.admitting = false;
    this.unregisterCloseHook();
    for (const held of [...this.entries.values()]) {
      this.dispose(held, "shutdown");
    }
  }

  /**
   * Retire ONE index.
   *
   * Idempotent, and safe against an entry whose walk is still running: the flag
   * is what `build` checks before publishing, and what `walkProjectFileNames`
   * polls through `isCancelled`, so a disposal stops the walk at its next
   * directory rather than letting it finish into a session nobody holds.
   */
  private dispose(entry: IndexEntry, reason: string): void {
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.result = null;
    if (this.entries.get(entry.projectId) === entry) {
      this.entries.delete(entry.projectId);
    }
    log.info(
      `[studio:search] dropped a name index projectId=${entry.projectId} reason=${reason}`,
    );
  }

  /** Test seam: how many indexes are alive. */
  heldIndexCount(): number {
    return this.entries.size;
  }

  /** Test seam: join the walk a session started. */
  async settleForTests(projectId: string): Promise<void> {
    await this.entries.get(projectId)?.building;
  }
}
