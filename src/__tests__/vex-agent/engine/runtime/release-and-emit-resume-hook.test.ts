/**
 * The behavioural half of the lease-release chokepoint guard.
 *
 * `releaseLeaseAndEmitControlState` owns the end-of-turn approval resume hook,
 * so every lease-releasing path in the engine inherits it. The properties that
 * must hold here are the ones the hook's own header declares, restated as
 * assertions because they are what makes the centralisation safe:
 *
 *   - the hook runs STRICTLY AFTER `handle.release()` — before it, the pass
 *     would block on the very lease it is trying to claim and fall back to the
 *     2s/5s/15s ladder, which is the latency this exists to remove;
 *   - the hook still runs when the control-state read/emit fails — a DB blip
 *     on a cosmetic emit must not cost the session its fast resume;
 *   - a throwing hook can NEVER reject this helper, which every caller invokes
 *     from a `finally`.
 *
 * Companion: `release-and-emit-chokepoint.test.ts` pins that no other file
 * releases a lease, so "the helper does it" means "everything does it".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-0000000000e1";

const callOrder: string[] = [];

const mockGetLease = vi.fn();
vi.mock("@vex-agent/db/repos/runner-leases.js", () => ({
  getLease: (...a: unknown[]) => mockGetLease(...a),
}));

const mockGetActiveRunBySession = vi.fn();
const mockGetRun = vi.fn();
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
  getRun: (...a: unknown[]) => mockGetRun(...a),
}));

const mockDispatchPendingApprovalResumes = vi.fn((sessionId: string) => {
  callOrder.push(`resume-hook:${sessionId}`);
});
vi.mock("@vex-agent/engine/core/approval-runtime/deferred-resume.js", () => ({
  dispatchPendingApprovalResumes: (...a: [string]) =>
    mockDispatchPendingApprovalResumes(...a),
  scheduleDeferredResumeRetries: vi.fn(),
  resumePendingApprovalsForSession: vi.fn().mockResolvedValue(0),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { releaseLeaseAndEmitControlState } = await import(
  "@vex-agent/engine/runtime/release-and-emit.js"
);
const { controlStateBus } = await import(
  "@vex-agent/engine/runtime/control-bus.js"
);

function leaseHandle() {
  return {
    lease: null,
    ownerId: "owner-1",
    release: vi.fn(async () => {
      callOrder.push("release");
    }),
  } as unknown as Parameters<typeof releaseLeaseAndEmitControlState>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockGetLease.mockResolvedValue(null);
  mockGetActiveRunBySession.mockResolvedValue(null);
  mockGetRun.mockResolvedValue(null);
  mockDispatchPendingApprovalResumes.mockImplementation((sessionId: string) => {
    callOrder.push(`resume-hook:${sessionId}`);
  });
});

describe("releaseLeaseAndEmitControlState — end-of-turn resume hook", () => {
  it("dispatches pending approval resumes strictly after the release", async () => {
    await releaseLeaseAndEmitControlState(leaseHandle(), SESSION_ID);
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("dispatches after the control-state emit, not before it", async () => {
    const seen: string[] = [];
    const off = controlStateBus.subscribe(() => {
      seen.push("emit");
      callOrder.push("emit");
    });
    try {
      await releaseLeaseAndEmitControlState(leaseHandle(), SESSION_ID);
    } finally {
      off();
    }
    expect(seen).toEqual(["emit"]);
    expect(callOrder).toEqual(["release", "emit", `resume-hook:${SESSION_ID}`]);
  });

  it("still dispatches when the control-state read fails", async () => {
    mockGetLease.mockRejectedValueOnce(new Error("db down"));
    await releaseLeaseAndEmitControlState(leaseHandle(), SESSION_ID);
    expect(mockDispatchPendingApprovalResumes).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does not reject when the hook throws", async () => {
    mockDispatchPendingApprovalResumes.mockImplementationOnce(() => {
      throw new Error("hook exploded");
    });
    await expect(
      releaseLeaseAndEmitControlState(leaseHandle(), SESSION_ID),
    ).resolves.toBeUndefined();
  });

  it("dispatches for the session whose lease was released", async () => {
    const other = "00000000-0000-4000-8000-0000000000e2";
    await releaseLeaseAndEmitControlState(leaseHandle(), other, {
      missionRunId: "run-9",
    });
    expect(mockDispatchPendingApprovalResumes).toHaveBeenCalledTimes(1);
    expect(mockDispatchPendingApprovalResumes).toHaveBeenCalledWith(other);
  });
});
