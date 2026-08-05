import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucket, ConcurrencyLimiter } from "@utils/rateLimit.js";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should allow immediate acquires within the rate limit", async () => {
    const bucket = new TokenBucket(3); // 3 per second
    // 3 tokens available initially
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // Should have consumed all tokens
  });

  it("should wait when tokens are exhausted", async () => {
    const bucket = new TokenBucket(1); // 1 per second
    await bucket.acquire(); // Consumes the only token

    let resolved = false;
    const p = bucket.acquire().then(() => { resolved = true; });

    // Not resolved yet — need to wait for refill
    expect(resolved).toBe(false);

    // Advance time by 1s to refill
    vi.advanceTimersByTime(1100);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("ConcurrencyLimiter", () => {
  it("should allow concurrent acquires up to max", async () => {
    const limiter = new ConcurrencyLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    // Both acquired immediately
  });

  it("should queue when max concurrent is reached", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // Takes the single slot

    let secondAcquired = false;
    const p = limiter.acquire().then(() => { secondAcquired = true; });

    // Should be queued
    // Yield to microtasks
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    // Release first
    limiter.release();
    await p;
    expect(secondAcquired).toBe(true);
  });

  it("should process queue in FIFO order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const order: number[] = [];
    const p1 = limiter.acquire().then(() => { order.push(1); });
    const p2 = limiter.acquire().then(() => { order.push(2); });

    limiter.release();
    await p1;
    limiter.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });
});

/**
 * Wave S1 (T7) — quota waits must not sit out an operator Stop, and an aborted
 * waiter must LEAVE the queue: a stranded resolver would hand a later
 * `release()` a slot to a caller that is already gone.
 */
describe("quota-wait cancellation", () => {
  it("rejects a TokenBucket wait when the signal aborts", async () => {
    const bucket = new TokenBucket(1);
    await bucket.acquire();

    const controller = new AbortController();
    const pending = bucket.acquire(controller.signal);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const bucket = new TokenBucket(1);
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.acquire(controller.signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });

  it("removes an aborted ConcurrencyLimiter waiter from the queue", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();
    expect(limiter.queueLength).toBe(0);

    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    expect(limiter.queueLength).toBe(1);

    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
    expect(limiter.queueLength).toBe(0);

    // The released slot goes to a live caller, not to the abandoned waiter.
    limiter.release();
    let acquired = false;
    await limiter.acquire().then(() => {
      acquired = true;
    });
    expect(acquired).toBe(true);
    expect(limiter.queueLength).toBe(0);
  });
});
