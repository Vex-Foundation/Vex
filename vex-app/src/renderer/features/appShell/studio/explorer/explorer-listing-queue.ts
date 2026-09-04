/**
 * ONE REQUEST IN FLIGHT, FIFO, coalesced by key.
 *
 * A resync of a large expanded tree is not one listing, it is one per open
 * directory, and issuing them together would put a burst of IPC round trips on
 * the bridge for a tree the user is looking at one screen of. So they are
 * serialized: the queue holds the order, and exactly one request is outstanding
 * at a time.
 *
 * COALESCING IS BY KEY, not by equality. Two refreshes of the same directory
 * are one refresh - the second would read the same disk state the first is
 * about to return - while two PAGE requests for the same directory are
 * genuinely different work (different cursors) and both must run. The caller
 * chooses the key, which is what keeps that distinction where it is understood.
 *
 * The queue owns no cancellation. Cancellation on this surface is a PUBLICATION
 * decision, not a transport one: a listing that is no longer wanted still
 * completes, and its result is dropped at the fence by the owner that knows
 * whether the row still exists. Aborting mid-flight would buy nothing and would
 * add a second way for a request to end.
 */

export interface SingleFlightQueueOptions<TRequest> {
  /**
   * The coalescing identity. A request whose key is already queued is DROPPED;
   * return a unique key for work that must not be coalesced.
   */
  readonly key: (request: TRequest) => string;
  /** Perform one request. Rejections are surfaced to `onError` and never thrown. */
  readonly run: (request: TRequest) => Promise<void>;
  /**
   * A request threw. The queue keeps draining: one directory that failed must
   * not strand every directory queued behind it.
   */
  readonly onError?: (error: unknown, request: TRequest) => void;
}

export class SingleFlightQueue<TRequest> {
  readonly #options: SingleFlightQueueOptions<TRequest>;
  readonly #queue: TRequest[] = [];
  #draining = false;

  constructor(options: SingleFlightQueueOptions<TRequest>) {
    this.#options = options;
  }

  /** Requests waiting, not counting the one in flight. */
  get pendingCount(): number {
    return this.#queue.length;
  }

  get isDraining(): boolean {
    return this.#draining;
  }

  /** Whether a request with this key is already waiting. */
  hasQueued(key: string): boolean {
    return this.#queue.some((request) => this.#options.key(request) === key);
  }

  /**
   * Add a request, unless one with the same key is already waiting.
   *
   * Returns whether it was accepted, so a caller that painted a loading state
   * for it can tell whether that state has an owner.
   */
  enqueue(request: TRequest): boolean {
    if (this.hasQueued(this.#options.key(request))) return false;
    this.#queue.push(request);
    void this.#drain();
    return true;
  }

  /**
   * Discard everything WAITING.
   *
   * The request in flight is not discarded, because it cannot be: it is a
   * promise the bridge already owns. It settles and is dropped at the owner's
   * publication fence, which is the only place that can tell whether its result
   * is still wanted.
   */
  clear(): void {
    this.#queue.length = 0;
  }

  /**
   * Resolve once nothing is queued and nothing is in flight.
   *
   * For a caller that must SEE the result of work it just enqueued - opening a
   * name box inside a folder it has only now asked to be listed, where an edit
   * row in an unresolved folder would read as "this folder is empty". It is
   * deliberately not a way to await ONE request: the queue coalesces by key, so
   * the request a caller enqueued may legitimately have been dropped in favour
   * of an identical one, and "my listing finished" is not a question this queue
   * can answer honestly. "Nothing is outstanding" is.
   *
   * It resolves on the NEXT idle, never later: a queue that is fed continuously
   * would starve a waiter that insisted on its own request, and a caller here
   * is doing one interactive thing.
   */
  whenIdle(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  readonly #idleWaiters: Array<() => void> = [];

  #releaseIdleWaiters(): void {
    if (this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const request = this.#queue.shift();
        if (request === undefined) return;
        try {
          await this.#options.run(request);
        } catch (error) {
          this.#options.onError?.(error, request);
        }
      }
    } finally {
      this.#draining = false;
      this.#releaseIdleWaiters();
    }
  }
}
