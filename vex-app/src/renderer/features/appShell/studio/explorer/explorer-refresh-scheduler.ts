/**
 * THE REFRESH WINDOW - VS Code's `RunOnceScheduler`, with its semantics intact.
 *
 * A file watcher under load does not deliver one change, it delivers a stream:
 * a build, an install, a branch switch. Reacting per change would put an IPC
 * listing on every one of them, and reacting only after the stream stops would
 * mean never reacting at all while it runs.
 *
 * VS Code's answer (`explorerService.ts:37,69-111`) is a scheduler ARMED ON THE
 * FIRST event and deliberately NOT re-armed while pending: `schedule()` is
 * called only `if (!this.onFileChangesScheduler.isScheduled())`. The window
 * therefore closes a fixed delay after the first event and processes everything
 * accumulated since, and the next event opens the next window.
 *
 * The distinction matters and is easy to lose: a timer RESET by each event is
 * the usual debounce, and under a steady stream it is never allowed to fire.
 * The tree would simply stop updating for as long as the build ran, and nothing
 * would look broken.
 *
 * ## What accumulates
 *
 * Two kinds of pending work, and one absorbs the other. A FULL refresh re-reads
 * the root and every open directory, which is a superset of any set of marked
 * parents, so marking is discarded the moment a full refresh is pending -
 * otherwise the same directory would be listed twice for one window.
 */

/** What one closed window asks its owner to do. */
export interface RefreshPlan {
  /** Re-read the root and every open directory. Absorbs `parents`. */
  readonly full: boolean;
  /** The directories a targeted refresh should re-read, when `full` is false. */
  readonly parents: readonly (string | null)[];
}

export class ExplorerRefreshScheduler {
  readonly #delayMs: number;
  readonly #run: (plan: RefreshPlan) => void;
  /** Bounded by the number of directories the user has actually opened. */
  readonly #parents = new Set<string | null>();
  #full = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(delayMs: number, run: (plan: RefreshPlan) => void) {
    this.#delayMs = delayMs;
    this.#run = run;
  }

  /** Whether a window is currently open. */
  get isArmed(): boolean {
    return this.#timer !== null;
  }

  /** Mark one directory for a targeted re-read. */
  markParent(parentId: string | null): void {
    if (!this.#full) this.#parents.add(parentId);
    this.#arm();
  }

  /** Ask for a full re-read. Absorbs every mark, now and for this window. */
  scheduleFull(): void {
    this.#full = true;
    this.#parents.clear();
    this.#arm();
  }

  /**
   * Close the window NOW and hand back what had accumulated.
   *
   * The header's Refresh action: the user asked, so waiting out a delay meant
   * for coalescing machine-generated events would only feel broken.
   */
  flushNow(): RefreshPlan {
    this.cancel();
    return this.#take();
  }

  /** Drop the window and everything in it. The teardown path. */
  cancel(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Drop pending work without running it, and close any open window. */
  reset(): void {
    this.cancel();
    this.#full = false;
    this.#parents.clear();
  }

  #arm(): void {
    // THE GUARD IS THE SEMANTICS. See the module note.
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#run(this.#take());
    }, this.#delayMs);
  }

  #take(): RefreshPlan {
    const plan: RefreshPlan = { full: this.#full, parents: [...this.#parents] };
    this.#full = false;
    this.#parents.clear();
    return plan;
  }
}
