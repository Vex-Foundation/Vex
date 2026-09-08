/**
 * Integration: the TRANSACTIONAL stop-retention rule, and the incomplete
 * approval-lifecycle fact it depends on.
 *
 * ## What retention is for
 *
 * A `stop_terminal` request that nothing will ever observe is not harmless. It
 * sits open, and the next unrelated thing that consults the gate — a fresh user
 * turn, a later `loop_defer`, an approved dispatch — is refused by a stop that
 * already did its job. So the SAME transaction that applies the stop decides,
 * from durable state, whether to leave a request behind at all:
 *
 *   - LIVE LEASE or INCOMPLETE APPROVAL LIFECYCLE → something will consult the
 *     gate, so the request stays OPEN for it;
 *   - NEITHER → nothing durable or airborne remains, so no request is created.
 *
 * ## Why `dispatching` must count as incomplete
 *
 * An abandoned `approved + dispatching` row has no run, no live lease, no
 * pending wake and no pending approval decision — every other stoppable fact is
 * false. But it IS durable work the system owes: the reconciler judges it,
 * resolves it to `indeterminate`, and resumes the agent. Retire the stop
 * request there and the operator's Stop is silently discarded, then the
 * reconciler wakes the agent on the session they stopped.
 *
 * That is why the predicate is the SHARED `db/contracts` one, and why this file
 * asserts the `dispatching` case explicitly.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import { claimSessionLease } from "@vex-agent/engine/runtime/lease-and-status.js";
import { enqueueSessionStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

async function openSessionScopedStops(sessionId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    `SELECT id FROM runtime_control_requests
      WHERE session_id = $1 AND kind = 'stop_terminal'
        AND mission_run_id IS NULL AND status IN ('pending','observed')`,
    [sessionId],
  );
}

async function seedApproval(input: {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: string | null;
  readonly executionStatus: string;
  readonly resultMessageId?: number | null;
  readonly resumeConsumedAt?: string | null;
}): Promise<void> {
  // `approval_intents.approval_id` is an FK onto `approval_queue`, so the
  // parent row has to exist. The tool is a `read` so nothing here implies a
  // money path — the lifecycle STATE is what this file is about.
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
     VALUES ($1, '{"name":"probe_tool"}'::jsonb, 'retention probe', 'resolved', $2)`,
    [input.approvalId, input.sessionId],
  );
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, action_kind, risk_level,
        preview_json, policy_json, decision, execution_status,
        result_message_id, resume_consumed_at, decided_at)
     VALUES ($1, $2, NULL, 'read', 'low',
             '{}'::jsonb, '{}'::jsonb, $3, $4, $5, $6, NOW())`,
    [
      input.approvalId,
      input.sessionId,
      input.decision,
      input.executionStatus,
      input.resultMessageId ?? null,
      input.resumeConsumedAt ?? null,
    ],
  );
}

/**
 * A launch intent that PARKED an agent turn: the agent asked, the form is open
 * (or settled) and the turn's tool call has never been answered.
 */
async function seedParkedLaunchForm(
  sessionId: string,
  intentId: string,
  overrides: {
    readonly toolCallId?: string | null;
    readonly resultMessageId?: number | null;
    readonly resumeConsumed?: boolean;
  } = {},
): Promise<void> {
  const toolCallId =
    overrides.toolCallId === undefined ? "call_abc" : overrides.toolCallId;
  // The schema itself pins the predicate's premise: a
  // `token_launch_intents_form_path_has_tool_call` CHECK means only the
  // `agent_requested_form` origin can carry a parked call, so "no tool call"
  // is expressible ONLY as a launch the human started.
  const origin = toolCallId === null ? "user" : "agent_requested_form";
  await execute(
    // `protocol` and `paired_asset` are STATED, not defaulted: migration 108
    // dropped the `trench` DEFAULT along with the launchpad, and
    // `token_launch_intents_pools_has_pair` requires the pair on a pools.fun row.
    // The retention predicate under test is launchpad-agnostic.
    `INSERT INTO token_launch_intents
       (intent_id, session_id, origin, status, chain_id, wallet_address,
        name, symbol, tool_call_id, result_message_id, expires_at,
        resume_consumed_at, protocol, paired_asset)
     VALUES ($1, $2, $5, 'awaiting_user_form', 8453,
             '0x0000000000000000000000000000000000000001',
             'Vex Coin', 'VEX', $3, $4, NOW() + interval '1 hour', $6,
             'pools_fun', 'weth')`,
    [
      intentId,
      sessionId,
      toolCallId,
      overrides.resultMessageId ?? null,
      origin,
      overrides.resumeConsumed === true ? new Date().toISOString() : null,
    ],
  );
}

describe("session stop — transactional retention (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("retires the request on a truly idle session", async () => {
    const sessionId = await makeSession();

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome).toEqual({ outcome: "applied" });
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  it("RETAINS the request while a live lease can observe it", async () => {
    const sessionId = await makeSession();
    await claimSessionLease({
      sessionId,
      ownerId: "airborne-slice",
      processKind: "electron_main",
      ttlMs: 60_000,
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);
  });

  it("does NOT retain for an EXPIRED lease — nothing is listening", async () => {
    const sessionId = await makeSession();
    await claimSessionLease({
      sessionId,
      ownerId: "dead-runner",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    await execute(
      "UPDATE runner_leases SET expires_at = NOW() - interval '1 minute' WHERE session_id = $1",
      [sessionId],
    );

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome).toEqual({ outcome: "applied" });
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR (delta-override D1): an abandoned
   * `approved + dispatching` row with an EXPIRED lease. The narrower
   * resumable-shapes predicate excludes `dispatching`, so it would have retired
   * the request — and the reconciler would then have resumed the agent on a
   * stopped session.
   */
  it("RETAINS for an abandoned approved+dispatching row with an expired lease", async () => {
    const sessionId = await makeSession();
    await seedApproval({
      sessionId,
      approvalId: "appr-dispatching",
      decision: "approved",
      executionStatus: "dispatching",
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);
  });

  it("RETAINS for approved + not_started (the tool provably never ran)", async () => {
    const sessionId = await makeSession();
    await seedApproval({
      sessionId,
      approvalId: "appr-not-started",
      decision: "approved",
      executionStatus: "not_started",
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).toBe("queued");
  });

  it("does NOT retain once the resume has been consumed", async () => {
    const sessionId = await makeSession();
    await seedApproval({
      sessionId,
      approvalId: "appr-done",
      decision: "approved",
      executionStatus: "succeeded",
      resumeConsumedAt: new Date().toISOString(),
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome).toEqual({ outcome: "applied" });
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  /**
   * THE LAUNCH-PATH REGRESSION (Codex whole-wave final review, blocker 2).
   *
   * A chat session whose agent turn is parked on a launch form has NO run, NO
   * lease, NO pending wake and NO approval — every other stoppable fact is
   * false. Without this fact the stop transaction proves "nothing will observe
   * a request", retires it, and the form's resume then runs a model turn on a
   * session the operator stopped. On the launch path, the next thing that turn
   * does can spend real money.
   */
  it("RETAINS for an agent turn parked on an unanswered user form", async () => {
    const sessionId = await makeSession();
    await seedParkedLaunchForm(sessionId, "intent-parked");

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);
  });

  /**
   * THE CORRECTION. This case previously asserted `applied` — it PINNED the
   * hole rather than closing it.
   *
   * The resume appends the result, THEN claims the session lease, THEN runs the
   * turn. A Stop committing between the stamp and the lease saw no live lease,
   * no approval lifecycle, and — while the fact keyed off `result_message_id` —
   * no outstanding form either. It retired its own request as unobservable, and
   * the dispatch ran the model turn anyway.
   *
   * The stamp is not the completion. Work is owed until a resumed turn has
   * COMPLETED, and the request must stay open for it.
   */
  it("RETAINS after the result is stamped but before the turn has run", async () => {
    const sessionId = await makeSession();
    await seedParkedLaunchForm(sessionId, "intent-stamped", {
      resultMessageId: 4242,
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);
  });

  it("does NOT retain once a resumed turn has COMPLETED for the form", async () => {
    const sessionId = await makeSession();
    await seedParkedLaunchForm(sessionId, "intent-consumed", {
      resultMessageId: 4242,
      resumeConsumed: true,
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome).toEqual({ outcome: "applied" });
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  /**
   * A launch the HUMAN started parks no agent turn — it persists no
   * `tool_call_id` — so it owes nothing and must not pin a stop request open.
   */
  it("does NOT retain for a user-initiated launch with no parked call", async () => {
    const sessionId = await makeSession();
    await seedParkedLaunchForm(sessionId, "intent-user-started", {
      toolCallId: null,
    });

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome).toEqual({ outcome: "applied" });
  });

  /**
   * The point of retiring: a stop that left nothing behind cannot refuse the
   * session's NEXT, unrelated autonomous work.
   */
  it("a retired stop does not refuse a later unrelated loop_defer", async () => {
    const sessionId = await makeSession();
    await enqueueSessionStopRequest({ sessionId });

    const { scheduleAgentSessionContinuation } = await import(
      "@vex-agent/engine/core/runner/runtime-continuation.js"
    );
    const next = await scheduleAgentSessionContinuation({
      sessionId,
      trigger: "iteration_limit",
    });

    expect(next.scheduled).toBe(true);
  });
});
