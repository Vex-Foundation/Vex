/**
 * Per-session in-memory serialization for the compact primitive.
 *
 * `executeCompactNow` (the deterministic forced-fallback path and the
 * runtime forced-fallback path) is single-flighted per `sessionId` so a
 * concurrent dispatch + wake-claim cannot observe a half-archived transcript.
 * This is a process-local mutex — single-process wake executor contract plus
 * the Phase II row lock (SELECT ... FOR UPDATE on `sessions`) covers the
 * cross-process case for current runtime topology.
 *
 * Lives under `engine/compact-jobs/` because the only consumer is the new
 * compact primitive; the legacy `engine/core/checkpoint/state.ts` was deleted
 * in the PR2 cutover.
 */

const compactInFlight = new Map<string, Promise<void>>();

export async function withCheckpointMutex<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = compactInFlight.get(sessionId) ?? Promise.resolve();

  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
  const chained = prev.then(() => current);
  compactInFlight.set(sessionId, chained);

  try {
    await prev;
    return await fn();
  } finally {
    resolveCurrent();
    // Tail cleanup — only remove if no later caller has chained behind us.
    if (compactInFlight.get(sessionId) === chained) {
      compactInFlight.delete(sessionId);
    }
  }
}

/** Test-only — clears the in-flight map between unit-test cases. */
export function resetCompactMutexForTests(): void {
  compactInFlight.clear();
}
