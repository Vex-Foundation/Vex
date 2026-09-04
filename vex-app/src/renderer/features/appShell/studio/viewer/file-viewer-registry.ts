/**
 * THE FILE VIEWER REGISTRY - sessions keyed by tab id, OUTSIDE React.
 *
 * Same posture and the same deferred teardown as `explorer-registry.ts`, whose
 * module note carries the measurement behind it: React 19's StrictMode
 * double-invokes effects (setup, cleanup, setup) SYNCHRONOUSLY, so an
 * immediate teardown on the cleanup would dispose a session and rebuild it,
 * costing a second read of the file on every mount in development. `release`
 * therefore defers to a microtask and cancels itself when the remount's
 * `acquire` has already restored the count.
 *
 * Keyed by TAB id rather than by path: two tabs on one path cannot exist (the
 * workspace model dedupes by path in `addFileTab`), and the tab id is the
 * identity the component already has. It is also what makes closing one tab
 * unambiguous - a path key would have to reason about which tab's close it was.
 *
 * ## The registry owns VISIBILITY, and therefore the warm-tab bound
 *
 * `setActive` routes every show/hide through here instead of the component
 * calling `FileViewerSession.setActive` directly, because holding
 * {@link VIEWER_WARM_TABS_MAX} is a decision ACROSS sessions: a session cannot
 * know it is the fifth-coldest of sixteen. Past the bound the least recently
 * shown hidden sessions release their text and tokens and re-read on their next
 * show. Nothing is closed and nothing is refused - see the constant for what is
 * never evicted and why.
 *
 * ## One port for every session
 *
 * The worker is shared. Each session's requests are correlated by id inside
 * `WorkerHighlighterPort`, so N open files cost one thread and one set of
 * compiled grammars rather than N. The registry owns the port's lifetime
 * because it outlives any single session, and `disposeAll` is the only thing
 * that ends it.
 */

import { FileViewerSession } from "./file-viewer-session.js";
import {
  defaultHighlighterPort,
  type HighlighterPort,
} from "./highlight/highlighter-port.js";
import type { ExplorerRegistry } from "../explorer/index.js";
import type { WorkspaceFileTab } from "../workspace/types.js";

/**
 * HIDDEN file tabs that keep their content in memory.
 *
 * `STUDIO_FILE_TABS_MAX` (workspace/types.ts) lets a project hold sixteen file
 * tabs open. Holding sixteen files' text AND their token graphs would make the
 * strip's cost the number of files a user has ever clicked, so past this many
 * HIDDEN sessions the least recently shown release their text and tokens and
 * re-read when the user comes back to them.
 *
 * FOUR because the realistic working set of a hidden tab is "the file I was
 * just in, and the two or three I am moving between" - the same reasoning, and
 * the same number, as `WORKSPACE_TERMINAL_GROUPS_MAX` and
 * `STUDIO_WORKSPACE_KEEP_ALIVE_MAX`, and a bound the user cannot perceive at
 * all when it is right.
 *
 * AT THE BOUND nothing is closed, nothing is refused and nothing is lost: an
 * evicted tab keeps its place in the strip, its path, its language and its
 * watch, and shows its file again on the next show. This is a CACHE bound, not
 * an admission bound, which is why it evicts where the other two refuse.
 *
 * NEVER EVICTED, both by construction:
 *
 *   - the ACTIVE tab, because the user is reading it;
 *   - an ORPHANED tab, because its bytes are the last copy of a file that is
 *     gone from disk and no re-read can bring them back (see
 *     `FileViewerSession.holdsEvictableContent`).
 */
export const VIEWER_WARM_TABS_MAX = 4;

interface RegistryRecord {
  readonly session: FileViewerSession;
  /** Mounted consumers. Zero schedules a teardown. */
  consumers: number;
  /** Set while a zero-consumer teardown is queued, so it can cancel itself. */
  teardownScheduled: boolean;
  /** Whether this tab is the one on screen. Never an eviction candidate. */
  active: boolean;
  /**
   * The registry clock reading at which this tab was last SHOWN. The LRU key.
   *
   * A monotonic counter rather than `Date.now()`: two tabs shown inside one
   * millisecond must still order, and a clock the system can move backwards
   * would silently reorder the eviction queue. A session never shown carries
   * 0, which sorts it first - correct, because a tab the user has not looked
   * at is the coldest thing the registry holds.
   */
  lastShownAt: number;
}

export interface FileViewerRegistryOptions {
  /**
   * The shared highlighter. A FACTORY, so the real port - and with it the
   * worker - is built on the first file opened rather than on module load.
   */
  readonly createHighlighter?: () => HighlighterPort;
  /** Injected so a suite never touches the window-wide explorer registry. */
  readonly explorers?: ExplorerRegistry;
  /** How a zero-consumer teardown is postponed past a StrictMode remount. */
  readonly defer?: (run: () => void) => void;
}

export class FileViewerRegistry {
  readonly #records = new Map<string, RegistryRecord>();
  readonly #createHighlighter: () => HighlighterPort;
  readonly #explorers: ExplorerRegistry | undefined;
  readonly #defer: (run: () => void) => void;
  #highlighter: HighlighterPort | null = null;
  /** Monotonic show counter. See `RegistryRecord.lastShownAt`. */
  #showClock = 0;

  constructor(options: FileViewerRegistryOptions = {}) {
    this.#createHighlighter = options.createHighlighter ?? defaultHighlighterPort;
    this.#explorers = options.explorers;
    // Wrapped, never stored: invoked as `this.#defer(run)` the platform
    // `queueMicrotask` would receive this registry as its receiver and
    // Chromium throws "TypeError: Illegal invocation" (Node ignores the
    // receiver, so only the built app showed it). See explorer-registry.ts.
    this.#defer = options.defer ?? ((run) => queueMicrotask(run));
  }

  /** Sessions currently held. Measurable, so a bound can be enforced on facts. */
  sessionCount(): number {
    return this.#records.size;
  }

  /** Mounted consumers of one tab's session. */
  consumerCount(tabId: string): number {
    return this.#records.get(tabId)?.consumers ?? 0;
  }

  has(tabId: string): boolean {
    return this.#records.has(tabId);
  }

  /**
   * Take a consumer reference, creating the session on first use.
   *
   * IDEMPOTENT per tab id, and it CANCELS a pending teardown, which is what
   * makes the StrictMode remount free.
   *
   * A tab whose TOKEN changed gets a NEW session, keeping its consumer count.
   *
   * That is the recovery path for an epoch change: a file deleted and recreated
   * is the same tab to the user (the workspace model dedupes by path, so
   * re-opening it from the tree hands `addFileTab` a fresh token under the same
   * tab id) while being a different read identity to main. A session that kept
   * the stale token would answer `invalid_node` for as long as the tab stayed
   * open, and no amount of re-opening would clear it.
   *
   * The old session is DISPOSED before the new one is published, so its read,
   * its timer and its path subscription are released rather than left running
   * against a tab that no longer points at their file. Repointing the live
   * session instead would swap the read identity mid-flight, which is the one
   * thing an opaque token must never allow.
   */
  acquire(projectId: string, tab: WorkspaceFileTab): FileViewerSession {
    const existing = this.#records.get(tab.tabId);
    if (existing !== undefined && existing.session.nodeId === tab.nodeId) {
      existing.consumers += 1;
      existing.teardownScheduled = false;
      return existing.session;
    }
    if (existing !== undefined) {
      this.#records.delete(tab.tabId);
      existing.teardownScheduled = false;
      existing.session.dispose();
    }
    const record: RegistryRecord = {
      session: new FileViewerSession({
        projectId,
        tab,
        highlighter: this.#sharedHighlighter(),
        ...(this.#explorers === undefined ? {} : { explorers: this.#explorers }),
      }),
      // The replaced session's consumers are still mounted; they are consumers
      // of THIS tab, and the count has to survive the swap or the first
      // `release` would tear down a session the component is still rendering.
      consumers: (existing?.consumers ?? 0) + 1,
      teardownScheduled: false,
      // A REPLACED session inherits the visibility and the LRU position of the
      // tab it replaces: the token changed, the tab did not, and resetting it
      // would make the tab the user is currently reading the coldest thing in
      // the registry.
      active: existing?.active ?? false,
      lastShownAt: existing?.lastShownAt ?? 0,
    };
    this.#records.set(tab.tabId, record);
    if (record.active) record.session.setActive(true);
    return record.session;
  }

  /**
   * Give up a consumer reference.
   *
   * At zero the session is disposed - but only after a microtask, so a
   * StrictMode remount reclaims it first. See the module note.
   */
  release(tabId: string): void {
    const record = this.#records.get(tabId);
    if (record === undefined) return;
    record.consumers = Math.max(0, record.consumers - 1);
    if (record.consumers > 0 || record.teardownScheduled) return;
    record.teardownScheduled = true;
    this.#defer(() => {
      if (!record.teardownScheduled) return;
      if (record.consumers > 0) return;
      record.teardownScheduled = false;
      this.#records.delete(tabId);
      record.session.dispose();
    });
  }

  /**
   * THE VISIBILITY EDGE, and the only place the warm-tab bound is applied.
   *
   * The registry owns this rather than the component calling
   * `session.setActive` directly, because eviction is a decision ACROSS
   * sessions: one session cannot know it is the fifth-coldest, and a component
   * that asked would be a second place the bound is enforced. `FileViewer`
   * reports what happened to its own tab; the registry decides what that costs
   * every other tab.
   *
   * Ordering matters and is deliberate: the session is told first, the clock is
   * stamped second, and the sweep runs last. A tab being SHOWN is therefore
   * already active and already the most recent when the sweep looks at the set,
   * so it can never evict the tab that just triggered it.
   *
   * A no-op for a tab with no session, which is the honest answer for a tab
   * whose consumer has already released it.
   */
  setActive(tabId: string, active: boolean): void {
    const record = this.#records.get(tabId);
    if (record === undefined) return;
    record.active = active;
    record.session.setActive(active);
    if (active) {
      this.#showClock += 1;
      record.lastShownAt = this.#showClock;
    }
    this.#evictColdSessions();
  }

  /** Sessions holding a file's text right now. The bound is enforced on this. */
  warmSessionCount(): number {
    let warm = 0;
    for (const record of this.#records.values()) {
      if (record.session.holdsEvictableContent()) warm += 1;
    }
    return warm;
  }

  /**
   * Release the content of every hidden session past the warm-tab bound.
   *
   * The candidate set is HIDDEN sessions that hold evictable content; the
   * active tab and every orphan are excluded by that definition alone rather
   * than by a special case, which is what makes "the active tab is never
   * evicted" a property of the set instead of a check that could be forgotten.
   *
   * The bound counts the ACTIVE tab too - one shown plus three hidden, not one
   * shown plus four - because the memory it protects does not care which tab
   * the user is looking at.
   */
  #evictColdSessions(): void {
    const candidates = [...this.#records.values()].filter(
      (record) => !record.active && record.session.holdsEvictableContent(),
    );
    const warm = this.warmSessionCount();
    const excess = warm - VIEWER_WARM_TABS_MAX;
    if (excess <= 0) return;
    // Coldest first, so the ones released are the ones the user looked at
    // longest ago. Sorted on a copy: `#records` order is insertion order and is
    // what `disposeAll` walks.
    candidates.sort((a, b) => a.lastShownAt - b.lastShownAt);
    for (const record of candidates.slice(0, excess)) {
      record.session.releaseContent();
    }
  }

  /** Dispose every session and the shared worker. The window teardown path. */
  disposeAll(): void {
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) record.session.dispose();
    const highlighter = this.#highlighter;
    this.#highlighter = null;
    highlighter?.dispose();
  }

  /**
   * The shared port, built on first use.
   *
   * Lazy because building it starts a Worker, and a Vex session that never
   * opens a file should never pay for one.
   */
  #sharedHighlighter(): HighlighterPort {
    this.#highlighter ??= this.#createHighlighter();
    return this.#highlighter;
  }
}

/** The window's registry. One per renderer process, like the sessions it holds. */
export const fileViewerRegistry = new FileViewerRegistry();
