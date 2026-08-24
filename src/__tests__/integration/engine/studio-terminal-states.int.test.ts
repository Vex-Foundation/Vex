/**
 * Integration: EVERY EXIT FROM AN APPROVED VEX STUDIO INTENT IS TERMINAL, on a
 * real PostgreSQL.
 *
 * The defect this file exists to keep closed: an approved Studio row that is
 * refused before it dispatches used to be reported to its caller and left
 * `not_started` (still claimable by the dispatch CAS) or, in the scope-edit
 * case, committed as `dispatching` with no writer alive. Nothing reconciles
 * either state - the agent lifecycle scans exclude Studio rows and the expiry
 * sweep only looks at UNDECIDED rows - so the row stayed approvable behind an
 * external agent that had already been told nothing happened.
 *
 * These are database statements about interleaving and predicates, so they run
 * on real connections through the PRODUCTION entry points, never on a
 * re-implementation of the SQL under test.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const admitStudioCall = vi.fn();
vi.mock("@vex-agent/mcp/admission.js", () => ({ admitStudioCall }));

const { execute, getPool, query, withTransaction } = await import(
  "@vex-agent/db/client.js"
);
const approvalIntentsRepo = await import(
  "@vex-agent/db/repos/approval-intents.js"
);
const { applyStudioApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.js"
);
const { buildApprovalToolCall } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);
const { advanceStudioDispatchGeneration, setStudioDispatchPreflight } =
  await import(
    "@vex-agent/engine/core/approval-runtime/studio/dispatch-gate.js"
  );
const {
  reconcileUnstartedStudioApprovals,
  reconcileAbandonedStudioDispatches,
} = await import(
  "@vex-agent/engine/core/approval-runtime/studio/reconcile-dispatching.js"
);
const { makeSession, resetDb } = await import("../setup/fixtures.js");

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

/** An APPROVED Studio intent, enqueued under scope version 1. */
async function seedApprovedIntent(
  sessionId: string,
  projectId: string,
  generation: string,
): Promise<string> {
  const approvalId = randomUUID();
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                 tool_call_id, source)
     VALUES ($1, '{}'::jsonb, 'because', 'approved', $2, $3, 'studio_mcp')`,
    [approvalId, sessionId, `call-${approvalId}`],
  );
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, decision, decided_at,
        execution_status, origin, project_id, scope_version_at_enqueue,
        dispatch_generation_at_enqueue)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
             '{}'::jsonb, '{}'::jsonb, 'approved', NOW(),
             'not_started', 'studio_mcp', $4, 1, $5)`,
    [approvalId, sessionId, `call-${approvalId}`, projectId, generation],
  );
  return approvalId;
}

interface DurableState {
  execution_status: string;
  decision: string | null;
  refusal_reason: string | null;
  settlement: Record<string, unknown> | null;
  settlement_bytes: number | null;
}

async function readState(approvalId: string): Promise<DurableState> {
  const rows = await query<DurableState>(
    `SELECT execution_status, decision, refusal_reason, settlement,
            settlement_bytes
       FROM approval_intents WHERE approval_id = $1`,
    [approvalId],
  );
  return rows[0]!;
}

const ENVELOPE = buildApprovalToolCall("wallet_send", { network: "solana" });

function snapshot(
  approvalId: string,
  sessionId: string,
  projectId: string,
): unknown {
  return {
    type: "approved_in_tx",
    queueResolvedAt: new Date().toISOString(),
    row: {
      approval_id: approvalId,
      session_id: sessionId,
      mission_run_id: null,
      tool_call_id: `call-${approvalId}`,
      expires_at: null,
      decision: "approved",
      decision_reason: null,
      decided_at: null,
      execution_status: "not_started",
      execution_result_hash: null,
      origin: "studio_mcp",
      project_id: projectId,
      scope_version_at_enqueue: 1,
      request_digest: null,
      queue_status: "approved",
      queue_resolved_at: null,
      queue_created_at: new Date(),
      queue_tool_call: ENVELOPE,
      queue_tool_call_id: `call-${approvalId}`,
      queue_permission_at_enqueue: "full",
      session_permission_live: "full",
    },
  };
}

beforeEach(async () => {
  await resetDb();
  await seedRuntimeGate();
  vi.clearAllMocks();
  setStudioDispatchPreflight(null);
  admitStudioCall.mockRejectedValue(
    new Error("the dispatch must never be reached in this suite"),
  );
});

describe("a scope edit that commits AFTER the enqueue", () => {
  it("refuses against the ENQUEUE version and leaves the row terminal", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");

    // The user edits the project's scope after the approval was granted. The
    // dispatcher would load THIS version; comparing it with itself would match
    // and the action would run under the NEW wallets.
    await execute(
      "UPDATE projects SET scope_version = scope_version + 1 WHERE id = $1",
      [projectId],
    );

    const outcome = await applyStudioApproveSideEffects(
      approvalId,
      snapshot(approvalId, sessionId, projectId) as never,
    );
    expect(admitStudioCall).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("dispatched");

    const state = await readState(approvalId);
    // Terminal, named, and with the sentence the caller was given - NOT left
    // `dispatching` by a committed claim, and NOT left `not_started`.
    expect(state.execution_status).toBe("failed");
    expect(state.refusal_reason).toBe("scope_changed");
    expect(state.settlement).not.toBeNull();
    expect(state.settlement_bytes).toBeGreaterThan(0);

    // The proof that it is terminal: the dispatch CAS can no longer take it.
    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(took).toBe(false);
  });
});

describe("a lock that advances the generation after the enqueue", () => {
  it("makes the row terminal instead of leaving it approvable", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");

    const advanced = await advanceStudioDispatchGeneration();
    expect(advanced.ok).toBe(true);

    await applyStudioApproveSideEffects(
      approvalId,
      snapshot(approvalId, sessionId, projectId) as never,
    );
    expect(admitStudioCall).not.toHaveBeenCalled();

    const state = await readState(approvalId);
    expect(state.execution_status).toBe("failed");
    expect(state.refusal_reason).toBe("generation_superseded");
    expect(state.settlement).not.toBeNull();
  });
});

describe("a preflight that cannot prove the lock fence", () => {
  it("refuses durably even though the durable generation still matches", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");
    // The generation is UNCHANGED: this is the failed-advance gap, in which the
    // fence never moved because nobody could move it.
    setStudioDispatchPreflight(() => false);

    await applyStudioApproveSideEffects(
      approvalId,
      snapshot(approvalId, sessionId, projectId) as never,
    );
    expect(admitStudioCall).not.toHaveBeenCalled();

    const state = await readState(approvalId);
    expect(state.execution_status).toBe("failed");
    expect(state.refusal_reason).toBe("generation_superseded");
  });
});

describe("the refusal CAS races the slot claim on one row", () => {
  it("lets exactly one of them win, in both orders", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);

    const claimFirst = await seedApprovedIntent(sessionId, projectId, "1");
    const took = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, claimFirst),
    );
    expect(took).toBe(true);
    const refusedAfterClaim = await withTransaction((client) =>
      approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(client, {
        approvalId: claimFirst,
        refusalReason: "stopped",
        settlementJson: '{"v":1,"result":{"success":false,"output":"x"}}',
        settlementBytes: 46,
        resultHash: "hash",
      }),
    );
    // The dispatcher owns it. A refusal must not overwrite a live dispatch.
    expect(refusedAfterClaim).toBe(false);
    expect((await readState(claimFirst)).execution_status).toBe("dispatching");

    const refuseFirst = await seedApprovedIntent(sessionId, projectId, "1");
    const refused = await withTransaction((client) =>
      approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(client, {
        approvalId: refuseFirst,
        refusalReason: "generation_superseded",
        settlementJson: '{"v":1,"result":{"success":false,"output":"x"}}',
        settlementBytes: 46,
        resultHash: "hash",
      }),
    );
    expect(refused).toBe(true);
    const tookAfterRefusal = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, refuseFirst),
    );
    // The refusal owns it. Nothing can dispatch a refused row.
    expect(tookAfterRefusal).toBe(false);
    const state = await readState(refuseFirst);
    expect(state.execution_status).toBe("failed");
    expect(state.refusal_reason).toBe("generation_superseded");
  });

  it("blocks the second writer rather than interleaving, on two connections", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");

    const pool = getPool();
    const dispatcher = await pool.connect();
    const refuser = await pool.connect();
    try {
      await dispatcher.query("BEGIN");
      const took = await approvalIntentsRepo.casClaimStudioDispatchSlotWith(
        dispatcher,
        approvalId,
      );
      expect(took).toBe(true);

      // The refusal reaches the same row while the claim is UNCOMMITTED. It
      // must wait for the row lock, not decide on stale state.
      await refuser.query("BEGIN");
      let refusalSettled = false;
      const refusal = approvalIntentsRepo
        .casRefuseStudioBeforeDispatchWith(refuser, {
          approvalId,
          refusalReason: "stopped",
          settlementJson: '{"v":1,"result":{"success":false,"output":"x"}}',
          settlementBytes: 46,
          resultHash: "hash",
        })
        .then((flipped) => {
          refusalSettled = true;
          return flipped;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(refusalSettled).toBe(false);

      await dispatcher.query("COMMIT");
      expect(await refusal).toBe(false);
      await refuser.query("COMMIT");
    } finally {
      dispatcher.release();
      refuser.release();
    }
    expect((await readState(approvalId)).execution_status).toBe("dispatching");
  });
});

describe("the indeterminate fallback", () => {
  it("commits the status AND the preserved settlement in ONE statement", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");
    await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );

    // The settlement write "failed" after the dispatch already ran, so the only
    // evidence left is the text - which has to land WITH the status, because a
    // status flip first would leave `dispatching` and the settlement CAS is
    // fenced on exactly that.
    const json = '{"v":1,"result":{"success":true,"output":"broadcast 0xabc"}}';
    const flipped = await withTransaction((client) =>
      approvalIntentsRepo.casMarkIndeterminateWithSettlementWith(client, {
        approvalId,
        settlementJson: json,
        settlementBytes: Buffer.byteLength(json, "utf8"),
        resultHash: "err-hash",
      }),
    );
    expect(flipped).toBe(true);

    const state = await readState(approvalId);
    expect(state.execution_status).toBe("indeterminate");
    expect(state.settlement).toEqual({
      v: 1,
      result: { success: true, output: "broadcast 0xabc" },
    });
    expect(state.settlement_bytes).toBe(Buffer.byteLength(json, "utf8"));

    // Fenced: a second pass finds nothing to flip and overwrites nothing.
    const again = await withTransaction((client) =>
      approvalIntentsRepo.casMarkIndeterminateWithSettlementWith(client, {
        approvalId,
        settlementJson: null,
        settlementBytes: null,
        resultHash: null,
      }),
    );
    expect(again).toBe(false);
  });
});

describe("the startup reconciler, against the real predicates", () => {
  /**
   * The scan that closes the live-process gap: an approved Studio row left
   * `not_started` is STILL CLAIMABLE by the dispatch CAS, so a process that
   * died - or a terminal refusal write that failed - leaves a money-path action
   * that any later dispatcher would run. Nothing else reaches it: the expiry
   * sweep scans `decision IS NULL` and the agent lifecycle scans exclude Studio
   * rows.
   *
   * These assertions are about the SQL predicate itself, which is why they run
   * on a real database rather than against a mocked repo.
   */
  it("refuses approved/not_started studio rows and leaves them unclaimable", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");

    const refused = await reconcileUnstartedStudioApprovals();
    expect(refused).toEqual([{ approvalId, projectId }]);

    const state = await readState(approvalId);
    expect(state.execution_status).toBe("failed");
    expect(state.refusal_reason).toBe("stopped");
    expect(state.decision).toBe("approved");
    const body = state.settlement as { result: { output: string } } | null;
    expect(body?.result.output).toMatch(/restarted/i);
    expect(body?.result.output).toMatch(/Nothing was executed/i);

    // TERMINAL means unclaimable: the slot CAS requires `not_started`, so it
    // now matches zero rows and the action can never run.
    const claimed = await withTransaction((client) =>
      approvalIntentsRepo.casClaimStudioDispatchSlotWith(client, approvalId),
    );
    expect(claimed).toBe(false);
  });

  it("leaves AGENT rows in the same state completely alone", async () => {
    const sessionId = await makeSession();
    const agentApprovalId = randomUUID();
    await execute(
      `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id,
                                   tool_call_id, source)
       VALUES ($1, '{}'::jsonb, 'because', 'approved', $2, $3, 'agent')`,
      [agentApprovalId, sessionId, `call-${agentApprovalId}`],
    );
    await execute(
      `INSERT INTO approval_intents
         (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
          risk_level, preview_json, policy_json, decision, decided_at,
          execution_status, origin)
       VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high',
               '{}'::jsonb, '{}'::jsonb, 'approved', NOW(),
               'not_started', 'agent')`,
      [agentApprovalId, sessionId, `call-${agentApprovalId}`],
    );

    expect(await reconcileUnstartedStudioApprovals()).toEqual([]);
    expect(await reconcileAbandonedStudioDispatches()).toEqual([]);

    // Untouched: an agent row belongs to the turn loop's own lifecycle, and a
    // Studio scan that reached it would settle a live agent turn's approval.
    const state = await readState(agentApprovalId);
    expect(state.execution_status).toBe("not_started");
    expect(state.refusal_reason).toBeNull();
    expect(state.settlement).toBeNull();
  });

  it("does not touch a studio row that is not APPROVED", async () => {
    const sessionId = await makeSession();
    const projectId = await seedProject(sessionId);
    const approvalId = await seedApprovedIntent(sessionId, projectId, "1");
    // An undecided row belongs to the pending-refusal primitive and the expiry
    // sweep, both of which write the DECISION as well.
    await execute(
      "UPDATE approval_intents SET decision = NULL, decided_at = NULL WHERE approval_id = $1",
      [approvalId],
    );
    expect(await reconcileUnstartedStudioApprovals()).toEqual([]);
    expect((await readState(approvalId)).execution_status).toBe("not_started");
  });
});
