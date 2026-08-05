/**
 * `abandonDispatchAfterOperatorStop` must always hand the lease back.
 *
 * The caller nulls its own reference to the continuation BEFORE delegating
 * here, so ownership has already moved and nothing behind us will release it.
 * The structural-result commit that runs first is fallible (it is a DB write),
 * and when it threw, `discardContinuation` was skipped: the lease stayed held
 * with its heartbeat interval renewing `expires_at` every TTL/3, so it did not
 * even expire on schedule and the session was blocked for minutes.
 *
 * Not a money-path re-dispatch risk — the gate already proved nothing ran, and
 * the release is idempotent — but a resource leak on the operator-Stop path,
 * which is exactly when a user wants the session back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCommitDispatchFailureToolResult = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitDispatchFailureToolResult: (...a: unknown[]) =>
      mockCommitDispatchFailureToolResult(...a),
    commitApprovedToolResult: vi.fn(),
    commitDecisionToolResult: vi.fn(),
  }),
);

const mockDiscardContinuation = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  discardContinuation: (...a: unknown[]) => mockDiscardContinuation(...a),
  claimResumeContinuation: vi.fn(),
  runResumeAfterDecision: vi.fn(),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopTransaction: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { abandonDispatchAfterOperatorStop } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/operator-stop.js"
);

const CONTINUATION = { kind: "mission_run" } as unknown as NonNullable<
  Parameters<typeof abandonDispatchAfterOperatorStop>[0]["continuation"]
>;

function args() {
  return {
    approvalId: "00000000-0000-4000-8000-0000000000a1",
    sessionId: "00000000-0000-4000-8000-0000000000b1",
    missionRunId: "00000000-0000-4000-8000-0000000000d1",
    runStatus: "stopped" as const,
    scope: "run" as const,
    toolCallId: "call-1",
    continuation: CONTINUATION,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCommitDispatchFailureToolResult.mockResolvedValue(undefined);
  mockDiscardContinuation.mockResolvedValue(undefined);
});

describe("abandonDispatchAfterOperatorStop — continuation release", () => {
  it("releases the continuation on the ordinary path", async () => {
    const outcome = await abandonDispatchAfterOperatorStop(args());
    expect(outcome.kind).toBe("run_terminated");
    expect(mockDiscardContinuation).toHaveBeenCalledWith(CONTINUATION);
  });

  it("still releases the continuation when the structural commit throws", async () => {
    mockCommitDispatchFailureToolResult.mockRejectedValueOnce(
      new Error("structural result persist failed"),
    );

    await expect(abandonDispatchAfterOperatorStop(args())).rejects.toThrow(
      "structural result persist failed",
    );

    // The lease — and its heartbeat — must not survive the failed commit.
    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
    expect(mockDiscardContinuation).toHaveBeenCalledWith(CONTINUATION);
  });

  it("does not invent a release when there is no continuation", async () => {
    mockCommitDispatchFailureToolResult.mockRejectedValueOnce(
      new Error("structural result persist failed"),
    );

    await expect(
      abandonDispatchAfterOperatorStop({ ...args(), continuation: null }),
    ).rejects.toThrow("structural result persist failed");

    expect(mockDiscardContinuation).not.toHaveBeenCalled();
  });
});
