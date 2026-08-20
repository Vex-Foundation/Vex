import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";

import { emitEngineError, errorDetailOf } from "@vex-agent/engine/runtime/error-bus.js";
import { readMissionErrorSignal } from "@vex-agent/engine/core/runner/mission-error-signal.js";

import type { WakeDeps } from "./deps.js";
import { handleClaimed } from "./claimed.js";

// ── Types ──────────────────────────────────────────────────────────

export type ClaimedWakeOutcome =
  | { kind: "resumed"; runId: string }
  | { kind: "agent_session_continued"; sessionId: string }
  /**
   * The session lease was held by unrelated work. The SAME pending row stays
   * pending with a pushed-out `due_at` and incremented attempt metadata —
   * nothing was consumed and nothing was lost. `attempt` is telemetry only; the
   * retry is unbounded by design and only the DELAY is bounded.
   */
  | {
      kind: "deferred_lease_busy";
      sessionId: string;
      attempt: number;
      dueAt: string;
    }
  | { kind: "skipped_stale_status"; currentStatus: string }
  | { kind: "skipped_claim_lost" }
  | { kind: "skipped_mission_run_missing" }
  | { kind: "error"; message: string };

export interface ClaimedWake {
  wake: LoopWakeRequest;
  outcome: ClaimedWakeOutcome;
}

// ── Pure tick ──────────────────────────────────────────────────────

/**
 * Run a single executor pass. Returns every row this pass acted on with its
 * outcome so callers (scheduler loop, tests, health endpoints) can observe what
 * the executor actually did.
 *
 * TWO reads, because the two wake shapes are claimed differently:
 *
 *   - MISSION-SCOPED rows are consumed by the batch `claimDue`, whose
 *     `FOR UPDATE SKIP LOCKED` exactly-once contract is unchanged;
 *   - SESSION-SCOPED rows are only LISTED here. Each is then claimed atomically
 *     under the session control lock (`claim-session-wake.ts`), which is why
 *     this read must be non-destructive: the session identity has to be known
 *     before the per-session lock can be taken.
 *
 * A listed candidate is not a claim. Every one of them is revalidated under the
 * lock, so a row cancelled by an operator Stop between the two simply yields
 * `skipped_claim_lost`.
 */
export async function tick(
  now: Date,
  limit: number,
  deps: WakeDeps,
): Promise<ClaimedWake[]> {
  // Pre-claim provider/config gate. `claimDue` is destructive
  // (pending→consumed) and the resume below needs the inference provider, so
  // skip the entire pass (no row consumed) when provider config is absent.
  if (!deps.isProviderReady()) return [];

  const claimed = [
    ...await deps.claimDue(now, limit),
    ...await deps.listDueSessionWakes(now, limit),
  ];
  const results: ClaimedWake[] = [];

  for (const wake of claimed) {
    try {
      const outcome = await handleClaimed(wake, deps, now);
      results.push({ wake, outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("wake.executor.handle_failed", {
        wakeId: wake.id,
        sessionId: wake.sessionId,
        missionRunId: wake.missionRunId,
        error: message,
      });
      // Bounded push FIRST — it needs no I/O and must not be lost if the
      // support DB behind the bug-report sink below is unreachable. Before
      // this, a failed wake tick was a log line and nothing else: the user saw
      // a scheduled continuation simply never happen.
      //
      // ONE emit site covers the whole executor. `handleClaimed` and the
      // agent-session continuation path neither catch nor rethrow, so every
      // failure in either arrives here.
      //
      // `readMissionErrorSignal` reads own-properties only and never walks
      // `.cause`; the raw message rides separately as `detail` and is
      // sanitized at the main-side bridge (owner decree 2026-08-02).
      try {
        const signal = readMissionErrorSignal(err);
        emitEngineError({
          sessionId: wake.sessionId,
          missionRunId: wake.missionRunId,
          scope: "wake",
          errorType: signal.errorType,
          errorClass: signal.errorClass,
          statusCode: signal.status,
          causeCode: signal.causeCode,
          retryAfterSeconds: signal.retryAfterSeconds,
          detail: errorDetailOf(err),
        });
      } catch (emitErr) {
        logger.warn("wake.executor.error_emit_failed", {
          wakeId: wake.id,
          errorClass:
            emitErr instanceof Error ? emitErr.constructor.name : typeof emitErr,
        });
      }

      // Phase 2 BUG-REPORTING emit (puzzle 03): wake resume failures
      // surface as `wake_resume_failure` automatic reports. Fail-closed
      // through `emitBugReportSafe` — a support DB outage cannot break
      // the wake executor.
      const { getBugReportSink } = await import(
        "../../support/bug-report-registry.js"
      );
      const { emitBugReportSafe } = await import(
        "../../../../lib/diagnostics/bug-report-sink.js"
      );
      await emitBugReportSafe(
        getBugReportSink(),
        {
          source: "agent",
          category: "wake_resume_failure",
          severity: "error",
          title: "wake.executor.handle_failed",
          description: message,
          refs: {
            sessionId: wake.sessionId,
            // A session-scoped agent continuation has no run. `refs` takes an
            // absent ref as `undefined`, so omit the key rather than asserting
            // a null run id the schema does not model.
            ...(wake.missionRunId !== null
              ? { missionRunId: wake.missionRunId }
              : {}),
          },
          agentContext: {
            stopReason: "system_error",
          },
        },
        logger,
      );
      results.push({ wake, outcome: { kind: "error", message } });
    }
  }

  return results;
}
