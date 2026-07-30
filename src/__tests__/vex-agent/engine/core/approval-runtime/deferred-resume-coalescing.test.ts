/**
 * The coalesced follow-up pass in `deferred-resume.ts`.
 *
 * A resume pass reads its work list ONCE. An approval that becomes eligible
 * after that read is invisible to the running pass, and the end-of-turn hook
 * announcing it used to be swallowed whole by the in-flight guard — so the
 * second approval of a burst fell through to the 2s/5s/15s ladder, in exactly
 * the busy-lease case the hook exists to serve. The sub-500 ms push contract
 * (`00-state-and-decisions.md`) is what that silently missed.
 *
 * What must hold now:
 *   - a hook arriving mid-pass still runs no pass CONCURRENTLY (the lease is
 *     session-scoped; two passes would only fight over it);
 *   - it is not dropped either — exactly ONE fresh pass follows;
 *   - any number of arrivals during one pass coalesce into that single re-run,
 *     because a fresh pass already scans every eligible row for the session;
 *   - the chain terminates: a pass with no arrivals during it queues nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";

const mockGetPendingLifecycleForSession = vi.fn();
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getPendingLifecycleForSession: (...a: unknown[]) =>
    mockGetPendingLifecycleForSession(...a),
}));

const mockApplyResumableLifecycleRow = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/lifecycle-actions.js", () => ({
  applyResumableLifecycleRow: (...a: unknown[]) =>
    mockApplyResumableLifecycleRow(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resumePendingApprovalsForSession, dispatchPendingApprovalResumes } =
  await import("@vex-agent/engine/core/approval-runtime/deferred-resume.js");

/** Minimal shape `applyResumableLifecycleRow` is handed; it is fully mocked. */
function row(approvalId: string): unknown {
  return { approvalId, sessionId: SESSION_ID, missionRunId: null };
}

/** Lets a test hold a pass open until it decides to let it finish. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPendingLifecycleForSession.mockResolvedValue([]);
  mockApplyResumableLifecycleRow.mockResolvedValue("resumed");
});

describe("resumePendingApprovalsForSession — mid-pass arrivals", () => {
  it("runs exactly one follow-up pass for a hook that arrived mid-pass", async () => {
    const gate = deferred();
    mockGetPendingLifecycleForSession
      .mockImplementationOnce(async () => {
        await gate.promise;
        return [row("a-1")];
      })
      .mockResolvedValue([]);

    const first = resumePendingApprovalsForSession(SESSION_ID);
    // The hook fires while the first pass is still reading its snapshot.
    await expect(
      resumePendingApprovalsForSession(SESSION_ID),
    ).resolves.toBe(0);
    // Still exactly one pass running — the arrival must not run concurrently.
    expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;
    // Let the fire-and-forget follow-up settle.
    await vi.waitFor(() =>
      expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(2),
    );
  });

  it("coalesces many mid-pass arrivals into a single follow-up pass", async () => {
    const gate = deferred();
    mockGetPendingLifecycleForSession
      .mockImplementationOnce(async () => {
        await gate.promise;
        return [];
      })
      .mockResolvedValue([]);

    const first = resumePendingApprovalsForSession(SESSION_ID);
    for (let i = 0; i < 5; i += 1) {
      await expect(
        resumePendingApprovalsForSession(SESSION_ID),
      ).resolves.toBe(0);
    }

    gate.resolve();
    await first;
    await vi.waitFor(() =>
      expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(2),
    );
    // Give any surplus queued pass a chance to appear before asserting it did
    // not: five arrivals must produce one re-run, not five.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(2);
  });

  it("queues nothing when no hook arrives during the pass", async () => {
    await resumePendingApprovalsForSession(SESSION_ID);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(1);
  });

  it("still runs the follow-up when the in-flight pass throws", async () => {
    const gate = deferred();
    mockGetPendingLifecycleForSession
      .mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error("snapshot read failed");
      })
      .mockResolvedValue([]);

    const first = resumePendingApprovalsForSession(SESSION_ID);
    await expect(resumePendingApprovalsForSession(SESSION_ID)).resolves.toBe(0);

    gate.resolve();
    await expect(first).rejects.toThrow("snapshot read failed");
    await vi.waitFor(() =>
      expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(2),
    );
  });

  it("dispatchPendingApprovalResumes coalesces the same way", async () => {
    const gate = deferred();
    mockGetPendingLifecycleForSession
      .mockImplementationOnce(async () => {
        await gate.promise;
        return [];
      })
      .mockResolvedValue([]);

    const first = resumePendingApprovalsForSession(SESSION_ID);
    dispatchPendingApprovalResumes(SESSION_ID);
    dispatchPendingApprovalResumes(SESSION_ID);
    await Promise.resolve();

    gate.resolve();
    await first;
    await vi.waitFor(() =>
      expect(mockGetPendingLifecycleForSession).toHaveBeenCalledTimes(2),
    );
  });
});
