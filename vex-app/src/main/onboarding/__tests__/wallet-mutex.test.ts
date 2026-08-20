/**
 * Tests for the M8 global wallet write mutex (codex turn 8 RED #2,
 * codex turn 9 STILL-OPEN coverage gap).
 *
 * Verifies:
 *  - Concurrent ops execute in submission order (no interleaving).
 *  - A failed op does not poison the chain — subsequent ops still run.
 *  - Each call resolves with its own fn return value.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetWalletMutexForTests,
  withWalletLock,
} from "../wallet-mutex.js";

afterEach(() => {
  __resetWalletMutexForTests();
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

describe("withWalletLock", () => {
  it("serialises concurrent fn invocations in submission order", async () => {
    const events: string[] = [];
    const a = defer<void>();
    const b = defer<void>();
    const c = defer<void>();

    const op = (label: string, signal: Promise<void>) =>
      withWalletLock(async () => {
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
    // Strict serialisation: A start → A end → B start → B end → C start → C end.
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

    const ra = withWalletLock(async () => {
      events.push("A:start");
      await a.promise;
      events.push("A:end");
    });
    const rb = withWalletLock(async () => {
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
    const fail = withWalletLock(async () => {
      throw new Error("boom");
    });
    await expect(fail).rejects.toThrow(/boom/);

    const ok = await withWalletLock(async () => "after-failure");
    expect(ok).toBe("after-failure");
  });

  it("each fn return value flows back to its own caller", async () => {
    const a = withWalletLock(async () => 1);
    const b = withWalletLock(async () => 2);
    const c = withWalletLock(async () => 3);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(await c).toBe(3);
  });

  it("propagates rejections of the wrapped fn back to the caller", async () => {
    await expect(
      withWalletLock(async () => {
        throw new TypeError("nope");
      })
    ).rejects.toBeInstanceOf(TypeError);
  });
});
