/**
 * Ownership loss is not a mission failure: another runner is authoritative
 * now, so the stale runner must exit without finalizing shared run state.
 */
export class RunnerLeaseLostError extends Error {
  readonly code = "RUNNER_LEASE_LOST";

  constructor(readonly sessionId: string) {
    super(`Runner lease lost for session ${sessionId}`);
    this.name = "RunnerLeaseLostError";
  }
}

export function isRunnerLeaseLostError(value: unknown): value is RunnerLeaseLostError {
  return value instanceof RunnerLeaseLostError
    || (
      typeof value === "object"
      && value !== null
      && "code" in value
      && value.code === "RUNNER_LEASE_LOST"
    );
}

export function getRunnerLeaseLostError(
  signal: AbortSignal | undefined,
): RunnerLeaseLostError | null {
  if (!signal?.aborted) return null;
  return isRunnerLeaseLostError(signal.reason)
    ? signal.reason
    : new RunnerLeaseLostError("unknown");
}

export function throwIfRunnerLeaseLost(signal: AbortSignal | undefined): void {
  const error = getRunnerLeaseLostError(signal);
  if (error !== null) throw error;
}
