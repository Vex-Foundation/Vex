/**
 * The COMMIT-TIME project check on a Studio approve.
 *
 * A Studio approval is authorized by a PROJECT, so the session-mirror
 * permission check that guards an agent approve is necessary and not
 * sufficient. Between the card appearing and the human clicking Approve the
 * project can be deleted, its scope edited, or its permission tightened, and
 * each of those must fail the approve CLOSED - inside the locked transaction,
 * before any approve CAS, with the real cause recorded on the row.
 *
 * Also pinned: the project row is locked LAST (`FOR UPDATE`), after the
 * approval rows, which is the documented global lock order and the same order
 * `updateProjectScope` takes. An approve and a scope edit therefore queue
 * behind each other on the session control lock instead of forming a cycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const approveWith = vi.fn();
const rejectWith = vi.fn();
const markDecisionWith = vi.fn();
const getRunBySession = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ approveWith, rejectWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ markDecisionWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ getRunBySession }));

const { buildApproveSnapshot, buildRejectSnapshot } = await import(
  "@vex-agent/engine/core/approval-runtime/snapshot/build.js"
);
const { TOOL_RESULT_EXPIRED_REASON } = await import(
  "@vex-agent/engine/core/approval-runtime/helpers.js"
);

const APPROVAL_ID = "approval-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function studioRow(overrides: Record<string, unknown> = {}) {
  return {
    approval_id: APPROVAL_ID,
    session_id: "session-1",
    mission_run_id: null,
    tool_call_id: "call-1",
    expires_at: null,
    decision: null,
    decision_reason: null,
    decided_at: null,
    execution_status: "not_started",
    execution_result_hash: null,
    origin: "studio_mcp",
    project_id: PROJECT_ID,
    scope_version_at_enqueue: 4,
    request_digest: "digest",
    queue_status: "pending",
    queue_resolved_at: null,
    queue_created_at: new Date(),
    queue_tool_call: { command: "wallet_send", args: {} },
    queue_tool_call_id: "call-1",
    queue_permission_at_enqueue: "full",
    session_permission_live: "full",
    ...overrides,
  };
}

function scriptClient(
  row: Record<string, unknown>,
  project: { scope_version: number; permission: string } | undefined,
) {
  const query = vi.fn(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes("FROM approval_intents i")) return { rows: [row], rowCount: 1 };
    if (text.includes("FROM projects")) {
      return {
        rows: project === undefined ? [] : [project],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (text.includes("SELECT NOW()")) return { rows: [{ now: new Date() }] };
    return { rows: [], rowCount: 0 };
  });
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  rejectWith.mockResolvedValue({ resolvedAt: new Date().toISOString() });
  markDecisionWith.mockResolvedValue(true);
  approveWith.mockResolvedValue({ resolvedAt: new Date().toISOString() });
});

describe("Studio approve - commit-time project drift", () => {
  it("rejects in-tx with `project_deleted` when the project is gone", async () => {
    const query = scriptClient(studioRow(), undefined);
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("policy_drift_blocked");
    if (snapshot.type !== "policy_drift_blocked") return;
    expect(snapshot.driftKind).toBe("project_deleted");
    expect(snapshot.refusalReason).toBe("project_deleted");
    // Failed closed BEFORE any approve CAS.
    expect(approveWith).not.toHaveBeenCalled();
    expect(rejectWith).toHaveBeenCalledWith(expect.anything(), APPROVAL_ID);
    expect(markDecisionWith.mock.calls[0]?.[1]).toMatchObject({
      kind: "rejected",
      refusalReason: "project_deleted",
    });
  });

  it("rejects in-tx with `scope_changed` when the scope version moved", async () => {
    const query = scriptClient(studioRow(), {
      scope_version: 5,
      permission: "full",
    });
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("policy_drift_blocked");
    if (snapshot.type !== "policy_drift_blocked") return;
    expect(snapshot.driftKind).toBe("scope_changed");
    expect(snapshot.refusalReason).toBe("scope_changed");
    expect(approveWith).not.toHaveBeenCalled();
  });

  it("rejects in-tx when the PROJECT permission was tightened after enqueue", async () => {
    const query = scriptClient(studioRow(), {
      scope_version: 4,
      permission: "restricted",
    });
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("policy_drift_blocked");
    if (snapshot.type !== "policy_drift_blocked") return;
    // Policy drift, not a refusal by an owner: nobody cancelled the action.
    expect(snapshot.driftKind).toBe("project_permission");
    expect(snapshot.refusalReason).toBeNull();
    expect(snapshot.livePermission).toBe("restricted");
    expect(approveWith).not.toHaveBeenCalled();
  });

  it("still runs the session-mirror check first, and reports it as such", async () => {
    // The mirror drifted and the project did not. The existing B-001 outcome
    // must still fire, with no Studio reason attached to it.
    const query = scriptClient(
      studioRow({ session_permission_live: "restricted" }),
      { scope_version: 4, permission: "full" },
    );
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("policy_drift_blocked");
    if (snapshot.type !== "policy_drift_blocked") return;
    expect(snapshot.driftKind).toBe("session_permission");
    expect(snapshot.refusalReason).toBeNull();
    // The project row was never even read: the mirror check short-circuits.
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes("FROM projects"))).toBe(false);
  });

  it("approves when the project still matches, locking it LAST and FOR UPDATE", async () => {
    const query = scriptClient(studioRow(), {
      scope_version: 4,
      permission: "full",
    });
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("approved_in_tx");
    const statements = query.mock.calls.map((c) => String(c[0]));
    const rowsAt = statements.findIndex((s) => s.includes("FROM approval_intents i"));
    const projectAt = statements.findIndex((s) => s.includes("FROM projects"));
    expect(rowsAt).toBeGreaterThanOrEqual(0);
    expect(projectAt).toBeGreaterThan(rowsAt);
    expect(statements[projectAt]).toContain("FOR UPDATE");
  });

  it("never reads a project row for an agent approval", async () => {
    const query = scriptClient(
      studioRow({ origin: "agent", project_id: null, scope_version_at_enqueue: null }),
      undefined,
    );
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("approved_in_tx");
    const statements = query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes("FROM projects"))).toBe(false);
  });
});

/**
 * The EXPIRY DISCRIMINATOR. "This Studio call expired" is a machine fact and
 * belongs in `refusal_reason`; before this it was recovered by matching
 * `/expired/i` against `decision_reason`, a human sentence that any rewording
 * could break and that a human's own decline could accidentally satisfy.
 */
describe("expiry is recorded as a typed reason on Studio rows", () => {
  it("stamps `expired` when the expiry path rejects a Studio row", async () => {
    const query = scriptClient(studioRow(), { scope_version: 4, permission: "full" });
    const snapshot = await buildRejectSnapshot(
      { query } as never,
      APPROVAL_ID,
      TOOL_RESULT_EXPIRED_REASON,
    );
    expect(snapshot.type).toBe("rejected_in_tx");
    expect(markDecisionWith.mock.calls[0]?.[1]).toMatchObject({
      kind: "rejected",
      reason: TOOL_RESULT_EXPIRED_REASON,
      refusalReason: "expired",
    });
  });

  it("writes NULL for an ordinary reject reason, which is not a refusal at all", async () => {
    const query = scriptClient(studioRow(), { scope_version: 4, permission: "full" });
    await buildRejectSnapshot({ query } as never, APPROVAL_ID, "user said no");
    expect(markDecisionWith.mock.calls[0]?.[1].refusalReason).toBeNull();
  });

  it("leaves an AGENT row's column NULL, exactly as before", async () => {
    const query = scriptClient(
      studioRow({ origin: "agent", project_id: null }),
      undefined,
    );
    await buildRejectSnapshot(
      { query } as never,
      APPROVAL_ID,
      TOOL_RESULT_EXPIRED_REASON,
    );
    expect(markDecisionWith.mock.calls[0]?.[1].refusalReason).toBeNull();
  });

  it("stamps it on the approve-time auto-expiry too", async () => {
    const query = scriptClient(
      studioRow({ expires_at: new Date(Date.now() - 60_000) }),
      { scope_version: 4, permission: "full" },
    );
    const snapshot = await buildApproveSnapshot({ query } as never, APPROVAL_ID);
    expect(snapshot.type).toBe("expired_in_tx");
    expect(markDecisionWith.mock.calls[0]?.[1]).toMatchObject({
      refusalReason: "expired",
    });
  });
});
