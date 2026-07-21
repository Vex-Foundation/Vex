/**
 * In-process wake signal for newly enqueued sync work.
 *
 * Persistence remains the source of truth: a missed signal is harmless because
 * the periodic executor still drains the queue. The signal only removes the
 * normal one-minute wait after a mutation.
 */

type SyncWakeListener = () => void;

const listeners = new Set<SyncWakeListener>();

export function requestSyncTick(): void {
  for (const listener of listeners) listener();
}

export function subscribeSyncTickWake(listener: SyncWakeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
