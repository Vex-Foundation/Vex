/**
 * Shared rate-limiting primitives.
 */

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

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise(resolve => setTimeout(resolve, waitMs));
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

  async acquire(): Promise<void> {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.inflight++;
  }

  release(): void {
    this.inflight--;
    const next = this.queue.shift();
    if (next) next();
  }
}
