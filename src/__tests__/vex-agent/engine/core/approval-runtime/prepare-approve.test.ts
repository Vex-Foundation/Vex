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
  TRANSCRIPT_APPEND_EVENT_TYPE: "transcript.append",
}));

// In-process backoff retries (A5 attempt 2) — stubbed so the suite never arms
// real timers. The retry ladder has its own coverage in deferred-resume tests.
const mockScheduleDeferredResumeRetries = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/deferred-resume.js",
  () => ({
    scheduleDeferredResumeRetries: (...a: unknown[]) =>
      mockScheduleDeferredResumeRetries(...a),
    dispatchPendingApprovalResumes: vi.fn(),
    resumePendingApprovalsForSession: vi.fn(),
  }),
);

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn(),
}));

// mission-runs repo: getRunBySession (used inside snapshot tx with client)
// reaches client.query via queryOneWith. updateStatus called outside tx for
// paused_error transition — mocked directly.
const mockMissionRunsUpdateStatus = vi.fn().mockResolvedValue(true);
vi.mock("@vex-agent/db/repos/mission-runs.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/db/repos/mission-runs.js")>(
    "@vex-agent/db/repos/mission-runs.js",
  );
  return {
    ...actual,
    updateStatus: (...a: unknown[]) => mockMissionRunsUpdateStatus(...a),
    // ATROPOS-2 made the paused_error flip terminal-safe; `flipRunToPausedError`
    // now goes through the CAS variant. Same spy, same assertions.
    updateStatusIfNotTerminal: (...a: unknown[]) =>
      mockMissionRunsUpdateStatus(...a),
  };
});

// Lease + status helpers (lazy-imported inside continuation.ts). `claimSessionLease`
// is the CHAT arm — a chat approval now claims a plain session lease instead of
// silently having no continuation at all.
const mockClaimRunLeaseAndFlipToRunning = vi.fn();
const mockClaimSessionLease = vi.fn();
/**
 * Operator-stop gate the approved dispatch runs between the slot CAS and the
 * dispatch. Stubbed `clear` by default so this file stays about the ORDERING
 * contract; the gate's own behaviour is proven in
 * `operator-stop-boundary.test.ts` (decision logic) and in
 * `integration/engine/operator-stop-boundary.int.test.ts` (real two-client
 * interleaving), because a SQL stub cannot demonstrate a serialization
 * boundary.
 */
const mockGateOnOperatorStopTransaction = vi
  .fn()
  .mockResolvedValue({ kind: "clear" });

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: vi.fn(),
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) =>
    mockClaimRunLeaseAndFlipToRunning(...a),
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  gateOnOperatorStopTransaction: (...a: unknown[]) =>
    mockGateOnOperatorStopTransaction(...a),
  // The `paused_error` recovery flip carries the durable operator-Stop consumer,
  // so it reaches the control plane too. Stubbed to "no stop raced us"; the
  // consumer's own behaviour is pinned by
  // `approval-runtime/paused-error-flip-stop-consumer.test.ts`.
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
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

// approval-intents repo: keep markExecutionStatus mockable so we can pin
// the non-tx audit calls. getExpired is mocked per-test for sweep cases.
const mockMarkExecutionStatus = vi.fn().mockResolvedValue(undefined);
const mockGetExpired = vi.fn().mockResolvedValue([]);
// Lifecycle CAS helpers (migration 056). `casMarkDispatchingWith` is the guard that
// takes the dispatch slot — `false` means another writer owns the dispatch and
// this path must NOT run the tool.
const mockCasMarkDispatching = vi.fn().mockResolvedValue(true);
const mockCasMarkResumeConsumed = vi.fn().mockResolvedValue(true);
const mockMarkResumeAttempted = vi.fn().mockResolvedValue(undefined);
// `true` = this writer still owned the `dispatching` slot when the result
// landed. The repo write is CAS-fenced on that status.
const mockCommitExecutionResultWith = vi.fn().mockResolvedValue(true);
const mockAttachResultMessageWith = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/approval-intents.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/db/repos/approval-intents.js")>(
    "@vex-agent/db/repos/approval-intents.js",
  );
  return {
    ...actual,
    markExecutionStatus: (...a: unknown[]) => mockMarkExecutionStatus(...a),
    getExpired: (...a: unknown[]) => mockGetExpired(...a),
    casMarkDispatchingWith: (...a: unknown[]) => mockCasMarkDispatching(...a),
    casMarkResumeConsumed: (...a: unknown[]) => mockCasMarkResumeConsumed(...a),
    markResumeAttempted: (...a: unknown[]) => mockMarkResumeAttempted(...a),
    commitExecutionResultWith: (...a: unknown[]) =>
      mockCommitExecutionResultWith(...a),
    attachResultMessageWith: (...a: unknown[]) =>
      mockAttachResultMessageWith(...a),
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
  /** The digest recorded at enqueue; a pre-digest row carries none. */
  request_digest?: string | null;
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
    // A pre-digest row records no digest, which `approvalRequestDigestMatches`
    // reads as "nothing to compare" rather than as a mismatch.
    request_digest: o.request_digest ?? null,
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
  mockClaimSessionLease.mockReset();
  mockCreateLeaseHandle.mockReset();
  mockResumeMissionRun.mockReset();
  mockReleaseLeaseAndEmit.mockReset();
  mockCasMarkDispatching.mockReset();
  mockCasMarkResumeConsumed.mockReset();
  mockMarkResumeAttempted.mockReset();
  mockCommitExecutionResultWith.mockReset();
  mockAttachResultMessageWith.mockReset();
  mockScheduleDeferredResumeRetries.mockReset();

  // Transcript writes return the inserted row — the atomic commit needs its id
  // to stamp `result_message_id` in the SAME transaction.
  mockAppendMessage.mockResolvedValue({
    id: 4242,
    role: "tool",
    content: "",
    timestamp: "2026-05-23T20:00:00.000Z",
  });
  mockCasMarkDispatching.mockResolvedValue(true);
  mockCasMarkResumeConsumed.mockResolvedValue(true);
  mockMarkResumeAttempted.mockResolvedValue(undefined);
  // `true` = this writer still owned the `dispatching` slot (CAS-fenced write).
  mockCommitExecutionResultWith.mockResolvedValue(true);
  mockAttachResultMessageWith.mockResolvedValue(undefined);
  mockReleaseLeaseAndEmit.mockResolvedValue(undefined);

  // Chat sessions claim a plain session lease.
  mockClaimSessionLease.mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: SESSION_ID,
      missionRunId: null,
      ownerId: "approve-x",
      processKind: "electron_main",
    },
  });

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

describe("prepareApprove", () => {
  it("happy path: snapshot+approveWith+markDecision → dispatched with succeeded execution_status and continuation", async () => {
    programSnapshotOnly(buildSnapshotRow());
    mockDispatchTool.mockResolvedValue({ success: true, output: "Tx hash 0xabc" });

    const outcome = await prepareApprove(APPROVAL_ID);

    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    expect(outcome.executionStatus).toBe("succeeded");
    expect(outcome.continuation).not.toBeNull();
    expect(outcome.toolResult.success).toBe(true);

    // Dispatch slot taken via the CAS (`not_started -> dispatching`), which
    // also stamps `dispatch_started_at`.
    expect(mockCasMarkDispatching).toHaveBeenCalledWith(
        // The CAS now runs on the stop gate's transaction client — same
        // predicate, one fewer commit. See `dispatch-slot-gate.ts`.
        expect.anything(),
        APPROVAL_ID,
      );

    // Result + result_message_id committed together with the transcript row.
    expect(mockCommitExecutionResultWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalId: APPROVAL_ID,
        status: "succeeded",
        resultMessageId: 4242,
      }),
    );

    // Tool-result message appended with visibility='internal', success=true
    expect(mockAppendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ role: "tool", content: "Tx hash 0xabc" }),
      expect.objectContaining({
        source: "tool",
        visibility: "internal",
        payload: { success: true },
      }),
      // Caller-owned transaction: storage-only append, caller emits after COMMIT.
      expect.objectContaining({ client: expect.anything() }),
    );

    // Snapshot tx executed FOR UPDATE OF i, q
    const snapshotCall = clientQueryLog.find((c) =>
      c.sql.includes("FOR UPDATE OF i, q"),
    );
    expect(snapshotCall).toBeDefined();
  });

  it("ORDERING: the continuation is claimed BEFORE the tool is dispatched", async () => {
    // The single most important ordering property in this module. With
    // dispatch-first, a busy lease meant the funds had already moved while the
    // IPC reported `dispatch_failed` — the user was told the opposite of the
    // truth. Claiming first makes a busy lease observable while nothing has
    // happened yet.
    const order: string[] = [];
    programSnapshotOnly(buildSnapshotRow());
    mockClaimRunLeaseAndFlipToRunning.mockImplementation(async () => {
      order.push("claim");
      return {
        outcome: "claimed",
        previousStatus: "paused_approval",
        lease: { sessionId: SESSION_ID, missionRunId: "run-1", ownerId: "approve-x", processKind: "electron_main" },
        wakeCancelledCount: 0,
      };
    });
    mockCasMarkDispatching.mockImplementation(async () => {
      order.push("cas_dispatching");
      return true;
    });
    mockDispatchTool.mockImplementation(async () => {
      order.push("dispatch");
      return { success: true, output: "ok" };
    });

    await prepareApprove(APPROVAL_ID);

    expect(order).toEqual(["claim", "cas_dispatching", "dispatch"]);
  });

  it("CAS loses the dispatch slot → deferred, tool NEVER dispatched (no double-spend)", async () => {
    // Another writer (the reconciler) already took `not_started -> dispatching`.
    // Losing that CAS is the guard that makes a second execution of an approved
    // money-path action impossible.
    programSnapshotOnly(buildSnapshotRow());
    mockCasMarkDispatching.mockResolvedValue(false);
    mockDispatchTool.mockResolvedValue({ success: true, output: "SHOULD NOT RUN" });

    const outcome = await prepareApprove(APPROVAL_ID);

    expect(outcome.kind).toBe("deferred_busy");
    expect(mockDispatchTool).not.toHaveBeenCalled();
    // The lease we claimed is handed straight back.
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();
  });

  it("dispatch returns success:false → executionStatus='failed', continuation still present (controlled failure)", async () => {
    programSnapshotOnly(buildSnapshotRow());
    mockDispatchTool.mockResolvedValue({
      success: false,
      output: "Insufficient funds",
    });

    const outcome = await prepareApprove(APPROVAL_ID);
    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.continuation).not.toBeNull();
    expect(outcome.toolResult.output).toBe("Insufficient funds");
  });

  it("dispatch THROWS → ApprovalDispatchError, mission flipped to paused_error, claimed lease RELEASED", async () => {
    programSnapshotOnly(buildSnapshotRow());
    const dispatchErr = new TypeError("network down");
    mockDispatchTool.mockRejectedValue(dispatchErr);

    await expect(prepareApprove(APPROVAL_ID)).rejects.toBeInstanceOf(
      ApprovalDispatchError,
    );

    // execution_status='failed' + result_message_id committed atomically with
    // the structural transcript row.
    expect(mockCommitExecutionResultWith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", resultMessageId: 4242 }),
    );

    // Mission run flipped to paused_error (NOT running)
    expect(mockMissionRunsUpdateStatus).toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      "approval_post_decision",
      expect.objectContaining({
        evidence: expect.objectContaining({ approvalId: APPROVAL_ID }),
      }),
      // The flip now runs inside the durable-Stop consumer's transaction, so it
      // carries that transaction's client.
      expect.anything(),
    );

    // CONTRACT CHANGE (claim-before-dispatch): the lease IS claimed up front
    // now, so the throw path must hand it back rather than never take it. No
    // continuation escapes to the caller — the error carries no continuation.
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalled();
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();

    // Tool-result written with structural error + errorHash, success=false
    expect(mockAppendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("Tool dispatch failed: TypeError"),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ success: false, dispatchError: true }),
      }),
      expect.objectContaining({ client: expect.anything() }),
    );
  });

  it("dispatch throws with secret in message → transcript stays structural-only (no raw or redacted message persisted)", async () => {
    programSnapshotOnly(buildSnapshotRow());
    const secretPayload =
      "Bearer sk_live_supersecret123 + private 0x" + "a".repeat(40);
    mockDispatchTool.mockRejectedValue(new Error(secretPayload));

    await expect(prepareApprove(APPROVAL_ID)).rejects.toBeInstanceOf(
      ApprovalDispatchError,
    );

    const transcriptCall = mockAppendMessage.mock.calls.find(
      (c) =>
        typeof c[1] === "object"
        && (c[1] as { role?: string }).role === "tool",
    );
    expect(transcriptCall).toBeDefined();
    const content = (transcriptCall![1] as { content: string }).content;
    // Structural format: "Tool dispatch failed: <ErrorKind>. Error hash: <hash>."
    expect(content).toMatch(/^Tool dispatch failed: Error\. Error hash: [a-f0-9]{16}\.$/);
    // NO part of the raw payload should leak (neither sk_live nor the long hex)
    expect(content).not.toContain("sk_live");
    expect(content).not.toContain("supersecret");
    expect(content).not.toContain("0x");
  });

  it("result commit throws AFTER successful dispatch → ApprovalPostDecisionError, mission flipped to paused_error, status NOT advanced", async () => {
    programSnapshotOnly(buildSnapshotRow());
    mockDispatchTool.mockResolvedValue({ success: true, output: "Tx 0xabc" });
    mockAppendMessage.mockRejectedValueOnce(new Error("transcript pg connection lost"));

    await expect(prepareApprove(APPROVAL_ID)).rejects.toBeInstanceOf(
      ApprovalPostDecisionError,
    );

    // CONTRACT CHANGE (atomic commit): the status is no longer written ahead of
    // the transcript row. Because both live in ONE transaction, a failure rolls
    // BOTH back, so the intent stays `dispatching` — which is exactly the state
    // the reconciler knows how to resolve honestly (`indeterminate`, never a
    // re-dispatch). Previously the row was left claiming `succeeded` with no
    // tool result anywhere in the conversation.
    expect(mockMarkExecutionStatus).not.toHaveBeenCalledWith(
      APPROVAL_ID,
      "succeeded",
      expect.anything(),
    );
    expect(mockMissionRunsUpdateStatus).toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      "approval_post_decision",
      expect.objectContaining({
        evidence: expect.objectContaining({ approvalId: APPROVAL_ID }),
      }),
      // The flip now runs inside the durable-Stop consumer's transaction, so it
      // carries that transaction's client.
      expect.anything(),
    );
  });

  it("lease busy → deferred_busy: tool NEVER dispatched, run NOT flipped to paused_error", async () => {
    // CONTRACT CHANGE (A3/A5). Old behaviour dispatched first and then failed
    // the claim, so the funds had already moved when the IPC said
    // `dispatch_failed`. Now the claim comes first: a busy lease means nothing
    // has happened, the intent stays `approved`/`not_started`, and the durable
    // resume paths finish the job.
    programSnapshotOnly(buildSnapshotRow());
    mockDispatchTool.mockResolvedValue({ success: true, output: "SHOULD NOT RUN" });
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: {
        sessionId: SESSION_ID,
        missionRunId: "run-1",
        ownerId: "other-runner",
        processKind: "electron_main",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const outcome = await prepareApprove(APPROVAL_ID);

    expect(outcome.kind).toBe("deferred_busy");
    if (outcome.kind !== "deferred_busy") throw new Error("kind mismatch");
    expect(outcome.resultCommitted).toBe(false);

    // The tool must NOT have run.
    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockCasMarkDispatching).not.toHaveBeenCalled();
    // No paused_error — the approval is recoverable without operator action.
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    // Fast in-process retry armed.
    expect(mockScheduleDeferredResumeRetries).toHaveBeenCalledWith(SESSION_ID);
  });

  it("status_mismatch → ApprovalPostDecisionError, mission flipped to paused_error (NOT deferred — retrying could never succeed)", async () => {
    programSnapshotOnly(buildSnapshotRow());
    mockDispatchTool.mockResolvedValue({ success: true, output: "SHOULD NOT RUN" });
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "status_mismatch",
      currentStatus: "cancelled",
    });

    await expect(prepareApprove(APPROVAL_ID)).rejects.toBeInstanceOf(
      ApprovalPostDecisionError,
    );

    // The run has left the resumable statuses, so this is permanent, not busy.
    // The tool is still never dispatched.
    expect(mockDispatchTool).not.toHaveBeenCalled();

    expect(mockMissionRunsUpdateStatus).toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      "approval_post_decision",
      expect.objectContaining({
        evidence: expect.objectContaining({
          errorKind: "ResumeClaimFailed",
        }),
      }),
      // The flip now runs inside the durable-Stop consumer's transaction, so it
      // carries that transaction's client.
      expect.anything(),
    );
  });

  it("snapshot returns cached_approved → returns outcome with no dispatch, no continuation", async () => {
    programSnapshotOnly(
      buildSnapshotRow({
        decision: "approved",
        queue_status: "approved",
        execution_status: "succeeded",
      }),
    );

    const outcome = await prepareApprove(APPROVAL_ID);
    expect(outcome.kind).toBe("cached_approved");
    if (outcome.kind !== "cached_approved") throw new Error("kind mismatch");
    expect(outcome.executionStatus).toBe("succeeded");

    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it("snapshot returns already_rejected → returns outcome, no dispatch", async () => {
    programSnapshotOnly(
      buildSnapshotRow({ decision: "rejected", queue_status: "rejected" }),
    );

    const outcome = await prepareApprove(APPROVAL_ID);
    expect(outcome.kind).toBe("already_rejected");
    expect(mockDispatchTool).not.toHaveBeenCalled();
  });

  it("expires_at < NOW → auto-reject inside tx, returns expired outcome with autoRejection rejected continuation", async () => {
    const past = new Date("2026-05-23T19:00:00.000Z");
    const dbNow = new Date("2026-05-23T20:00:00.000Z");
    programSnapshotOnly(buildSnapshotRow({ expires_at: past }), { dbNow });

    const outcome = await prepareApprove(APPROVAL_ID);

    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("kind mismatch");
    expect(outcome.expiresAt).toBe(past.toISOString());
    expect(outcome.autoRejection.kind).toBe("rejected");

    // No tool dispatch attempted for expired path
    expect(mockDispatchTool).not.toHaveBeenCalled();

    // Expired path writes "auto-rejected" tool-result content
    const trCall = mockAppendMessage.mock.calls.find((c) => {
      const msg = c[1] as { role?: string; content?: string };
      return msg.role === "tool" && msg.content?.includes("auto-rejected");
    });
    expect(trCall).toBeDefined();

    // Continuation claimed for the auto-rejection (mission run resumes)
    if (outcome.autoRejection.kind === "rejected") {
      expect(outcome.autoRejection.continuation).not.toBeNull();
    }
  });

  it("expires_at exactly NOW → expired (boundary inclusive)", async () => {
    const boundary = new Date("2026-05-23T20:00:00.000Z");
    programSnapshotOnly(buildSnapshotRow({ expires_at: boundary }), {
      dbNow: boundary,
    });

    const outcome = await prepareApprove(APPROVAL_ID);
    expect(outcome.kind).toBe("expired");
  });

  it("expires_at > NOW → no expiry, normal approve flow", async () => {
    const future = new Date("2026-05-23T22:00:00.000Z");
    const dbNow = new Date("2026-05-23T20:00:00.000Z");
    programSnapshotOnly(buildSnapshotRow({ expires_at: future }), { dbNow });
    mockDispatchTool.mockResolvedValue({ success: true, output: "ok" });

    const outcome = await prepareApprove(APPROVAL_ID);
    expect(outcome.kind).toBe("dispatched");
  });

  it("snapshot not_found → throws Error('not found')", async () => {
    programSnapshotOnly(null);

    await expect(prepareApprove(APPROVAL_ID)).rejects.toThrow(/not found/);
  });

  it("chat session (mission_run_id null) → CHAT continuation claimed via the session lease", async () => {
    // THE PRODUCT FIX. Previously a chat approval returned `continuation: null`
    // and the agent was never told its tool had run — the conversation simply
    // stopped. A chat session now claims a plain session lease (there is no
    // mission run to flip) so the same resume machinery applies.
    programSnapshotOnly(buildSnapshotRow({ mission_run_id: null }));
    mockDispatchTool.mockResolvedValue({ success: true, output: "Chat result" });

    const outcome = await prepareApprove(APPROVAL_ID);
    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    expect(outcome.missionRunId).toBeNull();
    expect(outcome.continuation).not.toBeNull();
    expect(outcome.continuation?.kind).toBe("chat_session");
    // Session lease, never the mission-run lease-and-flip.
    expect(mockClaimSessionLease).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it("chat session with a busy session lease → deferred_busy, tool NEVER dispatched", async () => {
    programSnapshotOnly(buildSnapshotRow({ mission_run_id: null }));
    mockDispatchTool.mockResolvedValue({ success: true, output: "SHOULD NOT RUN" });
    mockClaimSessionLease.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: {
        sessionId: SESSION_ID,
        missionRunId: null,
        ownerId: "in-flight-turn",
        processKind: "electron_main",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const outcome = await prepareApprove(APPROVAL_ID);

    expect(outcome.kind).toBe("deferred_busy");
    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockScheduleDeferredResumeRetries).toHaveBeenCalledWith(SESSION_ID);
  });

  // ── B-001 — approve-time live-policy re-enforcement (fail-closed) ────────
  //
  // Drift = the live session permission became strictly MORE restrictive than
  // the permission snapshot captured at enqueue. The approve MUST fail closed
  // BEFORE any dispatch state transition: no dispatch, no `dispatching` mark,
  // no approved tool-result, and queue+intent flip to `rejected` (not pending,
  // not approved). Unchanged / looser permission must stay byte-identical.

  describe("B-001 policy-drift re-enforcement", () => {
    it("enqueue=full, live=restricted (drifted MORE restrictive) → policy_drift_blocked: NO dispatch, NO dispatching mark, NO approved tool-result", async () => {
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "full",
          session_permission_live: "restricted",
        }),
      );
      // Make dispatch loud so a regression that DID dispatch would be obvious.
      mockDispatchTool.mockResolvedValue({ success: true, output: "SHOULD NOT RUN" });

      const outcome = await prepareApprove(APPROVAL_ID);

      expect(outcome.kind).toBe("policy_drift_blocked");
      if (outcome.kind !== "policy_drift_blocked") throw new Error("kind mismatch");
      expect(outcome.permissionAtEnqueue).toBe("full");
      expect(outcome.livePermission).toBe("restricted");

      // (c) Dispatcher NEVER called.
      expect(mockDispatchTool).not.toHaveBeenCalled();

      // (a) Intent NEVER marked dispatching (nor succeeded/failed execution).
      const dispatchingMark = mockMarkExecutionStatus.mock.calls.find(
        (c) => c[1] === "dispatching",
      );
      expect(dispatchingMark).toBeUndefined();
      expect(mockMarkExecutionStatus).not.toHaveBeenCalled();

      // (b) NO approved tool-result appended — the only tool message is the
      //     structural rejection (payload.rejected === true, success false).
      const toolAppends = mockAppendMessage.mock.calls.filter(
        (c) => (c[1] as { role?: string }).role === "tool",
      );
      expect(toolAppends).toHaveLength(1);
      // appendMessage(sessionId, message, metadata) — message is arg[1], the
      // metadata (with payload) is arg[2].
      const msg = toolAppends[0][1] as { content: string };
      const meta = toolAppends[0][2] as {
        payload?: { success?: boolean; rejected?: boolean };
      };
      expect(meta.payload).toEqual({ success: false, rejected: true });
      expect(msg.content).toContain("more restrictive");

      // Queue+intent were flipped to 'rejected' IN-TX, and the 'approved' CAS
      // never fired (decision can never be approved on the drift path).
      const approveCas = clientQueryLog.find(
        (c) => c.sql.includes("UPDATE approval_queue") && c.sql.includes("'approved'"),
      );
      expect(approveCas).toBeUndefined();
      const rejectCas = clientQueryLog.find(
        (c) => c.sql.includes("UPDATE approval_queue") && c.sql.includes("'rejected'"),
      );
      expect(rejectCas).toBeDefined();
    });

    it("drift on a mission run → run resumes via continuation (so the agent observes the auto-rejection), NOT stranded pending", async () => {
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "full",
          session_permission_live: "restricted",
        }),
      );

      const outcome = await prepareApprove(APPROVAL_ID);
      if (outcome.kind !== "policy_drift_blocked") throw new Error("kind mismatch");

      // Continuation claimed (mission resumes); dispatcher still untouched.
      expect(outcome.continuation).not.toBeNull();
      expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalled();
      expect(mockDispatchTool).not.toHaveBeenCalled();
    });

    it("INVARIANT GUARD: unchanged permission (enqueue=restricted, live=restricted) still approves + dispatches exactly as before", async () => {
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "restricted",
          session_permission_live: "restricted",
        }),
      );
      mockDispatchTool.mockResolvedValue({ success: true, output: "Tx hash 0xabc" });

      const outcome = await prepareApprove(APPROVAL_ID);

      expect(outcome.kind).toBe("dispatched");
      if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
      expect(outcome.executionStatus).toBe("succeeded");
      expect(mockDispatchTool).toHaveBeenCalledTimes(1);
      // `dispatching` is now taken through the CAS (which also stamps
      // `dispatch_started_at`) rather than an unconditional status write.
      expect(mockCasMarkDispatching).toHaveBeenCalledWith(
        // The CAS now runs on the stop gate's transaction client — same
        // predicate, one fewer commit. See `dispatch-slot-gate.ts`.
        expect.anything(),
        APPROVAL_ID,
      );

      // Approve CAS fired; reject CAS did not.
      const approveCas = clientQueryLog.find(
        (c) => c.sql.includes("UPDATE approval_queue") && c.sql.includes("'approved'"),
      );
      expect(approveCas).toBeDefined();
    });

    it("INVARIANT GUARD: LOOSER live permission (enqueue=restricted, live=full) does NOT block — approves + dispatches", async () => {
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "restricted",
          session_permission_live: "full",
        }),
      );
      mockDispatchTool.mockResolvedValue({ success: true, output: "ok" });

      const outcome = await prepareApprove(APPROVAL_ID);

      expect(outcome.kind).toBe("dispatched");
      expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    });

    it("snapshot SELECT joins sessions for the live permission (single locked read)", async () => {
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "full",
          session_permission_live: "restricted",
        }),
      );

      await prepareApprove(APPROVAL_ID);

      const snapshotCall = clientQueryLog.find((c) =>
        c.sql.includes("FOR UPDATE OF i, q"),
      );
      expect(snapshotCall).toBeDefined();
      expect(snapshotCall!.sql).toContain("JOIN sessions s");
      expect(snapshotCall!.sql).toContain("s.permission");
    });

    it("snapshot SELECT LOCKS the sessions row (FOR UPDATE OF i, q, s) so the live permission read is serialized against a concurrent downgrade", async () => {
      // Codex blocker B-001-fix: reading s.permission is not enough — the
      // joined sessions row must be locked in the SAME approve tx, otherwise a
      // concurrent permission-downgrade tx can race the live read. Assert the
      // emitted FOR UPDATE OF clause includes `s` (the sessions alias), not
      // just `i, q`.
      programSnapshotOnly(
        buildSnapshotRow({
          queue_permission_at_enqueue: "full",
          session_permission_live: "restricted",
        }),
      );

      await prepareApprove(APPROVAL_ID);

      const snapshotCall = clientQueryLog.find((c) =>
        c.sql.includes("FOR UPDATE OF"),
      );
      expect(snapshotCall).toBeDefined();
      // The lock list must name the sessions alias `s`. A regression back to
      // `FOR UPDATE OF i, q` (sessions unlocked) fails this assertion.
      expect(snapshotCall!.sql).toContain("FOR UPDATE OF i, q, s");
      // Parse the actual FOR UPDATE OF target list and assert `s` is a locked
      // table (defensive against whitespace/order drift in the clause).
      const lockMatch = snapshotCall!.sql.match(/FOR UPDATE OF\s+([^\n]+)/);
      expect(lockMatch).not.toBeNull();
      const lockedTables = lockMatch![1]
        .split(",")
        .map((t) => t.trim());
      expect(lockedTables).toContain("s");
      expect(lockedTables).toContain("i");
      expect(lockedTables).toContain("q");
    });
  });
});
