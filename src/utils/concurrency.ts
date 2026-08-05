/**
 * Bounded-concurrency iteration — the module that owns "run these N
 * independent async reads, but never more than K at once".
 *
 * WHY A SHARED MODULE. This started as a private helper inside the Khalani
 * balance scan. The local-chain scan in `wallet_balances` needed exactly the
 * same shape, and a second copy of a concurrency limiter is the kind of
 * duplicated logic that drifts silently — one copy gets a fix, the other keeps
 * the bug. Promoted rather than copied.
 *
 * WHY BOUNDED AND NOT `Promise.all`. Every caller here fans out to RPC or HTTP
 * providers that rate-limit. Unbounded parallelism turns a latency win into a
 * 429 storm, which is slower than the serial version it replaced.
 *
 * Import direction stays one-way (`tools → utils`); nothing here imports a tool.
 */

/**
 * Run `worker` over `values` with at most `concurrency` in flight.
 *
 * The worker returns nothing on purpose: callers that need results write them
 * into a slot they own, keyed by `index`, which keeps the output order
 * deterministic and independent of completion order. A worker that rejects
 * rejects the whole call — callers that want per-item softness (the balance
 * scans do) catch inside the worker.
 */
export async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      if (value !== undefined) {
        await worker(value, currentIndex);
      }
    }
  });

  await Promise.all(workers);
}
