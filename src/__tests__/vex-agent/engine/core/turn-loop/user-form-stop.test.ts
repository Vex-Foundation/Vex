/**
 * The user-form batch stop — `trench.launch_request_form` is a FIRST-CLASS
 * pending mechanism, not an ordinary tool result.
 *
 * THE BUG THIS EXISTS TO PREVENT (Codex blocker 1). The handler used to return
 * an ordinary success, which this loop recorded as the call's tool result like
 * any other. The resume later appended a SECOND result for the SAME
 * `tool_call_id` — transcript corruption, and a provider round-trip with two
 * results for one call. The `result_message_id IS NULL` CAS on the intent could
 * not catch it, because the first result was written by this loop, which never
 * stamps the intent.
 *
 * The fix mirrors the approval stop exactly (`approval-stop.ts`), because the
 * shape of the problem is identical — a call whose result arrives later, out of
 * band:
 *
 *   - the assistant's call is recorded WITHOUT a result ("awaiting the human"
 *     lives in `token_launch_intents`, not in the transcript);
 *   - the remaining calls in the batch are NOT dispatched;
 *   - the run parks under the session control lock, behind the operator-stop
 *     gate, so a Stop that landed mid-flight cannot park a dead run;
 *   - the dialog push is emitted AFTER that transaction commits — and it is now
 *     the ONLY delivery path, since the tool output no longer reaches anyone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDispatchTool = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockAppendMessage = vi.fn().mockResolvedValue({
  id: 1,
  role: "assistant",
  content: "",
  timestamp: new Date().toISOString(),
});
const mockEmitLaunchFormRequested = vi.fn();
/** Drives the operator-stop gate the park transaction runs under its lock. */
let runStatusUnderLock = "running";
/** Ordered trace of park-transaction lifecycle points and the dialog emit. */
let lifecycle: string[] = [];

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  appendEngineMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
  streamDeltaBus: { emit: vi.fn(), subscribe: vi.fn(), size: vi.fn(), clear: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/messages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addMessage: (...a: unknown[]) => mockAppendMessage(...a),
  addMessageReturningId: (...a: unknown[]) => mockAppendMessage(...a),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: vi.fn().mockResolvedValue(true),
  updateStatusIfNotTerminal: (...a: unknown[]) => mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("@vex-agent/engine/runtime/launch-form-bus.js", () => ({
  emitLaunchFormRequested: (...a: unknown[]) => mockEmitLaunchFormRequested(...a),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockImplementation(async (_c: unknown, sql: string) =>
    typeof sql === "string" && sql.includes("FROM mission_runs") && sql.includes("FOR UPDATE")
      ? { status: runStatusUnderLock }
      : null,
  ),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
    const out = await fn({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() });
    // The real `withTransaction` COMMITs here, after the body resolves.
    lifecycle.push("commit");
    return out;
  }),
}));

const { processTurnToolBatch } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch.js"
);

const INTENT_ID = "launch-intent-001";

function context() {
  return {
    sessionId: "sess-1",
    missionId: "mission-1",
    missionRunId: "run-1",
    sessionPermission: "full",
  } as never;
}

function batch(...names: string[]) {
  return {
    content: null,
    reasoning: null,
    toolCalls: names.map((name, i) => ({
      id: `call_${i}`,
      name,
      arguments: {},
    })),
  } as never;
}

function formResult() {
  return {
    success: true,
    output: "drafted",
    pendingUserForm: { intentId: INTENT_ID },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle = [];
  runStatusUnderLock = "running";
  mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
  mockAppendMessage.mockResolvedValue({
    id: 1,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
  });
});

/** Every `role: "tool"` row this batch persisted. */
function toolResultRows(): unknown[] {
  return mockAppendMessage.mock.calls.filter((c) => {
    const msg = c[1] as { role?: string } | undefined;
    return msg?.role === "tool";
  });
}

describe("a pending user form STOPS the batch without recording a result", () => {
  it("records NO tool result for the parked call — the resume owns the only one", async () => {
    mockDispatchTool.mockResolvedValue(formResult());
    const liveMessages: unknown[] = [];

    const outcome = await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool"),
      liveMessages: liveMessages as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(outcome.kind).toBe("user_form_pause");
    expect(toolResultRows()).toHaveLength(0);
  });

  it("does NOT dispatch the remaining calls in the batch", async () => {
    mockDispatchTool.mockResolvedValueOnce(formResult());
    mockDispatchTool.mockResolvedValue({ success: true, output: "second" });

    await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool", "get_portfolio"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
  });

  it("parks the run and carries the intent id out to the turn loop", async () => {
    mockDispatchTool.mockResolvedValue(formResult());

    const outcome = await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(outcome).toMatchObject({ kind: "user_form_pause", intentId: INTENT_ID });
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledWith(
      "run-1",
      "paused_user_form",
      "user_form_required",
    );
  });

  /**
   * EMIT-AFTER-COMMIT, the bus's binding producer contract. The renderer opens
   * the dialog by RE-READING the intent row named in the event, so an emit
   * issued inside the transaction races that read against a row no other
   * connection can see yet — and the form silently never appears.
   */
  it("emits the dialog push only AFTER the park transaction COMMITS", async () => {
    mockDispatchTool.mockResolvedValue(formResult());
    mockUpdateStatusIfNotTerminal.mockImplementation(async () => {
      lifecycle.push("park");
      return true;
    });
    mockEmitLaunchFormRequested.mockImplementation(() => lifecycle.push("emit"));

    await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(lifecycle).toEqual(["park", "commit", "emit"]);
  });

  /**
   * IDS ONLY on the wire. The draft — name, symbol, description, prebuy — stays
   * in the row the renderer re-reads. Putting any of it on an event would widen
   * a money-path surface, and every field there is model-authored text.
   */
  it("pushes IDS ONLY — no token content rides the event", async () => {
    mockDispatchTool.mockResolvedValue(formResult());

    await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(mockEmitLaunchFormRequested).toHaveBeenCalledTimes(1);
    const payload = mockEmitLaunchFormRequested.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["intentId", "sessionId"]);
    expect(payload).toEqual({ sessionId: "sess-1", intentId: INTENT_ID });
  });
});

describe("a Stop that landed mid-flight must not park a dead run", () => {
  it("gives the call a result, drains the batch, and pushes NO dialog", async () => {
    // The operator stopped the run while the handler was drafting. Parking now
    // would leave a form open on a run nobody will ever resume, and the agent
    // would never come back to answer it.
    runStatusUnderLock = "stopped";
    mockDispatchTool.mockResolvedValue(formResult());

    const outcome = await processTurnToolBatch({
      context: context(),
      turnResult: batch("execute_tool"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(outcome.kind).not.toBe("user_form_pause");
    expect(mockEmitLaunchFormRequested).not.toHaveBeenCalled();
    // Pairing is preserved: the call that ran gets a truthful result saying the
    // form was abandoned, rather than an unanswered call left dangling.
    expect(toolResultRows()).toHaveLength(1);
  });
});
