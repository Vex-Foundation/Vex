/**
 * Integration: the Full-Autonomous AGENT-SESSION continuation, proven against
 * real Postgres.
 *
 * A mocked `db/client.js` cannot demonstrate any of this. With one fake client
 * there is no advisory-lock queue, no second connection, no snapshot boundary
 * and no partial unique index — so "the cancellation was visible to the
 * enqueue", "the wake survived a busy lease", and "the row is really gone" are
 * all unrepresentable. This file drives the real substrate and asserts on what
 * Postgres actually committed.
 *
 * It also exercises migration 057 for real: the whole point is a
 * `loop_wake_requests` row with a NULL `mission_run_id`, which the pre-057
 * schema rejects outright. The session-scoped STOP needed no migration at all —
 * `runtime_control_requests.mission_run_id` has been nullable since 022.
 *
 * Three interleavings, one per round-8 finding:
 *   (a) wake due + session lease BUSY → the continuation SURVIVES (a
 *       replacement row is pending) and fires once the lease is released.
 *   (b) operator Stop during a wake-driven slice → the slice observes it.
 *   (c) cancellation racing the enqueue → no live wake is left behind.
 *
 * The LLM is never called: `deps.continueAgentSession` is the injected seam, so
 * this is the real control plane with a mock slice — the same split the unit
 * deps use.
 *
 * Companion to `plan-acceptance-park-stop-consumer.int.test.ts`; same fixtures,
 * same `EMBEDDING_BASE_URL` requirement from the shared globalSetup.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { query, execute } from "@vex-agent/db/client.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { claimSessionLease } from "@vex-agent/engine/runtime/lease-and-status.js";
import { scheduleAgentSessionContinuation } from "@vex-agent/engine/core/runner/runtime-continuation.js";
import {
  enqueueSessionStopRequest,
  gateOnOperatorStopTransaction,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  abortSessionSliceLocal,
  registerSessionSliceAbortController,
  unregisterSessionSliceAbortController,
} from "@vex-agent/engine/runtime/session-slice-abort.js";
import { tick, type WakeDeps } from "@vex-agent/engine/wake/executor.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

interface WakeRow {
  readonly id: string;
  readonly mission_run_id: string | null;
  readonly status: string;
  readonly payload: Record<string, unknown> | null;
}

async function readWakes(sessionId: string): Promise<WakeRow[]> {
  return query<WakeRow>(
    `SELECT id, mission_run_id, status, payload
       FROM loop_wake_requests WHERE session_id = $1
       ORDER BY created_at ASC`,
    [sessionId],
  );
}

async function pendingWakes(sessionId: string): Promise<WakeRow[]> {
  return (await readWakes(sessionId)).filter((w) => w.status === "pending");
}

/** Open (pending|observed) SESSION-scoped stop requests. */
async function openStopRequests(sessionId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    `SELECT id FROM runtime_control_requests
       WHERE session_id = $1 AND kind = 'stop_terminal'
         AND mission_run_id IS NULL AND status IN ('pending','observed')`,
    [sessionId],
  );
}

function makeDeps(overrides: Partial<WakeDeps> = {}): WakeDeps {
  return {
    claimDue: (now, limit) => loopWakeRepo.claimDue(now, limit),
    getMissionRun: vi.fn().mockResolvedValue(null),
    casFlipToRunning: vi.fn().mockResolvedValue(null),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
    continueAgentSession: vi.fn().mockResolvedValue(undefined),
    isProviderReady: () => true,
    ...overrides,
  };
}

describe("agent-session continuation (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── Migration 057 ────────────────────────────────────────────

  it("persists a session-scoped wake with a NULL mission_run_id", async () => {
    const sessionId = await makeSession();

    const result = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });

    expect(result.scheduled).toBe(true);
    const wakes = await pendingWakes(sessionId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.mission_run_id).toBeNull();
    expect(wakes[0]!.payload).toMatchObject({
      trigger: "iteration_limit",
      automatic: true,
    });

    // The transcript marker landed AFTER the row (emit-after-commit).
    // `message_type` is a real column — only `metadata.payload` reaches the
    // JSONB column (see db/repos/messages/write.ts).
    const markers = await query(
      "SELECT id FROM messages WHERE session_id = $1 AND message_type = 'runtime_yield'",
      [sessionId],
    );
    expect(markers).toHaveLength(1);
  });

  // ── (a) lease busy must not lose the continuation ─────────────

  it("a BUSY session lease re-schedules the wake instead of dropping it", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });
    // Make the row due.
    await execute(
      "UPDATE loop_wake_requests SET due_at = NOW() - interval '1 second' WHERE session_id = $1",
      [sessionId],
    );

    // Unrelated work holds the session lease — an approval resume, the
    // end-of-turn hook, anything. NOT this continuation.
    const held = await claimSessionLease({
      sessionId,
      ownerId: "unrelated-approval-resume",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    expect(held.outcome).toBe("claimed");

    const deps = makeDeps();
    const results = await tick(new Date(), 10, deps);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toMatchObject({
      kind: "rescheduled_lease_busy",
      attempt: 1,
      scheduled: true,
    });
    // Nothing ran against a session someone else is driving.
    expect(deps.continueAgentSession).not.toHaveBeenCalled();

    // THE POINT: the continuation still exists. The original row is consumed
    // (claimDue is one-way), but a replacement is pending with the attempt
    // counter, so the session is not silently abandoned.
    const all = await readWakes(sessionId);
    expect(all.filter((w) => w.status === "consumed")).toHaveLength(1);
    const pending = all.filter((w) => w.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.mission_run_id).toBeNull();
    expect(pending[0]!.payload).toMatchObject({ attempt: 1 });
  });

  it("the re-scheduled wake FIRES once the lease is released", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });
    await execute(
      "UPDATE loop_wake_requests SET due_at = NOW() - interval '1 second' WHERE session_id = $1",
      [sessionId],
    );

    await claimSessionLease({
      sessionId,
      ownerId: "unrelated-holder",
      processKind: "electron_main",
      ttlMs: 60_000,
    });

    /**
     * Captured from INSIDE the slice: the owner the executor passed, next to
     * the owner of the lease actually live in `runner_leases` at that instant.
     * It can only be observed here — the executor releases the lease in its
     * `finally`, so after `tick` returns the row is gone.
     */
    const observedOwners: { passed: string; live: string | undefined }[] = [];
    const deps = makeDeps({
      continueAgentSession: vi.fn(async (_sessionId: string, ownerId: string) => {
        const rows = await query<{ owner_id: string }>(
          "SELECT owner_id FROM runner_leases WHERE session_id = $1",
          [sessionId],
        );
        observedOwners.push({ passed: ownerId, live: rows[0]?.owner_id });
      }),
    });
    await tick(new Date(), 10, deps);
    expect(deps.continueAgentSession).not.toHaveBeenCalled();

    // The other worker finishes and releases.
    await execute("DELETE FROM runner_leases WHERE session_id = $1", [sessionId]);
    // The replacement is due (backoff elapsed).
    await execute(
      `UPDATE loop_wake_requests SET due_at = NOW() - interval '1 second'
         WHERE session_id = $1 AND status = 'pending'`,
      [sessionId],
    );

    const second = await tick(new Date(), 10, deps);

    expect(second[0]!.outcome).toMatchObject({
      kind: "agent_session_continued",
      sessionId,
    });
    // THE OWNERSHIP PROOF: the slice was handed the owner of the lease that is
    // genuinely live for this session at that instant. Without it the slice's
    // turn loop cannot prove ownership and silently never applies a prepared
    // compaction cutover.
    expect(observedOwners).toHaveLength(1);
    expect(observedOwners[0]!.live).toBeDefined();
    expect(observedOwners[0]!.passed).toBe(observedOwners[0]!.live);
    // Banner before the slice, and nothing left pending.
    expect(deps.injectWakeBanner).toHaveBeenCalled();
    expect(await pendingWakes(sessionId)).toHaveLength(0);
  });

  // ── (c) cancellation racing the enqueue ───────────────────────

  it("an already-cancelled slice signal schedules nothing", async () => {
    const sessionId = await makeSession();
    const controller = new AbortController();
    controller.abort();

    const result = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "timeout",
      abortSignal: controller.signal,
    });

    // The signal is an in-process fact, NOT a serialized one — it is read
    // inside the transaction purely so an obviously-dead slice does not spend a
    // round trip. The durable stop row above is what actually orders anything.
    expect(result.scheduled).toBe(false);
    expect(await readWakes(sessionId)).toHaveLength(0);
  });

  /**
   * The precise window blocker (c) named: the operator's Stop lands AFTER the
   * gate has been consulted but BEFORE the INSERT.
   *
   * The earlier version of this test raced a JavaScript AbortSignal and then
   * PERMITTED a pending wake whenever scheduling won — which was wrong twice
   * over. A signal mutation is not a database effect and is not serialized by
   * the advisory lock, so it proved nothing about ordering; and with a real
   * session-scoped stop row the correct post-Stop state is unconditional: NO
   * live wake, whoever won.
   *
   * Both orderings are asserted to converge on that, because the two
   * transactions contend for the same session control lock: if the stop commits
   * first the scheduler's gate consumes it and inserts nothing; if the
   * scheduler commits first the stop's own transaction cancels the row it finds.
   */
  it("a Stop racing the enqueue leaves NO live wake, whichever commits first", async () => {
    const sessionId = await makeSession();

    const [, scheduled] = await Promise.all([
      enqueueSessionStopRequest({ sessionId, correlationId: "race" }),
      scheduleAgentSessionContinuation({
        sessionId,
        trigger: "iteration_limit",
      }),
    ]);

    // The invariant does not depend on who won.
    expect(await pendingWakes(sessionId)).toHaveLength(0);
    // And whatever the scheduler reported, the durable state is authoritative.
    expect(typeof scheduled.scheduled).toBe("boolean");
  });

  it("the stop is CONSUMED by the scheduling gate, not left open", async () => {
    const sessionId = await makeSession();
    await enqueueSessionStopRequest({ sessionId, correlationId: "consume" });

    const result = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });

    expect(result.scheduled).toBe(false);
    expect(await pendingWakes(sessionId)).toHaveLength(0);
    // The request cannot linger and terminate some later, unrelated work.
    expect(await openStopRequests(sessionId)).toHaveLength(0);
  });

  // ── (b) operator Stop during a wake-driven slice ──────────────

  /**
   * The PRODUCTION stop, exercised through the two engine primitives
   * `runStopDispatch` actually calls — `enqueueSessionStopRequest` (durable,
   * under the session control lock) then `abortSessionSliceLocal` (in-process,
   * best-effort), in that order. The previous version called only the internal
   * abort helper, which proved the helper worked and nothing about whether the
   * operator could reach it.
   *
   * The IPC glue above them (renderer Stop → `vex:runtime:requestStop` →
   * `runStopDispatch` → these two calls) is pinned in vex-app's own
   * `request-stop.test.ts`; it cannot run here because the dispatcher imports
   * electron, and this config has no electron. Together the two files cover the
   * whole path with no gap: the route there, the durable semantics here.
   */
  it("the production Stop route stops a live wake-driven slice", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });

    // A slice is airborne, exactly as `continueAgentSessionUnderLease` runs it.
    const controller = registerSessionSliceAbortController(sessionId);
    try {
      await enqueueSessionStopRequest({ sessionId, correlationId: "req-stop-1" });
      expect(abortSessionSliceLocal(sessionId)).toBe(true);

      // The live slice was signalled — an in-flight provider call is cancelled
      // rather than running to completion.
      expect(controller.signal.aborted).toBe(true);
    } finally {
      unregisterSessionSliceAbortController(sessionId);
    }

    // Durable truth: the continuation is gone, so the executor cannot start a
    // fresh slice on a stopped session.
    expect(await pendingWakes(sessionId)).toHaveLength(0);

    // And a slice that MISSED the in-process signal still refuses to continue,
    // because the durable stop is consumed by its own gate.
    const afterStop = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });
    expect(afterStop.scheduled).toBe(false);
    expect(await pendingWakes(sessionId)).toHaveLength(0);
  });

  it("the production Stop route works with no slice in this process", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({ sessionId, trigger: "timeout" });

    // Nothing registered locally — the durable half must still land, and the
    // in-process half must report "nothing here" rather than throwing.
    await enqueueSessionStopRequest({ sessionId, correlationId: "req-stop-2" });
    expect(abortSessionSliceLocal(sessionId)).toBe(false);

    expect(await pendingWakes(sessionId)).toHaveLength(0);
  });

  it("a Stop prevents the wake executor from starting a slice", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });
    await execute(
      "UPDATE loop_wake_requests SET due_at = NOW() - interval '1 second' WHERE session_id = $1",
      [sessionId],
    );

    await enqueueSessionStopRequest({ sessionId, correlationId: "req-stop-3" });

    // The row was cancelled in the stop transaction, so claimDue finds nothing.
    const deps = makeDeps();
    const results = await tick(new Date(), 10, deps);

    expect(results).toHaveLength(0);
    expect(deps.continueAgentSession).not.toHaveBeenCalled();
  });

  it("pressing Stop twice is idempotent", async () => {
    const sessionId = await makeSession();
    await scheduleAgentSessionContinuation({ sessionId, trigger: "timeout" });

    await enqueueSessionStopRequest({ sessionId, correlationId: "r1" });
    await enqueueSessionStopRequest({ sessionId, correlationId: "r2" });

    // No duplicate open rows piling up for a gate to consume one at a time.
    expect(await openStopRequests(sessionId)).toHaveLength(1);
    expect(await pendingWakes(sessionId)).toHaveLength(0);
  });

  it("a stop queued BEFORE the slice starts prevents any further wake", async () => {
    const sessionId = await makeSession();
    const controller = new AbortController();
    controller.abort();

    // The slice ends on a continuable bound but was cancelled — the scheduler
    // must refuse, so the session does not wake itself again forever.
    const result = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
      abortSignal: controller.signal,
    });

    expect(result.scheduled).toBe(false);
    expect(await pendingWakes(sessionId)).toHaveLength(0);
  });

  // ── One-pending-per-session still holds ───────────────────────

  it("re-scheduling never breaks the one-pending-wake-per-session invariant", async () => {
    const sessionId = await makeSession();

    await scheduleAgentSessionContinuation({ sessionId, trigger: "iteration_limit" });
    const second = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });

    // The partial unique index rejected the duplicate; a continuation is still
    // live, so `scheduled` is honest about the session's state.
    expect(second.scheduled).toBe(true);
    expect(await pendingWakes(sessionId)).toHaveLength(1);
  });

  // ── The stop row is consumed exactly once ────────────────────

  /**
   * Round-10 blocker 2c, at the durable layer. An aborted slice consumes the
   * row that stopped it (the runner's exit consumer is pinned in
   * `agent-session-slice-stop.test.ts`); what matters HERE is that consuming it
   * really retires it, so the next piece of work is not refused by a stop that
   * already did its job.
   */
  it("a consumed session stop does NOT stop the next, unrelated work", async () => {
    const sessionId = await makeSession();
    await enqueueSessionStopRequest({ sessionId, correlationId: "stop-once" });
    expect(await openStopRequests(sessionId)).toHaveLength(1);

    // The slice's exit consumer — the same gate the runner calls.
    const applied = await gateOnOperatorStopTransaction({
      sessionId,
      missionRunId: null,
    });
    expect(applied).toEqual({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });
    expect(await openStopRequests(sessionId)).toHaveLength(0);

    // A fresh user turn asks the same question and must be free to proceed.
    const next = await gateOnOperatorStopTransaction({
      sessionId,
      missionRunId: null,
    });
    expect(next).toEqual({ kind: "clear" });

    // And it can schedule its own continuation again.
    const rescheduled = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });
    expect(rescheduled.scheduled).toBe(true);
    expect(await pendingWakes(sessionId)).toHaveLength(1);
  });

  it("consuming twice is idempotent — the second pass is a no-op", async () => {
    const sessionId = await makeSession();
    await enqueueSessionStopRequest({ sessionId, correlationId: "stop-twice" });

    const first = await gateOnOperatorStopTransaction({
      sessionId,
      missionRunId: null,
    });
    const second = await gateOnOperatorStopTransaction({
      sessionId,
      missionRunId: null,
    });

    expect(first.kind).toBe("stopped");
    // Not "stopped" again: the row is retired, so an unrelated later turn is
    // not silently terminated by it.
    expect(second.kind).toBe("clear");
    expect(await openStopRequests(sessionId)).toHaveLength(0);
  });
});
