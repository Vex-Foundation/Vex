/**
 * Shared stop-dispatch primitive used by both
 * `runtime.requestStop` and `mission.stop` IPC handlers.
 *
 * Returns the discriminated union compatible with both
 * `runtimeRequestStopResultSchema` and `missionStopResultSchema`.
 *
 * A `running` run with a LIVE lease is stopped GRACEFULLY: the handler
 * enqueues a run-scoped `stop_terminal` audit row — through the engine's
 * `enqueueOperatorStopRequest`, which writes it under the session control
 * lock so the insert serializes against the approval enqueue and the approved
 * money-path dispatch — that the live runner observes at its next iteration
 * boundary (codex puzzle-03: IPC must not apply state to a live loop
 * directly), and THEN fires the in-process
 * `AbortController` best-effort. Order matters: the durable request is
 * written first, so a crash between the two still leaves the stop
 * recoverable. Without the second step the request alone would only be seen
 * at the next boundary, which can be a whole provider call away — the Stop
 * button would not cancel an in-flight generation. The abort signal writes
 * nothing; the loop unwinds and runs the same shared stop transaction the
 * observer would have run. Everything else — a PAUSED run (approval/wake/error/user)
 * OR a `running` run whose lease is NOT active (parked between autonomous
 * slices, or the process that held it exited) — has NO runner to observe
 * that request, so it is aborted directly via `abortActiveMissionForSession`
 * (the engine finalizes it to `cancelled` and rejects pending approvals +
 * cancels wakes). `status === 'running'` alone does NOT imply a live
 * runner — see `classifyRunLeaseState`; without this check a dead-lease
 * `running` run strands the stop request forever (issue #12).
 */

import { ok, err, type Result } from "@shared/ipc/result.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { getActiveRunForSession } from "../../database/mission-runs-db.js";
import { log } from "../../logger/index.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";
import { classifyRunLeaseState } from "./lease-state.js";

export interface StopFlowInput {
  readonly sessionId: string;
}

export interface StopFlowContext {
  readonly requestId: string;
  readonly channelLabel: string;
}

export type StopFlowResult =
  | { readonly outcome: "queued"; readonly requestId: string }
  /**
   * A paused run was aborted directly. The engine finalizes it to the
   * canonical operator-stop terminal state: run `stopped` / `user_stopped`,
   * parent mission `cancelled`.
   */
  | { readonly outcome: "stopped" }
  | {
    readonly outcome: "already_terminal";
    readonly status: MissionRunStatus;
  }
  | { readonly outcome: "no_active_run" };

/**
 * Fire the engine's in-process `AbortController` for this run, if one is
 * registered in THIS process (Electron main hosts the engine, so it usually
 * is). Best-effort by construction: the durable `stop_terminal` request is
 * already committed, so a failure here only costs latency — the runner still
 * observes the request at its next iteration boundary. Never throws.
 */
async function signalLocalAbortBestEffort(
  missionRunId: string | null,
  ctx: StopFlowContext,
): Promise<void> {
  if (missionRunId === null) return;
  try {
    const { signalMissionRunAbortLocal } = await import(
      "@vex-agent/engine/index.js"
    );
    const signalled = signalMissionRunAbortLocal(missionRunId);
    log.info(
      `[ipc:${ctx.channelLabel}] local abort signalled=${signalled} correlationId=${ctx.requestId}`,
    );
  } catch (cause) {
    log.warn(
      `[ipc:${ctx.channelLabel}] local abort signal failed correlationId=${ctx.requestId}`,
      cause,
    );
  }
}

export async function runStopDispatch(
  input: StopFlowInput,
  ctx: StopFlowContext,
): Promise<Result<StopFlowResult>> {
  const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
  if (!dbUrlOutcome.ok) return dbUrlOutcome;
  try {
    const state = await getActiveRunForSession(input.sessionId);
    if (!state.ok) return state;
    if (!state.data.hasActiveRun) {
      return ok({ outcome: "no_active_run" });
    }
    const status = state.data.status;
    if (
      status === "completed"
      || status === "failed"
      || status === "stopped"
      || status === "cancelled"
    ) {
      return ok({ outcome: "already_terminal", status });
    }
    // `hasActiveRun` is derived from a real row, so the id is non-null here in
    // practice; the test narrows the type for the run-scoped engine call below
    // instead of asserting it. A null id falls through to the direct-abort
    // path, which is the correct handling for "no run to queue against".
    const missionRunId = state.data.missionRunId;
    if (
      missionRunId !== null
      && classifyRunLeaseState(status, state.data.leaseActive) === "live"
    ) {
      // Graceful path — ONLY when a live runner (active lease) is present:
      // it observes this queued stop_terminal request at its next iteration
      // boundary and finalizes the run.
      //
      // The insert goes through the engine's operator-stop boundary, not the
      // bare repo, so it happens under the session control lock. That is what
      // makes the request an ordering event: an approval enqueue or an
      // approved money-path dispatch that passes its own gate is guaranteed to
      // have either seen this row or committed before it existed. Run-scoped,
      // so a stale stop can never terminate a LATER run.
      const { enqueueOperatorStopRequest } = await import(
        "@vex-agent/engine/runtime/lease-and-status.js"
      );
      const enqueued = await enqueueOperatorStopRequest({
        sessionId: input.sessionId,
        missionRunId,
        correlationId: ctx.requestId,
      });
      if (enqueued.outcome === "run_not_found") {
        return ok({ outcome: "no_active_run" });
      }
      if (enqueued.outcome === "already_terminal") {
        // The run went terminal between the read above and the locked insert.
        // Queueing there would strand a request nobody will ever observe.
        await emitControlStateAfterChange(input.sessionId, ctx.requestId);
        return ok({ outcome: "already_terminal", status: enqueued.runStatus });
      }
      await signalLocalAbortBestEffort(missionRunId, ctx);
      await emitControlStateAfterChange(input.sessionId, ctx.requestId);
      return ok({ outcome: "queued", requestId: enqueued.requestId });
    }
    // No live runner is observing — either a paused run (approval/wake/
    // error/user) OR a `running` run whose lease is not active (out-of-
    // process / parked). A queued stop would never be applied, so abort
    // directly: the engine finalizes the run to `cancelled` and rejects
    // pending approvals + cancels wakes (`abortMissionRun` already handles
    // out-of-process running).
    const { abortActiveMissionForSession } = await import(
      "@vex-agent/engine/index.js"
    );
    const aborted = await abortActiveMissionForSession(input.sessionId);
    await emitControlStateAfterChange(input.sessionId, ctx.requestId);
    // null = the run vanished mid-flight; `aborted:false` = it was already
    // terminal by the time we aborted (race). Neither stopped a live paused
    // run, so report nothing-to-stop rather than a misleading `stopped`.
    if (aborted === null || !aborted.aborted) {
      return ok({ outcome: "no_active_run" });
    }
    return ok({ outcome: "stopped" });
  } catch (cause) {
    log.warn(
      `[ipc:${ctx.channelLabel}] failed correlationId=${ctx.requestId}`,
      cause,
    );
    return err(controlFailedError(ctx.requestId));
  }
}
