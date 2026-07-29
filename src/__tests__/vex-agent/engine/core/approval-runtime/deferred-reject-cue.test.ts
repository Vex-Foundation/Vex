/**
 * The `approval_resolved` cue must not lie about the transcript (finding 4).
 *
 * THE DEFECT. Every decision commits its tool result BEFORE it claims the
 * session lease — `post-tx/reject.ts` writes the rejection row first, then
 * claims. That order is deliberate and correct (the result must be durable
 * before anything can wake the agent), but it means a busy lease defers the
 * wake while the result is already in the conversation. Anything the running
 * turn appends in the meantime lands BETWEEN the result and the eventual cue.
 * The cue nevertheless told the model its result was "the preceding tool
 * message" — a false statement about the model's own transcript, made on the
 * path where it has to decide whether a real, money-moving action happened.
 *
 * This suite drives the real sequence rather than asserting on the constant
 * alone: reject with a busy lease, land an intervening row, then let the
 * deferred worker deliver the wake, and check what the cue claims against where
 * the cue actually is (rules/90 — a test that re-states the string instead of
 * exercising the ordering would stay green through the next regression).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c4";
const APPROVAL_ID = "approval-deferred-reject-001";
const TOOL_CALL_ID = "tc-reject-1";
const RESULT_MESSAGE_ID = 7010;
const CUE_MESSAGE_ID = 7012;

/** Ordered stand-in for the session transcript, as the model would read it. */
interface TranscriptRow {
  readonly kind: "tool_result" | "assistant" | "engine_cue";
  readonly content: string;
}
const transcript: TranscriptRow[] = [];

// ── Mocks ───────────────────────────────────────────────────────────────

const intentRow: {
  resumeConsumedAt: string | null;
  resumeCueMessageId: number | null;
} = { resumeConsumedAt: null, resumeCueMessageId: null };

const mockGetPendingLifecycleForSession = vi.fn().mockResolvedValue([]);
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markResumeAttempted: vi.fn().mockResolvedValue(undefined),
  casMarkResumeConsumed: vi.fn(async () => {
    if (intentRow.resumeConsumedAt !== null) return false;
    intentRow.resumeConsumedAt = "2026-07-28T12:00:00.000Z";
    return true;
  }),
  hasResumeCompleted: vi.fn(async () => intentRow.resumeConsumedAt !== null),
  lockResumeCueMessageIdWith: vi.fn(async () => intentRow.resumeCueMessageId),
  // The cue picks its wording from the durable outcome read under the same
  // lock. These are REJECTED approvals, so the neutral cue is the correct
  // choice — nothing executed, and the cue must not say otherwise.
  lockLifecycleRowWith: vi.fn(async () => ({
    decision: "rejected",
    executionStatus: "not_started",
  })),
  attachResumeCueMessageWith: vi.fn(
    async (_client: unknown, _approvalId: string, id: number) => {
      intentRow.resumeCueMessageId = id;
    },
  ),
  getPendingLifecycleForSession: (...a: unknown[]) =>
    mockGetPendingLifecycleForSession(...a),
}));

const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn(txClient),
  ),
}));

/**
 * The rejection tool-result commit, recorded as a transcript row. Its own
 * transactional pairing with `result_message_id` is covered in
 * `prepare-reject.test.ts`; what matters here is only WHERE it lands.
 */
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitDecisionToolResult: vi.fn(async (input: { content: string }) => {
      transcript.push({ kind: "tool_result", content: input.content });
      return {
        id: RESULT_MESSAGE_ID,
        role: "tool",
        content: input.content,
        timestamp: "2026-07-28T11:00:00.000Z",
      };
    }),
  }),
);

const mockAppendEngineMessage = vi.fn();
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...a: unknown[]) => mockAppendEngineMessage(...a),
  appendMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
  TRANSCRIPT_APPEND_EVENT_TYPE: "transcript.append",
}));

const mockRunAgentTurnUnderLease = vi.fn();
vi.mock("@vex-agent/engine/core/runner/agent.js", () => ({
  runAgentTurnUnderLease: (...a: unknown[]) => mockRunAgentTurnUnderLease(...a),
}));

vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: vi.fn(),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: vi.fn(async () => ({
    loadConfig: vi.fn().mockResolvedValue({ contextLimit: 256000 }),
  })),
}));

const mockClaimSessionLease = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  claimRunLeaseAndFlipToRunning: vi.fn(),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn((opts: { ownerId: string; lease: unknown }) => ({
    lease: opts.lease,
    ownerId: opts.ownerId,
    release: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@vex-agent/engine/core/approval-runtime/end-of-turn-resume-hook.js",
  () => ({
    dispatchPendingApprovalResumesAfterRelease: vi
      .fn()
      .mockResolvedValue(undefined),
  }),
);

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyRejectSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/reject.js"
);
const { resumePendingApprovalsForSession } = await import(
  "@vex-agent/engine/core/approval-runtime/deferred-resume.js"
);
const { APPROVAL_RESOLVED_CUE } = await import(
  "@vex-agent/engine/core/approval-runtime/helpers.js"
);

// ── Fixtures ────────────────────────────────────────────────────────────

const REJECTION_CONTENT = "Tool call rejected by user.\nReason: not this one";

/** Chat session (no mission run) — the Agent-Restricted shape. */
function rejectedSnapshot() {
  return {
    type: "rejected_in_tx" as const,
    queueResolvedAt: "2026-07-28T11:00:00.000Z",
    reason: "not this one",
    row: {
      approval_id: APPROVAL_ID,
      session_id: SESSION_ID,
      mission_run_id: null,
      tool_call_id: TOOL_CALL_ID,
      queue_tool_call_id: TOOL_CALL_ID,
    },
  } as unknown as Parameters<typeof applyRejectSideEffects>[1];
}

/** The rejection as the deferred worker later finds it: result, no wake. */
function pendingRejectionRow() {
  return {
    approvalId: APPROVAL_ID,
    sessionId: SESSION_ID,
    missionRunId: null,
    toolCallId: TOOL_CALL_ID,
    decision: "rejected",
    executionStatus: "not_started",
    dispatchStartedAt: null,
    resultMessageId: RESULT_MESSAGE_ID,
    resumeConsumedAt: null,
  };
}

beforeEach(() => {
  // The reject path arms the in-process backoff ladder on a busy lease. Fake
  // timers keep those bounded one-shot timers from firing a second,
  // nondeterministic pass mid-assertion.
  vi.useFakeTimers();
  vi.clearAllMocks();
  transcript.length = 0;
  intentRow.resumeConsumedAt = null;
  intentRow.resumeCueMessageId = null;

  mockGetPendingLifecycleForSession.mockResolvedValue([]);
  mockAppendEngineMessage.mockImplementation(
    async (_sessionId: string, content: string) => {
      transcript.push({ kind: "engine_cue", content });
      return {
        id: CUE_MESSAGE_ID,
        role: "system",
        content,
        timestamp: "2026-07-28T12:00:00.000Z",
      };
    },
  );
  mockRunAgentTurnUnderLease.mockResolvedValue({
    text: "understood",
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: null,
  });
  mockClaimSessionLease.mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: SESSION_ID, ownerId: "resume-x" },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deferred rejection — the cue and the transcript it describes", () => {
  /**
   * THE REGRESSION. Reject on a busy lease, an intervening assistant row, then
   * the deferred wake: the cue is provably NOT adjacent to the result it
   * explains, so it must not say it is.
   */
  it("with an intervening row the cue makes no adjacency claim", async () => {
    mockClaimSessionLease.mockResolvedValueOnce({ outcome: "lease_busy" });

    const outcome = await applyRejectSideEffects(
      APPROVAL_ID,
      rejectedSnapshot(),
      REJECTION_CONTENT,
    );

    // The result is durable; only the wake is outstanding.
    expect(outcome.kind).toBe("deferred_busy");
    expect(transcript).toEqual([
      { kind: "tool_result", content: REJECTION_CONTENT },
    ]);

    // The turn that held the lease keeps writing before it lets go.
    transcript.push({
      kind: "assistant",
      content: "Meanwhile, here is the balance you asked about.",
    });

    mockGetPendingLifecycleForSession.mockResolvedValue([
      pendingRejectionRow(),
    ]);
    expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(1);

    // Two rows separate the cue from the result it is about.
    expect(transcript.map((r) => r.kind)).toEqual([
      "tool_result",
      "assistant",
      "engine_cue",
    ]);
    const cue = transcript[2]!.content;
    expect(cue).toBe(APPROVAL_RESOLVED_CUE);
    expect(cue).not.toMatch(
      /preceding|previous message|last message|immediately (before|prior)|just above/i,
    );
  });

  /**
   * The meaning has to survive the fix: the model still needs to know a result
   * exists and where it lives, or the cue is a wake with no referent.
   */
  it("the cue still says the result is recorded, and where to look for it", () => {
    expect(APPROVAL_RESOLVED_CUE).toMatch(/approval_resolved/);
    expect(APPROVAL_RESOLVED_CUE).toMatch(/recorded in this conversation/i);
    expect(APPROVAL_RESOLVED_CUE).toMatch(/tool result/i);
    expect(APPROVAL_RESOLVED_CUE).toMatch(/[Cc]ontinue/);
    // Neutral across approve / reject / expire / policy-drift — it must never
    // imply the action went through.
    expect(APPROVAL_RESOLVED_CUE).not.toMatch(/success|succeeded|completed/i);
    expect(APPROVAL_RESOLVED_CUE).not.toMatch(/interrupt/i);
  });

  /**
   * A stable reference WOULD have been the other honest fix, but the only one
   * available is the model-authored `tool_call_id`, and interpolating that into
   * an `[Engine: ...]` banner is the injection shape `sanitizeRejectReason`
   * exists to defuse. Pin the choice so it is not quietly reversed.
   */
  it("interpolates no model-authored identifier into the engine banner", async () => {
    mockClaimSessionLease.mockResolvedValueOnce({ outcome: "lease_busy" });
    await applyRejectSideEffects(
      APPROVAL_ID,
      rejectedSnapshot(),
      REJECTION_CONTENT,
    );
    mockGetPendingLifecycleForSession.mockResolvedValue([
      pendingRejectionRow(),
    ]);
    await resumePendingApprovalsForSession(SESSION_ID);

    const cue = transcript.at(-1)!.content;
    expect(cue).not.toContain(TOOL_CALL_ID);
    expect(cue).not.toContain(APPROVAL_ID);
  });

  /**
   * The undeferred path is the one that USED to be adjacent, and the cue is the
   * same text there. Pinned so nobody reintroduces two cue variants — one
   * "adjacent" and one not — which would make the honest wording conditional on
   * a race nobody can observe from inside the model.
   */
  it("the immediate (unblocked) path gets the identical cue", async () => {
    mockGetPendingLifecycleForSession.mockResolvedValue([
      pendingRejectionRow(),
    ]);

    await resumePendingApprovalsForSession(SESSION_ID);

    expect(transcript).toEqual([
      { kind: "engine_cue", content: APPROVAL_RESOLVED_CUE },
    ]);
  });
});
