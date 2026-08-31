/**
 * `runtime.getState` → `pausedWake` composition AND the `stoppable` projection.
 *
 * The wake read is COMPOSED at the handler, not folded into
 * `getActiveRunForSession`'s query, for two reasons: the run query already
 * joins three tables and owns the control-gating contract, and the wake row
 * belongs to `wake-db.ts`. That composition has to satisfy three properties:
 *
 *  1. only a `paused_wake` run pays for the extra round-trip — every other
 *     status must not touch the wake table at all;
 *  2. `pausedWake` is ABSENT (not null) when there is nothing to show, so the
 *     additive field stays invisible to existing consumers and the renderer's
 *     gate is a single presence check;
 *  3. a failed/empty wake read still yields a successful runtime state. The
 *     banner is a decoration; the pause/stop/resume gating is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockReadSessionControlFacts = vi.fn();
const mockGetPendingWakeForSession = vi.fn();

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

vi.mock("../../../database/session-control-state.js", async (importOriginal) => {
  // `isStoppable` is the POLICY under test in the sibling file — the real one
  // is used here so this file cannot accidentally pin a fake predicate.
  const actual = await importOriginal<
    typeof import("../../../database/session-control-state.js")
  >();
  return {
    ...actual,
    readSessionControlFacts: (...a: unknown[]) =>
      mockReadSessionControlFacts(...a),
  };
});
vi.mock("../../../database/wake-db.js", () => ({
  getPendingWakeForSession: (...a: unknown[]) =>
    mockGetPendingWakeForSession(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerRuntimeGetStateHandler } = await import(
  "../../runtime/get-state.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000dddd";
const DUE = "2026-07-30T20:57:00.000Z";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

function runFacts(status: string) {
  return {
    sessionId: SESSION,
    hasActiveRun: true,
    missionRunId: "run-1",
    status,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: "2026-07-30T20:00:00.000Z",
    iterationCount: 2,
    leaseActive: false,
    leaseExpiresAt: null,
    pendingControlKind: null,
    hasPendingWake: false,
    sessionWakeDueAt: null,
    hasPendingApproval: false,
    hasIncompleteApprovalLifecycle: false,
    hasOutstandingUserForm: false,
  };
}

async function call() {
  const handler = electronMock.__handlers.get(CH.runtime.getState);
  if (!handler) throw new Error("No handler for runtime.getState");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { sessionId: SESSION },
  })) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.__handlers.clear();
  registerRuntimeGetStateHandler();
});

describe("runtime.getState pausedWake", () => {
  it("attaches pausedWake for a paused_wake run", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: runFacts("paused_wake"),
    });
    mockGetPendingWakeForSession.mockResolvedValueOnce({
      dueAt: DUE,
      reason: "waiting for the funding window",
      watchSummary: "price",
    });

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data?.pausedWake).toEqual({
      dueAt: DUE,
      reason: "waiting for the funding window",
      watchSummary: "price",
    });
    expect(mockGetPendingWakeForSession).toHaveBeenCalledWith(SESSION);
  });

  it.each(["running", "paused_approval", "paused_error", "paused_user"])(
    "never reads the wake table and omits pausedWake for status %s",
    async (status) => {
      mockReadSessionControlFacts.mockResolvedValueOnce({
        ok: true,
        data: runFacts(status),
      });

      const r = await call();

      expect(r.ok).toBe(true);
      expect(r.data && "pausedWake" in r.data).toBe(false);
      expect(mockGetPendingWakeForSession).not.toHaveBeenCalled();
    },
  );

  it("omits pausedWake when the run is paused_wake but no pending row remains", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: runFacts("paused_wake"),
    });
    // Real transient: the executor claimed the row (pending → consumed) between
    // the run read and this one. "Not sleeping" is the honest answer.
    mockGetPendingWakeForSession.mockResolvedValueOnce(null);

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data && "pausedWake" in r.data).toBe(false);
  });

  it("still returns a successful runtime state when the wake read throws", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: runFacts("paused_wake"),
    });
    mockGetPendingWakeForSession.mockRejectedValueOnce(new Error("db down"));

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data?.status).toBe("paused_wake");
    expect(r.data && "pausedWake" in r.data).toBe(false);
  });

  it("does not read the wake table when the run query itself failed", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "Unable to load runtime state.",
        retryable: true,
        userActionable: false,
        redacted: true,
        correlationId: "11111111-1111-4111-8111-111111111111",
      },
    });

    const r = await call();

    expect(r.ok).toBe(false);
    expect(mockGetPendingWakeForSession).not.toHaveBeenCalled();
  });
});

/**
 * THE REGRESSION SUITE for the reported defect: the Stop key vanished across a
 * `loop_defer` park while the agent was still running and still stoppable.
 *
 * The projection is asserted at the DTO boundary rather than on the predicate
 * alone, because the defect was never in the policy — it was that no field
 * carried the answer across IPC.
 */
describe("runtime.getState stoppable", () => {
  function idleFacts(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: SESSION,
      hasActiveRun: false,
      missionRunId: null,
      status: null,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: null,
      iterationCount: null,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
      hasPendingWake: false,
      sessionWakeDueAt: null,
      hasPendingApproval: false,
      hasIncompleteApprovalLifecycle: false,
      hasOutstandingUserForm: false,
      ...overrides,
    };
  }

  it("is TRUE for an agent session parked on a pending wake - no run, no lease", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: idleFacts({ hasPendingWake: true }),
    });

    const r = await call();

    expect(r.ok).toBe(true);
    // Every legacy signal says "nothing here"…
    expect(r.data?.hasActiveRun).toBe(false);
    expect(r.data?.status).toBeNull();
    expect(r.data?.leaseActive).toBe(false);
    // …and the agent is demonstrably still stoppable.
    expect(r.data?.stoppable).toBe(true);
  });

  it.each([
    ["a live lease", { leaseActive: true }],
    ["an active mission run", { hasActiveRun: true, status: "running" }],
    ["a pending approval decision", { hasPendingApproval: true }],
    ["an incomplete approval lifecycle", { hasIncompleteApprovalLifecycle: true }],
  ])("is TRUE for %s", async (_label, overrides) => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: idleFacts(overrides),
    });

    const r = await call();

    expect(r.data?.stoppable).toBe(true);
  });

  it("is FALSE for a genuinely idle session", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: idleFacts(),
    });

    const r = await call();

    expect(r.data?.stoppable).toBe(false);
  });

  /**
   * The `lane` lesson, pinned. The aggregate carries MAIN-INTERNAL existence
   * facts; a `{ ...facts }` assembly would carry them across a `.strict()`
   * cross-process contract the day one is added.
   */
  it("projects an EXACT key set - the private facts never cross IPC", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: idleFacts({ hasPendingWake: true, hasPendingApproval: true }),
    });

    const r = await call();

    expect(Object.keys(r.data ?? {}).sort()).toEqual([
      // M5: `activity` joins the projected set - a DERIVED policy over the
      // private facts, never one of the private facts itself. `recoveryReady`
      // is absent because this fixture is not `paused_error`, the one status
      // it is computed for.
      "activity",
      "hasActiveRun",
      "iterationCount",
      "lastCheckpointAt",
      "leaseActive",
      "leaseExpiresAt",
      "missionRunId",
      "pendingControlKind",
      "sessionId",
      "startedAt",
      "status",
      "stopReason",
      "stoppable",
    ]);
  });

  /**
   * The park term comes from the AGGREGATE's own snapshot, never from the
   * status-gated banner read. A wake-table hiccup may cost the banner; it must
   * never cost the Stop key.
   */
  it("keeps stoppable TRUE when the banner read throws", async () => {
    mockReadSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: { ...runFacts("paused_wake"), hasPendingWake: true },
    });
    mockGetPendingWakeForSession.mockRejectedValueOnce(new Error("db down"));

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data && "pausedWake" in r.data).toBe(false);
    expect(r.data?.stoppable).toBe(true);
  });
});
