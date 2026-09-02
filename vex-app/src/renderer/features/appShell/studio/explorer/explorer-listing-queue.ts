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
    }
  }
}
