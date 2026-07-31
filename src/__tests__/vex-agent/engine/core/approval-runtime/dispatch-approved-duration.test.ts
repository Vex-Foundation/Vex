/**
 * Caller-level: the PRODUCTION approval path persists the measured dispatch
 * duration.
 *
 * The sink (`appendApprovedToolResult`) is covered where it lives; what this
 * pins is the wiring one level up — `applyApproveSideEffects` reads
 * `ToolResult.durationMs` off the resumed dispatch and threads it all the way
 * into the appended tool-result's `metadata.payload.durationMs`, which is the
 * column the desktop app reads to render the duration chip. `result-message.js`
 * is therefore deliberately NOT mocked here; `appendMessage` is, so the
 * assertion is on the payload that would be persisted.
 *
 * The negative case matters as much as the positive one: contract C1 says the
 * field is null (absent) for a row that was never measured — it must NEVER be
 * a fabricated 0, which would read in the UI as "this took no time".
 *
 * The merged (compaction-v2 era) path claims the resume continuation and the
 * dispatch slot unconditionally — both are faked to their idle outcomes here;
 * their own suites cover the real behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendMessage = vi.fn().mockResolvedValue({ id: 1 });
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  emitTranscriptAppend: vi.fn(),
  TRANSCRIPT_APPEND_EVENT_TYPE: "transcript.append",
  streamDeltaBus: { emit: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

const mockDispatchTool = vi.fn();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

// Compaction-v2 merge: the commit is transactional (result-message's
// commitApprovedToolResult) — the repo CAS, tx client and session lock are
// faked exactly like the sink's own suite does; `true` = this writer still
// owns the `dispatching` slot.
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markExecutionStatus: vi.fn(),
  commitExecutionResultWith: vi.fn().mockResolvedValue(true),
  attachResultMessageWith: vi.fn(),
}));

const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(
    async (fn: (client: unknown) => Promise<unknown>) => fn(txClient),
  ),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: vi.fn(),
}));

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn().mockResolvedValue(null),
  buildSessionWalletResolution: vi.fn(),
}));

vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: vi
    .fn()
    .mockResolvedValue({ outcome: "claimed", continuation: null }),
  discardContinuation: vi.fn(),
}));

vi.mock("@vex-agent/engine/core/approval-runtime/deferred-resume.js", () => ({
  scheduleDeferredResumeRetries: vi.fn(),
}));

// The two orchestration siblings the merged path calls BEFORE dispatch: the
// slot gate (DB-only CAS transaction) and the resumed tool-context hydration.
// Both are covered by their own suites; here they must only let the dispatch
// proceed so the duration threading under test is reachable.
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/dispatch-slot-gate.js",
  () => ({
    claimDispatchSlotUnderStopGate: vi.fn().mockResolvedValue({
      tookSlot: true,
      stopGate: { kind: "clear" },
    }),
  }),
);
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/resumed-tool-context.js",
  () => ({
    buildResumedApprovalToolContext: vi.fn().mockResolvedValue({
      sessionId: "s1",
      permission: "full",
    }),
  }),
);

// Post-dispatch operator-stop landing (its own suite covers the real thing);
// idle outcome = the gate's "clear" kind, so the happy path proceeds.
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/operator-stop.js",
  () => ({
    applyQueuedOperatorStop: vi.fn().mockResolvedValue({ kind: "clear" }),
    abandonDispatchAfterOperatorStop: vi.fn(),
    STOP_APPLY_FAILED_ERROR_KIND: "stop_apply_failed",
  }),
);

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js"
);

function approvedSnapshot() {
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-07-13T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: null,
      tool_call_id: null,
      queue_tool_call_id: "tc-1",
      queue_tool_call: { command: "kyberswap_swap", args: {} },
      queue_permission_at_enqueue: "full",
    },
  } as unknown as Parameters<typeof applyApproveSideEffects>[1];
}

/** The metadata the appended tool-result row would be persisted with. */
function appendedPayload(): Record<string, unknown> | undefined {
  const call = mockAppendMessage.mock.calls.find(
    (c) => (c[2] as { messageType?: string } | undefined)?.messageType === "tool_result",
  );
  return (call?.[2] as { payload?: Record<string, unknown> } | undefined)?.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyApproveSideEffects — persisted dispatch duration", () => {
  it("carries the MEASURED durationMs into the appended tool-result payload", async () => {
    mockDispatchTool.mockResolvedValue({
      success: true,
      output: "{}",
      data: {},
      durationMs: 4321,
    });

    await applyApproveSideEffects("appr-1", approvedSnapshot());

    expect(appendedPayload()).toMatchObject({ success: true, durationMs: 4321 });
  });

  it("omits the key entirely when the dispatch reported no duration — never a fabricated 0", async () => {
    mockDispatchTool.mockResolvedValue({ success: true, output: "{}", data: {} });

    await applyApproveSideEffects("appr-1", approvedSnapshot());

    const payload = appendedPayload();
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("durationMs");
  });

  it("still carries the duration on a CONTROLLED failure — a failed action took real time too", async () => {
    mockDispatchTool.mockResolvedValue({
      success: false,
      output: "swap reverted",
      data: {},
      durationMs: 77,
    });

    await applyApproveSideEffects("appr-1", approvedSnapshot());

    expect(appendedPayload()).toMatchObject({ success: false, durationMs: 77 });
  });
});
