/**
 * The ATOMIC mission-scoped wake claim.
 *
 * ## What it replaces
 *
 * Mission wakes used to be consumed by a destructive BATCH claim: every due row
 * was flipped `pending → consumed` in one transaction, and only afterwards were
 * the runs resumed, one by one. A crash after the first resume left every later
 * row consumed and its run still `paused_wake`, with no pending row and nothing
 * that would ever look at it again. The same shape followed a busy lease (the
 * consumed row was simply dropped) and a run still `running` because its own
 * turn loop had not finished parking yet (LoopDefer enqueues the wake BEFORE
 * the park, so a short defer can come due first).
 *
 * ## The claim is ONE transaction, one row at a time
 *
 *   0. `acquireSessionControlLock` - FIRST, as for every holder of that lock;
 *   1. lock the `mission_runs` row - before the wake row, because every resume
 *      path that cancels a run's pending wake locks the run first;
 *   2. re-read and lock the wake row, proving it is still `pending` and due;
 *   3. decide, under those locks:
 *      - a resumable run: take the run/session lease and flip the run to
 *        `running` through the SAME claim every other resume path uses, which
 *        consumes this row in that commit (`consumeWakeId`), or, for an
 *        auto-retry wake, through the auto-retry claim that re-verifies the
 *        full safety state, then consume the row;
 *      - lease busy, or the run still `running` (its turn loop is unwinding
 *        toward the park): nothing is consumed; the SAME row is pushed out by
 *        the bounded backoff shared with the session-wake claim;
 *      - a run that is gone, belongs to another session, or sits in a state
 *        this wake can no longer resume (terminal, parked for something else,
 *        auto-retry refused): the row is retired as `cancelled`. `consumed`
 *        now means only "a runner started from this row".
 *
 * An error anywhere rolls the whole transaction back: the row stays pending,
 * the run stays where it was and no lease is left behind.
 *
 * The lease comes from the lease repo inside the claim, with whatever fencing
 * token that repo issues; the handle built from it by the caller carries it.
 */

import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { RunnerLease } from "@vex-agent/db/repos/runner-leases.js";
import type { MissionRunStatus } from "../../types.js";
import { AUTO_RETRY_WAKE_TRIGGER } from "../../core/runner/mission-auto-retry-policy.js";
import { backoffDelayMs } from "./claim-session-wake.js";

export type MissionWakeRoute = "continuation" | "auto_retry";

export type MissionWakeDropReason =
  | "run_missing"
  | "session_mismatch"
  | "not_resumable"
  | "auto_retry_ineligible";

export type ClaimMissionWakeOutcome =
  /** The row is consumed, the run is `running`, and this owner holds the lease. */
  | {
      readonly kind: "claimed";
      readonly route: MissionWakeRoute;
      readonly runId: string;
      readonly lease: RunnerLease;
    }
  /**
   * Someone else is driving the session (a live lease, or the run's own turn
   * loop that has not parked yet). The row is STILL PENDING with a pushed-out
   * `due_at`; nothing was lost.
   */
  | {
      readonly kind: "deferred";
      readonly cause: "lease_busy" | "run_active";
      readonly attempt: number;
      readonly dueAt: string;
    }
  /** The row stopped being claimable: cancelled, claimed elsewhere, or not due. */
  | { readonly kind: "not_claimable" }
  /** The run cannot be resumed by this wake. The row was retired as cancelled. */
  | {
      readonly kind: "dropped";
      readonly reason: MissionWakeDropReason;
      readonly currentStatus: MissionRunStatus | null;
    };

export interface ClaimMissionWakeInput {
  readonly wake: LoopWakeRequest;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now: Date;
}

/** The wake row routes to the auto-retry claim by its structured trigger only. */
export function isAutoRetryWake(wake: LoopWakeRequest): boolean {
  return wake.payload?.trigger === AUTO_RETRY_WAKE_TRIGGER;
}

/**
 * Deferral count for a mission wake. Kept under `claimAttempt`, never
 * `attempt`: an auto-retry wake's `attempt` is its retry epoch.
 */
function readClaimAttempt(wake: LoopWakeRequest): number {
  const attempt = wake.payload?.claimAttempt;
  return typeof attempt === "number" && Number.isFinite(attempt) && attempt > 0
    ? attempt
    : 0;
}

/** Only an auto-retry wake carries a retry epoch; anything else fails closed. */
function readRetryEpoch(wake: LoopWakeRequest): number {
  const attempt = wake.payload?.attempt;
  return typeof attempt === "number" ? attempt : -1;
}

interface LockedRunRow {
  readonly status: MissionRunStatus;
  readonly session_id: string;
}

export async function claimMissionWakeAtomically(
  input: ClaimMissionWakeInput,
): Promise<ClaimMissionWakeOutcome> {
  const runId = input.wake.missionRunId;
  if (runId === null) {
    throw new Error("claimMissionWakeAtomically: wake row has no mission run");
  }
  const { withTransaction, queryOneWith } = await import(
    "@vex-agent/db/client.js"
  );
  const loopWakeRepo = await import("@vex-agent/db/repos/loop-wake.js");
  const {
    acquireSessionControlLock,
    claimRunLeaseAndFlipToRunningWith,
    claimRunForAutoRetryWith,
  } = await import("../../runtime/lease-and-status.js");

  const outcome = await withTransaction(
    async (client): Promise<ClaimMissionWakeOutcome> => {
      await acquireSessionControlLock(client, input.wake.sessionId);

      const run = await queryOneWith<LockedRunRow>(
        client,
        "SELECT status, session_id FROM mission_runs WHERE id = $1 FOR UPDATE",
        [runId],
      );

      const locked = await loopWakeRepo.lockDueMissionScopedWith(
        client,
        input.wake.id,
        input.now,
      );
      if (locked === null) return { kind: "not_claimable" };

      const drop = async (
        reason: MissionWakeDropReason,
        currentStatus: MissionRunStatus | null,
      ): Promise<ClaimMissionWakeOutcome> => {
        await loopWakeRepo.dropLockedWith(
          client,
          locked.id,
          `wake_not_resumable:${reason}`,
        );
        return { kind: "dropped", reason, currentStatus };
      };

      const defer = async (
        cause: "lease_busy" | "run_active",
      ): Promise<ClaimMissionWakeOutcome> => {
        const attempt = readClaimAttempt(locked) + 1;
        const dueAt = new Date(input.now.getTime() + backoffDelayMs(attempt));
        await loopWakeRepo.deferLockedWith(
          client,
          locked.id,
          dueAt,
          attempt,
          "claimAttempt",
        );
        return { kind: "deferred", cause, attempt, dueAt: dueAt.toISOString() };
      };

      if (run === null) return drop("run_missing", null);
      if (run.session_id !== locked.sessionId) {
        return drop("session_mismatch", run.status);
      }

      if (isAutoRetryWake(locked)) {
        const claim = await claimRunForAutoRetryWith(client, {
          sessionId: locked.sessionId,
          missionRunId: runId,
          expectedAttempt: readRetryEpoch(locked),
          ownerId: input.ownerId,
          processKind: "electron_main",
          ttlMs: input.ttlMs,
        });
        if (claim.outcome === "lease_busy") return defer("lease_busy");
        if (claim.outcome === "ineligible") {
          return drop("auto_retry_ineligible", run.status);
        }
        const consumed = await loopWakeRepo.consumeLockedWith(client, locked.id);
        if (consumed !== 1) {
          throw new Error("claimMissionWakeAtomically: locked wake row vanished");
        }
        return { kind: "claimed", route: "auto_retry", runId, lease: claim.lease };
      }

      // The run's own turn loop enqueued this wake and has not parked yet, or
      // a runner is otherwise driving it. Either way it is not ours to drop.
      if (run.status === "running") return defer("run_active");

      const claim = await claimRunLeaseAndFlipToRunningWith(client, {
        sessionId: locked.sessionId,
        missionRunId: runId,
        fromStatuses: ["paused_wake"],
        ownerId: input.ownerId,
        processKind: "electron_main",
        ttlMs: input.ttlMs,
        consumeWakeId: locked.id,
      });
      if (claim.outcome === "lease_busy") return defer("lease_busy");
      if (claim.outcome === "status_mismatch") {
        return drop("not_resumable", claim.currentStatus);
      }
      return { kind: "claimed", route: "continuation", runId, lease: claim.lease };
    },
  );

  // AFTER the commit, as for the session-wake claim: the renderer learns the
  // session is live again. Total by contract, so it cannot fail a claim.
  if (outcome.kind === "claimed") {
    const { emitSessionControlState } = await import(
      "../../runtime/emit-control-state.js"
    );
    await emitSessionControlState(input.wake.sessionId, {
      missionRunId: outcome.runId,
    });
  }
  return outcome;
}
