/**
 * Approval runtime — continuation lifecycle.
 *
 * `claimResumeContinuation` produces a `PreparedContinuation`: for a mission
 * run via the lease-and-status helper (`paused_approval → running` flip + lease
 * acquisition in one tx), for an Agent-Restricted chat session via a plain
 * session lease. `runResumeAfterDecision` consumes it exactly once (lease
 * released in finally). `discardContinuation` is the idempotent fallback when
 * the caller cannot schedule.
 *
 * Codex puzzle-5 phase-3 review point 1 — lease ownership lives end-to-end
 * in this module so prepare callers cannot leak it.
 *
 * The claim is deliberately taken BEFORE the approved tool is dispatched. A
 * busy lease then means "nothing has happened yet, come back later" instead of
 * "the funds moved but we cannot tell the user" — which is what the old
 * dispatch-then-claim order produced.
 */

import * as approvalIntentsRepo from "../../../db/repos/approval-intents.js";
import {
  APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES,
  type MissionRunStatus,
  type ResumedTurnClaim,
  type TurnResult,
} from "../../types.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import { LEASE_TTL_MS } from "./helpers.js";
import { appendApprovalResolvedCueOnce } from "./resume-cue.js";
import { isTerminalStudioState } from "./studio/terminal-state.js";
import {
  continuationHoldsLease,
  type PreparedContinuation,
} from "./types.js";

/**
 * Claim outcome. `busy` is transient — another runner holds the session lease,
 * so the work is deferred and retried (in-process backoff, the end-of-turn
 * hook, then the reconciler). `status_mismatch` is NOT transient in the same
 * sense: the mission run has left `RESUME_CLAIMABLE_RUN_STATUSES`, and only the
 * run moving can change that, so retrying on a timer accomplishes nothing.
 *
 * The two must never be collapsed by a caller. `busy` is a statement about the
 * SESSION (every row of it is equally blocked, so a session-scoped pass may stop
 * early); `status_mismatch` is a statement about ONE run (the next row may be a
 * different run, or a chat row with no run at all). Treating a mismatch as a
 * busy lease is what let one permanently-unresumable row stall a whole session.
 */
export type ClaimResumeOutcome =
  | { readonly outcome: "claimed"; readonly continuation: PreparedContinuation }
  | { readonly outcome: "busy" }
  | {
      readonly outcome: "status_mismatch";
      /** `null` when the run row itself has gone (deleted / never existed). */
      readonly currentStatus: MissionRunStatus | null;
    };

export interface ClaimResumeInput {
  readonly sessionId: string;
  /** `null` for an Agent-Restricted chat session — there is no run to flip. */
  readonly missionRunId: string | null;
  readonly approvalId: string;
  /** Tags the lease owner: `approve` / `reject` / `expire` / `policy_drift`. */
  readonly ownerPrefix: string;
  /**
   * A3 - which surface enqueued the intent. `studio_mcp` takes the third arm
   * below; every other value is an agent approval and behaves exactly as before.
   */
  readonly origin?: "agent" | "studio_mcp";
  /** Studio only - carried through so the settlement event can name it. */
  readonly projectId?: string | null;
}

export async function claimResumeContinuation(
  input: ClaimResumeInput,
): Promise<ClaimResumeOutcome> {
  // A3 - the Studio arm, keyed on the row's ORIGIN and nothing else. It takes
  // no lease (see `StudioContinuation`), so it cannot report `busy` and a
  // Studio approval can never be deferred behind an in-app agent turn on the
  // same backing session. Its exclusivity is the per-intent dispatch CAS.
  if (input.origin === "studio_mcp") {
    return {
      outcome: "claimed",
      continuation: {
        kind: "studio_mcp",
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        projectId: input.projectId ?? null,
      },
    };
  }
  const ownerId = `${input.ownerPrefix}-${input.approvalId}`;
  return input.missionRunId === null
    ? claimChatSessionResume(input, ownerId)
    : claimMissionRunResume(input, input.missionRunId, ownerId);
}

async function claimMissionRunResume(
  input: ClaimResumeInput,
  missionRunId: string,
  ownerId: string,
): Promise<ClaimResumeOutcome> {
  const { claimRunLeaseAndFlipToRunning } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId: input.sessionId,
    missionRunId,
    // Shared with the lifecycle scans' fairness ordering, which sorts rows
    // outside this set last. A drift between the gate here and the ordering
    // there would deprioritise rows that are in fact claimable.
    fromStatuses: APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    logger.warn("engine.approval_runtime.lease_busy", {
      sessionId: input.sessionId,
      missionRunId,
      ownerId,
    });
    return { outcome: "busy" };
  }
  if (claim.outcome === "status_mismatch") {
    logger.warn("engine.approval_runtime.status_mismatch", {
      sessionId: input.sessionId,
      missionRunId,
      ownerId,
      currentStatus: claim.currentStatus,
    });
    return { outcome: "status_mismatch", currentStatus: claim.currentStatus };
  }
  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const leaseHandle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  return {
    outcome: "claimed",
    continuation: {
      kind: "mission_run",
      missionRunId,
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      leaseHandle,
      ownerId,
    },
  };
}

async function claimChatSessionResume(
  input: ClaimResumeInput,
  ownerId: string,
): Promise<ClaimResumeOutcome> {
  const { claimSessionLease } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimSessionLease({
    sessionId: input.sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    logger.warn("engine.approval_runtime.chat_lease_busy", {
      sessionId: input.sessionId,
      ownerId,
    });
    return { outcome: "busy" };
  }
  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const leaseHandle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  return {
    outcome: "claimed",
    continuation: {
      kind: "chat_session",
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      leaseHandle,
      ownerId,
    },
  };
}

/**
 * Run the resumed work under the held lease. Owns lease release in its finally
 * block. MUST be called at most once per `PreparedContinuation`; if the caller
 * cannot schedule, call `discardContinuation` instead.
 *
 * TWO DIFFERENT FACTS, KEPT APART — conflating them is what broke this twice:
 *
 *   IN PROGRESS  is the runner lease. Every resume path claims the session/run
 *                lease before its first side effect and holds it until after
 *                the completion marker below, so two resumes for one session
 *                cannot overlap. Nothing in the database expresses this, and
 *                nothing should: a durable "started" flag can only be cleared
 *                by guessing when its writer died, and that judgement is
 *                exactly what the lease already makes correctly.
 *
 *   COMPLETED    is `resume_consumed_at`, stamped HERE and only after the turn
 *                core has durably returned. It is the sole terminator of
 *                resume eligibility, and it exists to stop a LATER,
 *                non-overlapping pass — the end-of-turn hook, the reconciler —
 *                from waking the agent again for a result it already observed.
 *
 * The consequence is the property the lifecycle was missing: a failure ANYWHERE
 * — provider resolution, the cue, the run status flip, hydration, prompt and
 * tool construction, the model call, finalization — leaves `resume_consumed_at`
 * null, so the approval is still in every recovery scan and a later sweep
 * resumes it. Moving the stamp from "before the fallible work" to "when the
 * core begins" only moved that window; only completion closes it.
 *
 * REPLAY SEMANTICS, STATED HONESTLY (owner decision, 2026-07-28). The window
 * this leaves open is real: if the completion CAS itself fails AFTER the turn
 * core has returned, recovery runs a FULL agent turn again. It is not a
 * "redundant wake" and it is not side-effect free — in Full Autonomous the
 * replayed turn MAY make new, model-selected tool calls, including mutating
 * ones. The APPROVED tool is not re-dispatched (that is the dispatch CAS's
 * job); the agent's next actions are simply the agent's next actions. This is
 * accepted as autonomy rather than treated as a defect, so do not "fix" it by
 * stamping completion earlier — that trade costs a permanently lost resume on
 * every crash, which is the strictly worse failure.
 *
 * The marker is written before the `finally`, i.e. while the lease is still
 * held. The end-of-turn hook below fires strictly after the release and so
 * always sees the completed row — a resumed turn cannot re-trigger itself.
 */
export async function runResumeAfterDecision(
  cont: PreparedContinuation,
): Promise<TurnResult> {
  // A3 - the Studio case runs NO TURN. The approved call already dispatched and
  // its settlement already committed inside `applyApproveSideEffects`; what is
  // left is to tell the blocked MCP request that a durable answer exists. It
  // deliberately does not touch `resume_consumed_at`: that column terminates
  // AGENT resume eligibility, and a Studio row is filtered out of every scan
  // that reads it, so writing it would record a resume that never existed.
  if (cont.kind === "studio_mcp") {
    return runStudioSettlementAnnounce(cont);
  }
  try {
    // Attempt audit — deliberately not a gate. A crash between this stamp and
    // the core starting must still recover, so nothing may read `resumed_at` as
    // proof of a resume.
    await approvalIntentsRepo.markResumeAttempted(cont.approvalId);

    const claimTurn = buildOutstandingResumeGuard(cont);

    const result =
      cont.kind === "chat_session"
        ? await runChatSessionResume(cont, claimTurn)
        : await runMissionRunResume(cont, claimTurn);

    // The COMPLETION marker. The CAS predicate is what keeps this honest on the
    // abandoned path too: when the guard above vetoed the turn the column is
    // already set, so this is a no-op rather than a fabricated completion.
    const recorded = await approvalIntentsRepo.casMarkResumeConsumed(
      cont.approvalId,
    );
    if (!recorded) {
      logger.info("engine.approval_runtime.resume_completion_already_recorded", {
        sessionId: cont.sessionId,
        approvalId: cont.approvalId,
        kind: cont.kind,
      });
    }

    return result;
  } finally {
    await releaseLeaseAndEmitControlState(
      cont.leaseHandle,
      cont.sessionId,
      cont.kind === "mission_run"
        ? { missionRunId: cont.missionRunId }
        : undefined,
    );
    // The end-of-turn resume hook fires inside that helper. A resumed turn
    // holds the session lease exactly like an ordinary one, so a SECOND
    // approval resolved while this one was running is picked up there instead
    // of waiting out the retry ladder — including when THIS turn was itself
    // started by a resume pass that is still running, in which case the hook
    // queues one coalesced follow-up pass rather than being dropped. It cannot
    // run away on THIS approval: the completion marker was written above,
    // BEFORE the release, so the hook always observes an approval that has left
    // the eligibility scan.
  }
}

async function runMissionRunResume(
  cont: Extract<PreparedContinuation, { kind: "mission_run" }>,
  claimTurn: ResumedTurnClaim,
): Promise<TurnResult> {
  const { resumeMissionRun } = await import("../runner/mission.js");
  return resumeMissionRun(cont.missionRunId, cont.ownerId, claimTurn);
}

/**
 * The stale-snapshot guard, packaged as the hook the lease-held turn core calls
 * at the moment it begins consuming. `false` abandons the turn.
 *
 * It is a READ, not a claim. The attempt that got here was selected from a row
 * snapshot taken BEFORE the lease was claimed, and in that gap an earlier
 * attempt may have resumed the agent and finished; this asks whether that
 * happened. It must not be a write: a marker written here would once again make
 * "a resume started" indistinguishable from "a resume finished", which is the
 * defect this whole shape exists to remove.
 *
 * No exclusion is needed at this point. The caller holds the session/run lease
 * for the entire turn, so no concurrent resume can complete between this read
 * and the completion marker.
 */
function buildOutstandingResumeGuard(
  cont: PreparedContinuation,
): ResumedTurnClaim {
  return async () => {
    const alreadyCompleted = await approvalIntentsRepo.hasResumeCompleted(
      cont.approvalId,
    );
    if (alreadyCompleted) {
      logger.info("engine.approval_runtime.resume_already_consumed", {
        sessionId: cont.sessionId,
        approvalId: cont.approvalId,
        kind: cont.kind,
      });
    }
    return !alreadyCompleted;
  };
}

/**
 * Chat-session resume — the fix for Agent-Restricted sessions, where an
 * approved tool used to execute, record its result, and then leave the agent
 * asleep forever because the continuation was only ever claimed for a mission
 * run.
 *
 * The engine cue is appended through `appendApprovalResolvedCueOnce`, which is
 * bound to the approval rather than to this attempt. Ordering it behind the
 * guard would not be enough: eligibility now ends at COMPLETION, so an attempt
 * that died mid-turn is legitimately retried, and only an idempotent cue keeps
 * the prompt contract from announcing the same resolved approval twice.
 *
 * ## The stop ordering lives in `gated-session-turn.ts`, not here
 *
 * This path is reached from the reconciler too: `resolveAbandonedDispatch`
 * resolves an abandoned `approved + dispatching` row to `indeterminate`, writes
 * the result and calls `resumeLifecycleRow` DIRECTLY. It never passes through
 * `claimDispatchSlotUnderStopGate`, so before that ordering existed a Stop
 * committed while the row sat abandoned was correctly written and durably
 * retained — and then ignored, because nothing on this path read it. A full
 * turn ran on a session the operator had stopped.
 *
 * The launch-form resume had the identical defect on its own path, which is
 * why the ordering is a shared primitive rather than a pattern each caller
 * re-types. This function supplies only what is approval-SPECIFIC: the lease
 * owner it already holds, the resumed-turn guard, and the idempotent cue —
 * ordered behind the gate so a stopped session is never told about a
 * resolution it will not act on.
 *
 * The lease is claimed by `claimChatSessionResume` and released by
 * `runResumeAfterDecision`'s `finally`; the primitive never touches it.
 */
async function runChatSessionResume(
  cont: Extract<PreparedContinuation, { kind: "chat_session" }>,
  claimTurn: ResumedTurnClaim,
): Promise<TurnResult> {
  const { runStopGatedSessionTurn } = await import(
    "../runner/gated-session-turn.js"
  );
  return runStopGatedSessionTurn({
    sessionId: cont.sessionId,
    // The continuation carries the lease this resume runs under, so the turn
    // loop can prove ownership for a compaction cutover.
    runnerOwnerId: cont.ownerId,
    claimTurn,
    logScope: "approval_resume",
    // Ordered AFTER the gate on purpose: a stopped session must not have a cue
    // appended announcing a resolution it will never act on.
    beforeTurn: () =>
      appendApprovalResolvedCueOnce(cont.sessionId, cont.approvalId),
  });
}

/**
 * Idempotent lease release for callers that cannot schedule the
 * continuation (process shutdown, dispatch helper failure). The underlying
 * `LeaseHandle.release` is itself idempotent, so double-call is safe.
 */
export async function discardContinuation(
  cont: PreparedContinuation,
): Promise<void> {
  // Nothing to release: the Studio arm holds no lease. The settlement row is
  // already durable, so a discarded Studio continuation costs the waiter its
  // early notification and nothing else - its own expiry timer and the
  // scheduled sweep are the durable floor.
  if (!continuationHoldsLease(cont)) return;
  await releaseLeaseAndEmitControlState(
    cont.leaseHandle,
    cont.sessionId,
    cont.kind === "mission_run"
      ? { missionRunId: cont.missionRunId }
      : undefined,
  );
}

/**
 * The Vex Studio "resume": announce a durable settlement, run no turn.
 *
 * The row is read AFTER the settling transaction has committed, so the outcome
 * this emits is committed truth rather than the dispatcher's in-memory belief,
 * and it emits NOTHING unless that row is TERMINAL.
 * A row that has vanished (only possible if its whole approval was deleted)
 * emits nothing: there is no answer to announce, and the blocked call falls
 * back to its own expiry.
 *
 * `TurnResult` is the shape every continuation returns; a Studio settlement
 * made no model call, dispatched no tool from a TURN, and enqueued no approval,
 * so every field is the honest zero. It is not a stopped turn either, which is
 * why `stopReason` stays null.
 */
async function runStudioSettlementAnnounce(
  cont: Extract<PreparedContinuation, { kind: "studio_mcp" }>,
): Promise<TurnResult> {
  const idle: TurnResult = {
    text: null,
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: null,
  };
  const { getStudioSettlementByApprovalId } = await import(
    "../../../db/repos/approval-intents.js"
  );
  const row = await getStudioSettlementByApprovalId(cont.approvalId);
  if (row === null) {
    logger.warn("engine.studio.settlement_row_missing", {
      approvalId: cont.approvalId,
    });
    return idle;
  }
  // READ BEFORE EMIT, and emit ONLY for a terminal row. The approval commits
  // before the dispatch, so this can legitimately run while the row is still
  // `approved/not_started` or `approved/dispatching` - announcing that would
  // release a blocked external agent with an answer for an action still on its
  // way. The writer that makes the row terminal announces it, and the broker's
  // periodic durable read is the floor under a lost announce.
  if (
    !isTerminalStudioState({
      decision: row.decision,
      executionStatus: row.executionStatus,
    })
  ) {
    logger.warn("engine.studio.settlement_announce_skipped_non_terminal", {
      approvalId: cont.approvalId,
      executionStatus: row.executionStatus,
    });
    return idle;
  }
  const { emitStudioSettlement } = await import(
    "../../runtime/studio-settlement-bus.js"
  );
  emitStudioSettlement({
    approvalId: cont.approvalId,
    projectId: row.projectId ?? cont.projectId,
    outcome: studioOutcomeFromRow(row.decision, row.executionStatus),
  });
  return idle;
}

/**
 * Map the row's own state to the bounded outcome enum. The decision comes
 * first: a row that was never approved cannot have dispatched, whatever its
 * execution status says.
 */
function studioOutcomeFromRow(
  decision: string | null,
  executionStatus: string,
): "settled" | "rejected" | "dispatch_failed" | "indeterminate" {
  if (decision !== "approved") return "rejected";
  if (executionStatus === "succeeded" || executionStatus === "failed") {
    // `failed` here is a CONTROLLED tool failure: the call ran and reported an
    // error, which is a real answer the agent must receive whole. Only a
    // dispatch that could not be carried out is `dispatch_failed`.
    return "settled";
  }
  if (executionStatus === "indeterminate") return "indeterminate";
  return "dispatch_failed";
}
