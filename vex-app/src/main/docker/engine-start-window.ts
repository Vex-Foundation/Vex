/**
 * Owner of the bounded "the engine is coming up" window.
 *
 * There is NO documented Docker model that distinguishes "installed but not
 * started" from "starting" from "running", and nothing documented about when
 * the endpoint appears relative to readiness. So `engine_starting` is NOT
 * inferred from any probe. It exists only inside a bounded window after Vex
 * itself attempted a start, which is the one moment we can honestly claim
 * the engine is expected to be coming up. Outside that window a
 * non-answering engine is reported as `engine_stopped`.
 *
 * The window is deliberately generous: a starting daemon needs a far larger
 * budget than a steady-state one, and Docker Desktop routinely needs tens of
 * seconds before it answers.
 */

export const ENGINE_START_WINDOW_MS = 150_000;

let lastStartAttemptAt: number | null = null;

/** Called by the start action when Vex actually launched Docker. */
export function markDockerEngineStartAttempt(now: number = Date.now()): void {
  lastStartAttemptAt = now;
}

export function isWithinEngineStartWindow(now: number = Date.now()): boolean {
  if (lastStartAttemptAt === null) return false;
  if (now - lastStartAttemptAt >= ENGINE_START_WINDOW_MS) {
    lastStartAttemptAt = null;
    return false;
  }
  return true;
}

/** Closed as soon as the engine answers, and by tests between cases. */
export function clearDockerEngineStartWindow(): void {
  lastStartAttemptAt = null;
}
