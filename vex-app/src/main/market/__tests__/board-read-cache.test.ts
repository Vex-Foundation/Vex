/**
 * The board read cache, driven through its real single-flight loop.
 *
 * WHAT IS FAKED AND WHY THAT IS THE RIGHT SEAM. The LOAD (a deferred that this
 * test settles when it chooses) and the clock. Every decision under test -
 * single-flight, the waiter count, last-waiter cancellation, the drain - is the
 * shipped code.
 *
 * THE DEFECT THESE TESTS PIN. `read` raced the shared load against the
 * caller's abort, which stopped the CALLER waiting and left the provider read
 * running to completion for an audience that had gone. Cancelling is correct
 * exactly when the aborting caller was the last one, and wrong the moment a
 * sibling is still on screen; both halves are asserted below on the LOAD's own
 * signal, never on a call count.
 *
 * No wall-clock sleep proves anything here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The signal a load captured last. A holder array instead of a nullable
 * binding: an assignment inside a callback is invisible to control-flow
 * narrowing, which would otherwise narrow the binding to `null` at the read.
 */
function latest(signals: readonly AbortSignal[]): AbortSignal {
  const signal = signals[signals.length - 1];
  if (signal === undefined) throw new Error("no load signal was captured");
  return signal;
}


const { createBoardReadCache } = await import("../board-read-cache.js");

interface Answer {
  readonly kind: "value" | "refused";
  readonly text: string;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createCache(overrides: { maxConcurrent?: number } = {}) {
  return createBoardReadCache<Answer>({
    capacity: 8,
    maxConcurrent: overrides.maxConcurrent ?? 2,
    queueMax: 8,
    now: () => 1_000,
    refusal: (reason) => ({ kind: "refused", text: reason }),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("last-waiter cancellation", () => {
  it("aborts the load when its ONLY waiter gives up", async () => {
    const cache = createCache();
    const gate = deferred<void>();
    const loadSignals: AbortSignal[] = [];
    const caller = new AbortController();

    const answer = cache.read(
      "solana:pool-a",
      async (signal) => {
        loadSignals.push(signal);
        await gate.promise;
        return { value: { kind: "value", text: "bundle" }, expiresAtMs: 2_000 };
      },
      caller.signal,
    );
    await flush();
    expect(loadSignals).not.toHaveLength(0);
    expect(latest(loadSignals).aborted).toBe(false);

    caller.abort();
    // THE PROPERTY. Not "the caller stopped waiting" - the READ stopped.
    expect(latest(loadSignals).aborted).toBe(true);

    gate.resolve();
    await expect(answer).resolves.toEqual({
      kind: "refused",
      text: "cancelled",
    });
    await cache.dispose();
  });

  it("leaves a JOINED load untouched when one of two waiters gives up", async () => {
    const cache = createCache();
    const gate = deferred<void>();
    const loadSignals: AbortSignal[] = [];
    let loadCount = 0;
    const leaving = new AbortController();
    const staying = new AbortController();

    const load = async (signal: AbortSignal) => {
      loadCount += 1;
      loadSignals.push(signal);
      await gate.promise;
      return {
        value: { kind: "value", text: "bundle" } as Answer,
        expiresAtMs: 2_000,
      };
    };

    const abandoned = cache.read("solana:pool-a", load, leaving.signal);
    const kept = cache.read("solana:pool-a", load, staying.signal);
    await flush();
    expect(loadCount).toBe(1);

    leaving.abort();
    // A card is still on screen, so the answer is not taken away from it.
    expect(latest(loadSignals).aborted).toBe(false);
    await expect(abandoned).resolves.toEqual({
      kind: "refused",
      text: "cancelled",
    });

    gate.resolve();
    await expect(kept).resolves.toEqual({ kind: "value", text: "bundle" });
    expect(latest(loadSignals).aborted).toBe(false);
    await cache.dispose();
  });

  it("counts a caller with NO signal as a waiter, so it cannot be cancelled out from under", async () => {
    const cache = createCache();
    const gate = deferred<void>();
    const loadSignals: AbortSignal[] = [];
    const leaving = new AbortController();

    const load = async (signal: AbortSignal) => {
      loadSignals.push(signal);
      await gate.promise;
      return {
        value: { kind: "value", text: "bundle" } as Answer,
        expiresAtMs: 2_000,
      };
    };

    const patient = cache.read("solana:pool-a", load);
    const abandoned = cache.read("solana:pool-a", load, leaving.signal);
    await flush();

    leaving.abort();
    expect(latest(loadSignals).aborted).toBe(false);
    await expect(abandoned).resolves.toEqual({
      kind: "refused",
      text: "cancelled",
    });

    gate.resolve();
    await expect(patient).resolves.toEqual({ kind: "value", text: "bundle" });
    await cache.dispose();
  });

  it("does not cancel a LATER read for the same key after an earlier one was abandoned", async () => {
    const cache = createCache();
    const first = deferred<void>();
    const firstCaller = new AbortController();
    const firstSignals: AbortSignal[] = [];

    const abandoned = cache.read(
      "solana:pool-a",
      async (signal) => {
        firstSignals.push(signal);
        await first.promise;
        // What a real load does with an aborted signal: it produces a
        // transient, which is never cached.
        return signal.aborted
          ? { value: { kind: "refused", text: "cancelled" } as Answer, expiresAtMs: null }
          : { value: { kind: "value", text: "stale" } as Answer, expiresAtMs: 2_000 };
      },
      firstCaller.signal,
    );
    await flush();
    firstCaller.abort();
    expect(latest(firstSignals).aborted).toBe(true);
    first.resolve();
    await abandoned;
    await flush();

    // The abandoned load is gone from the in-flight map, so a fresh caller
    // starts a fresh read with a fresh signal rather than joining a corpse.
    const secondSignals: AbortSignal[] = [];
    const fresh = await cache.read("solana:pool-a", async (signal) => {
      secondSignals.push(signal);
      return {
        value: { kind: "value", text: "fresh" } as Answer,
        expiresAtMs: 2_000,
      };
    });
    expect(fresh).toEqual({ kind: "value", text: "fresh" });
    expect(latest(secondSignals).aborted).toBe(false);
    await cache.dispose();
  });
});

describe("single-flight and teardown are unchanged by the waiter count", () => {
  it("serves a burst of eight callers from ONE load", async () => {
    const cache = createCache();
    let loadCount = 0;
    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        cache.read("solana:pool-a", async () => {
          loadCount += 1;
          return {
            value: { kind: "value", text: "bundle" } as Answer,
            expiresAtMs: 2_000,
          };
        }),
      ),
    );
    expect(loadCount).toBe(1);
    expect(answers.every((answer) => answer.text === "bundle")).toBe(true);
    await cache.dispose();
  });

  it("dispose closes admission, aborts and DRAINS the read in flight", async () => {
    const cache = createCache();
    const gate = deferred<void>();
    const loadSignals: AbortSignal[] = [];
    let finished = false;

    const answer = cache.read("solana:pool-a", async (signal) => {
      loadSignals.push(signal);
      await gate.promise;
      finished = true;
      return {
        value: { kind: "value", text: "bundle" } as Answer,
        expiresAtMs: 2_000,
      };
    });
    await flush();

    const disposing = cache.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await flush();
    expect(latest(loadSignals).aborted).toBe(true);
    expect(disposed).toBe(false);

    gate.resolve();
    await disposing;
    expect(finished).toBe(true);
    expect(disposed).toBe(true);
    await answer;
    // Admission is closed: a later caller is refused rather than served.
    await expect(cache.read("solana:pool-a", async () => {
      throw new Error("must not run");
    })).resolves.toEqual({ kind: "refused", text: "not_mounted" });
  });

  it("DRAINS a load a last waiter aborted, even though it is no longer joinable", async () => {
    // THE DEFECT. Last-waiter abort unpublishes the record so a later caller
    // cannot inherit a cancellation it never asked for. Unpublishing at abort
    // time also removed it from the only collection `dispose` awaited, so
    // `dispose` could resolve while the aborted provider read was still
    // unwinding - a read outliving the transport it borrows.
    const cache = createCache();
    const gate = deferred<void>();
    const loadSignals: AbortSignal[] = [];
    let settled = 0;
    const caller = new AbortController();

    const answer = cache.read(
      "solana:pool-a",
      async (signal) => {
        loadSignals.push(signal);
        await gate.promise;
        settled += 1;
        return {
          value: { kind: "value", text: "bundle" } as Answer,
          expiresAtMs: 2_000,
        };
      },
      caller.signal,
    );
    await flush();

    caller.abort();
    expect(latest(loadSignals).aborted).toBe(true);
    await expect(answer).resolves.toEqual({
      kind: "refused",
      text: "cancelled",
    });

    // Dispose while the aborted read is still held open by the gate.
    const disposing = cache.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await flush();
    expect(disposed).toBe(false);
    expect(settled).toBe(0);

    gate.resolve();
    await disposing;
    expect(disposed).toBe(true);
    // Nothing is left running behind the disposed cache.
    expect(settled).toBe(1);
  });
});
