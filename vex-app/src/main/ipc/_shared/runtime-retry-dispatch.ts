/**
 * Retry dispatcher for `mission.retry` — the "Recover after error" control.
 *
 * Deliberately distinct from `runResumeDispatch`: that dispatcher owns
 * paused_user / paused_wake and refuses paused_error. This one claims +
 * resumes ONLY a `paused_error` run (or a `running` run with a DEAD lease —
 * see below), and classifies every other state explicitly so the dispatcher
 * is total. Fire-and-forget like the resume path: it claims the lease +
 * flips status, kicks off `resumeMissionRun` asynchronously, and returns a
 * Result immediately.
 *
 * Before it claims anything it enforces the RECOVERY MONEY GATE
 * (`readSessionMoneyState` below): a session with an unproven money-path
 * outcome cannot be resumed, and the refusal names the structural reasons.
 *
 * Duplicates ~60% of `runResumeDispatch` by intent (codex review): a shared
 * claim + fire-and-forget helper is only worth extracting once the stop-fix
 * slice proves the shape is stable.
 *
 * `status === 'running'` alone does NOT mean a runner is observing the
 * session — the lease can be expired/released. `getLatestRunForSession` now
 * loads lease state (it did not before) so this dispatcher can tell the two
 * apart, same as `runResumeDispatch` and `runtime-stop-dispatch.ts` (issue
 * #12's bug class, ported here per WP-C).
 */

import { randomUUID } from "node:crypto";
import { ok, err, type Result } from "@shared/ipc/result.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { getLatestRunForSession } from "../../database/mission-runs-db.js";
import { log } from "../../logger/index.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";
import { classifyRunLeaseState } from "./lease-state.js";

export interface RetryFlowInput {
  readonly sessionId: string;
}

export interface RetryFlowContext {
  readonly requestId: string;
  /** Label used for structured logs (channel name without colon prefix). */
  readonly channelLabel: string;
}

export type RetryFlowResult =
  | { readonly outcome: "resumed"; readonly runId: string }
  | { readonly outcome: "already_running"; readonly runId: string }
  | { readonly outcome: "no_active_run" }
  | { readonly outcome: "blocked_approval"; readonly pendingApprovalId: string }
  | { readonly outcome: "blocked_terminal"; readonly status: MissionRunStatus }
  | { readonly outcome: "not_recoverable"; readonly status: MissionRunStatus }
  | { readonly outcome: "status_changed" }
  | {
    readonly outcome: "blocked_money_state";
    readonly reasonKinds: readonly string[];
  }
  | { readonly outcome: "lease_busy"; readonly retryAfterMs?: number };

const LEASE_TTL_MS = 5 * 60_000;
const RETRY_OWNER_PREFIX = "ipc-retry-";

/**
 * The RECOVERY money gate, enforced here because this is the privileged half.
 *
 * Recover resumes a run that stopped in the middle of something. A run parked
 * by the restart-orphan reclaim is the sharpest case - the process died
 * mid-slice, so a wallet intent may be `consuming`, a transaction may be
 * broadcast with no confirmation yet, an approval may be `dispatching` - but it
 * is not a special case: every `paused_error` pause is a decision made from an
 * interrupted state, and resuming on top of an unproven money outcome is how a
 * double spend happens. The rule is the product's own (rule 90): an unknown
 * outcome is reconciled, never retried.
 *
 * Read inside a transaction under the SESSION CONTROL LOCK, which is what makes
 * it a boundary rather than a snapshot of the past: every money-state writer
 * takes the same lock (see the reader's module header). It is released before
 * the claim below, deliberately - nothing may hold that lock across the
 * fire-and-forget resume, and the claim revalidates status and lease under its
 * own row locks anyway.
 *
 * FAIL-CLOSED: a throw propagates to the caller's catch and the retry is
 * refused. An unreadable money state is not a clear one.
 *
 * The renderer's Recover affordance must gate on the same fact, but that is a
 * display concern; this check is the enforcement and does not trust it.
 */
async function readSessionMoneyState(
  sessionId: string,
): Promise<
  | { readonly clear: true }
  | { readonly clear: false; readonly reasons: readonly { kind: string }[] }
> {
  const { withTransaction } = await import("@vex-agent/db/client.js");
  const { acquireSessionControlLock } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const { getUnresolvedMoneyStateForSession } = await import(
    "@vex-agent/db/repos/approval-intents/money-state.js"
  );
  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, sessionId);
    return getUnresolvedMoneyStateForSession(client, sessionId);
  });
}

export async function runRetryDispatch(
  input: RetryFlowInput,
  ctx: RetryFlowContext,
): Promise<Result<RetryFlowResult>> {
  const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
  if (!dbUrlOutcome.ok) return dbUrlOutcome;
  try {
    const latest = await getLatestRunForSession(input.sessionId, ctx.requestId);
    if (!latest.ok) return latest;
    if (latest.data === null) return ok({ outcome: "no_active_run" });

    const runId = latest.data.missionRunId;
    const status = latest.data.status;
    if (status === "running") {
      if (classifyRunLeaseState(status, latest.data.leaseActive) === "live") {
        return ok({ outcome: "already_running", runId });
      }
      // Dead lease: no runner is actually observing this session. Fall
      // through to the SAME claim/reclaim path as paused_error below —
      // `claimRunLeaseAndFlipToRunning` re-validates the lease is
      // expired/absent under a row lock before reclaiming it, so this is
      // race-safe. SKIP the paused_error-specific auto-retry-wake
      // cancellation just below: a `running` row never has an
      // error_retry wake pending.
    }
    if (status === "paused_approval") {
      return ok({ outcome: "blocked_approval", pendingApprovalId: runId });
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "stopped" ||
      status === "cancelled"
    ) {
      return ok({ outcome: "blocked_terminal", status });
    }
    if (
      status === "paused_wake" ||
      status === "paused_user" ||
      // C3b — not an error pause either, and Recover cannot answer the pending
      // tool call; only the form's submit/dismiss continuation can.
      status === "paused_user_form"
    ) {
      // Not an error pause → Continue (runResumeDispatch) owns these.
      return ok({ outcome: "not_recoverable", status });
    }

    // Money gate BEFORE anything with an effect. Placed ahead of the wake
    // cancellation below so a refused Recover leaves the run exactly as it was,
    // scheduled auto-retry included.
    const money = await readSessionMoneyState(input.sessionId);
    if (!money.clear) {
      const reasonKinds = [...new Set(money.reasons.map((r) => r.kind))];
      log.info(
        `[ipc:${ctx.channelLabel}] retry refused on unresolved money state runId=${runId} reasons=${reasonKinds.join(",")}`,
      );
      return ok({ outcome: "blocked_money_state", reasonKinds });
    }

    if (status === "paused_error") {
      // Phase 4d: a human Recover supersedes any scheduled auto-retry — cancel
      // the pending error_retry wake so it can't fire later. A wake already
      // CONSUMED by the executor can't be cancelled; there, claimRunForAutoRetry's
      // atomic re-check (status/unsafe/attempt) is the authority and will skip.
      const { cancelForSession } = await import(
        "@vex-agent/db/repos/loop-wake.js"
      );
      await cancelForSession(input.sessionId, "superseded_by_manual_recover");
    }

    // status === "paused_error", or "running" with a DEAD lease — claim +
    // flip + fire-and-forget resume.
    const { enqueueRequest, markObserved, markCleared, markFailed } =
      await import("@vex-agent/db/repos/runtime-control-requests.js");
    const auditRequest = await enqueueRequest({
      sessionId: input.sessionId,
      missionRunId: runId,
      kind: "resume",
      requestedBy: "user",
      correlationId: ctx.requestId,
    });
    const { claimRunLeaseAndFlipToRunning } = await import(
      "@vex-agent/engine/runtime/lease-and-status.js"
    );
    const claim = await claimRunLeaseAndFlipToRunning({
      sessionId: input.sessionId,
      missionRunId: runId,
      // `[status]` — either `["paused_error"]` (the normal Recover path) or
      // `["running"]` (the dead-lease reclaim path above). Never both: only
      // one of the two branches above reaches here for a given call.
      fromStatuses: [status],
      ownerId: `${RETRY_OWNER_PREFIX}${randomUUID()}`,
      processKind: "electron_main",
      ttlMs: LEASE_TTL_MS,
    });
    if (claim.outcome === "lease_busy") {
      await markFailed(auditRequest.id, "lease_busy");
      const retryAfterMs = Math.max(
        0,
        claim.currentLease.expiresAt.getTime() - Date.now(),
      );
      await emitControlStateAfterChange(input.sessionId, ctx.requestId);
      return ok({ outcome: "lease_busy", retryAfterMs });
    }
    if (claim.outcome === "status_mismatch") {
      await markFailed(auditRequest.id, "status_changed");
      // Deliberate re-read: if a race winner already resumed the run, report
      // it as already_running rather than a generic error.
      const after = await getLatestRunForSession(
        input.sessionId,
        ctx.requestId,
      );
      if (after.ok && after.data?.status === "running") {
        return ok({ outcome: "already_running", runId: after.data.missionRunId });
      }
      return ok({ outcome: "status_changed" });
    }
    await markObserved(auditRequest.id);
    const ownerId = claim.lease.ownerId;
    const { createLeaseHandle } = await import(
      "@vex-agent/engine/runtime/lease-handle.js"
    );
    const handle = createLeaseHandle({
      lease: claim.lease,
      ownerId,
      ttlMs: LEASE_TTL_MS,
    });
    // Fire-and-forget. Bug-report sink + audit lifecycle on continuation.
    void (async () => {
      try {
        const { resumeMissionRun } = await import("@vex-agent/engine/index.js");
        await resumeMissionRun(runId, ownerId);
        await markCleared(auditRequest.id, "resumed");
      } catch (cause) {
        log.warn(
          `[ipc:${ctx.channelLabel}] retry continuation failed runId=${runId}`,
          cause,
        );
        try {
          await markFailed(auditRequest.id, "continuation_failed");
        } catch {
          // best-effort audit
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
              title: `${ctx.channelLabel}.continuation_failed`,
              description: cause instanceof Error ? cause.message : String(cause),
              refs: {
                sessionId: input.sessionId,
                missionRunId: runId,
                correlationId: ctx.requestId,
              },
              agentContext: { runtimeStatus: "running" },
            },
            log,
          );
        } catch {
          // sink unreachable
        }
      } finally {
        try {
          const { releaseLeaseAndEmitControlState } = await import(
            "@vex-agent/engine/runtime/release-and-emit.js"
          );
          await releaseLeaseAndEmitControlState(handle, input.sessionId, {
            missionRunId: runId,
            correlationId: ctx.requestId,
          });
        } catch {
          // best-effort
        }
      }
    })();
    await emitControlStateAfterChange(input.sessionId, ctx.requestId);
    return ok({ outcome: "resumed", runId });
  } catch (cause) {
    log.warn(
      `[ipc:${ctx.channelLabel}] failed correlationId=${ctx.requestId}`,
      cause,
    );
    return err(controlFailedError(ctx.requestId));
  }
}
