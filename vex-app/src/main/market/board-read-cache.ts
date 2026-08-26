/**
 * BOARD READ CACHE - the one owner of "ask the provider once, serve the burst".
 *
 * WHY IT EXISTS. Every board-owned one-shot read has the same three problems:
 * a grid mounts eight cards in one tick and each wants the same answer; the
 * provider states its own freshness in its headers and an entry is worth
 * exactly that long; and the process may tear down while reads are in flight.
 * `board-icon-service.ts` solved all three for icons, and a second hand-written
 * copy per read would be three more chances to get the teardown order wrong.
 * So the mechanism lives here and the details, subject and spotlight services
 * supply only their policy.
 *
 * FOUR PROPERTIES, each of which was a real defect in something before it was
 * a rule here:
 *
 *  1. SINGLE-FLIGHT IS WAITER-SAFE. A second caller for a key with a read in
 *     flight JOINS that read rather than starting another. It joins the
 *     PROMISE, not the entry, so a caller that arrives after the read settled
 *     but before the entry was written still gets the answer instead of
 *     starting a duplicate.
 *  2. TRANSIENTS ARE NEVER CACHED. A timeout, a 5xx or a torn-down transport
 *     says nothing about the resource. Caching one would turn a single bad
 *     second into a whole freshness window of a wrong answer, which for a
 *     safety chip means a card that says "checks unavailable" long after the
 *     provider came back. The caller declares which outcomes are cacheable.
 *  3. THE ENTRY EXPIRES ON THE PROVIDER'S CLOCK, NOT OURS. The caller returns
 *     the instant its answer stops being worth serving, computed from the
 *     provider's own `max-age` minus the `age` it already had. Freshness we
 *     invent is freshness we cannot defend.
 *  4. DISPOSE IS AWAITED. Closing admission first, then aborting, then DRAINING
 *     what is in flight, is what keeps a fetch from outliving the transport it
 *     borrows. A dropped teardown promise lets the bridge - Chromium session,
 *     hidden window and all - be disposed underneath a running read.
 *
 * THE LRU IS THE MEMORY BOUND AND NOTHING ELSE. Expiry decides correctness;
 * the capacity decides how much a board may hold. An insertion-ordered `Map`
 * is the LRU: re-inserting moves a key to the end, so the oldest key is always
 * the first one iteration yields.
 */

/** What one read produced, and whether it is worth remembering. */
export interface BoardReadOutcome<T> {
  readonly value: T;
  /**
   * The instant this value stops being served from cache, or null when it must
   * not be cached at all (every transient failure).
   */
  readonly expiresAtMs: number | null;
}

export interface BoardReadCacheOptions<T> {
  /** How many settled entries may be held. A memory bound, not a policy. */
  readonly capacity: number;
  /** Distinct keys read at once. Board reads yield the pipe to the agent. */
  readonly maxConcurrent: number;
  /** Waiting distinct keys. Past this, a caller is refused rather than queued. */
  readonly queueMax: number;
  readonly now: () => number;
  /** What a refusal looks like for this cache's value type. */
  readonly refusal: (reason: "busy" | "not_mounted") => T;
}

export interface BoardReadCache<T> {
  /**
   * Serve `key` from cache, join a read in flight, or start one.
   *
   * `signal` cancels THIS caller's wait. It deliberately does not cancel the
   * shared read: a second caller may still be waiting on it, and one reader
   * leaving must not take the answer away from the other.
   */
  read(
    key: string,
    load: (signal: AbortSignal) => Promise<BoardReadOutcome<T>>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** The cached value for `key` if it is still fresh, else null. */
  peek(key: string): T | null;
  /** Number of settled entries held. For tests and for logging. */
  size(): number;
  /** Idempotent. Closes admission, aborts in flight, drains, clears. */
  dispose(): Promise<void>;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

interface QueueEntry {
  readonly admit: (admitted: boolean) => void;
}

export function createBoardReadCache<T>(
  options: BoardReadCacheOptions<T>,
): BoardReadCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  const controllers = new Set<AbortController>();
  const queue: QueueEntry[] = [];
  let active = 0;
  let closed = false;

  function remember(key: string, value: T, expiresAtMs: number): void {
    entries.delete(key);
    entries.set(key, { value, expiresAtMs });
    while (entries.size > options.capacity) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  function fresh(key: string): T | null {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= options.now()) {
      entries.delete(key);
      return null;
    }
    // Re-insert so a served key is the most recently used one.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function pump(): void {
    while (active < options.maxConcurrent) {
      const next = queue.shift();
      if (next === undefined) return;
      // The slot is taken HERE, by the pump, so a waiter wakes already counted
      // and cannot increment a second time on its own side.
      active += 1;
      next.admit(true);
    }
  }

  function acquireSlot(): Promise<boolean> {
    if (active < options.maxConcurrent) {
      active += 1;
      return Promise.resolve(true);
    }
    if (queue.length >= options.queueMax) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      queue.push({ admit: resolve });
    });
  }

  function releaseSlot(): void {
    active -= 1;
    pump();
  }

  async function runLoad(
    key: string,
    load: (signal: AbortSignal) => Promise<BoardReadOutcome<T>>,
  ): Promise<T> {
    const admitted = await acquireSlot();
    if (!admitted) return options.refusal(closed ? "not_mounted" : "busy");
    // Admission can close while a caller waits in the queue.
    if (closed) {
      releaseSlot();
      return options.refusal("not_mounted");
    }
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const outcome = await load(controller.signal);
      // A CACHE WRITE AFTER TEARDOWN IS A LEAK, so it is checked here rather
      // than trusted from before the await.
      if (outcome.expiresAtMs !== null && !closed) {
        remember(key, outcome.value, outcome.expiresAtMs);
      }
      return outcome.value;
    } finally {
      controllers.delete(controller);
      releaseSlot();
    }
  }

  return {
    async read(key, load, signal): Promise<T> {
      if (closed) return options.refusal("not_mounted");
      const cached = fresh(key);
      if (cached !== null) return cached;

      // SINGLE-FLIGHT. Eight cards can name one pool and a grid mounts them in
      // the same tick; without this the same document is fetched eight times.
      let running = inFlight.get(key);
      if (running === undefined) {
        running = runLoad(key, load).finally(() => {
          inFlight.delete(key);
        });
        inFlight.set(key, running);
      }
      if (signal === undefined) return running;
      // This caller's own cancellation. The shared read continues, because
      // another caller may still be waiting on it: one reader closing a modal
      // must not take the answer away from a card that is still on screen.
      return Promise.race([
        running,
        new Promise<T>((resolve) => {
          if (signal.aborted) {
            resolve(options.refusal("not_mounted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              resolve(options.refusal("not_mounted"));
            },
            { once: true },
          );
        }),
      ]);
    },

    peek(key): T | null {
      return closed ? null : fresh(key);
    },

    size(): number {
      return entries.size;
    },

    async dispose(): Promise<void> {
      if (closed) return;
      // Order matters: close admission BEFORE aborting, so nothing queued
      // starts a read into a cache that is tearing down.
      closed = true;
      // Refused, not admitted: a queued caller never held a slot, so waking it
      // with `true` would let it release one it never took.
      for (const waiting of queue.splice(0)) waiting.admit(false);
      for (const controller of controllers) controller.abort();
      // DRAIN rather than abandon: every in-flight read settles before this
      // resolves, so no read outlives the transport it borrows.
      await Promise.allSettled([...inFlight.values()]);
      inFlight.clear();
      controllers.clear();
      entries.clear();
    },
  };
}
