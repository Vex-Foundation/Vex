/**
 * Approvals decision IPC handlers.
 *
 * Pinned invariants:
 *   - `ensureEngineDbUrl(ctx.requestId)` first; bail with its Result on DB
 *     unavailability.
 *   - approve / reject map `ApprovePrepareOutcome` / `RejectPrepareOutcome`
 *     to `Result<ApprovalActionResult>` with execution state, mission run,
 *     and cache metadata.
 *   - Background `dispatchPreparedMission` fires ONLY for outcomes that
 *     carry a continuation (dispatched / expired.autoRejection /
 *     rejected). Cached / already_* / run_terminated NEVER dispatch.
 *   - `ApprovalDispatchError` → `approvals.dispatch_failed` (not faked ok).
 *   - `ApprovalDecisionInconsistencyError` → `internal.unexpected`.
 *   - Scheduled sweep registered + first sweep fires on register; cleanup
 *     function clears the interval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  prepareApprove: vi.fn(),
  prepareReject: vi.fn(),
  expireApproval: vi.fn(),
  sweepExpiredApprovals: vi.fn().mockResolvedValue({
    swept: 0,
    errored: 0,
    continuations: [],
  }),
  reconcileApprovalLifecycle: vi.fn().mockResolvedValue({
    examined: 0,
    dispatched: 0,
    indeterminate: 0,
    resumed: 0,
    skippedLeaseHeld: 0,
    errored: 0,
  }),
  runResumeAfterDecision: vi.fn(),
  dispatchPreparedMission: vi.fn(),
  listPendingForSession: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  listPendingAllApprovals: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getApprovalById: vi.fn().mockResolvedValue({ ok: true, data: null }),
  getHistoryForSession: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class FakeApprovalDispatchError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly errorKind: string,
    public readonly errorHash: string,
  ) {
    super(`Dispatch failed (${approvalId})`);
    this.name = "ApprovalDispatchError";
  }
}

class FakeApprovalPostDecisionError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly errorKind: string,
    public readonly errorHash: string,
  ) {
    super(`Post-decision failed (${approvalId})`);
    this.name = "ApprovalPostDecisionError";
  }
}

class FakeApprovalDecisionInconsistencyError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly detail: string,
  ) {
    super(`Inconsistency (${approvalId}): ${detail}`);
    this.name = "ApprovalDecisionInconsistencyError";
  }
}

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mocks.ensureEngineDbUrl(...a),
}));

vi.mock("../mission/_engine-dispatch.js", () => ({
  dispatchPreparedMission: (...a: unknown[]) =>
    mocks.dispatchPreparedMission(...a),
}));

vi.mock("../../database/approvals-db.js", () => ({
  listPendingForSession: (...a: unknown[]) =>
    mocks.listPendingForSession(...a),
  listPendingAllApprovals: (...a: unknown[]) =>
    mocks.listPendingAllApprovals(...a),
  getApprovalById: (...a: unknown[]) => mocks.getApprovalById(...a),
  getHistoryForSession: (...a: unknown[]) =>
    mocks.getHistoryForSession(...a),
}));

vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  prepareApprove: (...a: unknown[]) => mocks.prepareApprove(...a),
  prepareReject: (...a: unknown[]) => mocks.prepareReject(...a),
  expireApproval: (...a: unknown[]) => mocks.expireApproval(...a),
  sweepExpiredApprovals: (...a: unknown[]) =>
    mocks.sweepExpiredApprovals(...a),
  // Lifecycle reconciler — runs in the SAME scheduled cycle as the TTL sweep.
  reconcileApprovalLifecycle: (...a: unknown[]) =>
    mocks.reconcileApprovalLifecycle(...a),
  runResumeAfterDecision: (...a: unknown[]) =>
    mocks.runResumeAfterDecision(...a),
  // A chat continuation has no mission run; the helper narrows the union so
  // the dispatch refs stay honest instead of carrying `undefined`.
  continuationMissionRunId: (cont: { kind: string; missionRunId?: string }) =>
    cont.kind === "mission_run" ? cont.missionRunId : undefined,
  discardContinuation: vi.fn(),
  ApprovalDispatchError: FakeApprovalDispatchError,
  ApprovalPostDecisionError: FakeApprovalPostDecisionError,
  ApprovalDecisionInconsistencyError: FakeApprovalDecisionInconsistencyError,
}));

vi.mock("../../logger/index.js", () => ({
  log: mocks.log,
}));

const { CH } = await import("../../../shared/ipc/channels.js");
const { registerApprovalsHandlers } = await import("../approvals.js");

// ── Test scaffolding ────────────────────────────────────────────────────

const SESSION = "00000000-0000-4000-8000-000000000001";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

interface RegisteredCleanups {
  cleanups: ReadonlyArray<() => void>;
}

let active: RegisteredCleanups | null = null;

function setupHandlers(): RegisteredCleanups {
  handlers.clear();
  const cleanups = registerApprovalsHandlers();
  return { cleanups };
}

function teardownHandlers(state: RegisteredCleanups | null): void {
  if (state) {
    for (const c of state.cleanups) c();
  }
  handlers.clear();
}

async function call<T = unknown>(
  channel: string,
  payload: Record<string, unknown>,
  options: { requestId?: string } = {},
): Promise<{
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  const requestId = options.requestId ?? `req-${Math.random()}`;
  const envelope = { requestId, payload };
  const result = (await handler(trustedSender as unknown as TestIpcEvent, envelope)) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  return result;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.sweepExpiredApprovals.mockResolvedValue({
    swept: 0,
    errored: 0,
    continuations: [],
  });
  mocks.reconcileApprovalLifecycle.mockResolvedValue({
    examined: 0,
    dispatched: 0,
    indeterminate: 0,
    resumed: 0,
    skippedLeaseHeld: 0,
    errored: 0,
  });
  active = setupHandlers();
});

afterEach(() => {
  teardownHandlers(active);
  active = null;
});

// ── approve handler ────────────────────────────────────────────────────

const STUB_CONTINUATION = {
  kind: "mission_run",
  missionRunId: "run-1",
  sessionId: SESSION,
  approvalId: "a-1",
  ownerId: "approve-test",
  leaseHandle: { lease: {}, ownerId: "approve-test", release: vi.fn() },
} as never;

/**
 * A chat-session continuation — no mission run. Before the resume fix these
 * did not exist: an Agent-Restricted approval returned `continuation: null`,
 * nothing was dispatched, and the agent was never told its tool had run.
 */
const STUB_CHAT_CONTINUATION = {
  kind: "chat_session",
  sessionId: SESSION,
  approvalId: "a-3",
  ownerId: "approve-test",
  leaseHandle: { lease: {}, ownerId: "approve-test", release: vi.fn() },
} as never;

describe("approve handler decision outcome mapping", () => {
  it("dispatched + missionRun + success → ok runtimeOutcome=resumed executionStatus=succeeded cached=false; dispatch fires", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "dispatched",
      approvalId: "a-1",
      resolvedAt: "2026-05-23T20:00:00.000Z",
      executionStatus: "succeeded",
      sessionId: SESSION,
      missionRunId: "run-1",
      continuation: STUB_CONTINUATION,
      toolResult: { success: true, output: "Tx 0xabc" },
    });

    const result = await call(CH.approvals.approve, { id: "a-1" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      id: "a-1",
      status: "approved",
      runtimeOutcome: "resumed",
      executionStatus: "succeeded",
      missionRunId: "run-1",
      cached: false,
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
    const dispatchArgs = mocks.dispatchPreparedMission.mock.calls[0];
    expect(dispatchArgs[1]).toMatchObject({
      sessionId: SESSION,
      missionRunId: "run-1",
      channelLabel: "vex:approvals:approve",
    });
  });

  it("dispatched + success:false → ok runtimeOutcome=resumed executionStatus=failed (mission resumes)", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "dispatched",
      approvalId: "a-2",
      resolvedAt: "2026-05-23T20:01:00.000Z",
      executionStatus: "failed",
      sessionId: SESSION,
      missionRunId: "run-1",
      continuation: STUB_CONTINUATION,
      toolResult: { success: false, output: "Insufficient" },
    });

    const result = await call(CH.approvals.approve, { id: "a-2" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      runtimeOutcome: "resumed",
      executionStatus: "failed",
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalled();
  });

  it("dispatched + chat session → ok runtimeOutcome=resumed; background dispatch FIRES (the resume fix)", async () => {
    // CONTRACT CHANGE. This case previously pinned "chat ⇒ NO background
    // dispatch", which encoded the bug: the tool ran, the result was recorded,
    // and the agent was never re-invoked, while the IPC still said "agent will
    // continue". A chat approval now carries a `chat_session` continuation.
    mocks.prepareApprove.mockResolvedValue({
      kind: "dispatched",
      approvalId: "a-3",
      resolvedAt: "2026-05-23T20:02:00.000Z",
      executionStatus: "succeeded",
      sessionId: SESSION,
      missionRunId: null,
      continuation: STUB_CHAT_CONTINUATION,
      toolResult: { success: true, output: "Chat result" },
    });

    const result = await call(CH.approvals.approve, { id: "a-3" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      runtimeOutcome: "resumed",
      missionRunId: null,
      cached: false,
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
    const refs = mocks.dispatchPreparedMission.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(refs).toMatchObject({
      sessionId: SESSION,
      channelLabel: "vex:approvals:approve",
    });
    // No mission run exists, so the key is omitted entirely rather than
    // carrying a misleading `undefined`.
    expect(refs).not.toHaveProperty("missionRunId");
  });

  it("dispatched + chat session with NO continuation → runtimeOutcome=stopped, message does not promise a continuation", async () => {
    // Defensive: if no continuation was claimed the message must not claim the
    // agent is continuing — that phrasing is exactly what hid the original bug.
    mocks.prepareApprove.mockResolvedValue({
      kind: "dispatched",
      approvalId: "a-3b",
      resolvedAt: "2026-05-23T20:02:00.000Z",
      executionStatus: "succeeded",
      sessionId: SESSION,
      missionRunId: null,
      continuation: null,
      toolResult: { success: true, output: "Chat result" },
    });

    const result = await call(CH.approvals.approve, { id: "a-3b" });

    expect(result.data).toMatchObject({ runtimeOutcome: "stopped" });
    expect((result.data as { message: string }).message).not.toMatch(
      /continuing|will continue/i,
    );
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("deferred_busy → ok runtimeOutcome=deferred_busy with a truthful queued message; NO dispatch", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "deferred_busy",
      approvalId: "a-3c",
      resolvedAt: "2026-05-23T20:02:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      resultCommitted: false,
    });

    const result = await call(CH.approvals.approve, { id: "a-3c" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: "approved",
      runtimeOutcome: "deferred_busy",
      executionStatus: "not_started",
    });
    // The tool did NOT run, so the message must not imply a result.
    const message = (result.data as { message: string }).message;
    expect(message).toMatch(/queued/i);
    expect(message).not.toMatch(/executed/i);
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("cached_approved → ok cached=true; NO background dispatch", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "cached_approved",
      approvalId: "a-4",
      resolvedAt: "2026-05-23T20:03:00.000Z",
      executionStatus: "succeeded",
      missionRunId: "run-1",
    });

    const result = await call(CH.approvals.approve, { id: "a-4" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      cached: true,
      runtimeOutcome: "stopped",
      executionStatus: "succeeded",
    });
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("expired → err approvals.expired with expiresAt detail; autoRejection continuation IS dispatched", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "expired",
      approvalId: "a-5",
      expiresAt: "2026-05-23T19:30:00.000Z",
      autoRejection: {
        kind: "rejected",
        approvalId: "a-5",
        resolvedAt: "2026-05-23T20:00:00.000Z",
        sessionId: SESSION,
        missionRunId: "run-1",
        reason: "expired_ttl",
        continuation: STUB_CONTINUATION,
      },
    });

    const result = await call(CH.approvals.approve, { id: "a-5" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.expired");
    expect(result.error?.details).toMatchObject({
      expiresAt: "2026-05-23T19:30:00.000Z",
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
  });

  it("already_rejected → err approvals.already_resolved with decision detail", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "already_rejected",
      approvalId: "a-6",
      resolvedAt: "2026-05-23T20:00:00.000Z",
      decision: "rejected",
    });

    const result = await call(CH.approvals.approve, { id: "a-6" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.already_resolved");
    expect(result.error?.details).toMatchObject({ decision: "rejected" });
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("run_terminated → err approvals.run_terminated with runStatus detail", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "run_terminated",
      approvalId: "a-7",
      missionRunId: "run-cancelled",
      runStatus: "cancelled",
    });

    const result = await call(CH.approvals.approve, { id: "a-7" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.run_terminated");
    expect(result.error?.details).toMatchObject({ runStatus: "cancelled" });
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("policy_drift_blocked (B-001) → err approvals.policy_drift_blocked; continuation IS dispatched (run resumes to see rejection)", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "policy_drift_blocked",
      approvalId: "a-7b",
      resolvedAt: "2026-05-23T20:00:00.000Z",
      sessionId: SESSION,
      missionRunId: "run-1",
      permissionAtEnqueue: "full",
      livePermission: "restricted",
      continuation: STUB_CONTINUATION,
    });

    const result = await call(CH.approvals.approve, { id: "a-7b" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.policy_drift_blocked");
    // Fail-closed but the mission still resumes so the agent observes the
    // auto-rejection rather than stranding in paused_approval.
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchPreparedMission.mock.calls[0][1]).toMatchObject({
      channelLabel: "vex:approvals:approve",
    });
  });

  it("policy_drift_blocked (B-001) chat session (no mission) → err policy_drift_blocked; NO background dispatch", async () => {
    mocks.prepareApprove.mockResolvedValue({
      kind: "policy_drift_blocked",
      approvalId: "a-7c",
      resolvedAt: "2026-05-23T20:00:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      permissionAtEnqueue: "full",
      livePermission: "restricted",
      continuation: null,
    });

    const result = await call(CH.approvals.approve, { id: "a-7c" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.policy_drift_blocked");
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("ApprovalDispatchError thrown → err approvals.dispatch_failed", async () => {
    mocks.prepareApprove.mockRejectedValue(
      new FakeApprovalDispatchError("a-8", "TypeError", "abc123"),
    );

    const result = await call(CH.approvals.approve, { id: "a-8" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.dispatch_failed");
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("ApprovalPostDecisionError thrown → err approvals.dispatch_failed (resume claim / persistence failure)", async () => {
    mocks.prepareApprove.mockRejectedValue(
      new FakeApprovalPostDecisionError(
        "a-8b",
        "ResumeClaimFailed",
        "deadbeef",
      ),
    );

    const result = await call(CH.approvals.approve, { id: "a-8b" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.dispatch_failed");
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("ApprovalDecisionInconsistencyError thrown → err internal.unexpected", async () => {
    mocks.prepareApprove.mockRejectedValue(
      new FakeApprovalDecisionInconsistencyError("a-9", "decision drift"),
    );

    const result = await call(CH.approvals.approve, { id: "a-9" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });

  it("ensureEngineDbUrl returns err → handler short-circuits with that err", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "DB unavailable",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });

    const result = await call(CH.approvals.approve, { id: "a-10" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(mocks.prepareApprove).not.toHaveBeenCalled();
  });
});

// ── reject handler ─────────────────────────────────────────────────────

describe("reject handler decision outcome mapping", () => {
  it("rejected + continuation → ok runtimeOutcome=resumed cached=false; dispatch fires", async () => {
    mocks.prepareReject.mockResolvedValue({
      kind: "rejected",
      approvalId: "r-1",
      resolvedAt: "2026-05-23T20:00:00.000Z",
      sessionId: SESSION,
      missionRunId: "run-1",
      reason: "No reason provided",
      continuation: STUB_CONTINUATION,
    });

    const result = await call(CH.approvals.reject, { id: "r-1" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      id: "r-1",
      status: "rejected",
      runtimeOutcome: "resumed",
      executionStatus: null,
      missionRunId: "run-1",
      cached: false,
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchPreparedMission.mock.calls[0][1]).toMatchObject({
      channelLabel: "vex:approvals:reject",
    });
  });

  it("rejected + chat session → ok runtimeOutcome=resumed; background dispatch FIRES", async () => {
    // CONTRACT CHANGE, mirroring the approve side: a rejection in an
    // Agent-Restricted session used to end the conversation silently. The agent
    // must be told its request was refused so it can choose another route.
    mocks.prepareReject.mockResolvedValue({
      kind: "rejected",
      approvalId: "r-2",
      resolvedAt: "2026-05-23T20:01:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      reason: "No reason provided",
      continuation: STUB_CHAT_CONTINUATION,
    });

    const result = await call(CH.approvals.reject, { id: "r-2" });

    expect(result.data).toMatchObject({
      runtimeOutcome: "resumed",
      missionRunId: null,
    });
    expect(mocks.dispatchPreparedMission).toHaveBeenCalledTimes(1);
    const refs = mocks.dispatchPreparedMission.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(refs).toMatchObject({ channelLabel: "vex:approvals:reject" });
    expect(refs).not.toHaveProperty("missionRunId");
  });

  it("reject deferred_busy → ok deferred_busy; rejection recorded, wake queued", async () => {
    mocks.prepareReject.mockResolvedValue({
      kind: "deferred_busy",
      approvalId: "r-2b",
      resolvedAt: "2026-05-23T20:01:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      reason: "No reason provided",
    });

    const result = await call(CH.approvals.reject, { id: "r-2b" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: "rejected",
      runtimeOutcome: "deferred_busy",
      executionStatus: null,
    });
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("passes the operator's reason through to prepareReject", async () => {
    // A7: `prepareReject` always accepted a reason; the IPC never sent one, so
    // every refusal reached the model as "No reason provided".
    mocks.prepareReject.mockResolvedValue({
      kind: "rejected",
      approvalId: "r-2c",
      resolvedAt: "2026-05-23T20:01:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      reason: "Too much slippage",
      continuation: null,
    });

    await call(CH.approvals.reject, {
      id: "r-2c",
      reason: "Too much slippage",
    });

    expect(mocks.prepareReject).toHaveBeenCalledWith(
      "r-2c",
      "Too much slippage",
    );
  });

  it("omitted reason reaches the engine as undefined (engine owns the default)", async () => {
    mocks.prepareReject.mockResolvedValue({
      kind: "rejected",
      approvalId: "r-2d",
      resolvedAt: "2026-05-23T20:01:00.000Z",
      sessionId: SESSION,
      missionRunId: null,
      reason: "No reason provided",
      continuation: null,
    });

    await call(CH.approvals.reject, { id: "r-2d" });

    expect(mocks.prepareReject).toHaveBeenCalledWith("r-2d", undefined);
  });

  it("rejects an over-long reason at the IPC schema gate", async () => {
    const result = await call(CH.approvals.reject, {
      id: "r-2e",
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    expect(mocks.prepareReject).not.toHaveBeenCalled();
  });

  it("cached_rejected → ok cached=true; no dispatch", async () => {
    mocks.prepareReject.mockResolvedValue({
      kind: "cached_rejected",
      approvalId: "r-3",
      resolvedAt: "2026-05-23T20:02:00.000Z",
      decision: "rejected",
      reason: "earlier",
      missionRunId: "run-1",
    });

    const result = await call(CH.approvals.reject, { id: "r-3" });

    expect(result.data).toMatchObject({
      cached: true,
      runtimeOutcome: "stopped",
    });
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });

  it("already_approved → err approvals.already_resolved", async () => {
    mocks.prepareReject.mockResolvedValue({
      kind: "already_approved",
      approvalId: "r-4",
      resolvedAt: "2026-05-23T20:03:00.000Z",
      missionRunId: "run-1",
    });

    const result = await call(CH.approvals.reject, { id: "r-4" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.already_resolved");
  });

  it("ensureEngineDbUrl err short-circuits", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "DB unavailable",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });

    const result = await call(CH.approvals.reject, { id: "r-5" });

    expect(result.ok).toBe(false);
    expect(mocks.prepareReject).not.toHaveBeenCalled();
  });

  it("ApprovalPostDecisionError thrown → err approvals.dispatch_failed (reject post-tx failure)", async () => {
    mocks.prepareReject.mockRejectedValue(
      new FakeApprovalPostDecisionError(
        "r-6",
        "ResumeClaimFailed",
        "deadbeef",
      ),
    );

    const result = await call(CH.approvals.reject, { id: "r-6" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("approvals.dispatch_failed");
    expect(mocks.dispatchPreparedMission).not.toHaveBeenCalled();
  });
});

// ── Scheduled sweep ────────────────────────────────────────────────────

describe("scheduled TTL sweep", () => {
  it("first sweep fires immediately after registration (background)", async () => {
    // beforeEach already called registerApprovalsHandlers — the first
    // sweep fires as `void runScheduledSweep()`. Await microtasks so the
    // mock observes the call.
    await flushMicrotasks();
    expect(mocks.sweepExpiredApprovals).toHaveBeenCalled();
  });

  it("sweep continuations are dispatched in background", async () => {
    // Re-register with a sweep that returns continuations.
    teardownHandlers(active);
    mocks.sweepExpiredApprovals.mockResolvedValueOnce({
      swept: 2,
      errored: 0,
      continuations: [
        { ...STUB_CONTINUATION, missionRunId: "run-1" },
        { ...STUB_CONTINUATION, missionRunId: "run-2" },
      ],
    });
    active = setupHandlers();
    await flushMicrotasks();

    // The continuations from sweep produce 2 background dispatches.
    expect(mocks.dispatchPreparedMission).toHaveBeenCalled();
    const sweepDispatches = mocks.dispatchPreparedMission.mock.calls.filter(
      (c) =>
        typeof c[1] === "object"
        && (c[1] as { channelLabel?: string }).channelLabel === "vex:approvals:sweep",
    );
    expect(sweepDispatches.length).toBe(2);
  });

  it("the reconciler runs in the SAME cycle — no second timer", async () => {
    await flushMicrotasks();

    expect(mocks.sweepExpiredApprovals).toHaveBeenCalled();
    expect(mocks.reconcileApprovalLifecycle).toHaveBeenCalled();
  });

  it("a TTL-sweep failure still lets the reconciler pass run", async () => {
    // The reconciler is the only thing that can finish an abandoned money-path
    // dispatch, so it must not share a failure domain with the TTL sweep.
    teardownHandlers(active);
    mocks.sweepExpiredApprovals.mockRejectedValueOnce(new Error("pg down"));
    active = setupHandlers();
    await flushMicrotasks();

    expect(mocks.reconcileApprovalLifecycle).toHaveBeenCalled();
  });
});
