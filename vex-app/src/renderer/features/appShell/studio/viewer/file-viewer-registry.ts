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

interface RegistryRecord {
  readonly session: FileViewerSession;
  /** Mounted consumers. Zero schedules a teardown. */
  consumers: number;
  /** Set while a zero-consumer teardown is queued, so it can cancel itself. */
  teardownScheduled: boolean;
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

  constructor(options: FileViewerRegistryOptions = {}) {
    this.#createHighlighter = options.createHighlighter ?? defaultHighlighterPort;
    this.#explorers = options.explorers;
    this.#defer = options.defer ?? queueMicrotask;
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
    };
    this.#records.set(tab.tabId, record);
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
