/**
 * Integration: the PROTOCOL-EXECUTION money-state writer vs the compaction
 * safe-moment gate — TWO REAL POSTGRES CLIENTS, never mocked SQL.
 *
 * Sibling of `compaction-apply-money-gate-interleaving.int.test.ts`; same
 * harness, same contract:
 *
 *   EITHER the gate saw the writer's row and deferred the cutover,
 *   OR the writer's write landed strictly AFTER the cutover committed.
 *
 * SCOPE — `protocol_executions`:
 *
 *   - COMPLETION (`execution_status: 'intent' → succeeded|failed`), the writer
 *     that moves a row OUT of the gate's set. Exercised through
 *     `captureExecution`, its only production caller, because the lock is taken
 *     by the caller and a test that called the repo directly would prove
 *     nothing about it.
 *   - CREATION is NOT tested here. Every `createExecutionIntent` call site is
 *     inside an `agent_activity` intent transaction, so the lock belongs to
 *     that transaction and is asserted in
 *     `compaction-apply-money-gate-agent-activity.int.test.ts`. Adding a second
 *     acquisition here would be a duplicate, not a guarantee.
 *
 * Also pins the SETTLED RULING that a `session_id IS NULL` intent row stays
 * OUTSIDE the session-scoped gate — completing one takes no lock and must not
 * serialize, because there is no session to key on.
 *
 * The first case is the NON-PARTICIPATING BASELINE, proving this file's harness
 * detects a writer that skips the lock.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { getPool, queryOne } from "@vex-agent/db/client.js";
import { completeExecutionIntentWith } from "@vex-agent/db/repos/executions.js";
import { captureExecution } from "@vex-agent/tools/protocols/runtime/capture.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { raceGateAgainstWriter } from "./money-gate-race-harness.js";

const TOOL_ID = "kyberswap_swap_execute";
const NAMESPACE = "kyberswap";

/** Seed an `intent` row directly. Fixture setup, not a race. */
async function seedExecutionIntent(sessionId: string | null): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO protocol_executions
       (tool_id, namespace, session_id, params, result, success,
        trade_capture, external_refs, execution_status)
     VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, false, NULL, '{}'::jsonb,
             'intent')
     RETURNING id`,
    [TOOL_ID, NAMESPACE, sessionId],
  );
  if (row === null) throw new Error("fixture: intent insert returned no id");
  return row.id;
}

async function executionStatusOf(executionId: number): Promise<string> {
  const row = await queryOne<{ execution_status: string }>(
    "SELECT execution_status FROM protocol_executions WHERE id = $1",
    [executionId],
  );
  return row?.execution_status ?? "missing";
}

/**
 * The production completion path. `_executionId` is the capture-threading
 * convention the swap/bridge execute handlers use, and its provenance check
 * requires the row's `tool_id`/`namespace` to match the tool now executing.
 */
function completeThroughCapture(
  sessionId: string | null,
  executionId: number,
): Promise<void> {
  return captureExecution(
    TOOL_ID,
    NAMESPACE,
    sessionId,
    { amount: "1" },
    { success: true, output: "ok", data: { _executionId: executionId } },
    12,
  );
}

describe("protocol-execution money-state writer participates in the session control lock", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  // ── baseline ────────────────────────────────────────────────────────

  it("baseline: a NON-participating completion proves the harness detects the failure", async () => {
    // The bare repo write on a raw connection. It MUST slip past — otherwise
    // the assertions below would pass vacuously.
    const executionId = await seedExecutionIntent(sessionId);
    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await completeExecutionIntentWith(client, {
          executionId,
          result: {},
          success: true,
          tradeCapture: null,
          externalRefs: {},
          durationMs: 1,
        });
      } finally {
        client.release();
      }
    });
    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  // ── the writer ──────────────────────────────────────────────────────

  it("completing an execution intent blocks until the gate transaction commits", async () => {
    const executionId = await seedExecutionIntent(sessionId);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      completeThroughCapture(sessionId, executionId),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // A durable pre-sign record whose outcome was never written back is
    // unresolved money state, so the gate correctly deferred the cutover.
    expect(outcome.gateKinds).toEqual(["protocol_execution_intent"]);
    expect(await executionStatusOf(executionId)).toBe("succeeded");
    // Settling it clears the gate for the NEXT apply attempt.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  it("a FAILED outcome also leaves the gate clear — the row is settled either way", async () => {
    const executionId = await seedExecutionIntent(sessionId);

    await captureExecution(
      TOOL_ID,
      NAMESPACE,
      sessionId,
      { amount: "1" },
      { success: false, output: "reverted", data: { _executionId: executionId } },
      12,
    );

    expect(await executionStatusOf(executionId)).toBe("failed");
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  // ── settled ruling: null-session rows are outside the gate ──────────

  it("a NULL-session intent neither blocks the gate nor serializes on it", async () => {
    // Settled ruling: a `session_id IS NULL` row is invisible to a
    // session-scoped reader by construction, so there is no key to lock on and
    // nothing to defer. This test PINS that, so a future widening of the gate
    // has to change it deliberately rather than by accident.
    const nullSessionExecutionId = await seedExecutionIntent(null);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      completeThroughCapture(null, nullSessionExecutionId),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    expect(outcome.gateKinds).toEqual([]);
    expect(await executionStatusOf(nullSessionExecutionId)).toBe("succeeded");
  });

  // ── cross-session ───────────────────────────────────────────────────

  it("does NOT serialize a completion for a DIFFERENT session", async () => {
    const otherSession = await makeSession();
    const executionId = await seedExecutionIntent(otherSession);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      completeThroughCapture(otherSession, executionId),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    expect(outcome.gateKinds).toEqual([]);
  });
});
