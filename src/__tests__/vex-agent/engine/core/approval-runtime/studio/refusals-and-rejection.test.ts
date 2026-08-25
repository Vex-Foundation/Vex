/**
 * Studio REFUSALS and the origin-aware rejection dispatcher.
 *
 * The two halves of "a Studio approval ends without dispatching":
 *
 *   - `refusePendingStudioIntents` makes a PENDING intent terminal with the
 *     machine cause that fired, and does the CAS BEFORE anything releases the
 *     blocked call. The announcement is a separate call precisely so it cannot
 *     be emitted from inside the refusing transaction.
 *   - `reject-dispatch` routes every generic decision entry point by ORIGIN. An
 *     agent row keeps the existing transcript-and-resume behaviour untouched; a
 *     Studio row gets a settlement event and NOTHING else: no transcript
 *     message, no `result_message_id`, no continuation claim.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Client,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import type {
  ApproveSnapshot,
  IntentSnapshotRow,
  RejectSnapshot,
} from "@vex-agent/engine/core/approval-runtime/snapshot.js";
import type { StudioSettlementEvent } from "@vex-agent/engine/runtime/studio-settlement-bus.js";

const rejectWith = vi.fn();
const markDecisionWith = vi.fn();
const applyRejectSideEffects = vi.fn();
const applyPolicyDriftSideEffects = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ rejectWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ markDecisionWith }));
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/reject.js",
  () => ({ applyRejectSideEffects, applyPolicyDriftSideEffects }),
);

const { refusePendingStudioIntents, announceStudioRefusals } = await import(
  "@vex-agent/engine/core/approval-runtime/studio/refuse.js"
);
const { dispatchRejectSideEffects, dispatchPolicyDriftSideEffects } =
  await import(
    "@vex-agent/engine/core/approval-runtime/post-tx/reject-dispatch.js"
  );
const { studioSettlementBus } = await import(
  "@vex-agent/engine/runtime/studio-settlement-bus.js"
);

const PROJECT_ID = "project-1";

type PromiseQuery = <Row extends QueryResultRow = QueryResultRow>(
  query: string | QueryConfig,
  values?: unknown[],
) => Promise<QueryResult<Row>>;

function scriptClient(rows: ReadonlyArray<{ approval_id: string; project_id: string | null }>) {
  const client = new Client();
  const query = vi.fn<PromiseQuery>();
  Object.defineProperty(client, "query", { configurable: true, value: query });
  query.mockResolvedValue({
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  });
  return { client, query };
}

function snapshotRow(origin: "agent" | "studio_mcp"): IntentSnapshotRow {
  return {
    approval_id: "approval-1",
    session_id: "session-1",
    mission_run_id: null,
    tool_call_id: "call-1",
    expires_at: null,
    decision: "rejected",
    decision_reason: "no",
    decided_at: null,
    execution_status: "not_started",
    execution_result_hash: null,
    origin,
    project_id: origin === "studio_mcp" ? PROJECT_ID : null,
    scope_version_at_enqueue: null,
    request_digest: null,
    queue_status: "rejected",
    queue_resolved_at: null,
    queue_created_at: new Date(),
    queue_tool_call: {},
    queue_tool_call_id: "call-1",
    queue_permission_at_enqueue: "full",
    session_permission_live: "full",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rejectWith.mockResolvedValue({ id: "approval-1" });
  markDecisionWith.mockResolvedValue(true);
});

describe("refusePendingStudioIntents", () => {
  it("locks the rows, CASes each terminal with its refusal reason, and emits nothing", async () => {
    const { client, query } = scriptClient([
      { approval_id: "a-1", project_id: PROJECT_ID },
      { approval_id: "a-2", project_id: PROJECT_ID },
    ]);
    const listener = vi.fn();
    const off = studioSettlementBus.subscribe(listener);
    let refused;
    try {
      refused = await refusePendingStudioIntents(
        client,
        { projectId: PROJECT_ID },
        "scope_changed",
      );
    } finally {
      off();
    }
    expect(refused).toEqual([
      { approvalId: "a-1", projectId: PROJECT_ID },
      { approvalId: "a-2", projectId: PROJECT_ID },
    ]);
    const lockSql = String(query.mock.calls[0]?.[0]);
    expect(lockSql).toContain("origin = 'studio_mcp'");
    expect(lockSql).toContain("decision IS NULL");
    expect(lockSql).toContain("ORDER BY created_at ASC");
    expect(lockSql).toContain("FOR UPDATE");
    // The machine cause and the human sentence are written in the SAME CAS as
    // the decision, so a refused row can never lack the reason that refused it.
    expect(markDecisionWith.mock.calls[0]?.[1]).toMatchObject({
      kind: "rejected",
      refusalReason: "scope_changed",
    });
    expect(String(markDecisionWith.mock.calls[0]?.[1].reason)).toMatch(
      /Nothing was executed/i,
    );
    // NOTHING is announced from inside the transaction: the waiter must not
    // learn of a refusal that has not committed.
    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op for a row another writer already settled", async () => {
    const { client, query } = scriptClient([
      { approval_id: "a-1", project_id: PROJECT_ID },
    ]);
    // The queue CAS misses: the row left `pending` under us.
    rejectWith.mockResolvedValue(null);
    const refused = await refusePendingStudioIntents(
      client,
      { approvalId: "a-1" },
      "cancelled",
    );
    expect(refused).toEqual([]);
    expect(markDecisionWith).not.toHaveBeenCalled();
  });

  it("targets every project for a lock or a quit", async () => {
    const { client, query } = scriptClient([]);
    await refusePendingStudioIntents(client, { all: true }, "lock");
    const lockSql = String(query.mock.calls[0]?.[0]);
    expect(lockSql).not.toContain("project_id = $1");
    expect(query.mock.calls[0]?.[1]).toEqual([]);
  });

  it("announces one settlement event per refused row, after the caller commits", () => {
    const events: StudioSettlementEvent[] = [];
    const off = studioSettlementBus.subscribe((event) => events.push(event));
    try {
      announceStudioRefusals([
        { approvalId: "a-1", projectId: PROJECT_ID },
        { approvalId: "a-2", projectId: null },
      ]);
    } finally {
      off();
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      approvalId: "a-1",
      projectId: PROJECT_ID,
      outcome: "rejected",
    });
    // Ids and one enum only: no prose, no tool output rides this bus.
    const firstEvent = events[0];
    if (firstEvent === undefined) throw new Error("settlement event missing");
    expect(Object.keys(firstEvent).sort()).toEqual([
      "approvalId",
      "occurredAt",
      "outcome",
      "projectId",
      "type",
    ]);
  });
});

describe("the origin-aware rejection dispatcher", () => {
  it("hands an AGENT rejection to the existing side effects, unchanged", async () => {
    applyRejectSideEffects.mockResolvedValue({ kind: "rejected" });
    const snapshot: Extract<RejectSnapshot, { type: "rejected_in_tx" }> = {
      type: "rejected_in_tx",
      row: snapshotRow("agent"),
      queueResolvedAt: "2026-08-23T10:00:00.000Z",
      reason: "no",
    };
    await dispatchRejectSideEffects("approval-1", snapshot, "content");
    expect(applyRejectSideEffects).toHaveBeenCalledWith(
      "approval-1",
      snapshot,
      "content",
    );
  });

  it("settles a STUDIO rejection with an event and no transcript or continuation", async () => {
    const events: StudioSettlementEvent[] = [];
    const off = studioSettlementBus.subscribe((event) => events.push(event));
    let outcome;
    try {
      outcome = await dispatchRejectSideEffects(
        "approval-1",
        {
          type: "rejected_in_tx",
          row: snapshotRow("studio_mcp"),
          queueResolvedAt: "2026-08-23T10:00:00.000Z",
          reason: "expired",
        },
        "content that must not be written anywhere",
      );
    } finally {
      off();
    }
    // The agent path is never entered, so no transcript row and no
    // `result_message_id` can be produced.
    expect(applyRejectSideEffects).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    // No continuation: nothing schedules a turn on the backing session.
    expect(outcome.continuation).toBeNull();
    expect(outcome.missionRunId).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      approvalId: "approval-1",
      projectId: PROJECT_ID,
      outcome: "rejected",
    });
  });

  it("splits the policy-drift path the same way", async () => {
    applyPolicyDriftSideEffects.mockResolvedValue({ kind: "policy_drift_blocked" });
    const agentSnapshot: Extract<
      ApproveSnapshot,
      { type: "policy_drift_blocked" }
    > = {
      type: "policy_drift_blocked",
      row: snapshotRow("agent"),
      queueResolvedAt: "2026-08-23T10:00:00.000Z",
      reason: "drift",
      permissionAtEnqueue: "full",
      livePermission: "restricted",
      driftKind: "session_permission",
      refusalReason: null,
    };
    await dispatchPolicyDriftSideEffects(
      "approval-1",
      agentSnapshot,
      "content",
    );
    expect(applyPolicyDriftSideEffects).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const outcome = await dispatchPolicyDriftSideEffects(
      "approval-1",
      { ...agentSnapshot, row: snapshotRow("studio_mcp") },
      "content",
    );
    expect(applyPolicyDriftSideEffects).not.toHaveBeenCalled();
    expect(outcome.continuation).toBeNull();
  });
});
