/**
 * mission.retry handler / runRetryDispatch tests.
 *
 * Recover-after-error claims + resumes ONLY a `paused_error` run; every other
 * state is classified explicitly (so the dispatcher is total). Only the retry
 * handler is registered for isolation; the engine claim/resume modules are
 * dynamic imports, mocked here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockGetLatestRunForSession = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockMarkObserved = vi.fn();
const mockMarkCleared = vi.fn();
const mockMarkFailed = vi.fn();
const mockClaim = vi.fn();
const mockCreateLeaseHandle = vi.fn();
const mockResumeMissionRun = vi.fn();
const mockRelease = vi.fn();
const mockAcquireLock = vi.fn();
const mockMoneyState = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<
    string,
    (e: IpcMainInvokeEvent, p: unknown) => unknown
  >();
  return {
    ipcMain: {
      handle: vi.fn(
        (channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
          handlers.set(channel, fn),
      ),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("../../../database/mission-runs-db.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../database/mission-runs-db.js")
    >();
  return {
    ...actual,
    getLatestRunForSession: (...a: unknown[]) =>
      mockGetLatestRunForSession(...a),
  };
});
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../runtime/_emit-control-state.js", () => ({
  emitControlStateAfterChange: (...a: unknown[]) =>
    mockEmitControlStateAfterChange(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-agent/db/repos/runtime-control-requests.js", () => ({
  enqueueRequest: (...a: unknown[]) => mockEnqueueRequest(...a),
  markObserved: (...a: unknown[]) => mockMarkObserved(...a),
  markCleared: (...a: unknown[]) => mockMarkCleared(...a),
  markFailed: (...a: unknown[]) => mockMarkFailed(...a),
}));
// Phase 4d: runRetryDispatch cancels pending error_retry wakes before claiming.
const mockCancelForSession = vi.fn().mockResolvedValue(0);
vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSessionWith: (...a: unknown[]) => mockCancelForSession(...a),
}));
// `withSessionControlLock` opens the transaction and takes the lock; the gate
// runs the money read, the wake cancellation and the claim INSIDE it. The fake
// records that the lock was taken and hands the body a client, so the unit
// tests can still assert the dispatcher's branching. That the exclusion is
// REAL - that no money writer can commit between the read and the claim - is
// not provable with a mocked lock and is proven against two live Postgres
// clients in `recovery-money-gate-race.int.test.ts`.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunningWith: (_client: unknown, ...a: unknown[]) =>
    mockClaim(...a),
  withSessionControlLock: async (
    sessionId: string,
    fn: (client: unknown) => Promise<unknown>,
  ) => {
    const client = { query: vi.fn() };
    await mockAcquireLock(client, sessionId);
    return fn(client);
  },
}));
// The RECOVERY money gate reads the session-scoped money state inside a
// transaction under the session control lock. Both are mocked: what is proven
// here is that the dispatcher REFUSES on an unclear answer and fails closed on
// an unreadable one. That the reader itself is correct is proven against real
// Postgres in the money-state reader's own integration suite.
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn() }),
}));
vi.mock("@vex-agent/db/repos/approval-intents/money-state.js", () => ({
  getUnresolvedMoneyStateForSession: (...a: unknown[]) => mockMoneyState(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockRelease(...a),
}));

const { registerMissionRetryHandler } = await import("../../mission/retry.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.retry);
  if (!handler) throw new Error("No handler for mission.retry");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; [k: string]: unknown };
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  mockAcquireLock.mockResolvedValue(undefined);
  // Default: nothing in flight. Every pre-existing case below is about run
  // STATE, not money state, so they all start from a clear session.
  mockMoneyState.mockResolvedValue({ clear: true });
  electronMock.__handlers.clear();
  registerMissionRetryHandler();
});

describe("mission.retry", () => {
  it("returns no_active_run when the session never had a run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({ ok: true, data: null });
    const r = await call({ sessionId: SESSION });
    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("no_active_run");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns already_running for a running run with a LIVE lease", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "running", leaseActive: true },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "already_running", runId: "run-1" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("attempts to RECLAIM (fromStatuses=['running']) instead of already_running when the lease is DEAD", async () => {
    // Regression: status='running' alone does not mean a runner is
    // observing the session (issue #12's bug class, ported to retry too).
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-dead", status: "running", leaseActive: false },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-dead" });
    mockClaim.mockResolvedValueOnce({
      outcome: "claimed",
      lease: { ownerId: "owner-y" },
      previousStatus: "running",
      wakeCancelledCount: 0,
    });
    mockCreateLeaseHandle.mockReturnValueOnce({});
    mockResumeMissionRun.mockResolvedValueOnce({ text: "ok" });
    mockRelease.mockResolvedValue(undefined);

    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "resumed", runId: "run-dead" });
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatuses: ["running"],
        missionRunId: "run-dead",
      }),
    );
    // A running row never has an error_retry wake pending — the
    // paused_error-only wake cancellation must not fire here.
    expect(mockCancelForSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockResumeMissionRun).toHaveBeenCalledWith("run-dead", "owner-y"),
    );
  });

  it("returns blocked_approval for a paused_approval run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "paused_approval" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({
      outcome: "blocked_approval",
      pendingApprovalId: "run-1",
    });
  });

  it("returns blocked_terminal for a terminal run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "failed" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "blocked_terminal", status: "failed" });
  });

  it("returns not_recoverable for a paused_wake run (use Continue)", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "paused_wake" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "not_recoverable", status: "paused_wake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("claims (fromStatuses paused_error) + resumes a paused_error run", async () => {
    mockGetLatestRunForSession.mockResolvedValue({
      ok: true,
      data: { missionRunId: "run-err", status: "paused_error" },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-1" });
    mockClaim.mockResolvedValueOnce({
      outcome: "claimed",
      lease: { ownerId: "owner-x" },
      previousStatus: "paused_error",
    });
    mockCreateLeaseHandle.mockReturnValueOnce({});
    mockResumeMissionRun.mockResolvedValueOnce({ text: "ok" });
    mockRelease.mockResolvedValue(undefined);

    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "resumed", runId: "run-err" });
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatuses: ["paused_error"],
        missionRunId: "run-err",
      }),
    );
    // Fire-and-forget continuation (dynamic-imports the engine) — poll for it.
    await vi.waitFor(() =>
      expect(mockResumeMissionRun).toHaveBeenCalledWith("run-err", "owner-x"),
    );
  });

  it("refuses with blocked_money_state when the session has unresolved money state", async () => {
    // The restart-orphan case: the process died mid-slice, so a transfer may be
    // broadcast with no confirmation yet. Resuming on top of that is how a
    // double spend happens - an unknown outcome is reconciled, never retried.
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-orphan", status: "paused_error" },
    });
    // The audit row is enqueued BEFORE the gate now, so the attempt is on
    // record ahead of any effect and a money refusal settles it explicitly. A
    // refusal on the money path is exactly what an operator needs to find
    // later, so it gets an audit row rather than vanishing.
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-blocked" });
    mockMoneyState.mockResolvedValueOnce({
      clear: false,
      reasons: [
        { kind: "wallet_transaction_confirmation_unknown", ref: "intent-1" },
        { kind: "wallet_transaction_confirmation_unknown", ref: "intent-2" },
        { kind: "approval_in_flight", ref: "approval-9" },
      ],
    });

    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({
      outcome: "blocked_money_state",
      reasonKinds: [
        "wallet_transaction_confirmation_unknown",
        "approval_in_flight",
      ],
    });
    // Nothing with an effect ran: no claim, no resume, and the scheduled
    // auto-retry wake is left exactly as it was.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
    expect(mockCancelForSession).not.toHaveBeenCalled();
    // Structural labels only: no row identifiers reach the renderer.
    expect(JSON.stringify(r.data)).not.toContain("intent-1");
    expect(mockMarkFailed).toHaveBeenCalledWith(
      "audit-blocked",
      "blocked_money_state",
    );
  });

  it("takes the session control lock around the money read AND the claim", async () => {
    // Read outside the lock the answer is stale the instant it returns: every
    // money-state writer serializes on this same lock. The claim runs inside
    // the same transaction, which is what makes the read a decision boundary
    // rather than a snapshot of the past.
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-orphan", status: "paused_error" },
    });
    mockMoneyState.mockResolvedValueOnce({ clear: false, reasons: [] });

    await call({ sessionId: SESSION });

    expect(mockAcquireLock).toHaveBeenCalledWith(expect.anything(), SESSION);
  });

  it("FAILS CLOSED when the money state cannot be read", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-orphan", status: "paused_error" },
    });
    mockMoneyState.mockRejectedValueOnce(new Error("db unreachable"));

    const r = await call({ sessionId: SESSION });

    expect(r.ok).toBe(false);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  it("maps lease_busy with a retryAfterMs hint and never leaks the owner id", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-err", status: "paused_error" },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-1" });
    mockClaim.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: {
        ownerId: "secret-owner",
        expiresAt: new Date(Date.now() + 30_000),
      },
    });

    const r = await call({ sessionId: SESSION });
    expect(r.data?.outcome).toBe("lease_busy");
    expect(JSON.stringify(r.data)).not.toContain("secret-owner");
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });
});
