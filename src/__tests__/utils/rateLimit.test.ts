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
