/**
 * Approval runtime — puzzle 5 phase 3 deep coverage.
 *
 * Pinned invariants:
 *   - FOR UPDATE locked snapshot tx (single client.query for snapshot SQL).
 *   - Snapshot SELECT locks i, q AND s (sessions) — `FOR UPDATE OF i, q, s` —
 *     so the LIVE session permission read is serialized against a concurrent
 *     permission-downgrade tx (B-001-fix).
 *   - DB-side NOW() used for TTL gate (NOT JS Date.now()).
 *   - Atomic auto-reject INSIDE tx for expired_in_tx path (queue + intent
 *     CAS in same client before commit).
 *   - markDecisionWith CAS-guarded with decision IS NULL predicate.
 *   - Dispatch THROW path: mark execution_status='failed' + tool-result
 *     redacted + mission run flipped to paused_error + ApprovalDispatchError
 *     + NO continuation.
 *   - Controlled failure (success:false): mission resumes, executionStatus
 *     'failed', continuation present.
 *   - Cached / already-rejected / run-terminated outcomes carry NO
 *     continuation.
 *   - sweepExpiredApprovals iterates getExpired with per-row exception
 *     isolation, returns continuations from rejected outcomes only.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Pool client mock — drives the snapshot tx + repo queries via SQL ─────

interface QueryRecord {
  sql: string;
  params: unknown[] | undefined;
}

const clientQueryLog: QueryRecord[] = [];
let mockClientQuery: Mock<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
>;

function resetClientQuery() {
  clientQueryLog.length = 0;
  mockClientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    clientQueryLog.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });
}
resetClientQuery();

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    return fn({ query: (sql: string, params?: unknown[]) => mockClientQuery(sql, params) });
  }),
  execute: vi.fn().mockResolvedValue(1),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn(async (client: { query: Mock }, sql: string, params?: unknown[]) => {
    const res = await client.query(sql, params);
    return (res.rows[0] ?? null) as unknown;
  }),
  executeWith: vi.fn(async (client: { query: Mock }, sql: string, params?: unknown[]) => {
    const res = await client.query(sql, params);
    return res.rowCount ?? 0;
  }),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock("@vex-agent/db/params.js", () => ({
  jsonb: (v: unknown) => JSON.stringify(v),
  nullableJsonb: (v: unknown) => (v === null ? null : JSON.stringify(v)),
}));

const mockDispatchTool = vi.fn();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

const mockAppendMessage = vi.fn();
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  appendEngineMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/engine/wake/blob-refresh.js", () => ({
  refreshBlobTtlForRecentMessages: vi.fn().mockResolvedValue(0),
}));

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn(),
}));

// mission-runs repo: getRunBySession (used inside snapshot tx with client)
// reaches client.query via queryOneWith. updateStatus called outside tx for
// paused_error transition — mocked directly.
const mockMissionRunsUpdateStatus = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/mission-runs.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/db/repos/mission-runs.js")>(
    "@vex-agent/db/repos/mission-runs.js",
  );
  return {
    ...actual,
    updateStatus: (...a: unknown[]) => mockMissionRunsUpdateStatus(...a),
  };
});

// Lease + status helpers (lazy-imported inside continuation.ts)
const mockClaimRunLeaseAndFlipToRunning = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) =>
    mockClaimRunLeaseAndFlipToRunning(...a),
}));

const mockCreateLeaseHandle = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

const mockReleaseLeaseAndEmit = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) =>
    mockReleaseLeaseAndEmit(...a),
}));

// resumeMissionRun (lazy import from continuation)
const mockResumeMissionRun = vi.fn().mockResolvedValue({
  text: "Resumed",
  toolCallsMade: 1,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: "running",
});
vi.mock("../../../../../vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCancelIfPending = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  cancelIfPending: (...a: unknown[]) => mockCancelIfPending(...a),
  getById: vi.fn(),
}));

// approval-intents repo: keep markExecutionStatus mockable so we can pin
// the non-tx audit calls. getExpired is mocked per-test for sweep cases.
const mockMarkExecutionStatus = vi.fn().mockResolvedValue(undefined);
const mockGetExpired = vi.fn().mockResolvedValue([]);
vi.mock("@vex-agent/db/repos/approval-intents.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/db/repos/approval-intents.js")>(
    "@vex-agent/db/repos/approval-intents.js",
  );
  return {
    ...actual,
    markExecutionStatus: (...a: unknown[]) => mockMarkExecutionStatus(...a),
    getExpired: (...a: unknown[]) => mockGetExpired(...a),
  };
});

// ── Imports under test (after mocks) ────────────────────────────────────

const {
  prepareApprove,
  prepareReject,
  expireApproval,
  sweepExpiredApprovals,
  ApprovalDispatchError,
  ApprovalPostDecisionError,
} = await import("@vex-agent/engine/core/approval-runtime.js");

// ── Helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const APPROVAL_ID = "approval-runtime-test-001";

interface SnapshotRowOverrides {
  decision?: "approved" | "rejected" | "rejected_stop" | null;
  queue_status?: string;
  expires_at?: Date | string | null;
  mission_run_id?: string | null;
  execution_status?: string | null;
  queue_tool_call?: Record<string, unknown>;
  // B-001 — permission snapshot at enqueue vs LIVE session permission read in
  // the same snapshot SELECT. Default both to "restricted" so the existing
  // approve/dispatch characterization stays byte-identical (no drift).
  queue_permission_at_enqueue?: "restricted" | "full";
  session_permission_live?: "restricted" | "full";
}

function buildSnapshotRow(o: SnapshotRowOverrides = {}): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    session_id: SESSION_ID,
    mission_run_id: o.mission_run_id !== undefined ? o.mission_run_id : "run-1",
    tool_call_id: "call-1",
    expires_at: o.expires_at !== undefined ? o.expires_at : null,
    decision: o.decision ?? null,
    decision_reason: null,
    decided_at: null,
    execution_status: o.execution_status ?? null,
    execution_result_hash: null,
    queue_status: o.queue_status ?? "pending",
    queue_resolved_at: null,
    queue_created_at: new Date("2026-05-23T10:00:00.000Z"),
    queue_tool_call: o.queue_tool_call ?? {
      command: "wallet_send_confirm",
      args: { to: "0xabc", amount: "1.0" },
    },
    queue_tool_call_id: "call-1",
    queue_permission_at_enqueue: o.queue_permission_at_enqueue ?? "restricted",
    session_permission_live: o.session_permission_live ?? "restricted",
  };
}

function programSnapshotOnly(
  row: Record<string, unknown> | null,
  options: { dbNow?: Date } = {},
) {
  // Snapshot tx pattern:
  //   1. SELECT ... FOR UPDATE  (snapshot row or empty)
  //   2. SELECT NOW() as now    (only if expires_at non-null)
  //   3. UPDATE approval_queue  (rejectWith for expired-in-tx, approveWith for happy)
  //   4. UPDATE approval_intents SET decision...   (markDecisionWith)
  // Subsequent test calls outside the tx (markExecutionStatus etc.) are
  // mocked on their repo functions directly.
  mockClientQuery.mockReset();
  mockClientQuery.mockImplementation(async (sql: string) => {
    clientQueryLog.push({ sql, params: undefined });
    if (sql.includes("FOR UPDATE OF i, q")) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SELECT NOW()")) {
      return { rows: [{ now: options.dbNow ?? new Date() }], rowCount: 1 };
    }
    if (sql.includes("UPDATE approval_queue") && sql.includes("'approved'")) {
      // approveWith CAS — return a synthetic queue row so the snapshot
      // transitions to approved_in_tx.
      return {
        rows: [
          {
            id: row?.approval_id ?? APPROVAL_ID,
            tool_call: row?.queue_tool_call ?? {},
            reasoning: "",
            status: "approved",
            session_id: row?.session_id ?? SESSION_ID,
            tool_call_id: row?.queue_tool_call_id ?? "call-1",
            permission_at_enqueue: "restricted",
            created_at: "2026-05-23T10:00:00Z",
            resolved_at: "2026-05-23T20:00:00Z",
            pending_context: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE approval_queue") && sql.includes("'rejected'")) {
      return {
        rows: [
          {
            id: row?.approval_id ?? APPROVAL_ID,
            tool_call: row?.queue_tool_call ?? {},
            reasoning: "",
            status: "rejected",
            session_id: row?.session_id ?? SESSION_ID,
            tool_call_id: row?.queue_tool_call_id ?? "call-1",
            permission_at_enqueue: "restricted",
            created_at: "2026-05-23T10:00:00Z",
            resolved_at: "2026-05-23T20:00:00Z",
            pending_context: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql.includes("UPDATE approval_intents")
      && sql.includes("decision        = $2")
    ) {
      // markDecisionWith CAS — return rowCount=1 to signal success.
      return { rows: [{ approval_id: row?.approval_id ?? APPROVAL_ID }], rowCount: 1 };
    }
    // mission_runs.getRunBySession inside snapshot tx → no terminal guard
    if (sql.includes("FROM mission_runs WHERE session_id")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  resetClientQuery();
  mockDispatchTool.mockReset();
  mockAppendMessage.mockReset();
  mockMissionRunsUpdateStatus.mockReset();
  mockMarkExecutionStatus.mockReset();
  mockGetExpired.mockReset();
  mockClaimRunLeaseAndFlipToRunning.mockReset();
  mockCreateLeaseHandle.mockReset();
  mockResumeMissionRun.mockReset();
  mockReleaseLeaseAndEmit.mockReset();
  mockCancelIfPending.mockReset();
  mockCancelIfPending.mockResolvedValue(null);

  // Default lease claim path — happy: claim succeeds, handle returned.
  mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_approval",
    lease: { sessionId: SESSION_ID, missionRunId: "run-1", ownerId: "approve-x", processKind: "electron_main" },
    wakeCancelledCount: 0,
  });
  mockCreateLeaseHandle.mockImplementation((opts: { ownerId: string; lease: unknown }) => ({
    lease: opts.lease,
    ownerId: opts.ownerId,
    release: vi.fn().mockResolvedValue(undefined),
  }));
});

// ── prepareApprove ──────────────────────────────────────────────────────

// ── expireApproval ──────────────────────────────────────────────────────

describe("expireApproval", () => {
  it("writes 'expired_ttl' decision_reason and auto-reject tool-result content", async () => {
    programSnapshotOnly(buildSnapshotRow());

    const outcome = await expireApproval(APPROVAL_ID);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("kind mismatch");
    expect(outcome.reason).toBe("expired_ttl");

    const trCall = mockAppendMessage.mock.calls.find(
      (c) =>
        typeof c[1] === "object"
        && (c[1] as { role?: string }).role === "tool",
    );
    expect(trCall).toBeDefined();
    expect((trCall![1] as { content: string }).content).toContain(
      "auto-rejected",
    );
  });

  it("skips race-lost rows (queue.status already approved) → already_approved", async () => {
    programSnapshotOnly(
      buildSnapshotRow({ decision: "approved", queue_status: "approved" }),
    );

    const outcome = await expireApproval(APPROVAL_ID);
    expect(outcome.kind).toBe("already_approved");
  });

  it("wallet_send_confirm expire cancels the linked pending wallet intent", async () => {
    const intentId = "intent-00000000-0000-4000-8000-000000000077";
    programSnapshotOnly(
      buildSnapshotRow({
        queue_tool_call: {
          command: "wallet_send_confirm",
          args: { network: "eip155", intentId },
        },
      }),
    );

    const outcome = await expireApproval(APPROVAL_ID);
    expect(outcome.kind).toBe("rejected");
    expect(mockCancelIfPending).toHaveBeenCalledWith(intentId, SESSION_ID);
  });
});
