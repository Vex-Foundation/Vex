/**
 * Approvals IPC — scheduled approval maintenance.
 *
 * ONE timer, two passes:
 *
 *   1. `sweepExpiredApprovals` — TTL expiry. Returns prepared continuations;
 *      main dispatches them via the shared `_engine-dispatch.ts` background
 *      helper, because the engine does NOT import main IPC helpers (Codex
 *      puzzle-5 phase-3 review point 5): "engine returns work, main does work."
 *
 *   2. `reconcileApprovalLifecycle` — the durable floor under every faster
 *      resume path. Unlike the sweep it owns its own claims end-to-end (it must
 *      hold a lease while it decides), so it reports counts rather than
 *      returning continuations.
 *
 * Deliberately NOT a second interval: staleness resolution belongs in the cycle
 * that already exists, and a second timer would double the contention on the
 * same rows.
 */

import { randomUUID } from "node:crypto";

import { log } from "../../logger/index.js";
import { dispatchPreparedMission } from "../mission/_engine-dispatch.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";

export async function runScheduledSweep(): Promise<void> {
  const correlationId = `sweep-${randomUUID()}`;
  const dbUrlOutcome = await ensureEngineDbUrl(correlationId);
  if (!dbUrlOutcome.ok) {
    log.info(
      `[approvals.sweep] waiting: database url unavailable (will retry next sweep) ` +
        `correlationId=${correlationId}`,
    );
    return;
  }

  // The caller fires this as `void runScheduledSweep()` on an interval, so it
  // must never reject — an unhandled rejection in Electron main is a crash
  // surface. The module load gets its own guard for that reason.
  let runtime: typeof import("@vex-agent/engine/core/approval-runtime.js");
  try {
    runtime = await import("@vex-agent/engine/core/approval-runtime.js");
  } catch (cause) {
    log.warn(
      `[approvals.sweep] engine module unavailable correlationId=${correlationId}`,
      cause,
    );
    return;
  }
  const {
    sweepExpiredApprovals,
    reconcileApprovalLifecycle,
    runResumeAfterDecision,
    continuationMissionRunId,
  } = runtime;

  try {
    const result = await sweepExpiredApprovals(new Date());
    for (const cont of result.continuations) {
      const missionRunId = continuationMissionRunId(cont);
      dispatchPreparedMission(() => runResumeAfterDecision(cont), {
        sessionId: cont.sessionId,
        ...(missionRunId !== undefined ? { missionRunId } : {}),
        correlationId,
        channelLabel: "vex:approvals:sweep",
      });
    }
    log.info(
      `[approvals.sweep] correlationId=${correlationId} swept=${result.swept} ` +
        `errored=${result.errored} continuations=${result.continuations.length}`,
    );
  } catch (cause) {
    log.warn(
      `[approvals.sweep] failed correlationId=${correlationId}`,
      cause,
    );
  }

  // Separate try/catch: a TTL-sweep failure must not cost us the reconciler
  // pass, which is the only thing that can finish an abandoned money-path
  // dispatch or deliver a resume nothing else picked up.
  try {
    const reconciled = await reconcileApprovalLifecycle(new Date());
    if (reconciled.examined > 0) {
      log.info(
        `[approvals.reconcile] correlationId=${correlationId} ` +
          `examined=${reconciled.examined} dispatched=${reconciled.dispatched} ` +
          `indeterminate=${reconciled.indeterminate} resumed=${reconciled.resumed} ` +
          `leaseHeld=${reconciled.skippedLeaseHeld} ` +
          `runNotResumable=${reconciled.skippedRunNotResumable} ` +
          `errored=${reconciled.errored}`,
      );
    }
  } catch (cause) {
    log.warn(
      `[approvals.reconcile] failed correlationId=${correlationId}`,
      cause,
    );
  }
}
