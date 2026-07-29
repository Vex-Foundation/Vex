/**
 * Approval runtime — the two SAFE resolutions of an incomplete approval
 * lifecycle, in ONE place so the fast in-process paths and the five-minute
 * reconciler cannot disagree about them:
 *
 *   approved + not_started    → dispatch now. `not_started` PROVES the tool
 *                               never ran (the dispatch CAS is its only exit),
 *                               so running it is safe and is exactly what the
 *                               user asked for. This is the state a busy
 *                               session lease at decision time leaves behind.
 *
 *   result exists, unconsumed → the outcome is already recorded and the
 *                               approved tool is NEVER re-run to "check".
 *                               What is missing is the agent's observation of
 *                               it, and delivering that means running a FULL
 *                               agent turn — not a side-effect-free wake. In
 *                               Full Autonomous that turn MAY make new,
 *                               model-selected tool calls, including mutating
 *                               ones. That is accepted autonomy (owner
 *                               decision, 2026-07-28), not a defect: the same
 *                               is true of any turn the agent runs. Say it out
 *                               loud so nobody plans on "resume is harmless".
 *
 * Both are lease-aware: each begins by claiming the session/run continuation,
 * and a busy claim changes nothing at all — it means "another runner owns this
 * session, come back later", which is why every caller can afford to give up
 * cheaply and let the next attempt path try.
 *
 * The third, unsafe state — `dispatching`, where the tool MAY have run —
 * deliberately does NOT live here. Judging it needs a row lock plus a live
 * lease read, and only the reconciler performs that; no fast path may ever
 * guess at an outcome it cannot prove.
 */

import { withTransaction } from "../../../db/client.js";
import type { ApprovalLifecycleRow } from "../../../db/repos/approval-intents.js";
import logger from "@utils/logger.js";

import { claimResumeContinuation, runResumeAfterDecision } from "./continuation.js";
import { toIso } from "./helpers.js";
import { lockAndLoadSnapshot } from "./snapshot/compare.js";

/**
 * What this pass did with one row.
 *
 * `lease_held` is not a failure — it is the lease doing its job, and because a
 * lease is session-scoped it tells a session-scoped caller that every remaining
 * row for that session will say the same thing, so stopping early is correct.
 *
 * `run_not_resumable` is the opposite kind of fact and MUST NOT be collapsed
 * into it: this row's mission run has left the claimable statuses, which says
 * nothing about the next row (one session can own several runs, and chat rows
 * have no run at all). Collapsing the two is what let a single row that can
 * never be resumed stop the fast worker for an entire session, while the
 * age-ordered sweep kept re-selecting the same head of the queue.
 */
export type LifecycleRowOutcome =
  | "dispatched"
  | "resumed"
  | "lease_held"
  | "run_not_resumable"
  | "noop";

/**
 * Resolve one incomplete lifecycle row, if it is in one of the two states that
 * can be resolved without proving an unknowable outcome. Anything else is a
 * `noop` here and is left to the reconciler.
 */
export async function applyResumableLifecycleRow(
  row: ApprovalLifecycleRow,
): Promise<LifecycleRowOutcome> {
  // A committed result that nothing consumed is the cheapest and safest fix,
  // and it applies to approvals AND rejections. Check it first so a settled
  // execution is never mistaken for an incomplete one.
  if (row.resultMessageId !== null && row.resumeConsumedAt === null) {
    return resumeLifecycleRow(row);
  }

  if (row.decision === "approved" && row.executionStatus === "not_started") {
    return dispatchNeverStarted(row);
  }

  return "noop";
}

/**
 * Claim the session and deliver the wake.
 *
 * The two non-`resumed` answers are kept apart on purpose — see
 * `LifecycleRowOutcome`. `lease_held` means "come back in a moment";
 * `run_not_resumable` means "this row cannot move until its run does".
 */
export async function resumeLifecycleRow(
  row: ApprovalLifecycleRow,
): Promise<"resumed" | "lease_held" | "run_not_resumable"> {
  const claim = await claimResumeContinuation({
    sessionId: row.sessionId,
    missionRunId: row.missionRunId,
    approvalId: row.approvalId,
    ownerPrefix: "resume",
  });
  if (claim.outcome === "busy") return "lease_held";
  if (claim.outcome === "status_mismatch") {
    // ── SEAM — user-facing exhaustion is a PRODUCT DECISION, not taken here ──
    //
    // What this branch does: skip the row and let the scans sort it last
    // (`APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES`). Deprioritised,
    // never destroyed — and deliberately not marked terminal, because most of
    // these runs come back. `paused_error`, `paused_user`, `paused_wake` and
    // `paused_plan_acceptance` are all operator-recoverable: the moment the run
    // returns to a claimable status this same pass delivers the wake. A row
    // marked terminal on first sight would have thrown that recovery away.
    //
    // What is NOT decided here, and is owed by the owner: whether an approval
    // whose run is genuinely terminal (`cancelled` / `failed` / `stopped` /
    // `completed`) is ever declared permanently exhausted, after how long, and
    // WHAT THE USER AND THE AGENT ARE TOLD when it is. That copy sits on a money
    // path and has to distinguish "your approved action never ran" from "it ran
    // and nobody can say what happened" — the `indeterminate` message next door
    // shows how carefully that has to be worded — so none is invented here.
    // Implementing it means all three of: a durable terminal marker on the row,
    // an agent-visible transcript message, and a scan predicate that stops
    // selecting it. Any one alone reintroduces a defect.
    logger.info("engine.approval_runtime.resume_run_not_resumable", {
      sessionId: row.sessionId,
      missionRunId: row.missionRunId,
      approvalId: row.approvalId,
      currentStatus: claim.currentStatus,
    });
    return "run_not_resumable";
  }
  await runResumeAfterDecision(claim.continuation);
  return "resumed";
}

/**
 * `approved` + `not_started`: the approve committed but the dispatch slot was
 * never taken (busy lease at decision time, or a crash in between). Replaying
 * the normal approve side effects is safe precisely because they begin with
 * the same claim and the same CAS — if another writer has since taken the
 * slot, this call defers instead of dispatching.
 *
 * `post-tx.js` is imported lazily to keep the module graph one-way: the
 * dispatch path arms the deferred worker, and the deferred worker replays the
 * dispatch path.
 */
async function dispatchNeverStarted(
  row: ApprovalLifecycleRow,
): Promise<LifecycleRowOutcome> {
  const snapshotRow = await withTransaction((client) =>
    lockAndLoadSnapshot(client, row.approvalId),
  );
  // The intent's queue/session join is gone, so there is nothing to dispatch and
  // no retry that recovers it. Reporting that as `lease_held` used to stop the
  // whole session's pass on a row that can never move again.
  if (snapshotRow === null) {
    logger.info("engine.approval_runtime.dispatch_snapshot_missing", {
      sessionId: row.sessionId,
      approvalId: row.approvalId,
    });
    return "noop";
  }

  const { applyApproveSideEffects } = await import("./post-tx.js");
  const outcome = await applyApproveSideEffects(row.approvalId, {
    type: "approved_in_tx",
    row: snapshotRow,
    queueResolvedAt: toIso(
      snapshotRow.queue_resolved_at ?? new Date().toISOString(),
    ),
  });

  if (outcome.kind === "deferred_busy") return "lease_held";
  if (outcome.kind === "dispatched" && outcome.continuation !== null) {
    await runResumeAfterDecision(outcome.continuation);
  }
  return "dispatched";
}
