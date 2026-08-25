/**
 * `casClaimStudioDispatchSlotWith` REQUIRES a real approval decision (audit
 * finding D3, `db/repos/approval-intents/studio-settlement.ts`), on real
 * PostgreSQL.
 *
 * Before this fix `CAS_CLAIM_STUDIO_SLOT_SQL` fenced on
 * `execution_status = 'not_started'` and `origin = 'studio_mcp'` only.
 * `not_started` is also the state of a row nobody has decided yet
 * (`decision IS NULL`), so the slot could be claimed - and the action
 * dispatched - for an intent no human ever approved. This proves the CAS now
 * requires `decision = 'approved'` against the real predicate, not a
 * re-implementation of the SQL under test.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, withTransaction } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

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
 * One Studio intent, with a caller-chosen `decision` and `queue_status`
 * (independent of each other on purpose, so a `not_started`+undecided row and
 * a `not_started`+rejected row can both be modeled - both are shapes that
 * must never claim the dispatch slot).
 */
async function seedStudioIntent(
  sessionId: string,
  projectId: string,
  decision: "approved" | "rejected" | null,
): Promise<string> {
  const approvalId = randomUUID();
  const queueStatus = decision ?? "pending";
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                 tool_call_id, source)
     VALUES ($1, '{}'::jsonb, 'because', $4, $2, $3, 'studio_mcp')`,
    [approvalId, sessionId, `call-${approvalId}`, queueStatus],
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
             'not_started', 'studio_mcp', $4, 1, '1')`,
    [approvalId, sessionId, `call-${approvalId}`, projectId, decision],
  );
  return approvalId;
}

async function readExecutionStatus(approvalId: string): Promise<string> {
  const rows = await query<{ execution_status: string }>(
    "SELECT execution_status FROM approval_intents WHERE approval_id = $1",
    [approvalId],
  );
  return rows[0]!.execution_status;
}

beforeEach(async () => {
  await resetDb();
  await seedRuntimeGate();
});

describe("the Studio dispatch-slot CAS requires decision = 'approved'", () => {
  it("refuses a claim on an UNDECIDED row (decision IS NULL)", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, null);

    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(false);
    expect(await readExecutionStatus(approvalId)).toBe("not_started");
  });

  it("refuses a claim on a REJECTED row even though execution_status is still not_started", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "rejected");

    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(false);
    expect(await readExecutionStatus(approvalId)).toBe("not_started");
  });

  it("claims the slot on an APPROVED row", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedStudioIntent(sessionId, projectId, "approved");

    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(true);
    expect(await readExecutionStatus(approvalId)).toBe("dispatching");
  });
});
