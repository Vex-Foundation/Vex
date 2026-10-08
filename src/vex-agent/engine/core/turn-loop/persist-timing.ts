/**
 * Transcript-persistence timing for one `runTurnLoop` invocation (Kairos
 * Phase 1, runtime measurement).
 *
 * WHY A SCOPE, NOT A PARAMETER. The awaited transcript writes a turn makes sit
 * in `saveAssistantMessage` and in the tool-result loop of
 * `persistBatchTranscript`, which are reached from the text path, the stop
 * path, the tool batch and every prepared-action follow-up branch. Threading
 * an accumulator through each of those call sites would widen half a dozen
 * signatures for a number nothing reads at runtime. Instead the turn loop
 * opens a scope and the two write sites add their own elapsed time to it -
 * the same `AsyncLocalStorage` idiom `nonce-reservation-scope.ts` uses.
 *
 * Measurement only: `timePersist` awaits exactly the promise it is given and
 * returns or rethrows its result unchanged, so write ordering and error
 * handling are those of the caller. Outside a turn loop there is no scope and
 * the write runs untimed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Total monotonic ms spent awaiting transcript writes in this scope. */
export interface PersistTimingAccumulator {
  persistMs: number;
}

const persistScope = new AsyncLocalStorage<PersistTimingAccumulator>();

/** Run `body` with `accumulator` collecting every timed write inside it. */
export function withPersistTiming<T>(
  accumulator: PersistTimingAccumulator,
  body: () => Promise<T>,
): Promise<T> {
  return persistScope.run(accumulator, body);
}

/**
 * Await one transcript write, adding its duration to the enclosing turn's
 * accumulator (if any). The time is added whether the write resolves or
 * throws - a slow failing write is still time the turn spent.
 */
export async function timePersist<T>(write: () => Promise<T>): Promise<T> {
  const accumulator = persistScope.getStore();
  if (accumulator === undefined) return write();
  const startedAtMs = performance.now();
  try {
    return await write();
  } finally {
    accumulator.persistMs += performance.now() - startedAtMs;
  }
}
