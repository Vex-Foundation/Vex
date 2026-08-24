/**
 * Integration: the Vex Studio DISPATCH GATE and the approve-versus-scope-edit
 * LOCK ORDER, on TWO REAL POSTGRES CONNECTIONS.
 *
 * This is the A3 merge gate. Two things cannot be proven with a scripted
 * client, because both are statements about what the DATABASE does when two
 * transactions interleave:
 *
 *   1. THE GENERATION INTERLEAVING. A dispatcher reads the generation, and the
 *      user locks Vex before its slot statement commits. The scripted test can
 *      only assert the SQL text; only a real connection can show that the
 *      advance and the claim cannot both commit. The predicate reads the gate
 *      row `FOR SHARE` inside the UPDATE, so either the claim commits first and
 *      the advance waits, or the advance commits first and the claim matches
 *      zero rows. There is no third interleaving.
 *
 *   2. THE LOCK ORDER. An approve and a `updateProjectScope` both take the
 *      session control lock as edge 0, then the approval rows, then the project
 *      row. If either ever took them in the other order the two would deadlock;
 *      here they simply queue, and the second one to run sees the first one's
 *      committed state.
 *
 * Both use the PRODUCTION entry points (the repo's slot-claim statement, the
 * engine's advance, the engine's refusal primitive), never a re-implementation
 * of the SQL under test.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, getPool, query, withTransaction } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { advanceStudioDispatchGeneration } from "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js";
import { refusePendingStudioIntents } from "@vex-agent/engine/core/approval-runtime/studio/refuse.js";
import { acquireSessionControlLockOn } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/** `resetDb` truncates every table, so the seeded gate row is restored here. */
async function seedRuntimeGate(): Promise<void> {
  await execute(
    `INSERT INTO studio_runtime_gate (id, dispatch_generation)
     VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET dispatch_generation = 1`,
  );
}

async function seedProject(sessionId: string): Promise<string> {
  const projectId = randomUUID();
  await execute(
    `INSERT INTO studio_settings (id, projects_root)
     VALUES (1, '/tmp/vex-projects') ON CONFLICT (id) DO NOTHING`,
  );
  await execute(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, 'Test', $2, $2, 'full', $3, 1)`,
    [projectId, `p-${projectId.slice(0, 8)}`, sessionId],
  );
  return projectId;
}

/**
 * Seed one Studio intent. `decision: "approved"` is the shape a dispatch-slot
 * test needs (the human already decided); `null` is the shape a refusal test
 * needs (still pending, still refusable). They are different fixtures because
 * they are different states, and a refusal CAS on a decided row is correctly a
 * no-op.
 */
async function seedStudioIntent(
  sessionId: string,
  projectId: string,
  generation: string,
  decision: "approved" | null = "approved",
): Promise<string> {
  const approvalId = randomUUID();
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                 tool_call_id, source)
     VALUES ($1, '{}'::jsonb, 'because', $4, $2, $3, 'studio_mcp')`,
    [approvalId, sessionId, `call-${approvalId}`, decision === null ? "pending" : "approved"],
  );
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, decision, decided_at,
        execution_status, origin, project_id, scope_version_at_enqueue,
        dispatch_generation_at_enqueue)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
             '{}'::jsonb, '{}'::jsonb, $6,
             CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END,
             'not_started', 'studio_mcp', $4, 1, $5)`,
    [approvalId, sessionId, `call-${approvalId}`, projectId, generation, decision],
  );
  return approvalId;
}

async function readState(approvalId: string): Promise<{
  execution_status: string;
  decision: string | null;
  refusal_reason: string | null;
}> {
  const rows = await query<{
    execution_status: string;
    decision: string | null;
    refusal_reason: string | null;
  }>(
    "SELECT execution_status, decision, refusal_reason FROM approval_intents WHERE approval_id = $1",
    [approvalId],
  );
  return rows[0]!;
}

beforeEach(async () => {
  await resetDb();
  await seedRuntimeGate();
});

describe("the dispatch generation is a real linearization point", () => {
  it("refuses a slot claim whose generation advanced BEFORE the claim ran", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1");

    // The user locks Vex.
    const advanced = await advanceStudioDispatchGeneration();
    expect(advanced.ok).toBe(true);

    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(false);
    // The row never left `not_started`, so nothing dispatched and the
    // reconciler still owns it.
    expect((await readState(approvalId)).execution_status).toBe("not_started");
  });

  it("cannot let an advance and a stale claim both commit (the interleaving)", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1");

    const pool = getPool();
    const dispatcher = await pool.connect();
    try {
      await dispatcher.query("BEGIN");
      // The dispatcher reads the generation (as the enqueue gate does) and then
      // AWAITS. That await is the window under test: everything the dispatcher
      // knows about the fence is now stale, and only the predicate inside its
      // own UPDATE can still see the truth.
      const seen = await dispatcher.query<{ dispatch_generation: string }>(
        "SELECT dispatch_generation FROM studio_runtime_gate WHERE id = 1",
      );
      expect(String(seen.rows[0]!.dispatch_generation)).toBe("1");

      // On a SECOND connection, the user locks Vex. It commits immediately,
      // because the dispatcher holds no lock on the gate row yet.
      const advanced = await advanceStudioDispatchGeneration();
      expect(advanced.ok).toBe(true);

      // Only NOW does the dispatcher run its slot statement. The predicate
      // re-reads the generation inside the UPDATE, so it sees the committed
      // advance and matches nothing.
      const took = await approvalIntentsRepo.casClaimStudioDispatchSlotWith(
        dispatcher,
        approvalId,
      );
      await dispatcher.query("COMMIT");
      expect(took).toBe(false);
    } finally {
      dispatcher.release();
    }
    expect((await readState(approvalId)).execution_status).toBe("not_started");
  });

  it("does not disturb an intent whose slot was claimed BEFORE the advance", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1");

    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(true);
    // The lock arrives after the dispatch already began. The in-flight rule
    // applies: the call is not undone, and the generation is not retroactive.
    await advanceStudioDispatchGeneration();
    expect((await readState(approvalId)).execution_status).toBe("dispatching");
  });

  it("is MONOTONIC across a lock and a later unlock", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1");

    await advanceStudioDispatchGeneration(); // lock  -> 2
    const afterUnlock = await advanceStudioDispatchGeneration(); // unlock -> 3
    expect(afterUnlock).toEqual({ ok: true, generation: "3" });

    // A pre-lock intent is never resurrected by the unlock.
    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(false);
  });
});

describe("approve versus a scope edit take their locks in the same order", () => {
  it("serializes on the session control lock instead of deadlocking", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1", null);

    const pool = getPool();
    const editor = await pool.connect();
    const approver = await pool.connect();
    try {
      // The scope edit opens first and takes the WHOLE documented prefix:
      // session control lock -> approval rows -> project row.
      await editor.query("BEGIN");
      await acquireSessionControlLockOn(editor, sessionId);
      const refused = await refusePendingStudioIntents(
        editor,
        { projectId },
        "scope_changed",
      );
      expect(refused).toHaveLength(1);
      await editor.query(
        "UPDATE projects SET scope_version = scope_version + 1 WHERE id = $1",
        [projectId],
      );

      // The approve starts in the SAME order and therefore BLOCKS on edge 0
      // rather than acquiring the project row out of order.
      await approver.query("BEGIN");
      let approverAcquired = false;
      const approverLock = acquireSessionControlLockOn(approver, sessionId).then(
        () => {
          approverAcquired = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(approverAcquired).toBe(false);

      await editor.query("COMMIT");
      await approverLock;
      expect(approverAcquired).toBe(true);

      // The approve now sees the committed refusal and the bumped version, so
      // it can only report the real state - it can never dispatch.
      const state = await approver.query<{
        decision: string | null;
        refusal_reason: string | null;
      }>(
        "SELECT decision, refusal_reason FROM approval_intents WHERE approval_id = $1 FOR UPDATE",
        [approvalId],
      );
      expect(state.rows[0]!.decision).toBe("rejected");
      expect(state.rows[0]!.refusal_reason).toBe("scope_changed");
      await approver.query("COMMIT");
    } finally {
      editor.release();
      approver.release();
    }
  });
});

describe("the refusal primitive on real rows", () => {
  it("is idempotent: a refusal after a settlement is a no-op", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1", null);

    const first = await withTransaction((client) =>
      refusePendingStudioIntents(client, { approvalId }, "lock"),
    );
    expect(first).toHaveLength(1);
    const second = await withTransaction((client) =>
      refusePendingStudioIntents(client, { approvalId }, "vex_quit"),
    );
    expect(second).toHaveLength(0);
    // The FIRST cause stands: a later owner cannot rewrite why it ended.
    expect((await readState(approvalId)).refusal_reason).toBe("lock");
  });

  it("keeps the audit row when its project is deleted, by REFUSING the delete", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "1", null);
    await withTransaction((client) =>
      refusePendingStudioIntents(client, { projectId }, "project_deleted"),
    );
    await execute("DELETE FROM project_wallets WHERE project_id = $1", [projectId]);

    // `project_id` references `projects(id)` with NO cascade and no
    // `ON DELETE SET NULL`, so the row cannot vanish - and, as the schema
    // stands, the project cannot be deleted while an audit row points at it
    // either. That is the STRONGER of the two guarantees the plan asked for,
    // and it is what a later project-deletion stage has to design around:
    // refusing the pending intents does not remove the reference.
    await expect(
      execute("DELETE FROM projects WHERE id = $1", [projectId]),
    ).rejects.toThrow(/foreign key constraint/i);

    const state = await readState(approvalId);
    expect(state.decision).toBe("rejected");
    expect(state.refusal_reason).toBe("project_deleted");
  });
});
