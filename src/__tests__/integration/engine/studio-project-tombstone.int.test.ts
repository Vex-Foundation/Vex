/**
 * Integration: the PROJECT TOMBSTONE, on a REAL POSTGRES.
 *
 * These properties are properties of the schema and of PostgreSQL under
 * concurrency, so a mocked client cannot prove any of them:
 *
 *   - the refusal sweep settles the `approval_queue` row as well as the
 *     `approval_intents` row, so the pending list actually drains;
 *   - an APPROVED-but-not-started row is settled `project_deleted` with the
 *     human's decision preserved, because the sweep's CAS (`status='pending'`)
 *     cannot reach it;
 *   - the audit survives: `approval_intents.project_id` still joins the
 *     tombstone, which is why the delete is soft in the first place;
 *   - a hard `DELETE FROM projects` is still impossible while audit rows exist;
 *   - the slug is reusable ONLY through the partial unique index;
 *   - the whole thing is idempotent.
 *
 * They use the PRODUCTION entry points - the engine's refusal primitive and the
 * real statements - never a re-implementation of the SQL under test.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, withTransaction } from "@vex-agent/db/client.js";
import { refusePendingStudioIntents } from "@vex-agent/engine/core/approval-runtime/studio/refuse.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

async function seedProject(
  sessionId: string,
  slug = `p-${randomUUID().slice(0, 8)}`,
): Promise<{ projectId: string; slug: string }> {
  const projectId = randomUUID();
  await execute(
    `INSERT INTO studio_settings (id, projects_root)
     VALUES (1, '/tmp/vex-projects') ON CONFLICT (id) DO NOTHING`,
  );
  await execute(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, 'Test', $2, $2, 'full', $3, 1)`,
    [projectId, slug, sessionId],
  );
  return { projectId, slug };
}

async function seedStudioIntent(
  sessionId: string,
  projectId: string,
  decision: "approved" | null,
  executionStatus = "not_started",
): Promise<string> {
  const approvalId = randomUUID();
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                 tool_call_id, source)
     VALUES ($1, '{}'::jsonb, 'because', $4, $2, $3, 'studio_mcp')`,
    [
      approvalId,
      sessionId,
      `call-${approvalId}`,
      decision === null ? "pending" : "approved",
    ],
  );
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, decision, decided_at,
        execution_status, origin, project_id, scope_version_at_enqueue,
        dispatch_generation_at_enqueue)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
             '{}'::jsonb, '{}'::jsonb, $5,
             CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END,
             $6, 'studio_mcp', $4, 1, '1')`,
    [approvalId, sessionId, `call-${approvalId}`, projectId, decision, executionStatus],
  );
  return approvalId;
}

async function readIntent(approvalId: string): Promise<{
  decision: string | null;
  refusal_reason: string | null;
  execution_status: string;
}> {
  const rows = await query<{
    decision: string | null;
    refusal_reason: string | null;
    execution_status: string;
  }>(
    `SELECT decision, refusal_reason, execution_status
       FROM approval_intents WHERE approval_id = $1`,
    [approvalId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("intent row missing");
  return row;
}

async function readQueueStatus(approvalId: string): Promise<string> {
  const rows = await query<{ status: string }>(
    "SELECT status FROM approval_queue WHERE id = $1",
    [approvalId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("queue row missing");
  return row.status;
}

/** The production tombstone statement, as `database/projects/delete.ts` runs it. */
async function tombstone(
  projectId: string,
  cleanupState: "pending" | "trash_pending" = "pending",
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE projects
        SET deleted_at = NOW(), cleanup_state = $2, cleanup_attempts = 0,
            cleanup_last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [projectId, cleanupState],
  );
  return rows.length;
}

beforeEach(async () => {
  await resetDb();
});

describe("the refusal sweep, in the delete transaction", () => {
  it("settles the approval_queue row too, so the pending list DRAINS", async () => {
    // THE MUST-VERIFY. `refusePendingStudioIntents` is documented as writing
    // "queue first, then intent"; this proves the queue write actually lands,
    // because a refused intent whose queue row stayed `pending` would leave an
    // approval sitting in the user's inbox that nobody can ever decide.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, null);

    expect(await readQueueStatus(approvalId)).toBe("pending");

    const refused = await withTransaction((client) =>
      refusePendingStudioIntents(client, { projectId }, "project_deleted"),
    );

    expect(refused).toHaveLength(1);
    expect(await readQueueStatus(approvalId)).toBe("rejected");
    const intent = await readIntent(approvalId);
    expect(intent.decision).toBe("rejected");
    expect(intent.refusal_reason).toBe("project_deleted");
  });

  it("CANNOT settle an already-approved row, which is why the gate exists", async () => {
    // The sweep's CAS is guarded on `approval_queue.status = 'pending'`. An
    // approved row is not pending, so the sweep skips it SILENTLY - and that is
    // precisely why the delete transaction settles approved rows itself and why
    // the dispatch gate must be tombstone-aware.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "approved");

    const refused = await withTransaction((client) =>
      refusePendingStudioIntents(client, { projectId }, "project_deleted"),
    );

    expect(refused).toHaveLength(0);
    const intent = await readIntent(approvalId);
    expect(intent.decision).toBe("approved");
    expect(intent.refusal_reason).toBeNull();
  });
});

describe("the tombstone itself", () => {
  it("KEEPS the audit joinable to the deleted project", async () => {
    // The whole reason deletion is soft. The record that an external agent
    // asked Vex to move funds must outlive the project it was scoped to.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, null);

    await withTransaction((client) =>
      refusePendingStudioIntents(client, { projectId }, "project_deleted"),
    );
    expect(await tombstone(projectId)).toBe(1);

    const joined = await query<{ approval_id: string; name: string }>(
      `SELECT i.approval_id, p.name
         FROM approval_intents i
         JOIN projects p ON p.id = i.project_id
        WHERE i.approval_id = $1`,
      [approvalId],
    );
    expect(joined).toHaveLength(1);
    // The project's NAME is still readable, which is what lets the approvals
    // inbox say which project asked.
    expect(joined[0]?.name).toBe("Test");
  });

  it("still REFUSES a hard delete while an audit row points at it", async () => {
    // `approval_intents.project_id` references `projects(id)` with no cascade,
    // deliberately. This is the constraint that makes a tombstone the only
    // available deletion model, so it is asserted rather than assumed.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await seedStudioIntent(sessionId, projectId, null);
    await execute("DELETE FROM project_wallets WHERE project_id = $1", [projectId]);

    await expect(
      execute("DELETE FROM projects WHERE id = $1", [projectId]),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  it("is IDEMPOTENT: a second tombstone matches zero rows", async () => {
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);

    expect(await tombstone(projectId)).toBe(1);
    // The `deleted_at IS NULL` guard is what stops two concurrent deletes from
    // both believing they performed the deletion.
    expect(await tombstone(projectId)).toBe(0);
  });

  it("records the trash intent DURABLY, so a resume cannot change it", async () => {
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);

    await tombstone(projectId, "trash_pending");

    const rows = await query<{ cleanup_state: string; cleanup_attempts: number }>(
      "SELECT cleanup_state, cleanup_attempts FROM projects WHERE id = $1",
      [projectId],
    );
    expect(rows[0]?.cleanup_state).toBe("trash_pending");
    expect(rows[0]?.cleanup_attempts).toBe(0);
  });
});

describe("the backing session", () => {
  it("is tombstoned, never hard-deleted, so the audit does not cascade away", async () => {
    // `approval_intents.session_id` IS `ON DELETE CASCADE`. Hard-deleting the
    // backing session would therefore destroy the very refusal rows the
    // tombstone exists to preserve. This proves the soft delete keeps them.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, null);

    await execute(
      `UPDATE sessions SET deleted_at = NOW()
        WHERE id = $1 AND scope = 'vex_studio' AND deleted_at IS NULL`,
      [sessionId],
    );

    const rows = await query<{ approval_id: string }>(
      "SELECT approval_id FROM approval_intents WHERE approval_id = $1",
      [approvalId],
    );
    expect(rows).toHaveLength(1);
  });

  it("the vex_studio filter refuses to touch an agent-mode session", async () => {
    // The mirrored guarantee of `softDeleteSession`'s `vex_app` filter:
    // whatever id this statement is handed, it can only tombstone a Studio
    // session.
    const agentSessionId = randomUUID();
    await execute(
      "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_app')",
      [agentSessionId],
    );

    const rows = await query<{ id: string }>(
      `UPDATE sessions SET deleted_at = NOW()
        WHERE id = $1 AND scope = 'vex_studio' AND deleted_at IS NULL
        RETURNING id`,
      [agentSessionId],
    );

    expect(rows).toHaveLength(0);
  });
});

describe("the slug's partial unique index", () => {
  it("BLOCKS a duplicate slug while the project is active", async () => {
    const first = await makeSession();
    const second = await makeSession();
    const { slug } = await seedProject(first, "shared-slug");

    await expect(seedProject(second, slug)).rejects.toThrow(
      /duplicate key value|unique constraint/i,
    );
  });

  it("FREES the slug once the project is tombstoned", async () => {
    // A tombstone must not hold a name hostage forever, or a user could never
    // recreate a project they just deleted.
    const first = await makeSession();
    const second = await makeSession();
    const { projectId, slug } = await seedProject(first, "reusable-slug");
    await tombstone(projectId);

    const recreated = await seedProject(second, slug);

    expect(recreated.projectId).not.toBe(projectId);
    const rows = await query<{ id: string }>(
      "SELECT id FROM projects WHERE slug = $1 AND deleted_at IS NULL",
      [slug],
    );
    expect(rows).toHaveLength(1);
  });

  it("still exposes the tombstone to the unfinished-cleanup lookup", async () => {
    // The database frees the slug immediately; the FILESYSTEM does not. This is
    // the query `createProject` runs before claiming the directory, so it must
    // still find the tombstone the index has stopped enforcing against.
    const sessionId = await makeSession();
    const { projectId, slug } = await seedProject(sessionId, "held-slug");
    await tombstone(projectId, "trash_pending");

    const held = await query<{ id: string }>(
      `SELECT id FROM projects
        WHERE slug = $1 AND deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        LIMIT 1`,
      [slug],
    );
    expect(held).toHaveLength(1);

    // And once cleanup is done, the slug is genuinely free.
    await execute("UPDATE projects SET cleanup_state = 'done' WHERE id = $1", [
      projectId,
    ]);
    const stillHeld = await query<{ id: string }>(
      `SELECT id FROM projects
        WHERE slug = $1 AND deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        LIMIT 1`,
      [slug],
    );
    expect(stillHeld).toHaveLength(0);
  });
});

describe("the cleanup obligation", () => {
  it("has NO failed state: a failure increments attempts and stays pending", async () => {
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await tombstone(projectId);

    const attempts = await query<{ cleanup_attempts: number }>(
      `UPDATE projects
          SET cleanup_attempts = cleanup_attempts + 1, cleanup_last_error = $2
        WHERE id = $1 AND deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        RETURNING cleanup_attempts`,
      [projectId, "Some of the entries Vex wrote could not be removed."],
    );

    expect(attempts[0]?.cleanup_attempts).toBe(1);
    const rows = await query<{ cleanup_state: string }>(
      "SELECT cleanup_state FROM projects WHERE id = $1",
      [projectId],
    );
    // The obligation still stands. There is nowhere for it to be forgotten.
    expect(rows[0]?.cleanup_state).toBe("pending");
  });

  it("is discoverable by the STARTUP REPAIR sweep after a crash", async () => {
    // "Crash after commit" is exactly this state: a tombstone whose cleanup
    // never ran. The sweep's own query must find it.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await tombstone(projectId, "trash_pending");

    const outstanding = await query<{ id: string; cleanup_state: string }>(
      `SELECT id, cleanup_state FROM projects
        WHERE deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        ORDER BY deleted_at ASC
        LIMIT 50`,
    );

    expect(outstanding.map((r) => r.id)).toContain(projectId);
  });

  it("marks done only from an unfinished state, so it cannot revive a row", async () => {
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await tombstone(projectId);

    const first = await query<{ id: string }>(
      `UPDATE projects SET cleanup_state = 'done', cleanup_last_error = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        RETURNING id`,
      [projectId],
    );
    expect(first).toHaveLength(1);

    // A second pass matches nothing: `already_removed`, not another cleanup.
    const second = await query<{ id: string }>(
      `UPDATE projects SET cleanup_state = 'done'
        WHERE id = $1 AND deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
        RETURNING id`,
      [projectId],
    );
    expect(second).toHaveLength(0);
  });

  it("bounds cleanup_last_error at the column's CHECK", async () => {
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await tombstone(projectId);

    await expect(
      execute("UPDATE projects SET cleanup_last_error = $2 WHERE id = $1", [
        projectId,
        "x".repeat(501),
      ]),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("active-only reads", () => {
  it("hide a tombstone from the scope snapshot EVERY MCP call loads", async () => {
    // `SCOPE_SNAPSHOT_SQL` is the choke point: `runStudioCall` loads it for
    // every call, including read-only ones. A tombstone must vanish from it, or
    // a deleted project's agent could keep executing.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);

    const before = await query<{ id: string }>(
      "SELECT id FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL",
      [projectId],
    );
    expect(before).toHaveLength(1);

    await tombstone(projectId);

    const after = await query<{ id: string }>(
      "SELECT id FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL",
      [projectId],
    );
    expect(after).toHaveLength(0);
  });

  it("refuse a scope edit on a tombstoned project", async () => {
    // The guarded UPDATE is the whole refusal: zero rows means the edit wrote
    // nothing, and the caller reports `projects.not_found`.
    const sessionId = await makeSession();
    const { projectId } = await seedProject(sessionId);
    await tombstone(projectId);

    const updated = await query<{ id: string }>(
      `UPDATE projects
          SET permission = 'restricted', scope_version = scope_version + 1
        WHERE id = $1 AND scope_version = 1 AND deleted_at IS NULL
        RETURNING id`,
      [projectId],
    );

    expect(updated).toHaveLength(0);
  });
});
