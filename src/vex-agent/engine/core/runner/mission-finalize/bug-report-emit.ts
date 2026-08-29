/**
 * Mission bug-report emission (phase 2 BUG-REPORTING, puzzle 03).
 *
 * The two mission failure surfaces that record a support entry both live
 * in the finalize family: terminal `system_error` and the recoverable
 * `paused_error` pause. Both emit through `emitBugReportSafe`, which is
 * fail-closed so a support-sink outage can never mask the real failure.
 *
 * Neither emitter runs when the run turned out to be terminal under an
 * operator Stop: the `runtimeStatus` it would report would be a false
 * statement about the row. That precedence decision belongs to the
 * calling arm; this module owns only the emission.
 */

import logger from "@utils/logger.js";

interface MissionBugReportRefs {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runId: string;
}

/**
 * Terminal `system_error` escalation record. `severity: "critical"` -
 * terminal `system_error` is a hard failure surface, so the mission state
 * is recorded.
 */
export async function emitMissionSystemErrorReport(
  refs: MissionBugReportRefs,
  description: string,
): Promise<void> {
  const { getBugReportSink } = await import(
    "../../../support/bug-report-registry.js"
  );
  const { emitBugReportSafe } = await import(
    "../../../../../lib/diagnostics/bug-report-sink.js"
  );
  await emitBugReportSafe(
    getBugReportSink(),
    {
      source: "agent",
      category: "mission_system_error",
      severity: "critical",
      title: "mission.system_error",
      description,
      refs: {
        sessionId: refs.sessionId,
        missionId: refs.missionId,
        missionRunId: refs.runId,
      },
      agentContext: {
        stopReason: "system_error",
        runtimeStatus: "failed",
      },
    },
    logger,
  );
}

/**
 * Recoverable `paused_error` record - the canonical recoverable-failure
 * surface, so support records carry the error class plus agent context.
 *
 * `context` itself is `z.record(z.string(), z.unknown())` (unbounded;
 * `bug-report-schema.ts`) - redaction happens later in the bug-report
 * service. The VALUE stored under `causeCode` here is shape-validated
 * (errno-shaped, own-property-read - see `mission-error-signal.ts`),
 * never raw message text beyond what already flows through
 * `description`.
 */
export async function emitMissionPausedErrorReport(
  refs: MissionBugReportRefs,
  input: {
    readonly errorClass: string;
    readonly errorMessage: string;
    readonly causeCode: string | null;
  },
): Promise<void> {
  const { getBugReportSink } = await import(
    "../../../support/bug-report-registry.js"
  );
  const { emitBugReportSafe } = await import(
    "../../../../../lib/diagnostics/bug-report-sink.js"
  );
  await emitBugReportSafe(
    getBugReportSink(),
    {
      source: "agent",
      category: "mission_paused_error",
      severity: "error",
      title: `mission.${input.errorClass}`,
      description: input.errorMessage,
      refs: {
        sessionId: refs.sessionId,
        missionId: refs.missionId,
        missionRunId: refs.runId,
      },
      context: { causeCode: input.causeCode },
      agentContext: {
        stopReason: "provider_error",
        runtimeStatus: "paused_error",
      },
    },
    logger,
  );
}
