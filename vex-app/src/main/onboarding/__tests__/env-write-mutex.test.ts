/**
 * Tests for the M9 env-write-mutex (mirror of wallet-mutex pattern).
 *
 * Verifies:
 *  - Concurrent ops execute in submission order (no interleaving).
 *  - A failed op does not poison the chain — subsequent ops still run.
 *  - Each call resolves with its own fn return value.
 *  - "B doesn't start until A returns" via microtask draining.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetEnvWriteMutexForTests,
  withEnvWriteLock,
} from "../env-write-mutex.js";

afterEach(() => {
  __resetEnvWriteMutexForTests();
});

function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withEnvWriteLock", () => {
  it("serialises concurrent fn invocations in submission order", async () => {
    const events: string[] = [];
    const a = defer<void>();
    const b = defer<void>();
    const c = defer<void>();

    const op = (label: string, signal: Promise<void>) =>
      withEnvWriteLock(async () => {
        events.push(`${label}:start`);
        await signal;
        events.push(`${label}:end`);
        return label;
      });

    const ra = op("A", a.promise);
    const rb = op("B", b.promise);
    const rc = op("C", c.promise);

    // Resolve out-of-order. If serialisation breaks, B or C would
    // start before A finishes and the events array would interleave.
    c.resolve();
    b.resolve();
    a.resolve();

    const [vA, vB, vC] = await Promise.all([ra, rb, rc]);
    expect(vA).toBe("A");
    expect(vB).toBe("B");
    expect(vC).toBe("C");
    expect(events).toEqual([
      "A:start",
      "A:end",
      "B:start",
      "B:end",
      "C:start",
      "C:end",
    ]);
  });

  it("does not start the next op until the current one's fn returns", async () => {
    const events: string[] = [];
    const a = defer<void>();

    const ra = withEnvWriteLock(async () => {
      events.push("A:start");
      await a.promise;
      events.push("A:end");
    });
    const rb = withEnvWriteLock(async () => {
      events.push("B:start");
    });

    // Drain a generous number of microtasks; B must NOT have started.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(events).toEqual(["A:start"]);

    a.resolve();
    await Promise.all([ra, rb]);
    expect(events).toEqual(["A:start", "A:end", "B:start"]);
  });

  it("a failed op does NOT poison the chain - subsequent ops run", async () => {
    const fail = withEnvWriteLock(async () => {
      throw new Error("boom");
    });
    await expect(fail).rejects.toThrow(/boom/);

    const ok = await withEnvWriteLock(async () => "after-failure");
    expect(ok).toBe("after-failure");
  });

  it("each fn return value flows back to its own caller", async () => {
    const a = withEnvWriteLock(async () => 1);
    const b = withEnvWriteLock(async () => 2);
    const c = withEnvWriteLock(async () => 3);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(await c).toBe(3);
  });

  it("propagates rejections of the wrapped fn back to the caller", async () => {
    await expect(
      withEnvWriteLock(async () => {
        throw new TypeError("nope");
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("two writes do not lose fields when serialised through the mutex", async () => {
    // Simulates what concurrent IPC writes look like: each "writer"
    // reads a shared counter, modifies, writes back. Without the
    // mutex this races. With the mutex the final value is N.
    const N = 50;
    let counter = 0;
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        withEnvWriteLock(async () => {
          const local = counter;
          await Promise.resolve(); // simulate I/O
          counter = local + 1;
        }),
      );
    }
    await Promise.all(promises);
    expect(counter).toBe(N);
  });
});
