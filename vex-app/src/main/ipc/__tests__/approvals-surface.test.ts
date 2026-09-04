/**
 * Surface test for the vex.approvals.* IPC façade (`approvals.ts`) after the
 * structural split into the `approvals/` sibling modules (`read.ts`,
 * `decision.ts` alongside the pre-existing `_errors.ts`, `_map-outcomes.ts`,
 * `_sweep.ts`).
 *
 * Pins the façade's PUBLIC runtime surface so the split cannot silently add,
 * drop, or rename an export: the only export is `registerApprovalsHandlers`, a
 * function, and (smoke) calling it returns an array of teardown functions.
 *
 * Mocks mirror `approvals-decision-ipc.test.ts` so importing the façade does
 * not touch real Electron, Postgres, or the engine runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

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

vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: vi
    .fn()
    .mockResolvedValue({ ok: true, data: undefined }),
}));

vi.mock("../mission/_engine-dispatch.js", () => ({
  dispatchPreparedMission: vi.fn(),
}));

vi.mock("../../database/approvals-db.js", () => ({
  listPendingForSession: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  listPendingAllApprovals: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getApprovalById: vi.fn().mockResolvedValue({ ok: true, data: null }),
  getHistoryForSession: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  prepareApprove: vi.fn(),
  prepareReject: vi.fn(),
  expireApproval: vi.fn(),
  sweepExpiredApprovals: vi.fn().mockResolvedValue({
    swept: 0,
    errored: 0,
    continuations: [],
  }),
  // Second pass of the same scheduled cycle (no extra timer).
  reconcileApprovalLifecycle: vi.fn().mockResolvedValue({
    examined: 0,
    dispatched: 0,
    indeterminate: 0,
    resumed: 0,
    skippedLeaseHeld: 0,
    errored: 0,
  }),
  runResumeAfterDecision: vi.fn(),
  continuationMissionRunId: (cont: { kind: string; missionRunId?: string }) =>
    cont.kind === "mission_run" ? cont.missionRunId : undefined,
  discardContinuation: vi.fn(),
  ApprovalDispatchError: class extends Error {},
  ApprovalPostDecisionError: class extends Error {},
  ApprovalDecisionInconsistencyError: class extends Error {},
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const approvalsFacade = await import("../approvals.js");
const { registerApprovalsHandlers } = approvalsFacade;

// Type-only import of an exported type from the façade-adjacent schema surface
// must compile (no runtime effect). Pins that the public types remain importable.
import type { Result } from "@shared/ipc/result.js";
type _ResultProbe = Result<{ ok: true }>;

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("approvals façade surface", () => {
  it("exports registerApprovalsHandlers as a function", () => {
    expect(typeof registerApprovalsHandlers).toBe("function");
  });

  it("exposes EXACTLY the expected runtime export keys", () => {
    const runtimeKeys = Object.keys(approvalsFacade).sort();
    expect(runtimeKeys).toEqual(["registerApprovalsHandlers"]);
  });

  it("smoke: registerApprovalsHandlers() returns an array of teardown functions", () => {
    const teardowns = registerApprovalsHandlers();
    expect(Array.isArray(teardowns)).toBe(true);
    expect(teardowns.length).toBeGreaterThan(0);
    for (const teardown of teardowns) {
      expect(typeof teardown).toBe("function");
    }
    // Clear the registered sweep interval to avoid a leaked timer.
    for (const teardown of teardowns) teardown();
  });
});
