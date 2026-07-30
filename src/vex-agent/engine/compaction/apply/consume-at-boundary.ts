/**
 * Consuming a queued cutover at the runner's iteration boundary — Tx A, plus
 * the boundary action the turn loop registers.
 *
 * ## Only the ACTUAL lease holder may consume
 *
 * The cutover rewrites the transcript the runner is mid-way through reading, so
 * exactly one cutover may be in flight and only the process that owns the
 * session may perform it. The caller therefore passes ITS OWN
 * `runnerOwnerId` — the id it used to acquire the lease — and it must EQUAL the
 * live, unexpired lease's owner:
 *
 *   - before Tx A (here), so a stale runner never even claims the cutover;
 *   - AGAIN inside Tx B, under the session advisory lock, so a lease that
 *     changed hands between the two phases cannot be used to finish a cutover
 *     the new holder now owns.
 *
 * Reading the CURRENT owner out of the database and adopting it as our identity
 * — which an earlier version did — is precisely the hole this closes: a stale
 * runner would impersonate whatever replacement lease holder it happened to
 * find and sail through every ownership fence downstream.
 *
 * On top of that equality, `apply_locked_by` fences every apply edge
 * (`casBeginApply` / `casMarkApplied` / `casDeferApply`), and Tx B's session
 * advisory lock serializes cutovers outright.
 *
 * `requestApply` deliberately does not check the lease before queueing — the
 * request is durable and waits for whoever holds the lease next.
 *
 * ## Full-Autonomous auto-apply (contract C6/C13)
 *
 * A `full` permission session has no operator watching a button, so a ready
 * preparation would sit unapplied until pressure forced it at critical. This
 * boundary therefore queues its own request with source `auto_full_autonomous`
 * and consumes it in the same pass. A `restricted` session never auto-applies:
 * there, compaction is an operator decision until the critical path overrides
 * it.
 *
 * The permission comes from the caller's `EngineContext`, never from a fresh
 * read: this runs on EVERY iteration, and the compaction subsystem must not
 * become a per-turn DB dependency for the 99% of turns with no live
 * preparation.
 *
 * ## What runs where
 *
 * Tx A (`casBeginApply`) commits HERE, on its own, before `commitPreparation`
 * opens Tx B. See `commit-preparation.ts` for why the split is what makes a
 * crashed cutover detectable.
 *
 * ## Deferral is not failure
 *
 * `compaction_apply_deferred` means the gate worked — a stop is queued, or
 * money is in flight. The turn loop must NOT count it toward
 * `criticalNoopCounter`: doing so would escalate a healthy run to
 * `paused_error` for waiting correctly. The iteration-entry seam documents the
 * same rule from the consumer side.
 *
 * Nothing here does unbounded external work: this sits on the operator-Stop
 * latency path, and every step is a short DB transaction.
 */

import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import { APPLY_STALE_THRESHOLD_MS } from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import type { Permission } from "@vex-agent/engine/types.js";
import type {
  IterationBoundaryAction,
  IterationBoundaryOutcome,
} from "@vex-agent/engine/core/turn-loop-iteration-entry.js";
import logger from "@utils/logger.js";

import {
  commitPreparation,
  type ApplyCommitResult,
  type ApplyExecutionMode,
} from "./commit-preparation.js";
import { emitApplyTransition } from "./emit-transition.js";
import { requestApply } from "./request-apply.js";

export type ConsumeApplyOutcome =
  | { kind: "applied"; generation: number; archivedMessages: number }
  | { kind: "deferred"; result: ApplyCommitResult }
  /** Nothing queued, not the lease holder, or nothing ready — the common case. */
  | { kind: "nothing_to_do" };

export interface ConsumeApplyInput {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  /** From `EngineContext` — `full` enables auto-apply. See the header. */
  readonly sessionPermission: Permission;
  /**
   * The owner id THIS runner acquired the session lease with. Required: it is
   * checked for equality against the live lease before Tx A and again in Tx B.
   * Never derived from the row — see the header.
   */
  readonly runnerOwnerId: string;
}

/**
 * Consume a standing `apply_requested` for this session, if this runner owns
 * the lease. Queues one first when the session is Full-Autonomous and a
 * preparation is `summary_ready`.
 */
export async function consumeApplyRequest(
  input: ConsumeApplyInput,
): Promise<ConsumeApplyOutcome> {
  if (!(await holdsLiveLease(input.sessionId, input.runnerOwnerId))) {
    return { kind: "nothing_to_do" };
  }

  let live = await preparationsRepo.getLivePreparationForSession(input.sessionId);
  if (live === null) return { kind: "nothing_to_do" };

  // AWAITED stale-apply recovery, BEFORE this turn's apply can proceed. This is
  // the authoritative half of the crash guarantee: a row left `applying` by a
  // dead runner is resolved here, for THIS session, at the boundary that is
  // about to act on it — not left to a periodic sweep that may run much later.
  //
  // `recoverStuckApplying` owns the discriminator: a still-`applying` row proves
  // Tx B never committed, so a spent target generation is a CONFLICT (terminal)
  // and anything else returns the row to `apply_requested`. Either way the state
  // below is re-read, so this pass never acts on the row it just recovered.
  if (live.status === "applying" && isApplyLeaseStale(live.applyHeartbeatAt)) {
    await preparationsRepo.recoverStuckApplying(APPLY_STALE_THRESHOLD_MS);
    live = await preparationsRepo.getLivePreparationForSession(input.sessionId);
    if (live === null) return { kind: "nothing_to_do" };
  }
  // A cutover still legitimately in flight (live heartbeat) is not ours to take.
  if (live.status === "applying") return { kind: "nothing_to_do" };

  if (live.status === "summary_ready") {
    if (input.sessionPermission !== "full") {
      // A restricted session waits for the operator (or for the critical path).
      return { kind: "nothing_to_do" };
    }
    const queued = await requestApply({
      sessionId: input.sessionId,
      source: "auto_full_autonomous",
    });
    if (queued.kind !== "queued" && queued.kind !== "already_requested") {
      return { kind: "nothing_to_do" };
    }
    live = await preparationsRepo.getLivePreparationForSession(input.sessionId);
    if (live === null) return { kind: "nothing_to_do" };
  }

  if (live.status !== "apply_requested") return { kind: "nothing_to_do" };

  return runCutover({
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    preparationId: live.id,
    leaseOwnerId: input.runnerOwnerId,
    mode: "requested",
  });
}

/**
 * The critical-band entry point (contract C8). Owned by the PRESSURE package's
 * call sites — this module only EXPOSES it; it must never be invoked from
 * anywhere but a runner boundary, where no tool batch can be in flight.
 *
 * Accepts BOTH `summary_ready` and `apply_requested`: at critical there may be
 * no standing request, and waiting for one would strand the session. A
 * `summary_ready` row is stamped `forced_critical` on its way through
 * `casRequestApply`, so the stored source names the forcing; a row a user
 * already requested keeps ITS source (the asker was the user) and the forcing
 * is recorded as the money-gate bypass audit instead.
 */
export async function forcePreparedApply(
  input: ConsumeApplyInput,
): Promise<ConsumeApplyOutcome> {
  if (!(await holdsLiveLease(input.sessionId, input.runnerOwnerId))) {
    return { kind: "nothing_to_do" };
  }

  const live = await preparationsRepo.getLivePreparationForSession(
    input.sessionId,
  );
  if (live === null) return { kind: "nothing_to_do" };

  if (live.status === "summary_ready") {
    const cas = await preparationsRepo.casRequestApply(live.id, "forced_critical");
    if (!cas.ok) return { kind: "nothing_to_do" };
  } else if (live.status !== "apply_requested") {
    return { kind: "nothing_to_do" };
  }

  return runCutover({
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    preparationId: live.id,
    leaseOwnerId: input.runnerOwnerId,
    mode: "forced_critical",
  });
}

/**
 * Is an `applying` row's heartbeat old enough that its owner is presumed dead?
 * A NULL heartbeat is stale by construction — the column is stamped by Tx A.
 */
function isApplyLeaseStale(applyHeartbeatAt: string | null): boolean {
  if (applyHeartbeatAt === null) return true;
  return Date.now() - new Date(applyHeartbeatAt).getTime() > APPLY_STALE_THRESHOLD_MS;
}

/**
 * Does `runnerOwnerId` hold the session's live lease RIGHT NOW? Equality, never
 * adoption — see the header.
 */
async function holdsLiveLease(
  sessionId: string,
  runnerOwnerId: string,
): Promise<boolean> {
  const lease = await runnerLeasesRepo.getLease(sessionId);
  return (
    lease !== null
    && lease.ownerId === runnerOwnerId
    && lease.expiresAt >= new Date()
  );
}

async function runCutover(args: {
  sessionId: string;
  missionRunId: string | null;
  preparationId: number;
  leaseOwnerId: string;
  mode: ApplyExecutionMode;
}): Promise<ConsumeApplyOutcome> {
  // ── Tx A — commits on its own. See `commit-preparation.ts`. ────────
  const begun = await preparationsRepo.casBeginApply(
    args.preparationId,
    args.leaseOwnerId,
  );
  if (!begun.ok) return { kind: "nothing_to_do" };
  // Tx A committed on its own — announce it before Tx B starts, so the UI can
  // show the cutover in progress rather than jumping straight to the result.
  emitApplyTransition(args.sessionId, "applying");

  // ── Tx B ───────────────────────────────────────────────────────────
  const result = await commitPreparation({
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    preparationId: args.preparationId,
    runnerLeaseId: args.leaseOwnerId,
    mode: args.mode,
  });

  if (result.kind === "applied") {
    logger.info("compaction.apply.committed", {
      sessionId: args.sessionId,
      preparationId: args.preparationId,
      mode: args.mode,
      generation: result.generation,
      archivedMessages: result.archivedMessages,
    });
    return {
      kind: "applied",
      generation: result.generation,
      archivedMessages: result.archivedMessages,
    };
  }

  logger.info("compaction.apply.not_committed", {
    sessionId: args.sessionId,
    preparationId: args.preparationId,
    mode: args.mode,
    outcome: result.kind,
  });
  return { kind: "deferred", result };
}

/**
 * The turn loop's `apply`-phase boundary action.
 *
 * Registered in the existing action array; the seam runs every `apply`-phase
 * action before every `trigger`-phase one STRUCTURALLY, so a requested cutover
 * always wins over a trigger that could supersede that very preparation.
 */
export function createCompactionApplyAction(input: ConsumeApplyInput): IterationBoundaryAction {
  return {
    name: "compaction_apply",
    phase: "apply",
    async run(): Promise<IterationBoundaryOutcome> {
      const outcome = await consumeApplyRequest(input);
      if (outcome.kind === "applied") {
        return {
          kind: "compaction_applied",
          generation: outcome.generation,
          archivedMessages: outcome.archivedMessages,
        };
      }
      if (outcome.kind === "deferred") {
        return {
          kind: "compaction_apply_deferred",
          reasons:
            outcome.result.kind === "money_state_blocked"
              ? outcome.result.reasons
              : [],
        };
      }
      return { kind: "continue" };
    },
  };
}
