/**
 * Integration: the APPROVAL money-state writers vs the compaction safe-moment
 * gate — TWO REAL POSTGRES CLIENTS, never mocked SQL.
 *
 * Sibling of `compaction-apply-money-gate-interleaving.int.test.ts` (wallet
 * writers); same harness, same contract:
 *
 *   EITHER the gate saw the writer's row and deferred the cutover,
 *   OR the writer's write landed strictly AFTER the cutover committed.
 *
 * SCOPE — every writer that moves an `approval_intents` row into or out of the
 * gate's set:
 *
 *   1. the dispatch-slot claim (`not_started → dispatching`), now folded into
 *      the operator-stop gate's transaction;
 *   2. the execution-result commit (`dispatching → succeeded|failed`);
 *   3. the reconciler's `dispatching → indeterminate` verdict;
 *   4. the decision CAS (`decision IS NULL → approved|rejected`).
 *
 * Each is exercised through its PRODUCTION entry point, not through the repo
 * function underneath it. A test that called the repo directly would prove the
 * repo takes a lock while the real caller still did not, which is the exact
 * shape of the "tests that re-implement the logic under test" failure in
 * rules/90.
 *
 * The first case is the NON-PARTICIPATING BASELINE: it proves this file's
 * harness actually detects a writer that skips the lock, so the assertions
 * below cannot pass vacuously.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { claimDispatchSlotUnderStopGate } from "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/dispatch-slot-gate.js";
import { commitApprovedToolResult } from "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js";
import { reconcileApprovalLifecycle } from "@vex-agent/engine/core/approval-runtime/reconcile.js";
import { prepareReject } from "@vex-agent/engine/core/approval-runtime.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { raceGateAgainstWriter } from "./money-gate-race-harness.js";

/**
 * Seed a queue row + intent row directly. Fixture setup, not a race — the
 * writers under test are the ones launched inside the harness.
 */
async function seedApproval(
  sessionId: string,
  fields: {
    decision?: string | null;
    executionStatus?: string;
    queueStatus?: "pending" | "approved" | "rejected";
    dispatchStartedAt?: string | null;
  } = {},
): Promise<string> {
  const approvalId = randomUUID();
  const toolCallId = `call-${approvalId}`;
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id, tool_call_id)
     VALUES ($1, $2::jsonb, 'because', $3, $4, $5)`,
    [
      approvalId,
      JSON.stringify({ id: toolCallId, name: "wallet_send", arguments: "{}" }),
      fields.queueStatus ?? "pending",
      sessionId,
      toolCallId,
    ],
  );
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, decision, decided_at,
        execution_status, dispatch_started_at)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
             '{}'::jsonb, '{}'::jsonb,
             $4, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END,
             $5, $6)`,
    [
      approvalId,
      sessionId,
      toolCallId,
      fields.decision ?? null,
      fields.executionStatus ?? "not_started",
      fields.dispatchStartedAt ?? null,
    ],
  );
  return approvalId;
}

async function executionStatusOf(approvalId: string): Promise<string> {
  const row = await queryOne<{ execution_status: string }>(
    "SELECT execution_status FROM approval_intents WHERE approval_id = $1",
    [approvalId],
  );
  return row?.execution_status ?? "missing";
}

async function decisionOf(approvalId: string): Promise<string | null> {
  const row = await queryOne<{ decision: string | null }>(
    "SELECT decision FROM approval_intents WHERE approval_id = $1",
    [approvalId],
  );
  return row?.decision ?? null;
}

describe("approval money-state writers participate in the session control lock", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  // ── baseline ────────────────────────────────────────────────────────

  it("baseline: a NON-participating approval writer proves the harness detects the failure", async () => {
    // The bare repo CAS, on a raw connection with no session lock. It MUST slip
    // past — otherwise every assertion below would pass vacuously.
    const approvalId = await seedApproval(sessionId, {
      decision: "approved",
      queueStatus: "approved",
    });
    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await approvalIntentsRepo.casMarkDispatchingWith(
          client,
          approvalId,
        );
      } finally {
        client.release();
      }
    });
    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  // ── writer 1: dispatch-slot claim (dispatch-approved.ts step 3) ──────

  it("the dispatch-slot claim blocks until the gate transaction commits", async () => {
    const approvalId = await seedApproval(sessionId, {
      decision: "approved",
      queueStatus: "approved",
    });

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      claimDispatchSlotUnderStopGate({
        approvalId,
        sessionId,
        missionRunId: null,
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // `approved` + `not_started` is ALREADY unresolved money state, so the gate
    // correctly refuses the cutover — and the claim landed strictly after it.
    expect(outcome.gateKinds).toEqual(["approval_in_flight"]);
    expect(await executionStatusOf(approvalId)).toBe("dispatching");
  });

  it("the dispatch-slot claim still reports the taken slot when it loses the CAS", async () => {
    // The CAS predicate is untouched by the lock fold: a row already
    // `dispatching` is not claimable, and the caller must not dispatch.
    const approvalId = await seedApproval(sessionId, {
      decision: "approved",
      queueStatus: "approved",
      executionStatus: "dispatching",
    });
    const result = await claimDispatchSlotUnderStopGate({
      approvalId,
      sessionId,
      missionRunId: null,
    });
    expect(result.tookSlot).toBe(false);
    expect(result.stopGate.kind).toBe("clear");
  });

  // ── writer 2: execution-result commit (result-message.ts) ───────────

  it("the execution-result commit blocks until the gate transaction commits", async () => {
    const approvalId = await seedApproval(sessionId, {
      decision: "approved",
      queueStatus: "approved",
      executionStatus: "dispatching",
    });

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      commitApprovedToolResult({
        approvalId,
        sessionId,
        toolCallId: `call-${approvalId}`,
        dispatchResult: { success: true, output: "done" },
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // `dispatching` is unproven money state, so the gate deferred.
    expect(outcome.gateKinds).toEqual(["approval_in_flight"]);
    expect(await executionStatusOf(approvalId)).toBe("succeeded");
    // And settling it clears the gate for the NEXT apply attempt.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  // ── writer 3: reconciler's indeterminate verdict (reconcile.ts) ──────

  it("the reconciler's dispatching→indeterminate verdict blocks until the gate commits", async () => {
    // Abandoned by construction: `dispatching`, stamped long ago, and no runner
    // lease exists for this session, which is what licenses the verdict.
    const approvalId = await seedApproval(sessionId, {
      decision: "approved",
      queueStatus: "approved",
      executionStatus: "dispatching",
      dispatchStartedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      reconcileApprovalLifecycle(),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["approval_in_flight"]);
    expect(await executionStatusOf(approvalId)).toBe("indeterminate");
    // `indeterminate` is the honest "we cannot prove what happened" verdict and
    // STAYS unresolved money state — the cutover must keep deferring.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after.clear).toBe(false);
  });

  // ── writer 4: the decision CAS (snapshot/build.ts) ───────────────────

  it("the decision CAS blocks until the gate transaction commits", async () => {
    const approvalId = await seedApproval(sessionId);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      prepareReject(approvalId, "not now"),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // An undecided approval sits on the operator's screen — the strongest
    // reason of all to refuse a transcript rewrite.
    expect(outcome.gateKinds).toEqual(["approval_queue_pending"]);
    expect(await decisionOf(approvalId)).toBe("rejected");
    // A rejected approval never dispatches, so the gate clears afterwards.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  // ── cross-session ───────────────────────────────────────────────────

  it("does NOT serialize an approval writer for a DIFFERENT session", async () => {
    // The lock is session-keyed. One compacting session must not stall the
    // approval path of every other session.
    const otherSession = await makeSession();
    const approvalId = await seedApproval(otherSession, {
      decision: "approved",
      queueStatus: "approved",
    });

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      claimDispatchSlotUnderStopGate({
        approvalId,
        sessionId: otherSession,
        missionRunId: null,
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    expect(outcome.gateKinds).toEqual([]);
  });
});
