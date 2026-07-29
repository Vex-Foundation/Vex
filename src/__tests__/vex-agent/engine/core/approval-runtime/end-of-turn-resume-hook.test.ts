/**
 * The end-of-turn resume hook must fire on EVERY path that releases a session
 * lease — not just the ones that happened to get it first.
 *
 * The defect this pins, in two rounds. First the hook existed on the initial
 * mission run and the chat turn but not on approval continuation, recovery or
 * retry. Then, after those three were patched one at a time, review found four
 * more (`runner/setup-turn.ts`, `runner/mission-prepare.ts`,
 * `runner/recover-prepare.ts`, `approval-runtime/continuation.ts`'s
 * `discardContinuation`). Patching the sites someone notices is not a strategy,
 * so the hook now lives in `runtime/release-and-emit.ts` — the one function
 * through which every lease release passes.
 *
 * WHAT PROVES THE CLASS, AND WHERE. Coverage is by composition of three files,
 * because enumerating call sites in a mock-heavy test is exactly the pattern
 * that let the misses happen:
 *
 *   1. `runtime/release-and-emit-chokepoint.test.ts` — static: NOTHING in
 *      `src/vex-agent` releases a runner lease except the helper.
 *   2. `runtime/release-and-emit-resume-hook.test.ts` — behavioural: the helper
 *      fires the hook, strictly after the release, and cannot fail a turn.
 *   3. THIS FILE — end-to-end through the real helper on the runner paths that
 *      were individually broken, so a regression that bypasses or reorders the
 *      helper on one of them is caught in its own terms.
 *
 * Pinned invariants:
 *   - the hook runs STRICTLY AFTER the lease release (otherwise it blocks on
 *     the very lease it is trying to claim, and the fast path becomes the slow
 *     one);
 *   - it can NEVER fail the turn — it is invoked from a `finally`, so a broken
 *     hook must not convert a completed run into a failed one;
 *   - it is invoked once per release, with that release's session id.
 *
 * Note that `release-and-emit.js` is deliberately NOT mocked here: mocking it
 * away is what made the previous version of this file green while four release
 * paths had no hook at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-00000000b400";

/** Interleaving record — the ordering assertion reads this. */
const callOrder: string[] = [];

/** Fake lease handle that records its own release into `callOrder`. */
function recordingLeaseHandle(ownerId: string) {
  return {
    lease: null,
    ownerId,
    release: vi.fn(async () => {
      callOrder.push("release");
    }),
  };
}

const mockDispatchPendingApprovalResumes = vi.fn((sessionId: string) => {
  callOrder.push(`resume-hook:${sessionId}`);
});
vi.mock("@vex-agent/engine/core/approval-runtime/deferred-resume.js", () => ({
  dispatchPendingApprovalResumes: (...a: [string]) =>
    mockDispatchPendingApprovalResumes(...a),
  scheduleDeferredResumeRetries: vi.fn(),
  resumePendingApprovalsForSession: vi.fn().mockResolvedValue(0),
}));

// ── the real `releaseLeaseAndEmitControlState` runs; only its DB reads are
//    stubbed, so the release → emit → hook ordering under test is the product's.
vi.mock("@vex-agent/db/repos/runner-leases.js", () => ({
  getLease: vi.fn().mockResolvedValue(null),
}));

// ── recover path ────────────────────────────────────────────────────────
const mockResumePreparedMissionRun = vi.fn();
vi.mock("@vex-agent/engine/core/runner/mission-run.js", () => ({
  resumePreparedMissionRun: (...a: unknown[]) =>
    mockResumePreparedMissionRun(...a),
}));

const mockAppendEngineMessage = vi.fn().mockResolvedValue({ id: 1 });
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...a: unknown[]) => mockAppendEngineMessage(...a),
  appendMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
}));

// ── retry path ──────────────────────────────────────────────────────────
const mockGetActiveRunBySession = vi.fn();
const mockGetRun = vi.fn();
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
  getRun: (...a: unknown[]) => mockGetRun(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: vi.fn().mockResolvedValue(0),
}));

const mockClaimRunLeaseAndFlipToRunning = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) =>
    mockClaimRunLeaseAndFlipToRunning(...a),
  claimSessionLease: vi.fn(),
}));

const mockCreateLeaseHandle = vi.fn(() => recordingLeaseHandle("test-owner"));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

const mockResumeMissionRun = vi.fn();
vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));

// ── continuation path ───────────────────────────────────────────────────
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markResumeAttempted: vi.fn().mockResolvedValue(undefined),
  casMarkResumeConsumed: vi.fn().mockResolvedValue(true),
  hasResumeCompleted: vi.fn().mockResolvedValue(false),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runPreparedMissionRecover } = await import(
  "@vex-agent/engine/core/runner/recover-run.js"
);
const { retryActiveMissionRun } = await import(
  "@vex-agent/engine/core/runner/retry.js"
);
const { runResumeAfterDecision, discardContinuation } = await import(
  "@vex-agent/engine/core/approval-runtime/continuation.js"
);

const TURN_RESULT = {
  text: "done",
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: "running" as const,
};

function preparedRecover() {
  return {
    sessionId: SESSION_ID,
    missionId: "mission-1",
    newRunId: "run-new",
    recoveredFromRunId: "run-old",
    run: { id: "run-new", missionId: "mission-1", sessionId: SESSION_ID },
    mission: { id: "mission-1" },
    provider: {},
    config: {},
    sessionLease: recordingLeaseHandle("recover-owner"),
  } as unknown as Parameters<typeof runPreparedMissionRecover>[0];
}

function missionContinuation() {
  return {
    kind: "mission_run" as const,
    missionRunId: "run-1",
    sessionId: SESSION_ID,
    approvalId: "approval-1",
    leaseHandle: recordingLeaseHandle("resume-owner"),
    ownerId: "resume-owner",
  } as unknown as Parameters<typeof runResumeAfterDecision>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockCreateLeaseHandle.mockImplementation(() =>
    recordingLeaseHandle("test-owner"),
  );
  mockDispatchPendingApprovalResumes.mockImplementation((sessionId: string) => {
    callOrder.push(`resume-hook:${sessionId}`);
  });
  mockResumePreparedMissionRun.mockResolvedValue(TURN_RESULT);
  mockResumeMissionRun.mockResolvedValue(TURN_RESULT);
  mockGetRun.mockResolvedValue(null);
  mockGetActiveRunBySession.mockResolvedValue({
    id: "run-1",
    missionId: "mission-1",
    sessionId: SESSION_ID,
    status: "paused_error",
  });
  mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_error",
    lease: null,
    wakeCancelledCount: 0,
  });
});

describe("end-of-turn resume hook — recovery path", () => {
  it("dispatches pending approval resumes after the lease release", async () => {
    await runPreparedMissionRecover(preparedRecover());
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("still dispatches when the recovered run itself threw", async () => {
    mockResumePreparedMissionRun.mockRejectedValueOnce(new Error("run failed"));
    await expect(runPreparedMissionRecover(preparedRecover())).rejects.toThrow(
      "run failed",
    );
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("does not turn a completed recovery into a failure when the hook throws", async () => {
    mockDispatchPendingApprovalResumes.mockImplementationOnce(() => {
      throw new Error("hook exploded");
    });
    await expect(
      runPreparedMissionRecover(preparedRecover()),
    ).resolves.toEqual(TURN_RESULT);
  });
});

describe("end-of-turn resume hook — retry path", () => {
  it("dispatches pending approval resumes after the lease release", async () => {
    await retryActiveMissionRun(SESSION_ID);
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("does not dispatch when the retry was refused before any lease was taken", async () => {
    mockGetActiveRunBySession.mockResolvedValueOnce(null);
    await expect(retryActiveMissionRun(SESSION_ID)).rejects.toThrow(
      /No active mission run to retry/,
    );
    expect(mockDispatchPendingApprovalResumes).not.toHaveBeenCalled();
  });

  it("does not turn a completed retry into a failure when the hook throws", async () => {
    mockDispatchPendingApprovalResumes.mockImplementationOnce(() => {
      throw new Error("hook exploded");
    });
    await expect(retryActiveMissionRun(SESSION_ID)).resolves.toEqual(
      TURN_RESULT,
    );
  });
});

describe("end-of-turn resume hook — approval continuation path", () => {
  it("dispatches pending approval resumes after the lease release", async () => {
    await runResumeAfterDecision(missionContinuation());
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("still dispatches when the resumed turn threw", async () => {
    mockResumeMissionRun.mockRejectedValueOnce(new Error("resume failed"));
    await expect(
      runResumeAfterDecision(missionContinuation()),
    ).rejects.toThrow("resume failed");
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("does not turn a completed resume into a failure when the hook throws", async () => {
    mockDispatchPendingApprovalResumes.mockImplementationOnce(() => {
      throw new Error("hook exploded");
    });
    await expect(
      runResumeAfterDecision(missionContinuation()),
    ).resolves.toEqual(TURN_RESULT);
  });
});

/**
 * `discardContinuation` is the path review flagged as "releases the lease on
 * the caller-cannot-schedule branch". It BELONGS in the hook's scope: the lease
 * it hands back is the same session lease an approval decision defers on, so a
 * decision taken during the claim window would otherwise wait out the ladder
 * for a turn that never even ran.
 *
 * It cannot resume something it should not. The suppression callers — the
 * operator-Stop paths in `post-tx/dispatch-approved*` — discard precisely
 * because the run is terminal or stopped, and a resume claim only accepts
 * `running` / `paused_approval`. Chat sessions have no suppression path at all
 * (`applyQueuedOperatorStop` returns `clear` when there is no run).
 */
describe("end-of-turn resume hook — discarded continuation", () => {
  it("dispatches pending approval resumes after handing the lease back", async () => {
    await discardContinuation(missionContinuation());
    expect(callOrder).toEqual(["release", `resume-hook:${SESSION_ID}`]);
  });

  it("does not throw when the hook throws", async () => {
    mockDispatchPendingApprovalResumes.mockImplementationOnce(() => {
      throw new Error("hook exploded");
    });
    await expect(
      discardContinuation(missionContinuation()),
    ).resolves.toBeUndefined();
  });
});
