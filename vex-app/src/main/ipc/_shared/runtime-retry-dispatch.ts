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
 * (`gatedClaimUnderSessionLock` below): a session with an unproven money-path
 * outcome cannot be resumed, and the refusal names the structural reasons. The
 * gate and the claim it guards commit as ONE transaction under the session
 * control lock - two transactions leave a window a money writer commits in.
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
import type { ClaimRunOutcome } from "@vex-agent/engine/runtime/lease-and-status.js";
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
 * The gated claim: the RECOVERY money gate and the claim it guards, as ONE
 * decision in ONE transaction under the session control lock.
 *
 * ## The gate
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
 * ## Why one transaction, and what was wrong before
 *
 * The gate used to read the money state under the lock, RELEASE it, and then
 * claim the run in a separate transaction. That is a TOCTOU window, not a
 * boundary: every money-path writer takes this same lock, so a writer blocked
 * behind the read would commit an unresolved intent the instant the read
 * released it, and the claim - which takes row locks on `mission_runs` and
 * `runner_leases` but never the session control lock - would then resume the
 * run over exactly the outcome the gate exists to refuse. The window was small
 * and the loss is a double spend, which is the trade this rule does not make.
 *
 * So the read, the claim and the auto-retry wake cancellation now commit
 * together or not at all. A money writer either commits before the read (and
 * the gate sees it and refuses) or waits behind the lock until the claim is
 * durable. There is no third ordering, which is what the two-client
 * integration test asserts.
 *
 * ## Lock ORDER inside that transaction
 *
 * The claim runs BEFORE the wake cancellation, matching the order every other
 * claimant uses: `mission_runs`, then `runner_leases`, then
 * `loop_wake_requests`. Cancelling first inverted that order and made a real
 * deadlock reachable whenever the run advanced to `paused_wake` between this
 * dispatcher's outside read and the transaction. `gatedClaimUnderSessionLock`
 * spells out the interleaving; the regression is pinned live in
 * `recovery-reverse-lock-order.int.test.ts`.
 *
 * ## The hold is still short
 *
 * The lock is held across three statements and NO inference: the fire-and-
 * forget `resumeMissionRun` starts after this transaction commits, exactly as
 * before. Holding the session control lock across a model turn is the failure
 * this module's lock discipline forbids, and nothing here does it.
 *
 * FAIL-CLOSED: a throw propagates to the caller's catch and the retry is
 * refused. An unreadable money state is not a clear one.
 *
 * The renderer's Recover affordance gates on a MIRROR of the same fact, but
 * that is a display concern; this is the enforcement and does not trust it.
 *
 * EXPORTED for its integration test, which drives this exact function from two
 * real clients to prove the interleaving is impossible. The alternative was a
 * test that re-composed the same three calls, which would prove only that the
 * copy is safe. It is not part of the IPC surface and has no other caller.
 */
type GatedClaimOutcome =
  | {
    readonly kind: "blocked_money_state";
    readonly reasonKinds: readonly string[];
  }
  | { readonly kind: "claimed"; readonly claim: ClaimRunOutcome };

export async function gatedClaimUnderSessionLock(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly status: MissionRunStatus;
  readonly ownerId: string;
}): Promise<GatedClaimOutcome> {
  const { withSessionControlLock } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const { claimRunLeaseAndFlipToRunningWith } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const { getUnresolvedMoneyStateForSession } = await import(
    "@vex-agent/db/repos/approval-intents/money-state.js"
  );
  const { cancelForSessionWith } = await import(
    "@vex-agent/db/repos/loop-wake.js"
  );

  return withSessionControlLock(input.sessionId, async (client) => {
    const money = await getUnresolvedMoneyStateForSession(
      client,
      input.sessionId,
    );
    if (!money.clear) {
      return {
        kind: "blocked_money_state",
        reasonKinds: [...new Set(money.reasons.map((r) => r.kind))],
      };
    }

    // THE CLAIM COMES FIRST, and the order is load-bearing, not stylistic.
    //
    // `claimRunLeaseAndFlipToRunningWith` locks the `mission_runs` row, then
    // the lease row, then pending `loop_wake_requests` rows - in that order,
    // and every other claimant in the system follows it. Cancelling the
    // auto-retry wake BEFORE the claim took those wake rows first and inverted
    // it, which is a textbook lock-order inversion with a reachable deadlock:
    //
    //   1. this dispatcher reads `paused_error` OUTSIDE the transaction;
    //   2. the run advances to `paused_wake` before the gate opens;
    //   3. a wake or Continue claimant locks the run row and moves toward the
    //      wake rows;
    //   4. this transaction, still carrying the stale `paused_error`, locks
    //      the pending wake row and then waits on the run row;
    //   5. the claimant waits on the wake row this transaction holds.
    //
    // Postgres breaks that cycle by aborting one side, which turns an ordinary
    // lost race into a failed control action. Claiming first removes the cycle
    // entirely: a stale Recover simply loses the status check and returns
    // `status_mismatch` having touched no wake row at all.
    const claim = await claimRunLeaseAndFlipToRunningWith(client, {
      sessionId: input.sessionId,
      missionRunId: input.runId,
      // `[status]` - either `["paused_error"]` (the normal Recover path) or
      // `["running"]` (the dead-lease reclaim path). Never both: only one of
      // the two branches reaches here for a given call. This is also the
      // revalidation that makes the outside read safe to be stale.
      fromStatuses: [input.status],
      ownerId: input.ownerId,
      processKind: "electron_main",
      ttlMs: LEASE_TTL_MS,
    });

    // A human Recover supersedes any scheduled auto-retry - but ONLY once the
    // claim has actually won, and only for a run that really was parked on an
    // error. `previousStatus` is what the claim OBSERVED under the row lock,
    // never the status this dispatcher read outside the transaction; keying on
    // the latter is what let a stale call cancel a wake belonging to a
    // different scheduling cycle.
    //
    // A `paused_wake` claim needs nothing here: the claim cancels that run's
    // own wake itself, under the same lock order. And a wake already CONSUMED
    // by the executor cannot be cancelled by anyone - there
    // `claimRunForAutoRetry`'s atomic re-check is the authority and will skip.
    if (claim.outcome === "claimed" && claim.previousStatus === "paused_error") {
      await cancelForSessionWith(
        client,
        input.sessionId,
        "superseded_by_manual_recover",
      );
    }
    return { kind: "claimed", claim };
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

    // status === "paused_error", or "running" with a DEAD lease: money gate +
    // wake cancellation + claim + flip, then fire-and-forget resume.
    //
    // The audit request is enqueued BEFORE the gated claim so the attempt is
    // recorded ahead of any effect (rule 09: request before dispatch, exactly
    // one correlated outcome after settlement). A money-blocked Recover
    // therefore leaves an audit row settled `blocked_money_state`, which is
    // the point - a refusal on the money path is precisely what an operator
    // needs to find later.
    const { enqueueRequest, markObserved, markCleared, markFailed } =
      await import("@vex-agent/db/repos/runtime-control-requests.js");
    const auditRequest = await enqueueRequest({
      sessionId: input.sessionId,
      missionRunId: runId,
      kind: "resume",
      requestedBy: "user",
      correlationId: ctx.requestId,
    });
    const gated = await gatedClaimUnderSessionLock({
      sessionId: input.sessionId,
      runId,
      status,
      ownerId: `${RETRY_OWNER_PREFIX}${randomUUID()}`,
    });
    if (gated.kind === "blocked_money_state") {
      await markFailed(auditRequest.id, "blocked_money_state");
      log.info(
        `[ipc:${ctx.channelLabel}] retry refused on unresolved money state runId=${runId} reasons=${gated.reasonKinds.join(",")}`,
      );
      return ok({
        outcome: "blocked_money_state",
        reasonKinds: gated.reasonKinds,
      });
    }
    const claim = gated.claim;
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
