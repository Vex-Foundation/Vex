/**
 * Runtime continuation helpers.
 *
 * `iteration_limit` and `timeout` are slice guards, not mission contract
 * outcomes. When an autonomous runtime slice is exhausted, schedule a
 * near-future wake so the executor can continue from a clean turn instead of
 * ending the work with a canned paragraph.
 *
 * TWO SHAPES OF CONTINUATION, one substrate:
 *
 *   - MISSION RUN (`missionRunId` set). The caller (`mission-finalize.ts`)
 *     parks the run row in `paused_wake`; the wake executor claims the RUN and
 *     resumes it.
 *   - AGENT SESSION (`missionRunId === null`, owner decision 2026-07-29). A
 *     Full-Autonomous agent chat has no run row at all, so there is nothing to
 *     park and nothing for the executor to claim by run status — the wake is
 *     session-scoped and the executor claims the SESSION LEASE instead. This
 *     is the whole reason `loop_wake_requests.mission_run_id` became nullable
 *     (migration 057).
 *
 * Counters reset by construction on both shapes: the woken turn is a fresh
 * `runTurnLoop`, so the iteration counter starts at 0 and the wall clock starts
 * now. Nothing carries the exhausted slice's state forward.
 *
 * Restricted sessions are deliberately NOT continued. Continuation is a
 * full-autonomy affordance; extending it silently to a session whose whole
 * point is a human in the loop would be an autonomy decision this module is not
 * entitled to make.
 */

import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import { currentDate } from "@vex-agent/engine/runtime-clock.js";
import logger from "@utils/logger.js";
import type { RuntimeStopReason, StopReason } from "../../types.js";

const AUTO_CONTINUE_AFTER_MS = 5_000;

export type ContinuableRuntimeStop = Extract<RuntimeStopReason, "iteration_limit" | "timeout">;

export interface RuntimeContinuationInput {
  sessionId: string;
  /**
   * `null` for a Full-Autonomous AGENT session — there is no mission run row to
   * reference, and the wake is claimed by session lease instead of run status.
   */
  missionRunId: string | null;
  trigger: ContinuableRuntimeStop;
}

export interface RuntimeContinuationResult {
  dueAt: string;
  enqueued: boolean;
}

export function isContinuableRuntimeStop(
  stopReason: StopReason | null,
): stopReason is ContinuableRuntimeStop {
  return stopReason === "iteration_limit" || stopReason === "timeout";
}

export async function scheduleRuntimeContinuation(
  input: RuntimeContinuationInput,
): Promise<RuntimeContinuationResult> {
  const dueAt = new Date(currentDate().getTime() + AUTO_CONTINUE_AFTER_MS);
  const reason = `${input.trigger}: runtime slice exhausted; continue autonomously`;

  const row = await loopWakeRepo.enqueue({
    sessionId: input.sessionId,
    missionRunId: input.missionRunId,
    dueAt,
    reason,
    payload: { trigger: input.trigger, automatic: true },
  });

  const pending = row ?? await loopWakeRepo.getPendingForSession(input.sessionId);
  const scheduledAt = pending?.dueAt ?? dueAt.toISOString();
  const action = row ? "scheduled" : "existing pending wake retained";

  await appendEngineMessage(
    input.sessionId,
    `[Engine: runtime_yield - ${input.trigger}; ${action}; next check: ${scheduledAt}]`,
    {
      source: "engine",
      messageType: "runtime_yield",
      visibility: "internal",
      payload: {
        trigger: input.trigger,
        dueAt: scheduledAt,
        enqueued: row !== null,
        missionRunId: input.missionRunId,
      },
    },
  );

  return { dueAt: scheduledAt, enqueued: row !== null };
}

// ── Session-scoped wake primitive ──────────────────────────────────

export interface SessionScopedWakeInput {
  readonly sessionId: string;
  readonly dueAt: Date;
  readonly reason: string;
  readonly payload: Record<string, unknown> | null;
  readonly abortSignal?: AbortSignal;
}

export type SessionScopedWakeOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "decided"; readonly row: Awaited<ReturnType<typeof loopWakeRepo.enqueue>> };

/**
 * Insert a session-scoped (`missionRunId: null`) pending wake, with the
 * operator-stop gate and the INSERT committing in ONE transaction under the
 * session control lock.
 *
 * This is the transactional core shared by the two things that can park a
 * Full-Autonomous AGENT session: the automatic slice-exhaustion continuation
 * below, and an explicit `loop_defer` from the model. Both need the identical
 * guarantee and neither may re-derive it: sampling the stop and then inserting
 * leaves a LIVE wake on a session the operator stopped, because the
 * compensating cancel races the very thing it compensates for. The long-form
 * rationale is in `scheduleAgentSessionContinuation`'s doc block.
 *
 * What differs between the two callers is only what they say afterwards — the
 * continuation appends a `runtime_yield` transcript marker, the defer carries
 * its own `defer_until` engine signal — so the transcript write deliberately
 * stays OUT of this primitive.
 */
export async function enqueueSessionScopedWake(
  input: SessionScopedWakeInput,
): Promise<SessionScopedWakeOutcome> {
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../runtime/lease-and-status.js"
  );

  return withSessionControlLock(input.sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: null,
    });
    // Fail-closed on either signal, re-read INSIDE the transaction. Nothing is
    // inserted for a session the operator stopped, so there is nothing to
    // compensate for afterwards.
    if (gate.kind === "stopped" || input.abortSignal?.aborted === true) {
      return { kind: "stopped" as const };
    }
    const row = await loopWakeRepo.enqueue(
      {
        sessionId: input.sessionId,
        missionRunId: null,
        dueAt: input.dueAt,
        reason: input.reason,
        payload: input.payload,
      },
      client,
    );
    return { kind: "decided" as const, row };
  });
}

// ── Agent-session continuation ─────────────────────────────────────

export interface AgentSessionContinuationInput {
  readonly sessionId: string;
  readonly trigger: ContinuableRuntimeStop;
  /**
   * The slice's cancellation signal — the interactive turn's "stop generating"
   * signal, or the session-slice controller for a wake-driven slice. For a
   * session with no run row this, not a run-scoped `stop_terminal` row, is what
   * an operator Stop actually looks like today.
   */
  readonly abortSignal?: AbortSignal;
  /** Backoff attempt for a re-scheduled wake; omitted for a first schedule. */
  readonly attempt?: number;
  /** Overrides the 5 s default (the executor's lease-busy backoff uses this). */
  readonly delayMs?: number;
}

export interface AgentSessionContinuationResult {
  /** True only when a wake is actually live for this session. */
  readonly scheduled: boolean;
  readonly dueAt: string;
}

/**
 * Schedule the continuation of a Full-Autonomous AGENT session.
 *
 * ## The decision and the INSERT are ONE transaction
 *
 * The earlier shape sampled cancellation, then enqueued, then re-checked and
 * cancelled if it had lost — a pre-sample. A cancellation landing immediately
 * after the sample left a LIVE wake on a session the operator had stopped,
 * because the compensating cancel raced the very thing it was compensating for.
 *
 * There is no reason to carry that window here. A mission run must enqueue
 * before its park because the park is a SECOND durable write (the run row) that
 * can fail independently. An agent session has no run row: the wake row IS the
 * entire park. So the gate, the cancellation re-check, and the INSERT all commit
 * together under the session control lock. Either the stop is visible to this
 * transaction and no row is ever inserted, or this transaction committed first
 * and the stop's own wake cancellation — which runs under the same lock —
 * observes the row and cancels it. No compensating write, no window.
 *
 * `gateOnOperatorStopWithClient` is called even though it is `clear` by
 * construction for a session with no run (`stop_terminal` is run-scoped and no
 * chat turn mints one). It is not ceremony: it takes the canonical lock in the
 * canonical order, so this decision is serialized against every other holder
 * instead of being a read of the past, and the site is already correct on the
 * day a session-scoped stop request exists.
 *
 * The transcript marker is appended AFTER the transaction commits — the
 * emit-after-commit rule: a `runtime_yield` message implies a wake a reader can
 * fetch, so it must not precede the row.
 */
export async function scheduleAgentSessionContinuation(
  input: AgentSessionContinuationInput,
): Promise<AgentSessionContinuationResult> {
  const delayMs = input.delayMs ?? AUTO_CONTINUE_AFTER_MS;
  const dueAt = new Date(currentDate().getTime() + delayMs);
  const reason = `${input.trigger}: runtime slice exhausted; continue autonomously`;

  const outcome = await enqueueSessionScopedWake({
    sessionId: input.sessionId,
    dueAt,
    reason,
    payload: {
      trigger: input.trigger,
      automatic: true,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    },
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
  });

  if (outcome.kind === "stopped") {
    logger.info("engine.agent.runtime_continuation_declined_stopped", {
      sessionId: input.sessionId,
      trigger: input.trigger,
    });
    return { scheduled: false, dueAt: dueAt.toISOString() };
  }

  // `null` means a pending wake already existed for this session (the partial
  // unique index). A continuation IS live either way — that is what `scheduled`
  // reports — but it is not one we inserted.
  const pending = outcome.row
    ?? await loopWakeRepo.getPendingForSession(input.sessionId);
  const scheduledAt = pending?.dueAt ?? dueAt.toISOString();
  const action = outcome.row ? "scheduled" : "existing pending wake retained";

  await appendEngineMessage(
    input.sessionId,
    `[Engine: runtime_yield - ${input.trigger}; ${action}; next check: ${scheduledAt}]`,
    {
      source: "engine",
      messageType: "runtime_yield",
      visibility: "internal",
      payload: {
        trigger: input.trigger,
        dueAt: scheduledAt,
        enqueued: outcome.row !== null,
        missionRunId: null,
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
    },
  );

  return { scheduled: pending !== null, dueAt: scheduledAt };
}
