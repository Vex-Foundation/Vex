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

/**
 * Stop a session that has no mission run — a Full-Autonomous agent chat.
 *
 * Same two-step shape as the live-lease mission branch, and the same ordering
 * for the same reason:
 *
 *   1. DURABLE FIRST. `enqueueSessionStopRequest` writes a session-scoped
 *      `stop_terminal` (a `stop_terminal` row with a NULL `mission_run_id`) and
 *      cancels the pending continuation wake in ONE transaction under the
 *      session control lock. That single transaction is what stops a Stop from
 *      racing the wake executor into starting a fresh slice: either the wake is
 *      cancelled before it is claimed, or the continuation scheduler's own gate
 *      — which takes the same lock — sees this row and refuses to schedule.
 *
 *   2. IN-PROCESS SECOND, best-effort. `abortSessionSliceLocal` fires the
 *      AbortController of a slice already airborne in THIS process, so an
 *      in-flight provider call is cancelled instead of running to completion.
 *      A JavaScript signal is not a database effect and is NOT serialized by
 *      the advisory lock — it is a latency optimisation on top of the durable
 *      truth, never the truth itself. A crash between the two steps still
 *      leaves the stop recoverable, because step 1 already committed; a slice
 *      that misses the signal still refuses to continue at its next gate.
 *
 * Reported as `queued` when a durable request was retained. The engine decides
 * that in the SAME transaction, from durable state: a request nothing will ever
 * observe is not harmless — it sits open and refuses the session's next,
 * unrelated work. So when the transaction proves no live lease and no
 * incomplete approval lifecycle remain, it applies the stop and retains
 * NOTHING, and this reports `stopped` rather than promising an observation that
 * will never happen.
 *
 * It can also come back with the engine-internal `active_run_exists`: the
 * target scope was revalidated under the lock and a mission run was found that
 * the pre-transaction read had missed. See the reroute below.
 */
async function stopChatSession(
  sessionId: string,
  ctx: StopFlowContext,
): Promise<Result<StopFlowResult>> {
  const { enqueueSessionStopRequest } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const enqueued = await enqueueSessionStopRequest({
    sessionId,
    correlationId: ctx.requestId,
  });

  // TARGET-SCOPE REVALIDATION (one-time reroute). The engine re-read the run
  // under the session control lock and found one that was not visible to the
  // read this dispatch chose its scope from. A session-scoped request would
  // have been invisible to the run-scoped gate (which matches on
  // `mission_run_id`), so the engine wrote NOTHING and handed the run back.
  // Re-run the RUN-scoped path for it exactly once: `stopMissionRun` re-locks
  // the run in its own transaction and reports `already_terminal` if it moved
  // in between, which is the terminating condition — there is no retry loop.
  if (enqueued.outcome === "active_run_exists") {
    log.info(
      `[ipc:${ctx.channelLabel}] session stop rerouted to run `
      + `${enqueued.missionRunId} correlationId=${ctx.requestId}`,
    );
    const rechecked = await getActiveRunForSession(sessionId, ctx.requestId);
    const leaseActive = rechecked.ok && rechecked.data.leaseActive;
    return stopMissionRun(
      { sessionId, missionRunId: enqueued.missionRunId, status: enqueued.runStatus, leaseActive },
      ctx,
    );
  }

  try {
    const { abortSessionSliceLocal } = await import(
      "@vex-agent/engine/index.js"
    );
    const signalled = abortSessionSliceLocal(sessionId);
    log.info(
      `[ipc:${ctx.channelLabel}] session slice abort signalled=${signalled} `
      + `correlationId=${ctx.requestId}`,
    );
  } catch (cause) {
    log.warn(
      `[ipc:${ctx.channelLabel}] session slice abort failed correlationId=${ctx.requestId}`,
      cause,
    );
  }

  await emitControlStateAfterChange(sessionId, ctx.requestId);
  // `applied` means the same transaction proved nothing durable or airborne
  // remained, applied the stop and retained NO request. Reporting `queued`
  // there would promise an observation that will never happen.
  if (enqueued.outcome === "applied") return ok({ outcome: "stopped" });
  return ok({ outcome: "queued", requestId: enqueued.requestId });
}

interface RunStopTarget {
  readonly sessionId: string;
  readonly missionRunId: string;
  readonly status: MissionRunStatus;
  readonly leaseActive: boolean;
}

/**
 * The RUN-scoped stop path. Extracted so the ordinary dispatch and the D2
 * target-scope reroute run byte-identical logic rather than two spellings of
 * it.
 */
async function stopMissionRun(
  target: RunStopTarget,
  ctx: StopFlowContext,
): Promise<Result<StopFlowResult>> {
  const { sessionId, missionRunId, status } = target;
  if (
    status === "completed"
    || status === "failed"
    || status === "stopped"
    || status === "cancelled"
  ) {
    return ok({ outcome: "already_terminal", status });
  }
  if (classifyRunLeaseState(status, target.leaseActive) === "live") {
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
      sessionId,
      missionRunId,
      correlationId: ctx.requestId,
    });
    if (enqueued.outcome === "run_not_found") {
      return ok({ outcome: "no_active_run" });
    }
    if (enqueued.outcome === "already_terminal") {
      // The run went terminal between the read above and the locked insert.
      // Queueing there would strand a request nobody will ever observe.
      await emitControlStateAfterChange(sessionId, ctx.requestId);
      return ok({ outcome: "already_terminal", status: enqueued.runStatus });
    }
    await signalLocalAbortBestEffort(missionRunId, ctx);
    await emitControlStateAfterChange(sessionId, ctx.requestId);
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
  const aborted = await abortActiveMissionForSession(sessionId);
  await emitControlStateAfterChange(sessionId, ctx.requestId);
  // null = the run vanished mid-flight; `aborted:false` = it was already
  // terminal by the time we aborted (race). Neither stopped a live paused
  // run, so report nothing-to-stop rather than a misleading `stopped`.
  if (aborted === null || !aborted.aborted) {
    return ok({ outcome: "no_active_run" });
  }
  return ok({ outcome: "stopped" });
}

export async function runStopDispatch(
  input: StopFlowInput,
  ctx: StopFlowContext,
): Promise<Result<StopFlowResult>> {
  const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
  if (!dbUrlOutcome.ok) return dbUrlOutcome;
  try {
    const state = await getActiveRunForSession(input.sessionId, ctx.requestId);
    if (!state.ok) return state;
    if (!state.data.hasActiveRun) {
      // No mission run — but "no run" is NOT the same as "nothing to stop".
      // A Full-Autonomous agent SESSION can be running a wake-driven slice, or
      // sitting on a pending continuation wake that is about to start one, with
      // no run row anywhere. Returning `no_active_run` here meant the Stop
      // button could not stop autonomous work at all.
      return stopChatSession(input.sessionId, ctx);
    }
    const status = state.data.status;
    // `hasActiveRun` is derived from a real row, so the id is non-null here in
    // practice; the test narrows the type for the run-scoped engine call
    // instead of asserting it. A null id has no run to queue against, so it
    // takes the direct-abort path inside `stopMissionRun`.
    const missionRunId = state.data.missionRunId;
    if (status === null || missionRunId === null) {
      const { abortActiveMissionForSession } = await import(
        "@vex-agent/engine/index.js"
      );
      const aborted = await abortActiveMissionForSession(input.sessionId);
      await emitControlStateAfterChange(input.sessionId, ctx.requestId);
      if (aborted === null || !aborted.aborted) {
        return ok({ outcome: "no_active_run" });
      }
      return ok({ outcome: "stopped" });
    }
    return stopMissionRun(
      {
        sessionId: input.sessionId,
        missionRunId,
        status,
        leaseActive: state.data.leaseActive,
      },
      ctx,
    );
  } catch (cause) {
    log.warn(
      `[ipc:${ctx.channelLabel}] failed correlationId=${ctx.requestId}`,
      cause,
    );
    return err(controlFailedError(ctx.requestId));
  }
}
