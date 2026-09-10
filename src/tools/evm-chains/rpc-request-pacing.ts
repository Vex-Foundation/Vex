/** FIFO admission by quota group. Cancelled waiters consume no future slot. */
interface Waiter {
  readonly spacingMs: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abort: () => void;
}
interface Lane {
  nextStart: number;
  readonly waiting: Set<Waiter>;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcRequestPacer {
  private readonly lanes = new Map<string, Lane>();

  wait(key: string, spacingMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { nextStart: 0, waiting: new Set() };
      this.lanes.set(key, lane);
    }
    const current = lane;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { spacingMs, resolve, reject, signal, abort: () => {
        current.waiting.delete(waiter);
        signal?.removeEventListener("abort", waiter.abort);
        reject(signal?.reason);
        this.pump(key, current);
      } };
      current.waiting.add(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.pump(key, current);
    });
  }

  /** Reset is test-owned; every outstanding promise is explicitly rejected. */
  reset(): void {
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer);
      for (const waiter of lane.waiting) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.reject(new DOMException("RPC pacing reset", "AbortError"));
      }
    }
    this.lanes.clear();
  }

  private pump(key: string, lane: Lane): void {
    clearTimeout(lane.timer);
    lane.timer = undefined;
    const delay = lane.nextStart - performance.now();
    if (delay > 0) {
      // One timer per group, including its final cooldown. Cancelled backlog
      // cannot extend this deadline beyond the last real admission's spacing.
      lane.timer = setTimeout(() => this.pump(key, lane), delay);
      return;
    }
    const waiter = lane.waiting.values().next().value;
    if (!waiter) {
      this.lanes.delete(key);
      return;
    }
    lane.waiting.delete(waiter);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    lane.nextStart = performance.now() + waiter.spacingMs;
    waiter.resolve();
    this.pump(key, lane);
  }
}
