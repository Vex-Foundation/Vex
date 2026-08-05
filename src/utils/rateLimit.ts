/**
 * Shared rate-limiting primitives.
 *
 * Both waits accept an optional `AbortSignal` so an operator Stop is not made
 * to sit out a quota wait. Without a signal the behaviour is unchanged.
 */

import { delay, throwIfAborted } from "./cancellation.js";

// --- Token bucket rate limiter ---

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(ratePerSec: number) {
    this.maxTokens = ratePerSec;
    this.tokens = ratePerSec;
    this.refillRate = ratePerSec / 1000;
    this.lastRefill = Date.now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await delay(waitMs, signal);
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// --- FIFO concurrency limiter ---

export class ConcurrencyLimiter {
  private inflight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  /** Waiters currently queued. Exposed so a leaked waiter is observable. */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Take a slot, queueing behind the current holders when the limiter is full.
   *
   * A queued waiter has no timeout, so an aborted one MUST leave the queue:
   * otherwise the abort strands a resolver that a later `release()` calls,
   * leaking the slot to a caller that is already gone.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        detach();
        resolve();
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        detach();
        reject(signal?.reason as Error);
      };
      const detach = (): void => signal?.removeEventListener("abort", onAbort);

      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.inflight++;
  }

  release(): void {
    this.inflight--;
    const next = this.queue.shift();
    if (next) next();
  }
}
