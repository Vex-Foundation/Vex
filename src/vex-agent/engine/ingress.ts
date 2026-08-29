/**
 * Ingress router — the single entry point desktop hosts call when a user
 * message arrives for a session.
 *
 * Responsibilities:
 *   1. Cancel any pending `LoopDefer` wake for the session (user preempt).
 *   2. Re-check mission run / session state.
 *   3. Route the message to the right runtime:
 *        - `paused_wake` mission run → flip to `running` + save user msg +
 *          `resumeMissionRun` so the agent sees the preempt as the next user
 *          turn instead of a scheduled wake.
 *        - `running` / `paused_approval` mission run → persist the message
 *          as an interrupt; resume is driven by the approval flow, not here.
 *        - Everything else → `processAgentTurn` (agent / mission-setup).
 */

import type { TurnResult } from "./types.js";
import {
  processAgentTurn,
  processMissionSetupTurn,
  resumeMissionRun,
  type TurnRequestOptions,
} from "./core/runner.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import {
  addOperatorCue,
  addOperatorInstruction,
} from "./core/operator-instructions.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "./runtime/release-and-emit.js";

/**
 * `QUEUED_INTERRUPT_TEXT` is RETIRED (M6). It was a paragraph returned as
 * `TurnResult.text` from three different branches with three different
 * meanings, and it did not survive a reload. The acknowledgement is now a
 * durable, user-visible engine notice row written in the same transaction as
 * the instruction itself, with the disposition typed - see
 * `core/operator-instructions.ts`. These branches return `text: null` because
 * the acknowledgement is on the tape where the operator can still find it
 * tomorrow, not in a response object that is gone once rendered.
 */

/**
 * Why the run is parked, per stop reason, for the hint returned to a user who
 * typed at a `paused_error` run.
 *
 * CAUSE-SPECIFIC, because the generic sentence below CLAIMS a provider or
 * runtime error, and for these two reasons that claim is simply false: nothing
 * failed at the provider. `restart_orphan` was parked by the reclaim sweep
 * after Vex died mid-slice (M3); `tool_call_loop` was stopped by the detector
 * after repeating itself (M4). Keyed by the closed engine stop-reason union, so
 * an unnamed reason falls through to the generic wording rather than to a
 * wrong one.
 */
const PAUSED_ERROR_CAUSE_TEXT: Readonly<Record<string, string>> = {
  restart_orphan:
    "Run is paused because Vex restarted while it was executing. Steps already in flight"
    + " may or may not have completed.",
  tool_call_loop:
    "Run is paused because it repeated the same tool call without making progress.",
};

const PAUSED_ERROR_GENERIC_TEXT = "Run is paused after a provider/runtime error.";

/** The one shared tail: what was done with the message, and what clears it. */
const PAUSED_ERROR_TAIL =
  "I saved your instruction; use the Recover button to re-attempt.";

function pausedErrorText(stopReason: string | null): string {
  const cause =
    (stopReason === null ? undefined : PAUSED_ERROR_CAUSE_TEXT[stopReason])
    ?? PAUSED_ERROR_GENERIC_TEXT;
  return `${cause} ${PAUSED_ERROR_TAIL}`;
}

/**
 * Route an incoming user message to the correct runtime. Always cancels any
 * pending wake first so the freshly-typed user turn is not racing against a
 * banner injection for a stale wake.
 */
export async function routeUserMessage(
  sessionId: string,
  userInput: string,
  signal?: AbortSignal,
  options?: TurnRequestOptions,
): Promise<TurnResult> {
  const cancelled = await loopWakeRepo.cancelForSession(sessionId, "user_preempt");
  if (cancelled > 0) {
    logger.info("ingress.preempt_cancelled_wake", { sessionId, cancelled });
  }

  const activeRun = await missionRunsRepo.getActiveRunBySession(sessionId);

  if (activeRun) {
    if (activeRun.status === "paused_wake") {
      return resumeMissionRunWithPreempt(sessionId, userInput, activeRun.id);
    }
    if (activeRun.status === "paused_error") {
      // The run is parked because the previous loop threw. Persist the
      // user message so the operator's input is visible in transcript,
      // but return a clear hint instead of letting the shell render the
      // empty-fallback `(no text — stopReason: unknown)` string. The
      // operator drives recovery via the Recover button.
      // `queued_interrupt`, not `steered`: a run parked on an error is not
      // executing a turn, so nothing will merge this until the operator
      // recovers it.
      await addOperatorInstruction(sessionId, userInput, "queued_interrupt", {
        target: "mission_run",
        runId: activeRun.id,
        runStatus: activeRun.status,
      });
      await addOperatorCue(sessionId);
      logger.info("ingress.paused_error_hint", { sessionId, runId: activeRun.id });
      return {
        text: pausedErrorText(activeRun.stopReason),
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: "running",
      };
    }
    // `paused_approval` / `running` — persist the message as an interrupt
    // but do NOT fire a new turn here. Approvals resume through their own
    // flow (`approveAndResume`); a running run will pick up the message on
    // its next iteration.
    // `queued_interrupt` for BOTH statuses this branch covers. `running` looks
    // like a live turn, but this route (unlike `submitSteeringMessage`) never
    // established that a runner is actually executing one - `getActiveRunBySession`
    // reports a row status, not a live loop - and `paused_approval` is
    // definitively waiting on a human. The weaker, provable claim is the one
    // the operator gets told.
    await addOperatorInstruction(sessionId, userInput, "queued_interrupt", {
      target: "mission_run",
      runId: activeRun.id,
      runStatus: activeRun.status,
    });
    logger.info("ingress.user_interrupt_persisted", {
      sessionId,
      runId: activeRun.id,
      runStatus: activeRun.status,
    });
    return {
      text: null,
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: "running",
    };
  }

  // No active run — distinguish agent / mission-setup by mission presence.
  const mission = await missionsRepo.getActiveMission(sessionId);
  if (mission && mission.status !== "running") {
    return processMissionSetupTurn(sessionId, userInput, signal);
  }

  // Chat/agent turn — the only path that honours the chat-turn "stop
  // generating" signal (9-5a) and per-turn request options (S6). Mission
  // resume/interrupt/setup branches above ignore both — autonomous
  // iterations keep the uniform engine defaults.
  return processAgentTurn(sessionId, userInput, signal, options);
}

export async function submitOperatorInstruction(
  sessionId: string,
  userInput: string,
  signal?: AbortSignal,
  options?: TurnRequestOptions,
): Promise<TurnResult> {
  return routeUserMessage(sessionId, userInput, signal, options);
}

export type SteeringOutcome = "queued_live" | "no_active_turn";

/**
 * Steering (A33) — persist a user message into a LIVE turn for delivery at
 * the next tool-batch boundary. Fires no turn and interrupts nothing: the
 * row is an ordinary `operator_interrupt` transcript write (logged, and
 * emitted post-commit, before it can become model-visible), consumed by the
 * loop's existing batch-complete merge.
 *
 *   - Mission run `running`/`paused_approval` → the existing interrupt path.
 *   - Agent session with an active runner lease → same persist; the shared
 *     loop merges it (characterization: agent-steering-characterization).
 *   - Anything else (idle, parked `paused_*` states) → `no_active_turn`;
 *     the caller submits normally through `routeUserMessage` instead.
 *
 * At-least-on-tape: if the turn ends between the liveness probe and the
 * merge, the row is not lost — the next turn's hydration reads it as
 * ordinary context. Exactly one row per call; callers must not auto-retry.
 */
export async function submitSteeringMessage(
  sessionId: string,
  userInput: string,
): Promise<{ outcome: SteeringOutcome }> {
  const activeRun = await missionRunsRepo.getActiveRunBySession(sessionId);
  if (activeRun) {
    if (activeRun.status !== "running" && activeRun.status !== "paused_approval") {
      return { outcome: "no_active_turn" };
    }
    await addOperatorInstruction(sessionId, userInput, "steered", {
      target: "mission_run",
      runId: activeRun.id,
      runStatus: activeRun.status,
    });
    logger.info("ingress.steer_persisted", {
      sessionId,
      runId: activeRun.id,
      runStatus: activeRun.status,
    });
    return { outcome: "queued_live" };
  }

  const { getLease } = await import("@vex-agent/db/repos/runner-leases.js");
  const lease = await getLease(sessionId);
  if (lease === null || lease.expiresAt < new Date()) {
    return { outcome: "no_active_turn" };
  }
  await addOperatorInstruction(sessionId, userInput, "steered", { target: "agent_turn" });
  logger.info("ingress.steer_persisted", { sessionId, target: "agent_turn" });
  return { outcome: "queued_live" };
}

async function resumeMissionRunWithPreempt(
  sessionId: string,
  userInput: string,
  runId: string,
): Promise<TurnResult> {
  // Puzzle 03 — atomic claim lease + flip status. Replaces the
  // non-atomic `casFlipToRunning` + appendMessage pattern so a
  // concurrent IPC `requestResume` / retry / wake can't end up with
  // two runners writing to the same session (codex blocker #2 covers
  // this entry point).
  const ownerId = `ingress-preempt-${runId}`;
  const { claimRunLeaseAndFlipToRunning } = await import(
    "./runtime/lease-and-status.js"
  );
  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId,
    missionRunId: runId,
    fromStatuses: ["paused_wake"],
    ownerId,
    processKind: "electron_main",
    ttlMs: 5 * 60_000,
  });
  if (claim.outcome === "lease_busy" || claim.outcome === "status_mismatch") {
    logger.info("ingress.preempt_claim_lost", {
      sessionId,
      runId,
      outcome: claim.outcome,
    });
    // The preempt lost its race, so the wake was NOT preempted by us and the
    // run is not ours to resume. `queued_interrupt` is the truthful record of
    // what this call achieved: the row is on the tape and whoever won the
    // claim will read it.
    await addOperatorInstruction(sessionId, userInput, "queued_interrupt", {
      target: "mission_run",
      runId,
      runStatus: "claim_lost",
    });
    return {
      text: null,
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: "running",
    };
  }

  const { createLeaseHandle } = await import(
    "./runtime/lease-handle.js"
  );
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: 5 * 60_000,
  });
  try {
    await addOperatorInstruction(sessionId, userInput, "preempted_wake", {
      target: "mission_run",
      runId,
      preempt: "wake",
    });
    await addOperatorCue(sessionId);

    logger.info("ingress.preempt_resume", {
      sessionId,
      runId,
      previousStatus: claim.previousStatus,
      wakeCancelledCount: claim.wakeCancelledCount,
    });
    // `resumeMissionRun` refreshes tool_output_blob TTLs internally (PR-13
    // S-2), so we don't double-call here.
    return await resumeMissionRun(runId, ownerId);
  } finally {
    await releaseLeaseAndEmitControlState(handle, sessionId, {
      missionRunId: runId,
    });
  }
}
