/**
 * Chat-session approval resume (A4) + durable deferred resume (A5).
 *
 * The bug this covers: in an Agent-Restricted session, Approve executed the
 * tool, recorded the result, and then never resumed the agent — the
 * continuation was only ever claimed when `missionRunId !== null`, and chat
 * sessions have none. The conversation simply stopped, while the IPC told the
 * user the agent would continue.
 *
 * Pinned invariants:
 *   - a chat resume claims the session lease, appends a dedicated engine cue
 *     (NOT the operator-interrupt banner), and re-invokes the agent turn core
 *     with NO user message;
 *   - `resume_consumed_at` is a COMPLETION marker: written ONCE, only after the
 *     resumed turn core has durably returned, and always BEFORE the lease is
 *     released. A failure anywhere in the turn leaves it null and the approval
 *     recoverable by a later sweep;
 *   - the in-turn hook is a READ, never a write — it reports that an EARLIER
 *     attempt already finished, and a `true` answer abandons the turn;
 *   - `resumed_at` is attempt audit and NEVER a gate;
 *   - the `approval_resolved` cue is bound to the approval, so retrying a
 *     crashed attempt appends no second cue and a losing attempt appends none
 *     at all;
 *   - the lease is released on every path;
 *   - the deferred worker resolves BOTH outstanding shapes — decided but
 *     undispatched, and dispatched but unresumed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-0000000000a4";
const APPROVAL_ID = "approval-chat-resume-001";
const CUE_MESSAGE_ID = 9001;

/**
 * Stand-in for the two `approval_intents` cells this contract turns on. The
 * repo FUNCTIONS are faked; their RULES are not. `casMarkResumeConsumed` keeps
 * its write-once CAS semantics, `hasResumeCompleted` reads the same cell, and
 * the cue slot is claimed under the same one-shot rule — so a test cannot pass
 * by re-implementing the ordering it is supposed to pin (rules/90).
 */
const intentRow: {
  resumeConsumedAt: string | null;
  resumeCueMessageId: number | null;
} = { resumeConsumedAt: null, resumeCueMessageId: null };

// ── Mocks ───────────────────────────────────────────────────────────────

const mockMarkResumeAttempted = vi.fn().mockResolvedValue(undefined);
const mockCasMarkResumeConsumed = vi.fn();
const mockHasResumeCompleted = vi.fn();
const mockLockResumeCueMessageIdWith = vi.fn();
const mockAttachResumeCueMessageWith = vi.fn();
const mockGetPendingLifecycleForSession = vi.fn().mockResolvedValue([]);
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markResumeAttempted: (...a: unknown[]) => mockMarkResumeAttempted(...a),
  casMarkResumeConsumed: (...a: unknown[]) => mockCasMarkResumeConsumed(...a),
  hasResumeCompleted: (...a: unknown[]) => mockHasResumeCompleted(...a),
  lockResumeCueMessageIdWith: (...a: unknown[]) =>
    mockLockResumeCueMessageIdWith(...a),
  attachResumeCueMessageWith: (...a: unknown[]) =>
    mockAttachResumeCueMessageWith(...a),
  getPendingLifecycleForSession: (...a: unknown[]) =>
    mockGetPendingLifecycleForSession(...a),
}));

// The dispatch replay path used for "decided but undispatched" rows, and the
// cue transaction.
const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn(txClient),
  ),
}));

const mockLockAndLoadSnapshot = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/snapshot/compare.js", () => ({
  lockAndLoadSnapshot: (...a: unknown[]) => mockLockAndLoadSnapshot(...a),
  getDbNow: vi.fn(),
}));

const mockApplyApproveSideEffects = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx.js", () => ({
  applyApproveSideEffects: (...a: unknown[]) =>
    mockApplyApproveSideEffects(...a),
}));

/**
 * Stubbed so a resumed turn's own end-of-turn hook cannot fire a second,
 * nondeterministic pass mid-assertion. Its ORDER relative to the completion
 * marker is asserted explicitly below — that ordering is what makes the hook
 * unable to recurse on the approval the turn just resumed.
 *
 * The hook is now invoked by `releaseLeaseAndEmitControlState` rather than by
 * `continuation.ts`, so with that helper also stubbed here this mock no longer
 * receives calls; it stays because it is what guarantees the real module (and
 * therefore a real resume pass) can never load in this file.
 */
const mockDispatchAfterRelease = vi.fn().mockResolvedValue(undefined);
vi.mock(
  "@vex-agent/engine/core/approval-runtime/end-of-turn-resume-hook.js",
  () => ({
    dispatchPendingApprovalResumesAfterRelease: (...a: unknown[]) =>
      mockDispatchAfterRelease(...a),
  }),
);

const mockAppendEngineMessage = vi.fn();
const mockEmitTranscriptAppend = vi.fn();
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...a: unknown[]) => mockAppendEngineMessage(...a),
  appendMessage: vi.fn(),
  emitTranscriptAppend: (...a: unknown[]) => mockEmitTranscriptAppend(...a),
  TRANSCRIPT_APPEND_EVENT_TYPE: "transcript.append",
}));

const mockRunAgentTurnUnderLease = vi.fn();
vi.mock("@vex-agent/engine/core/runner/agent.js", () => ({
  runAgentTurnUnderLease: (...a: unknown[]) => mockRunAgentTurnUnderLease(...a),
}));

const mockResumeMissionRun = vi.fn();
vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));

const mockResolveProvider = vi.fn();
vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

const mockClaimSessionLease = vi.fn();
const mockClaimRunLeaseAndFlipToRunning = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) =>
    mockClaimRunLeaseAndFlipToRunning(...a),
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

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { claimResumeContinuation, runResumeAfterDecision } = await import(
  "@vex-agent/engine/core/approval-runtime/continuation.js"
);
const { resumePendingApprovalsForSession } = await import(
  "@vex-agent/engine/core/approval-runtime/deferred-resume.js"
);
const { APPROVAL_RESOLVED_CUE } = await import(
  "@vex-agent/engine/core/approval-runtime/helpers.js"
);

// ── Fixtures ────────────────────────────────────────────────────────────

const TURN_RESULT = {
  text: "continuing",
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: null,
};

const NEUTRAL_TURN_RESULT = {
  text: null,
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: null,
};

/**
 * Faithful stand-in for a lease-held turn core: it consults the guard hook at
 * the moment it would begin consuming the result, and abandons the turn when
 * the guard says an earlier attempt already finished. Modelling the core this
 * way is the point — a stub that ignored the hook would silently accept
 * whatever ordering the caller used.
 */
function turnCoreStub(claimArgIndex: number) {
  return async (...args: unknown[]) => {
    const claim = args[claimArgIndex] as (() => Promise<boolean>) | undefined;
    if (claim !== undefined && !(await claim())) return NEUTRAL_TURN_RESULT;
    return TURN_RESULT;
  };
}

/**
 * A core that reaches the guard, passes it, and then dies before the turn can
 * finish — the crash window the completion marker exists to keep recoverable.
 */
function crashingTurnCoreStub(claimArgIndex: number, message: string) {
  return async (...args: unknown[]) => {
    const claim = args[claimArgIndex] as (() => Promise<boolean>) | undefined;
    if (claim !== undefined) await claim();
    throw new Error(message);
  };
}

function chatContinuation() {
  return {
    kind: "chat_session" as const,
    sessionId: SESSION_ID,
    approvalId: APPROVAL_ID,
    ownerId: "approve-x",
    leaseHandle: { release: vi.fn() },
  } as unknown as Parameters<typeof runResumeAfterDecision>[0];
}

function missionContinuation() {
  return {
    kind: "mission_run" as const,
    missionRunId: "run-1",
    sessionId: SESSION_ID,
    approvalId: APPROVAL_ID,
    ownerId: "approve-x",
    leaseHandle: { release: vi.fn() },
  } as unknown as Parameters<typeof runResumeAfterDecision>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  intentRow.resumeConsumedAt = null;
  intentRow.resumeCueMessageId = null;

  mockMarkResumeAttempted.mockResolvedValue(undefined);
  // Write-once CAS on the completion cell.
  mockCasMarkResumeConsumed.mockImplementation(async () => {
    if (intentRow.resumeConsumedAt !== null) return false;
    intentRow.resumeConsumedAt = "2026-07-28T12:00:00.000Z";
    return true;
  });
  mockHasResumeCompleted.mockImplementation(
    async () => intentRow.resumeConsumedAt !== null,
  );
  // Cue slot, read under the row lock inside the cue transaction.
  mockLockResumeCueMessageIdWith.mockImplementation(
    async () => intentRow.resumeCueMessageId,
  );
  mockAttachResumeCueMessageWith.mockImplementation(
    async (_client: unknown, _approvalId: string, id: number) => {
      intentRow.resumeCueMessageId = id;
    },
  );

  mockGetPendingLifecycleForSession.mockResolvedValue([]);
  mockAppendEngineMessage.mockResolvedValue({
    id: CUE_MESSAGE_ID,
    role: "system",
    content: APPROVAL_RESOLVED_CUE,
    timestamp: "2026-07-28T12:00:00.000Z",
  });
  mockDispatchAfterRelease.mockResolvedValue(undefined);
  // `runAgentTurnUnderLease(sessionId, provider, config, signal, claimTurn)`
  mockRunAgentTurnUnderLease.mockImplementation(turnCoreStub(4));
  // `resumeMissionRun(runId, claimTurn)`
  mockResumeMissionRun.mockImplementation(turnCoreStub(1));
  mockReleaseLeaseAndEmit.mockResolvedValue(undefined);
  mockLockAndLoadSnapshot.mockResolvedValue({
    approval_id: APPROVAL_ID,
    session_id: SESSION_ID,
    mission_run_id: null,
    queue_tool_call: { command: "wallet_send_confirm", args: {} },
    queue_tool_call_id: "tc-1",
    queue_permission_at_enqueue: "restricted",
    queue_resolved_at: "2026-07-28T11:00:00.000Z",
  });
  mockApplyApproveSideEffects.mockResolvedValue({
    kind: "dispatched",
    continuation: null,
  });
  mockResolveProvider.mockResolvedValue({
    loadConfig: vi.fn().mockResolvedValue({ contextLimit: 128000 }),
  });
  mockClaimSessionLease.mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: SESSION_ID, ownerId: "approve-x" },
  });
  mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_approval",
    lease: { sessionId: SESSION_ID, missionRunId: "run-1" },
  });
  mockCreateLeaseHandle.mockImplementation(
    (opts: { ownerId: string; lease: unknown }) => ({
      lease: opts.lease,
      ownerId: opts.ownerId,
      release: vi.fn().mockResolvedValue(undefined),
    }),
  );
});

// ── Claiming ────────────────────────────────────────────────────────────

describe("claimResumeContinuation", () => {
  it("chat session (no mission run) → claims the SESSION lease", async () => {
    const claim = await claimResumeContinuation({
      sessionId: SESSION_ID,
      missionRunId: null,
      approvalId: APPROVAL_ID,
      ownerPrefix: "approve",
    });

    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("outcome mismatch");
    expect(claim.continuation.kind).toBe("chat_session");
    expect(mockClaimSessionLease).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        ownerId: `approve-${APPROVAL_ID}`,
      }),
    );
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it("mission run → claims the run lease and flips to running", async () => {
    const claim = await claimResumeContinuation({
      sessionId: SESSION_ID,
      missionRunId: "run-1",
      approvalId: APPROVAL_ID,
      ownerPrefix: "approve",
    });

    if (claim.outcome !== "claimed") throw new Error("outcome mismatch");
    expect(claim.continuation.kind).toBe("mission_run");
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatuses: ["paused_approval", "running"],
      }),
    );
    expect(mockClaimSessionLease).not.toHaveBeenCalled();
  });

  it("busy chat lease → `busy` (transient, retried) not an error", async () => {
    mockClaimSessionLease.mockResolvedValue({ outcome: "lease_busy" });

    const claim = await claimResumeContinuation({
      sessionId: SESSION_ID,
      missionRunId: null,
      approvalId: APPROVAL_ID,
      ownerPrefix: "approve",
    });

    expect(claim.outcome).toBe("busy");
  });

  it("mission status_mismatch is distinguished from busy (NOT transient)", async () => {
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "status_mismatch",
      currentStatus: "cancelled",
    });

    const claim = await claimResumeContinuation({
      sessionId: SESSION_ID,
      missionRunId: "run-1",
      approvalId: APPROVAL_ID,
      ownerPrefix: "approve",
    });

    expect(claim.outcome).toBe("status_mismatch");
  });
});

// ── Running the chat resume ─────────────────────────────────────────────

describe("runResumeAfterDecision — chat session", () => {
  it("appends the approval cue and re-invokes the agent under the held lease", async () => {
    const result = await runResumeAfterDecision(chatContinuation());

    expect(result).toEqual(TURN_RESULT);
    expect(mockAppendEngineMessage).toHaveBeenCalledWith(
      SESSION_ID,
      APPROVAL_RESOLVED_CUE,
      expect.objectContaining({
        source: "engine",
        messageType: "approval_resolved",
        visibility: "internal",
      }),
      expect.objectContaining({ client: txClient }),
    );
    // The core runs with the lease ALREADY held and appends no user message.
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTurnUnderLease.mock.calls[0]![0]).toBe(SESSION_ID);
  });

  it("the cue is an engine marker, NOT the operator-interrupt banner", async () => {
    await runResumeAfterDecision(chatContinuation());

    const [, content, metadata] = mockAppendEngineMessage.mock.calls[0]!;
    // "the user interrupted you" would be the opposite of what happened.
    expect(content).not.toMatch(/interrupt/i);
    expect(content).toMatch(/approval_resolved/);
    expect(content).toMatch(/[Cc]ontinue/);
    expect((metadata as { messageType: string }).messageType).not.toBe(
      "operator_interrupt",
    );
  });

  it("publishes the cue's transcript event only after its transaction commits", async () => {
    await runResumeAfterDecision(chatContinuation());

    expect(mockEmitTranscriptAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        messageId: CUE_MESSAGE_ID,
        messageType: "approval_resolved",
      }),
    );
  });

  /**
   * CONTRACT CHANGE (fix wave, finding B1). `resume_consumed_at` used to be
   * written when the core BEGAN consuming. That is a START marker used as a
   * completion gate: it removed the approval from every recovery scan while the
   * turn — hydration, prompt and tool construction, the model call, the tool
   * batch, finalization — could still die. The marker is now written by the
   * caller AFTER the core durably returns, and the in-turn hook is a read.
   */
  it("stamps resume_consumed_at only AFTER the core returns, and before the lease is released", async () => {
    const order: string[] = [];
    mockAppendEngineMessage.mockImplementation(async () => {
      order.push("cue");
      return { id: CUE_MESSAGE_ID, role: "system", timestamp: "t" };
    });
    mockHasResumeCompleted.mockImplementation(async () => {
      order.push("guard-read");
      return false;
    });
    mockCasMarkResumeConsumed.mockImplementation(async () => {
      order.push("completion-marker");
      return true;
    });
    mockRunAgentTurnUnderLease.mockImplementation(async (...args: unknown[]) => {
      order.push("core-start");
      const claim = args[4] as () => Promise<boolean>;
      await claim();
      order.push("model-call");
      return TURN_RESULT;
    });
    // `releaseLeaseAndEmitControlState` OWNS the end-of-turn hook (it is the
    // one chokepoint every lease release passes through), so the stub models
    // both halves. That the hook fires strictly AFTER the release inside it is
    // pinned by `runtime/release-and-emit-resume-hook.test.ts`; what THIS
    // assertion pins is the fact that module cannot see — that the completion
    // marker is written BEFORE either of them, which is what stops the hook
    // recursing on the approval this turn just resumed.
    mockReleaseLeaseAndEmit.mockImplementation(async () => {
      order.push("lease-release");
      order.push("end-of-turn-hook");
    });

    await runResumeAfterDecision(chatContinuation());

    expect(mockCasMarkResumeConsumed).toHaveBeenCalledTimes(1);
    expect(mockCasMarkResumeConsumed).toHaveBeenCalledWith(APPROVAL_ID);
    expect(order).toEqual([
      "cue",
      "core-start",
      "guard-read",
      "model-call",
      "completion-marker",
      "lease-release",
      "end-of-turn-hook",
    ]);
  });

  it("the in-turn hook writes NOTHING — it only reads whether an earlier attempt finished", async () => {
    await runResumeAfterDecision(chatContinuation());

    // One read inside the core, one CAS after it returned. If the hook were
    // still a write there would be two writes, and the earlier of them would be
    // the eligibility gate all over again.
    expect(mockHasResumeCompleted).toHaveBeenCalledTimes(1);
    expect(mockHasResumeCompleted).toHaveBeenCalledWith(APPROVAL_ID);
    expect(mockCasMarkResumeConsumed).toHaveBeenCalledTimes(1);
  });

  it("a failure before the core leaves the approval unconsumed and recoverable", async () => {
    mockAppendEngineMessage.mockRejectedValue(new Error("pg down"));

    await expect(runResumeAfterDecision(chatContinuation())).rejects.toThrow(
      /pg down/,
    );

    expect(intentRow.resumeConsumedAt).toBeNull();
    expect(mockRunAgentTurnUnderLease).not.toHaveBeenCalled();
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();
  });

  /**
   * REGRESSION 2 (finding B1). The crash window the old START marker opened:
   * the turn claimed, then died before completing. Under the old contract the
   * row was already marked consumed, so no scan would ever look at it again and
   * the agent stayed asleep for good.
   */
  it("a crash AFTER the guard but before the core completes stays recoverable, and recovers exactly once", async () => {
    mockRunAgentTurnUnderLease.mockImplementationOnce(
      crashingTurnCoreStub(4, "process died mid-turn"),
    );

    await expect(runResumeAfterDecision(chatContinuation())).rejects.toThrow(
      /process died mid-turn/,
    );
    // Nothing durable was written, so the approval is still in the scan.
    expect(intentRow.resumeConsumedAt).toBeNull();

    // A later sweep claims it again and this time the turn finishes.
    const recovered = await runResumeAfterDecision(chatContinuation());
    expect(recovered).toEqual(TURN_RESULT);
    expect(intentRow.resumeConsumedAt).not.toBeNull();

    // And a third pass is a no-op: the completion marker vetoes the turn.
    mockRunAgentTurnUnderLease.mockClear();
    const third = await runResumeAfterDecision(chatContinuation());
    expect(third.text).toBeNull();
    const [, , , , claim] = mockRunAgentTurnUnderLease.mock.calls[0]!;
    expect(await (claim as () => Promise<boolean>)()).toBe(false);
  });

  /**
   * REGRESSION 3 (finding B1). Retrying a crashed attempt must not append a
   * second `approval_resolved` cue: a second copy announces a second resolved
   * approval that never happened, and a wake the model already handled reads as
   * new work.
   */
  it("a retried attempt appends NO second cue", async () => {
    mockRunAgentTurnUnderLease.mockImplementationOnce(
      crashingTurnCoreStub(4, "process died mid-turn"),
    );

    await expect(runResumeAfterDecision(chatContinuation())).rejects.toThrow();
    expect(mockAppendEngineMessage).toHaveBeenCalledTimes(1);

    await runResumeAfterDecision(chatContinuation());

    // Still one cue in the transcript, and the retry DID run the turn.
    expect(mockAppendEngineMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitTranscriptAppend).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(2);
  });

  /**
   * REGRESSION 3 (finding B1), the losing-attempt half. This used to append an
   * orphan cue with no turn behind it, and the previous version of this test
   * explicitly accepted that artifact. The cue is bound to the approval now, so
   * a loser writes nothing at all.
   */
  it("an attempt that lost the race appends no cue and runs no turn", async () => {
    // An earlier attempt already completed the resume and owns the cue.
    intentRow.resumeConsumedAt = "2026-07-28T11:59:00.000Z";
    intentRow.resumeCueMessageId = CUE_MESSAGE_ID;

    const result = await runResumeAfterDecision(chatContinuation());

    expect(mockAppendEngineMessage).not.toHaveBeenCalled();
    expect(mockEmitTranscriptAppend).not.toHaveBeenCalled();
    expect(result.text).toBeNull();
    expect(result.toolCallsMade).toBe(0);
    // No fabricated completion — the CAS refuses to restamp.
    expect(intentRow.resumeConsumedAt).toBe("2026-07-28T11:59:00.000Z");
  });

  it("passes the guard to the MISSION core too, not only the chat core", async () => {
    await runResumeAfterDecision(missionContinuation());

    expect(mockResumeMissionRun).toHaveBeenCalledTimes(1);
    const [runId, claim] = mockResumeMissionRun.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(typeof claim).toBe("function");
    expect(mockCasMarkResumeConsumed).toHaveBeenCalledWith(APPROVAL_ID);
  });

  /**
   * REGRESSION 1 (finding B1). The mission core claims, flips the run to
   * `running`, and only THEN hydrates. A hydration failure there is squarely
   * inside the window the old START marker had already closed.
   */
  it("a mission hydration failure BEFORE the model call leaves the result resumable by a later sweep", async () => {
    mockResumeMissionRun.mockImplementationOnce(
      crashingTurnCoreStub(1, `Session ${SESSION_ID} not found`),
    );

    await expect(
      runResumeAfterDecision(missionContinuation()),
    ).rejects.toThrow(/not found/);

    expect(intentRow.resumeConsumedAt).toBeNull();
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();

    // The unconsumed marker is exactly what keeps the row in the sweep's
    // eligibility set — and the sweep then delivers the wake.
    mockGetPendingLifecycleForSession.mockResolvedValue([
      {
        approvalId: APPROVAL_ID,
        sessionId: SESSION_ID,
        missionRunId: "run-1",
        toolCallId: "tc-1",
        decision: "approved",
        executionStatus: "succeeded",
        dispatchStartedAt: null,
        resultMessageId: 4242,
        resumeConsumedAt: intentRow.resumeConsumedAt,
      },
    ]);

    expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(1);
    expect(mockResumeMissionRun).toHaveBeenCalledTimes(2);
    expect(intentRow.resumeConsumedAt).not.toBeNull();
  });

  it("resolves the provider BEFORE consuming, so an outage does not burn the resume", async () => {
    mockResolveProvider.mockResolvedValue(null);

    await expect(runResumeAfterDecision(chatContinuation())).rejects.toThrow(
      /No inference provider/,
    );

    // Still unconsumed — the reconciler can retry once inference is back.
    expect(intentRow.resumeConsumedAt).toBeNull();
    // And the lease was handed back.
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();
  });

  it("stamps the attempt audit, which is NEVER the gate", async () => {
    intentRow.resumeConsumedAt = "2026-07-28T11:59:00.000Z";

    await runResumeAfterDecision(chatContinuation());

    // `resumed_at` records that an attempt happened even when the attempt did
    // not deliver the wake.
    expect(mockMarkResumeAttempted).toHaveBeenCalledWith(APPROVAL_ID);
  });

  it("releases the lease even when the turn throws", async () => {
    mockRunAgentTurnUnderLease.mockRejectedValue(new Error("provider down"));

    await expect(runResumeAfterDecision(chatContinuation())).rejects.toThrow(
      /provider down/,
    );

    expect(mockReleaseLeaseAndEmit).toHaveBeenCalled();
  });
});

// ── Deferred resume pass ────────────────────────────────────────────────

describe("resumePendingApprovalsForSession", () => {
  /** DISPATCHED BUT UNRESUMED — the tool ran, only the wake is missing. */
  function resumableRow(overrides: Record<string, unknown> = {}) {
    return {
      approvalId: APPROVAL_ID,
      sessionId: SESSION_ID,
      missionRunId: null,
      toolCallId: "tc-1",
      decision: "approved",
      executionStatus: "succeeded",
      dispatchStartedAt: null,
      resultMessageId: 4242,
      resumeConsumedAt: null,
      ...overrides,
    };
  }

  /**
   * DECIDED BUT UNDISPATCHED — the session lease was busy when the user
   * approved, so the tool has NOT run and there is no result row yet. This is
   * the ordinary case (approving mid-turn), and the shape the worker used to be
   * blind to.
   */
  function undispatchedRow(overrides: Record<string, unknown> = {}) {
    return resumableRow({
      executionStatus: "not_started",
      resultMessageId: null,
      ...overrides,
    });
  }

  it("claims and resumes an eligible pending resume", async () => {
    mockGetPendingLifecycleForSession.mockResolvedValue([resumableRow()]);

    const resumed = await resumePendingApprovalsForSession(SESSION_ID);

    expect(resumed).toBe(1);
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
  });

  it("a completed resume is NOT delivered twice", async () => {
    // Second pass: the row is gone from the eligibility query because
    // `resume_consumed_at` is set. This is what stops the end-of-turn hook and
    // the reconciler from looping on the same approval.
    mockGetPendingLifecycleForSession.mockResolvedValueOnce([resumableRow()]);
    mockGetPendingLifecycleForSession.mockResolvedValueOnce([]);

    expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(1);
    expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(0);
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
  });

  it("stops the pass when the lease is busy rather than spinning", async () => {
    mockGetPendingLifecycleForSession.mockResolvedValue([resumableRow()]);
    mockClaimSessionLease.mockResolvedValue({ outcome: "lease_busy" });

    const resumed = await resumePendingApprovalsForSession(SESSION_ID);

    expect(resumed).toBe(0);
    expect(mockRunAgentTurnUnderLease).not.toHaveBeenCalled();
  });

  // ── Poison rows must not starve valid recovery (finding 3) ────────────

  /**
   * THE DEFECT. `lease_held` and "this row's run is not resumable" arrived at
   * the worker as one answer, and the worker `break`s on it. A busy lease is a
   * fact about the SESSION, so breaking is right; a run status is a fact about
   * ONE run. One approval whose run had gone to `paused_error` therefore
   * stopped every newer approval in the session — and, being the oldest, the
   * age-ordered scan handed it back first on every subsequent pass too.
   */
  describe("a row whose run cannot be claimed", () => {
    /** A mission row whose run has left `paused_approval` / `running`. */
    function unresumableRunRow(overrides: Record<string, unknown> = {}) {
      return resumableRow({
        approvalId: "stuck-on-dead-run",
        missionRunId: "run-paused-error",
        ...overrides,
      });
    }

    it("is skipped, and the newer approvals behind it still resume", async () => {
      mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
        outcome: "status_mismatch",
        currentStatus: "paused_error",
      });
      mockGetPendingLifecycleForSession.mockResolvedValue([
        unresumableRunRow(),
        resumableRow({ approvalId: "newer-and-valid" }),
      ]);

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      // The valid one moved; the stuck one did not, and did not count.
      expect(handled).toBe(1);
      expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
      expect(mockResumeMissionRun).not.toHaveBeenCalled();
    });

    it("is NOT destroyed — a recovered run resumes it on the next pass", async () => {
      // `paused_error` is operator-recoverable, so terminality would be wrong.
      mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
        outcome: "status_mismatch",
        currentStatus: "paused_error",
      });
      mockGetPendingLifecycleForSession.mockResolvedValue([
        unresumableRunRow(),
      ]);

      expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(0);
      expect(intentRow.resumeConsumedAt).toBeNull();

      // The operator retried the run; the very same row is now claimable.
      expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(1);
      expect(mockResumeMissionRun).toHaveBeenCalledTimes(1);
    });

    /**
     * The half that must NOT change: a busy lease is session-wide, so the pass
     * still gives up cheaply instead of trying every row against a lease it has
     * already been refused.
     */
    it("does not weaken the busy-lease break", async () => {
      mockGetPendingLifecycleForSession.mockResolvedValue([
        resumableRow({ approvalId: "first" }),
        resumableRow({ approvalId: "second" }),
      ]);
      mockClaimSessionLease.mockResolvedValue({ outcome: "lease_busy" });

      expect(await resumePendingApprovalsForSession(SESSION_ID)).toBe(0);
      // One claim attempt, not two — the pass stopped on the first refusal.
      expect(mockClaimSessionLease).toHaveBeenCalledTimes(1);
    });
  });

  it("a failing row does not abort the pass for the session", async () => {
    mockGetPendingLifecycleForSession.mockResolvedValue([
      resumableRow({ approvalId: "bad" }),
      resumableRow({ approvalId: "good" }),
    ]);
    mockRunAgentTurnUnderLease.mockRejectedValueOnce(new Error("boom"));

    const resumed = await resumePendingApprovalsForSession(SESSION_ID);

    expect(resumed).toBe(1);
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(2);
  });

  it("NEVER re-dispatches a tool that already ran — it only delivers the wake", async () => {
    mockGetPendingLifecycleForSession.mockResolvedValue([resumableRow()]);

    await resumePendingApprovalsForSession(SESSION_ID);

    // The only agent-facing action is the turn re-invocation; the recorded
    // result is read from the transcript, never recomputed.
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  // ── The busy path (owner's #1 requirement) ────────────────────────────

  /**
   * THE regression. The user approves while a turn is still running, so the
   * session lease is busy and the approve leaves the intent `approved` /
   * `not_started` with no result row. The eligibility query used to demand
   * `result_message_id IS NOT NULL`, so the backoff retries AND the end-of-turn
   * hook both found zero work and the approval sat for the full five minutes.
   */
  describe("decided but undispatched (busy lease at decision time)", () => {
    it("dispatches the approved tool that never ran", async () => {
      mockGetPendingLifecycleForSession.mockResolvedValue([undispatchedRow()]);

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      expect(handled).toBe(1);
      expect(mockApplyApproveSideEffects).toHaveBeenCalledTimes(1);
      expect(mockApplyApproveSideEffects.mock.calls[0]![0]).toBe(APPROVAL_ID);
      expect(mockApplyApproveSideEffects.mock.calls[0]![1]).toMatchObject({
        type: "approved_in_tx",
      });
    });

    it("resumes the agent when the replayed dispatch hands back a continuation", async () => {
      mockGetPendingLifecycleForSession.mockResolvedValue([undispatchedRow()]);
      mockApplyApproveSideEffects.mockResolvedValue({
        kind: "dispatched",
        continuation: {
          kind: "chat_session",
          sessionId: SESSION_ID,
          approvalId: APPROVAL_ID,
          ownerId: "approve-x",
          leaseHandle: { release: vi.fn() },
        },
      });

      await resumePendingApprovalsForSession(SESSION_ID);

      expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
    });

    it("a still-busy lease defers again instead of dispatching", async () => {
      // The replay goes through the same claim-before-dispatch side effects, so
      // a lease that is STILL held means nothing runs.
      mockGetPendingLifecycleForSession.mockResolvedValue([undispatchedRow()]);
      mockApplyApproveSideEffects.mockResolvedValue({ kind: "deferred_busy" });

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      expect(handled).toBe(0);
      expect(mockRunAgentTurnUnderLease).not.toHaveBeenCalled();
    });

    it("a vanished approval (snapshot gone) is a no-op, not a crash", async () => {
      mockGetPendingLifecycleForSession.mockResolvedValue([undispatchedRow()]);
      mockLockAndLoadSnapshot.mockResolvedValue(null);

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      expect(handled).toBe(0);
      expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
    });

    it("a REJECTED row sitting at not_started is never dispatched", async () => {
      // Rejections also rest at `not_started` (nothing ran). Only an approved
      // decision may take the dispatch branch.
      mockGetPendingLifecycleForSession.mockResolvedValue([
        undispatchedRow({ decision: "rejected" }),
      ]);

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      expect(handled).toBe(0);
      expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
    });

    it("resolves both shapes in one pass", async () => {
      mockGetPendingLifecycleForSession.mockResolvedValue([
        undispatchedRow({ approvalId: "needs-dispatch" }),
        resumableRow({ approvalId: "needs-wake" }),
      ]);

      const handled = await resumePendingApprovalsForSession(SESSION_ID);

      expect(handled).toBe(2);
      expect(mockApplyApproveSideEffects).toHaveBeenCalledTimes(1);
      expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
    });
  });
});
