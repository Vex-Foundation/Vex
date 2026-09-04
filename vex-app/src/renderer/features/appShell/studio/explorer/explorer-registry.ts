/**
 * THE EXPLORER REGISTRY - sessions keyed by project id, OUTSIDE React.
 *
 * Same posture, and for the same reason, as `terminal/terminal-registry.ts`: a
 * session is not a rendered value. It owns a watcher subscription in another
 * process, a tree the user has expanded, a selection and a scroll position, and
 * if React owned it then every remount - a tab switch, a StrictMode pass, a
 * sidebar collapse - would throw that away and re-subscribe.
 *
 * ## acquire / release, and why release is DEFERRED rather than immediate
 *
 * React 19's StrictMode double-invokes effects: setup, cleanup, setup, and the
 * measurement that decided this design (React 19.2.6 under this repo's jsdom
 * setup) shows all three run SYNCHRONOUSLY, before any microtask queued inside
 * the first setup. So an immediate teardown on the cleanup would unwatch and
 * then re-watch, producing two subscriptions per mount in development and a
 * bridge call pattern that never happens in production.
 *
 * `release` therefore lowers the consumer count and, at zero, schedules the
 * teardown on a MICROTASK. The remount's `acquire` has already run by then and
 * the count is back at one, so the teardown cancels itself. A real unmount has
 * no remount, the count stays at zero, and the session is disposed exactly once.
 *
 * ## Bounds
 *
 * The registry refuses nothing: how many projects stay alive is a product
 * decision that belongs to B4, which owns the project list. What it does is
 * make the decision MEASURABLE - {@link ExplorerRegistry.sessionCount} and
 * {@link ExplorerRegistry.consumerCount} - so B4 can enforce a bound with facts
 * rather than guesses.
 */

import { ExplorerSession } from "./explorer-session.js";

interface RegistryRecord {
  readonly session: ExplorerSession;
  /** How many mounted consumers hold this session. Zero schedules a teardown. */
  consumers: number;
  /** Set while a zero-consumer teardown is queued, so it can cancel itself. */
  teardownScheduled: boolean;
}

export class ExplorerRegistry {
  readonly #records = new Map<string, RegistryRecord>();
  readonly #defer: (run: () => void) => void;

  /**
   * @param defer how a zero-consumer teardown is postponed past a StrictMode
   * remount. The default is a microtask; a test injects a manual pump when it
   * wants to observe the window in between.
   *
   * The default WRAPS `queueMicrotask` instead of storing the function: stored
   * on the instance and invoked as `this.#defer(run)`, the platform function
   * receives the registry as its receiver and Chromium throws
   * "TypeError: Illegal invocation" (Node's implementation ignores the
   * receiver, which is why vitest never saw it and closing a file tab crashed
   * the workspace in the built app).
   */
  constructor(defer: (run: () => void) => void = (run) => queueMicrotask(run)) {
    this.#defer = defer;
  }

  /** Sessions currently held. B4's bound is enforced against this. */
  sessionCount(): number {
    return this.#records.size;
  }

  /** Mounted consumers of one project's session. */
  consumerCount(projectId: string): number {
    return this.#records.get(projectId)?.consumers ?? 0;
  }

  has(projectId: string): boolean {
    return this.#records.has(projectId);
  }

  /**
   * Read a HELD session without taking a reference.
   *
   * For a caller that needs to act on a session someone else keeps mounted -
   * the Studio sidebar's explorer header, whose Refresh and Collapse All sit
   * beside the tree rather than inside it (a `role="tree"` may only contain
   * tree items, so the header is a sibling and has no session of its own).
   * Returns null when nothing holds the project, so a header rendered a frame
   * before the tree's acquire effect is a no-op rather than a crash - and
   * never, ever creates a session as a side effect of reading one.
   */
  peek(projectId: string): ExplorerSession | null {
    return this.#records.get(projectId)?.session ?? null;
  }

  /**
   * Take a consumer reference, creating the session on first use.
   *
   * IDEMPOTENT per project id: the second call returns the same session and
   * builds nothing. It also CANCELS a pending teardown, which is what makes the
   * StrictMode remount free.
   */
  acquire(projectId: string): ExplorerSession {
    const existing = this.#records.get(projectId);
    if (existing !== undefined) {
      existing.consumers += 1;
      existing.teardownScheduled = false;
      return existing.session;
    }
    const record: RegistryRecord = {
      session: new ExplorerSession({ projectId }),
      consumers: 1,
      teardownScheduled: false,
    };
    this.#records.set(projectId, record);
    return record.session;
  }

  /** Bring a held session live. Idempotent and single-flight; see the session. */
  async activate(projectId: string): Promise<void> {
    await this.#records.get(projectId)?.session.activate();
  }

  /** Stop watching but keep the tree, so returning to the project is cheap. */
  async deactivate(projectId: string): Promise<void> {
    await this.#records.get(projectId)?.session.deactivate();
  }

  /**
   * Give up a consumer reference.
   *
   * At zero the session is disposed - but only after a microtask, so a
   * StrictMode remount reclaims it first. See the module note.
   */
  release(projectId: string): void {
    const record = this.#records.get(projectId);
    if (record === undefined) return;
    record.consumers = Math.max(0, record.consumers - 1);
    if (record.consumers > 0 || record.teardownScheduled) return;
    record.teardownScheduled = true;
    this.#defer(() => {
      if (!record.teardownScheduled) return;
      if (record.consumers > 0) return;
      record.teardownScheduled = false;
      this.#records.delete(projectId);
      void record.session.dispose();
    });
  }

  /**
   * Switch the shown project. THE ORDER IS THE CONTRACT.
   *
   * The new project is watched and its watch has RESOLVED before the old one is
   * released, because watchers are refcounted per project in main and releasing
   * first opens a window in which a change lands between a listing and its
   * watcher. The bridge's own `watchFile` doc states this rule; this method is
   * the one place it is enforced rather than remembered.
   *
   * Returns the newly active session so the caller does not have to look it up
   * and accidentally acquire a second reference.
   */
  async switchTo(nextProjectId: string, previousProjectId: string | null): Promise<ExplorerSession> {
    const next = this.acquire(nextProjectId);
    await next.activate();
    if (previousProjectId !== null && previousProjectId !== nextProjectId) {
      await this.deactivate(previousProjectId);
      this.release(previousProjectId);
    }
    return next;
  }

  /** Dispose every session. The window teardown path. */
  async disposeAll(): Promise<void> {
    const records = [...this.#records.values()];
    this.#records.clear();
    await Promise.all(records.map((record) => record.session.dispose()));
  }
}

/** The window's registry. One per renderer process, like the sessions it holds. */
export const explorerRegistry = new ExplorerRegistry();
