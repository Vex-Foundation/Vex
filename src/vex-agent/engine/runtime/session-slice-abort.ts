/**
 * In-process cancellation for SESSION-SCOPED slices — the wake-driven
 * continuation of a Full-Autonomous agent session.
 *
 * ## Why this exists separately from `runner/abort.ts`
 *
 * That registry is keyed by `runId`, and every mechanism hanging off it —
 * `signalMissionRunAbortLocal`, the `stop_terminal` control request, the
 * iteration-boundary observer — is run-scoped. A Full-Autonomous AGENT session
 * has no run row, so none of it reaches a wake-driven slice.
 *
 * That left the operator with nothing. An interactive chat turn is at least
 * stoppable because the IPC caller owns the "stop generating" AbortSignal and
 * passes it in; a slice started by the wake executor has NO request-scoped
 * caller at all, so without this registry a background slice ran to completion
 * no matter what the operator pressed. Half of the owner's contract is that
 * autonomous work is not interrupted; the other half is that the operator can
 * always stop it. This is the second half.
 *
 * ## Contract
 *
 * Same shape and the same limits as the run-scoped registry, deliberately:
 *   - per-PROCESS. Electron main hosts the engine, so the IPC layer can reach
 *     it; a slice running in another process is not reachable and the caller
 *     must fall back to the durable path.
 *   - writes NOTHING. Firing a signal is not a state transition. The durable
 *     record of an operator stop is the caller's responsibility and must
 *     already be persisted, so a crash between the two leaves the durable
 *     truth intact.
 *   - re-entrant register: a second call for a live session returns the SAME
 *     controller, so a concurrent aborter and the slice share one signal.
 *
 * The slice threads the signal into BOTH turn-loop positions (boundary +
 * inference), which is what makes a Stop land at the next iteration, inside a
 * tool batch, and mid-provider-call — never mid-dispatch, so a signing or
 * broadcast call in flight still completes.
 */

const sessionSliceControllers = new Map<string, AbortController>();

/**
 * Obtain the controller for a session slice about to run. The caller MUST pass
 * the signal to `runTurnLoop` and MUST call `unregister` in a `finally`.
 */
export function registerSessionSliceAbortController(
  sessionId: string,
): AbortController {
  let controller = sessionSliceControllers.get(sessionId);
  if (controller === undefined) {
    controller = new AbortController();
    sessionSliceControllers.set(sessionId, controller);
  }
  return controller;
}

/** MUST be called in a `finally` once the slice returns. */
export function unregisterSessionSliceAbortController(sessionId: string): void {
  sessionSliceControllers.delete(sessionId);
}

/** Whether THIS process is currently running a slice for this session. */
export function hasSessionSliceAbortController(sessionId: string): boolean {
  return sessionSliceControllers.has(sessionId);
}

/**
 * Fire the in-process signal for a session slice if this process holds one.
 * Returns `false` when no slice is registered here — the caller then relies on
 * the durable path (the pre-slice gate refuses to start a stopped session).
 */
export function abortSessionSliceLocal(sessionId: string): boolean {
  const controller = sessionSliceControllers.get(sessionId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}
