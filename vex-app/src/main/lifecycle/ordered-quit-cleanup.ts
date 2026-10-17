/**
 * Ordered quit cleanup — sequence a long-lived worker's drain BEFORE the
 * local runtime stop and the secret sweep.
 *
 * `globalCleanup.runAll()` invokes its tasks CONCURRENTLY
 * (`Promise.allSettled`, see `cleanup-registry.ts`). Registering a worker's
 * `stop()` as an independent task would race the quit cleanup, which stops
 * the local runtime's Postgres — pulling the DB out from under an in-flight
 * Track-2 job the worker is still draining.
 *
 * Composing the two into ONE ordered task guarantees the worker drains
 * first. The `finally` keeps the runtime stop and the secret sweep running
 * even if the worker's stop throws, so a stuck worker can never block them.
 */
export function makeOrderedQuitCleanup(
  stopWorker: () => Promise<void>,
  quitCleanup: () => Promise<void>,
): () => Promise<void> {
  return async (): Promise<void> => {
    try {
      await stopWorker();
    } finally {
      await quitCleanup();
    }
  };
}
