/**
 * Background dispatch helper for `mission.start` and `mission.recover`.
 *
 * Both commands prepare a durable `mission_runs` row synchronously
 * (`prepareMissionStart` / `prepareMissionRecover` open the lease +
 * commit the atomic gate before the IPC handler returns
 * `dispatched`). The actual turn loop runs in the background; this
 * helper wraps the long-running call with:
 *
 *   - structured log on continuation failure
 *   - bug-report sink emit so observability picks up provider-side
 *     failures even though the lease release / status finalize lives
 *     inside the engine helper (`runPreparedMission{Start,Recover}`
 *     handle their own `finalizeMissionRunError`).
 *   - an `engineErrorBus` emit so the FAILURE REACHES THE USER. This was
 *     the single largest silent-failure surface in the app: five call
 *     sites (mission start, mission recover, approval approve, approval
 *     reject, and the TTL auto-reject sweep) all funnel through here, and
 *     until now a throw produced a log line and nothing else — the window
 *     simply sat there. Only bounded codes are emitted; the exception
 *     message stays in the log and the bug report.
 *
 * Per puzzle 04 phase 6 codex review #3: no dedicated audit table for
 * mission start/recover — the `mission_runs` row IS the durable
 * dispatch record. This helper provides observability without changing
 * the run lifecycle.
 */

import { emitEngineError, errorDetailOf } from "@vex-agent/engine/runtime/error-bus.js";
import type { EngineErrorScope } from "@vex-agent/engine/runtime/error-bus.js";
import { readMissionErrorSignal } from "@vex-agent/engine/core/runner/mission-error-signal.js";
import { log } from "../../logger/index.js";

export interface DispatchRefs {
  readonly sessionId: string;
  readonly missionId?: string;
  readonly missionRunId?: string;
  readonly correlationId: string;
  readonly channelLabel: string;
  /**
   * Which runtime surface failed, for the renderer's framing. Required, not
   * derived from `channelLabel`: an approval resume and a mission start are
   * different things to a user, and parsing a log label to decide what to tell
   * them would be a string-matching contract nobody would maintain.
   */
  readonly scope: EngineErrorScope;
}

/**
 * Run a prepared engine continuation (e.g. `runPreparedMissionStart`,
 * `runPreparedMissionRecover`) in the background and emit a bug report
 * on failure. The continuation owns its own lease release.
 */
export function dispatchPreparedMission(
  continuation: () => Promise<unknown>,
  refs: DispatchRefs,
): void {
  void (async () => {
    try {
      await continuation();
    } catch (cause) {
      log.warn(
        `[ipc:${refs.channelLabel}] continuation failed ` +
          `sessionId=${refs.sessionId} runId=${refs.missionRunId ?? "<unknown>"} ` +
          `correlationId=${refs.correlationId}`,
        cause,
      );
      // Bounded push FIRST: it needs no I/O and must not be lost if the
      // bug-report sink below is unreachable. `readMissionErrorSignal` reads
      // own-properties only and never walks `.cause`; the raw message rides as
      // `detail` and is sanitized at the error bridge (decree 2026-08-02).
      try {
        const signal = readMissionErrorSignal(cause);
        emitEngineError({
          sessionId: refs.sessionId,
          missionRunId: refs.missionRunId ?? null,
          scope: refs.scope,
          errorType: signal.errorType,
          errorClass: signal.errorClass,
          statusCode: signal.status,
          causeCode: signal.causeCode,
          retryAfterSeconds: signal.retryAfterSeconds,
          detail: errorDetailOf(cause),
          correlationId: refs.correlationId,
        });
      } catch (emitErr) {
        log.warn(`[ipc:${refs.channelLabel}] engine error emit failed`, emitErr);
      }

      try {
        const { getBugReportSink } = await import(
          "@vex-agent/engine/support/bug-report-registry.js"
        );
        const { emitBugReportSafe } = await import(
          "@vex-lib/diagnostics/bug-report-sink.js"
        );
        await emitBugReportSafe(
          getBugReportSink(),
          {
            source: "agent",
            category: "mission_system_error",
            severity: "error",
            title: `${refs.channelLabel}.continuation_failed`,
            description:
              cause instanceof Error ? cause.message : String(cause),
            refs: {
              sessionId: refs.sessionId,
              ...(refs.missionId !== undefined
                ? { missionId: refs.missionId }
                : {}),
              ...(refs.missionRunId !== undefined
                ? { missionRunId: refs.missionRunId }
                : {}),
              correlationId: refs.correlationId,
            },
            agentContext: { runtimeStatus: "running" },
          },
          log,
        );
      } catch {
        // Bug-report sink itself unreachable — the log above is the
        // observability fallback.
      }
    }
  })();
}
