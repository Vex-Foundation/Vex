/**
 * `vex.runtime.requestPause` — enqueue-only audit + `pause_after_step`
 * row.
 *
 * **IPC MUST NOT apply the transition directly.** Clearing the
 * request before the runner sees it would let the active turn-loop
 * continue and overwrite the status (codex puzzle-03 review blocker
 * #1). The runner observes pending pause requests at its
 * iteration-boundary checkpoint in `turn-loop.ts` and applies the
 * transition there.
 *
 * `status === 'running'` alone does NOT imply a live runner — the lease
 * can be expired/released (parked between autonomous mission slices). In
 * that case a `pause_after_step` request would be enqueued but never
 * observed (same bug class as issue #12's stop dead-end), so it is
 * refused up front with `already_parked` instead — the run is already
 * effectively idle; the caller should use Resume/Retry to reclaim it or
 * Stop to end it.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  runtimeRequestInputSchema,
  runtimeRequestPauseResultSchema,
  type RuntimeRequestPauseResult,
} from "@shared/schemas/runtime.js";
import { getActiveRunForSession } from "../../database/mission-runs-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "./_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "./_emit-control-state.js";
import { classifyRunLeaseState } from "../_shared/lease-state.js";

export function registerRuntimeRequestPauseHandler(): () => void {
  return registerHandler({
    channel: CH.runtime.requestPause,
    domain: "runtime",
    inputSchema: runtimeRequestInputSchema,
    outputSchema: runtimeRequestPauseResultSchema,
    handle: async (input, ctx): Promise<Result<RuntimeRequestPauseResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const state = await getActiveRunForSession(
          input.sessionId,
          ctx.requestId,
        );
        if (!state.ok) return state;
        if (!state.data.hasActiveRun) {
          return ok({ outcome: "no_active_run" });
        }
        const status = state.data.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "stopped" ||
          status === "cancelled"
        ) {
          return ok({ outcome: "terminal", status });
        }
        if (
          status === "paused_user" ||
          status === "paused_approval" ||
          status === "paused_wake" ||
          status === "paused_error" ||
          // C3b — a form-parked run is already parked; enqueueing a pause
          // request would sit pending forever, exactly like the other arms.
          status === "paused_user_form"
        ) {
          // Already paused — return state without enqueueing a new
          // duplicate audit row. The active control plane (whoever
          // resumes next) will be the one to honor a fresh request.
          return ok({ outcome: "already_paused", status });
        }
        if (classifyRunLeaseState(status, state.data.leaseActive) === "dead") {
          // Dead lease: no runner would ever observe an enqueued pause
          // request. Refuse rather than enqueue an unobservable request
          // that sits pending forever.
          return ok({ outcome: "already_parked" });
        }
        // Running with a live lease — enqueue the request and return.
        const { enqueueRequest, getPendingForSession } = await import(
          "@vex-agent/db/repos/runtime-control-requests.js"
        );
        const pending = await getPendingForSession(input.sessionId);
        const existingPause = pending.find(
          (p) => p.kind === "pause_after_step",
        );
        if (existingPause) {
          return ok({ outcome: "already_pending", requestId: existingPause.id });
        }
        const request = await enqueueRequest({
          sessionId: input.sessionId,
          missionRunId: state.data.missionRunId,
          kind: "pause_after_step",
          requestedBy: "user",
          correlationId: ctx.requestId,
        });
        await emitControlStateAfterChange(input.sessionId, ctx.requestId);
        return ok({ outcome: "queued", requestId: request.id });
      } catch (cause) {
        log.warn(
          `[ipc:vex:runtime:requestPause] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
