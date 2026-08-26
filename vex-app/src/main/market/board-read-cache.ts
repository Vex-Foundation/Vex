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
 *     hidden window and all - be disposed underneath a running read. The drain
 *     covers BOTH halves of the graph: what is still joinable, and what a
 *     last-waiter abort unpublished and has not finished unwinding.
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
  readonly refusal: (reason: "busy" | "not_mounted" | "cancelled") => T;
}

export interface BoardReadCache<T> {
  /**
   * Serve `key` from cache, join a read in flight, or start one.
   *
   * `signal` cancels THIS caller's wait. A read another caller is still
   * waiting on CONTINUES: one reader closing a modal must not take the answer
   * away from a card that is still on screen. When the aborting caller was the
   * LAST one, though, there is nobody left to take it away from, and the load
   * itself is cancelled - otherwise "cancel" would mean nothing more than
   * looking away while the provider read ran to completion for no one.
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

/**
 * One load in flight and everyone waiting on it.
 *
 * The waiter COUNT is the whole reason this is a record rather than a bare
 * promise: cancelling a shared load is correct exactly when the count reaches
 * zero, and that is a fact only the cache can hold.
 */
interface InFlightLoad<T> {
  promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

export function createBoardReadCache<T>(
  options: BoardReadCacheOptions<T>,
): BoardReadCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, InFlightLoad<T>>();
  /**
   * Loads that were UNPUBLISHED by a last-waiter abort and have not unwound.
   *
   * A tombstone is not joinable - that is the whole point of unpublishing at
   * abort time - but it is still a promise borrowing the transport, so
   * `dispose` has to wait for it exactly as it waits for a joinable one.
   * Without this set an aborted read outlives the bridge it reads through.
   */
  const draining = new Set<Promise<T>>();
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
    controller: AbortController,
  ): Promise<T> {
    const admitted = await acquireSlot();
    if (!admitted) return options.refusal(closed ? "not_mounted" : "busy");
    // Admission can close while a caller waits in the queue.
    if (closed) {
      releaseSlot();
      return options.refusal("not_mounted");
    }
    // The controller is the CALLER-FACING one, created before the slot was
    // asked for, so a last waiter that gives up while this load is still
    // queued has something to abort.
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
        const controller = new AbortController();
        const record: InFlightLoad<T> = {
          promise: Promise.resolve(options.refusal("not_mounted")),
          controller,
          waiters: 0,
        };
        record.promise = runLoad(key, load, controller).finally(() => {
          // Identity-guarded: a `finally` from a superseded load must not
          // delete the record that replaced it.
          if (inFlight.get(key) === record) inFlight.delete(key);
          // The load has unwound, so it is no longer something `dispose` must
          // wait for. Harmless when it was never tombstoned.
          draining.delete(record.promise);
        });
        inFlight.set(key, record);
        running = record;
      }

      // EVERY joiner is counted, abortable or not. A caller with no signal
      // never leaves, which is exactly why it must be counted: it is the
      // reason an aborting sibling may not cancel the load.
      const load_ = running;
      load_.waiters += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        load_.waiters -= 1;
      };

      if (signal === undefined) {
        return await load_.promise.finally(release);
      }

      // This caller's own cancellation. ONE listener does both halves - stop
      // waiting, and decide whether anyone is left - so the two can never
      // disagree about the count.
      let stopWaiting: (value: T) => void = () => undefined;
      const abandoned = new Promise<T>((resolve) => {
        stopWaiting = resolve;
      });
      const onAbort = (): void => {
        release();
        // LAST-WAITER CANCELLATION. Nobody is left to receive this answer, so
        // the provider read is stopped rather than run to completion for an
        // audience that has gone. With a waiter still joined, the count is
        // above zero and the load is untouched.
        if (load_.waiters === 0) {
          load_.controller.abort();
          // UNPUBLISHED AT ABORT TIME, not at settle time. An aborted load
          // that stayed joinable until its `finally` ran handed a caller who
          // arrived in that window the corpse's `cancelled` answer - a read
          // that caller never asked to cancel. The identity guard keeps a
          // record that already replaced this one in place; the `finally`
          // above is the same guard and is a no-op afterwards.
          if (inFlight.get(key) === load_) {
            inFlight.delete(key);
            // UNPUBLISHED IS NOT UNOWNED. Abort asks for cancellation; it does
            // not prove the read has unwound. The load leaves the joinable map
            // and enters the non-joinable drain set, so `dispose` still waits
            // for it and no read outlives the transport it borrows.
            draining.add(load_.promise);
          }
        }
        // The caller left; saying "not mounted" would blame the service for
        // the caller's own decision, so the refusal names the real cause.
        stopWaiting(options.refusal("cancelled"));
      };
      if (signal.aborted) {
        onAbort();
        return options.refusal("cancelled");
      }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([load_.promise, abandoned]);
      } finally {
        // The listener is removed on the settled path so a long-lived signal
        // does not accumulate one entry per read it outlived.
        signal.removeEventListener("abort", onAbort);
        release();
      }
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
      // resolves, so no read outlives the transport it borrows. BOTH halves of
      // the graph are awaited - what is still joinable, and what a last-waiter
      // abort already unpublished but has not finished unwinding.
      await Promise.allSettled([
        ...[...inFlight.values()].map((running) => running.promise),
        ...draining,
      ]);
      inFlight.clear();
      draining.clear();
      controllers.clear();
      entries.clear();
    },
  };
}
