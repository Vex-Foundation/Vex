/**
 * Stage 2 — `commitApprovedToolResult` carries `explorerRefs` under
 * `metadata.payload` for approval-gated (financial) actions. This is a
 * metadata-only attachment — the approval/dispatch behavior is unchanged.
 *
 * Also pins the atomicity contract the lifecycle work introduced: the
 * transcript row and the intent's `execution_status` + `result_message_id` are
 * written on the SAME transaction client, and the transcript event is emitted
 * only AFTER that transaction commits. Before this was atomic, a crash between
 * the two writes left an approval marked `succeeded` with no tool result in the
 * conversation.
 *
 * And the fence on that write: the repo UPDATE is CAS'd on
 * `execution_status = 'dispatching'`, so a dispatcher that woke up after the
 * reconciler already declared its outcome `indeterminate` cannot overwrite that
 * verdict or append a second tool result.
 *
 * And the money-gate participation: the session control lock is taken as the
 * transaction's FIRST statement, so the write is ordered against the compaction
 * safe-moment gate rather than able to interleave with it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendMessage = vi.fn();
const mockEmitTranscriptAppend = vi.fn();
const mockCommitExecutionResultWith = vi.fn();
const mockAcquireSessionControlLock = vi.fn();

/** Ordered log proving the commit happens before the emit. */
const callOrder: string[] = [];

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  emitTranscriptAppend: (...a: unknown[]) => {
    callOrder.push("emit");
    return mockEmitTranscriptAppend(...a);
  },
  TRANSCRIPT_APPEND_EVENT_TYPE: "transcript.append",
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  commitExecutionResultWith: (...a: unknown[]) => {
    callOrder.push("intent-update");
    return mockCommitExecutionResultWith(...a);
  },
  attachResultMessageWith: vi.fn(),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: (...a: unknown[]) => {
    callOrder.push("session-lock");
    return mockAcquireSessionControlLock(...a);
  },
}));

const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const out = await fn(txClient);
    callOrder.push("commit");
    return out;
  }),
}));

const { commitApprovedToolResult, commitDispatchFailureToolResult } =
  await import(
    "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js"
  );

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  // `true` = this writer still owned the `dispatching` slot.
  mockCommitExecutionResultWith.mockResolvedValue(true);
  mockAppendMessage.mockResolvedValue({
    id: 4242,
    role: "tool",
    content: "{}",
    timestamp: "2026-07-28T00:00:00.000Z",
  });
});

describe("commitApprovedToolResult — explorerRefs", () => {
  it("attaches explorerRefs to payload when present", async () => {
    const refs = [{ chain: "hyperliquid", txRef: "0xdeadbeef" }];
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
      explorerRefs: refs,
    });

    const call = mockAppendMessage.mock.calls[0]!;
    expect(call[1] as { role: string; content: string }).toMatchObject({
      role: "tool",
      content: "{}",
    });
    const meta = call[2] as { payload?: Record<string, unknown> };
    expect(meta.payload).toEqual({ success: true, explorerRefs: refs });
  });

  it("omits explorerRefs when none / arg omitted (back-compat)", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: false, output: "err" },
    });

    const meta = mockAppendMessage.mock.calls[0]![2] as {
      payload?: Record<string, unknown>;
    };
    expect(meta.payload).toEqual({ success: false });
    expect(meta.payload).not.toHaveProperty("explorerRefs");
  });

  it("attaches durationMs (post-approval dispatch only) when the caller measured one", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
      durationMs: 4200,
    });

    const meta = mockAppendMessage.mock.calls[0]![2] as {
      payload?: Record<string, unknown>;
    };
    expect(meta.payload).toEqual({ success: true, durationMs: 4200 });
  });

  it("omits durationMs when the dispatch reported none", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
    });

    const meta = mockAppendMessage.mock.calls[0]![2] as {
      payload?: Record<string, unknown>;
    };
    expect(meta.payload).not.toHaveProperty("durationMs");
  });
});

describe("commitApprovedToolResult — atomicity", () => {
  it("writes the transcript row and the intent columns on the SAME tx client", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
    });

    // Storage-only append: the caller owns the transaction, so `appendMessage`
    // receives the client and does NOT emit for itself.
    expect(mockAppendMessage.mock.calls[0]![3]).toEqual({ client: txClient });
    expect(mockCommitExecutionResultWith).toHaveBeenCalledWith(txClient, {
      approvalId: "appr-1",
      status: "succeeded",
      resultHash: expect.any(String),
      // The id of the row inserted in this same transaction — this pairing is
      // what makes "succeeded with no tool result" unrepresentable.
      resultMessageId: 4242,
    });
  });

  it("emits the transcript event only AFTER the transaction commits", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
    });

    // The session control lock is the FIRST statement of the transaction —
    // this writer settles `approval_intents` rows that the compaction
    // safe-moment gate reads, so it must serialize with that gate.
    expect(callOrder).toEqual([
      "session-lock",
      "intent-update",
      "commit",
      "emit",
    ]);
    expect(mockAcquireSessionControlLock).toHaveBeenCalledWith(txClient, "s1");
    expect(mockEmitTranscriptAppend).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", messageId: 4242 }),
    );
  });

  it("maps a controlled failure to execution_status='failed'", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: false, output: "Insufficient funds" },
    });

    expect(mockCommitExecutionResultWith).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ status: "failed", resultMessageId: 4242 }),
    );
  });

  it("honors an indeterminate execution-status override for unresolved money paths", async () => {
    await commitApprovedToolResult({
      approvalId: "appr-1",
      sessionId: "s1",
      toolCallId: "tc-1",
      dispatchResult: { success: true, output: "{}" },
      executionStatus: "indeterminate",
    });

    expect(mockCommitExecutionResultWith).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ status: "indeterminate", resultMessageId: 4242 }),
    );
  });
});

describe("commitApprovedToolResult — late-completion fence", () => {
  // The scenario: this dispatcher's heartbeat stalled, the reconciler saw no
  // live lease and an old `dispatch_started_at`, declared the outcome
  // `indeterminate`, wrote the honest tool result, and woke the agent. THEN the
  // original dispatch returned. Without the fence it would rewrite the terminal
  // verdict with an outcome it can no longer prove, and leave two tool results
  // answering one tool call.
  beforeEach(() => {
    mockCommitExecutionResultWith.mockResolvedValue(false);
  });

  it("a superseded write throws instead of overwriting `indeterminate`", async () => {
    await expect(
      commitApprovedToolResult({
        approvalId: "appr-1",
        sessionId: "s1",
        toolCallId: "tc-1",
        dispatchResult: { success: true, output: "{}" },
      }),
    ).rejects.toThrow(/superseded/i);
  });

  it("throws from INSIDE the transaction, so the second tool result rolls back", async () => {
    await expect(
      commitApprovedToolResult({
        approvalId: "appr-1",
        sessionId: "s1",
        toolCallId: "tc-1",
        dispatchResult: { success: true, output: "{}" },
      }),
    ).rejects.toThrow();

    // The INSERT was attempted on the tx client and never committed…
    expect(mockAppendMessage.mock.calls[0]![3]).toEqual({ client: txClient });
    expect(callOrder).not.toContain("commit");
    // …and no transcript event was published for a row that does not exist.
    expect(mockEmitTranscriptAppend).not.toHaveBeenCalled();
  });

  it("the same fence protects the dispatch-FAILURE result", async () => {
    await expect(
      commitDispatchFailureToolResult({
        approvalId: "appr-1",
        sessionId: "s1",
        toolCallId: "tc-1",
        content: "Tool dispatch failed: Error. Error hash: abc.",
        errorHash: "abc",
      }),
    ).rejects.toThrow(/superseded/i);
    expect(mockEmitTranscriptAppend).not.toHaveBeenCalled();
  });
});
