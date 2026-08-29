/**
 * Tool-call repetition detection INSIDE a tool batch - the six-step ordering.
 *
 * The detector itself is proved as a pure decision in
 * `runner/tool-call-loop-detector.test.ts`. What is pinned HERE is everything
 * the batch orchestrator owns and the detector cannot know:
 *
 *   1. the result exists only post-dispatch, so the observation happens after
 *      `dispatchTool` returns and after `resolvePreparedActionFollowUp`;
 *   2. operator Stop still outranks detection;
 *   3. approval, user-form, prepared-action and engine-signal outcomes keep
 *      their stronger semantics and are NOT detector inputs;
 *   4. the completed result feeds the history;
 *   5. STRIKE 1 drains the rest of the emitted batch through the EXISTING
 *      drain mechanism, keeps the pairing balanced, and makes the corrective
 *      cue visible to the model before any further real call executes;
 *   6. STRIKE 2 drains the remainder and returns `tool_call_loop`.
 *
 * Only the DB writes are stubbed. The real drain constants, the real
 * `mapBatchOutcome`, the real detector and the real cue text stay in play, so
 * these assert production behaviour rather than a re-implementation of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { definedValue } from "../../../_test-value-guards.js";

/**
 * The single argument `persistBatchTranscript` receives, narrowed to the two
 * fields these tests read. Declaring it on the MOCK is what lets `mock.calls`
 * carry a real type, so the accessor below needs no cast to reach them.
 */
interface PersistedBatchArg {
  readonly executedCalls: ReadonlyArray<{ readonly id: string }>;
  readonly executedResults: ReadonlyArray<{ readonly output: string }>;
}

const dispatchTool = vi.fn();
const persistBatchTranscript = vi
  .fn<(batch: PersistedBatchArg, ...rest: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);
const appendEngineMessage = vi.fn().mockResolvedValue({ id: 1, role: "system" });
const enqueueApprovalIntent = vi.fn();
const parkTurnOnUserForm = vi.fn();

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...args: unknown[]) => dispatchTool(...args),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/execute.js", () => ({
  buildToolContext: (context: Record<string, unknown>) => ({
    ...context,
    approved: false,
    contextUsageBand: "normal",
  }),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js", () => ({
  assertApprovalActionKind: () => "read",
  enqueueApprovalIntent: (...args: unknown[]) => enqueueApprovalIntent(...args),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/user-form-stop.js", () => ({
  parkTurnOnUserForm: (...args: unknown[]) => parkTurnOnUserForm(...args),
}));
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...args: unknown[]) => appendEngineMessage(...args),
  appendMessage: vi.fn().mockResolvedValue({ id: 1, role: "system" }),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (
  importOriginal,
) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (
    ...args: Parameters<typeof persistBatchTranscript>
  ) => persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);
const {
  BATCH_ABORTED_BY_LOOP_CORRECTION_OUTPUT,
  BATCH_ABORTED_BY_TOOL_CALL_LOOP_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
} = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/results.js"
);
const { createToolCallLoopDetector } = await import(
  "../../../../vex-agent/engine/core/runner/tool-call-loop-detector.js"
);
const { TOOL_CALL_LOOP_CORRECTION_MESSAGE_TYPE } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/loop-correction-emit.js"
);

import type { Message } from "@vex-agent/db/repos/messages.js";
import type { ToolCallLoopDetector } from "@vex-agent/engine/core/runner/tool-call-loop-detector.js";
import type { EngineContext } from "@vex-agent/engine/types/engine-context.js";

/**
 * A REAL `EngineContext`, not a cast bag. The cast hid which fields the batch
 * orchestrator actually requires, so a context that drifted out of shape would
 * have kept type-checking here and failed only at runtime.
 */
function context(): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "full",
    missionId: "mission-1",
    missionRunId: "run-1",
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    loadedDocuments: new Map<string, string>(),
    walletPolicy: { kind: "none" },
  };
}

/** N copies of the SAME call - same name, same arguments, distinct ids. */
function identicalCalls(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `call-${i}`,
    name: "swap_quote",
    arguments: { inputMint: "SOL", outputMint: "USDC" },
  }));
}

async function runBatch(args: {
  readonly calls: ReturnType<typeof identicalCalls>;
  readonly detector: ToolCallLoopDetector;
  readonly liveMessages?: Message[];
  readonly abortSignal?: AbortSignal;
}) {
  return processTurnToolBatch({
    context: context(),
    turnResult: { content: null, reasoning: null, toolCalls: args.calls },
    liveMessages: args.liveMessages ?? [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
    loopDetector: args.detector,
    ...(args.abortSignal !== undefined ? { abortSignal: args.abortSignal } : {}),
  });
}

/** The batch argument of the `callIndex`-th persist call, typed by the mock. */
function persisted(callIndex = 0): PersistedBatchArg {
  return definedValue(
    persistBatchTranscript.mock.calls[callIndex],
    `persistBatchTranscript call ${callIndex}`,
  )[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
  appendEngineMessage.mockResolvedValue({ id: 1, role: "system" });
  // The incident's shape: the call succeeds and returns the SAME thing forever.
  dispatchTool.mockResolvedValue({ success: true, output: "no route found" });
});

describe("strike one - seven identical calls in ONE batch", () => {
  it("dispatches exactly five, drains the remainder, keeps the pairing balanced", async () => {
    const outcome = await runBatch({
      calls: identicalCalls(7),
      detector: createToolCallLoopDetector(),
    });

    // Five real dispatches: the fifth is the one that trips the detector, and
    // it had to RUN for its result to exist.
    expect(dispatchTool).toHaveBeenCalledTimes(5);
    expect(outcome.toolCallsExecuted).toBe(5);

    const { executedCalls, executedResults } = persisted();
    // The persisted assistant message still carries the FULL emitted batch.
    expect(executedCalls).toHaveLength(7);
    expect(executedResults).toHaveLength(7);
    expect(executedResults.slice(5).map((r) => r.output)).toEqual([
      BATCH_ABORTED_BY_LOOP_CORRECTION_OUTPUT,
      BATCH_ABORTED_BY_LOOP_CORRECTION_OUTPUT,
    ]);
  });

  it("does NOT end the turn - the slice continues so the model can act on the cue", async () => {
    const outcome = await runBatch({
      calls: identicalCalls(7),
      detector: createToolCallLoopDetector(),
    });
    expect(outcome.kind).toBe("normal_complete");
  });

  it("makes the correction visible to the model, AFTER the tool results", async () => {
    const liveMessages: Message[] = [];
    await runBatch({
      calls: identicalCalls(7),
      detector: createToolCallLoopDetector(),
      liveMessages,
    });

    // Durable: the model-visible cue is reconstructable from history (rule 09).
    expect(appendEngineMessage).toHaveBeenCalledTimes(1);
    const [, cue, metadata] = appendEngineMessage.mock.calls[0] as [
      string, string, { messageType: string; visibility: string; payload: Record<string, unknown> },
    ];
    expect(metadata.messageType).toBe(TOOL_CALL_LOOP_CORRECTION_MESSAGE_TYPE);
    expect(cue).toContain("tool_call_loop_correction");
    expect(cue).toContain("swap_quote");
    // The structured facts ride the row and carry no arguments.
    expect(metadata.payload).toMatchObject({ cycleLength: 1, repeatCount: 5, strike: 1 });
    expect(JSON.stringify(metadata.payload)).not.toContain("USDC");

    // Live: the CURRENT turn's next round must read it, or the correction
    // exists only for a turn that already ended.
    const live = liveMessages.at(-1);
    expect(live?.role).toBe("system");
    expect(live?.content).toBe(cue);

    // Ordering: the cue is written after the batch transcript, never before.
    expect(persistBatchTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      definedValue(
        appendEngineMessage.mock.invocationCallOrder[0],
        "appendEngineMessage first invocation order",
      ),
    );
  });
});

describe("strike two - the sixth identical call, on the next turn", () => {
  it("executes, then ends the turn with tool_call_loop and evidence", async () => {
    const detector = createToolCallLoopDetector();
    // Turn 1: five identical calls trip the correction.
    await runBatch({ calls: identicalCalls(5), detector });
    expect(dispatchTool).toHaveBeenCalledTimes(5);

    // Turn 2: the model repeats itself anyway. A fresh batch, the SAME
    // turn-scoped detector - which is the whole reason it is threaded from
    // `runTurnLoop` rather than created per batch.
    vi.clearAllMocks();
    dispatchTool.mockResolvedValue({ success: true, output: "no route found" });
    const outcome = await runBatch({
      calls: [
        { id: "call-6", name: "swap_quote", arguments: { inputMint: "SOL", outputMint: "USDC" } },
        { id: "call-7", name: "other_tool", arguments: {} },
      ],
      detector,
    });

    // The repeat still RAN: it had to, for its result to be observable.
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("engine_stop");
    if (outcome.kind !== "engine_stop") throw new Error("expected engine_stop");
    expect(outcome.stopReason).toBe("tool_call_loop");
    expect(outcome.stopPayload?.evidence).toMatchObject({
      toolName: "swap_quote",
      cycleLength: 1,
      repeatCount: 5,
    });
    // Durable evidence never carries arguments (inference-sensitive).
    expect(JSON.stringify(outcome.stopPayload)).not.toContain("USDC");

    const { executedResults } = persisted();
    expect(executedResults).toHaveLength(2);
    expect(executedResults[1]?.output).toBe(BATCH_ABORTED_BY_TOOL_CALL_LOOP_OUTPUT);
    // No second correction: the cue is spent.
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });
});

describe("precedence - what outranks detection and what is never observed", () => {
  it("an operator Stop mid-batch wins: no detection, no correction", async () => {
    const controller = new AbortController();
    const detector = createToolCallLoopDetector();
    // Four identical calls land first, so the fifth would trip the detector -
    // except the Stop is checked at the top of its iteration.
    dispatchTool.mockImplementation(async () => {
      if (dispatchTool.mock.calls.length >= 4) controller.abort();
      return { success: true, output: "no route found" };
    });

    const outcome = await runBatch({
      calls: identicalCalls(7),
      detector,
      abortSignal: controller.signal,
    });

    expect(outcome.kind).toBe("engine_stop");
    if (outcome.kind !== "engine_stop") throw new Error("expected engine_stop");
    expect(outcome.stopReason).toBe("user_stopped");
    expect(appendEngineMessage).not.toHaveBeenCalled();
    expect(persisted().executedResults.at(-1)?.output)
      .toBe(BATCH_ABORTED_BY_USER_STOP_OUTPUT);
  });

  it("approval breaks are never detector inputs - five identical approvals do not loop", async () => {
    enqueueApprovalIntent.mockResolvedValue({ kind: "enqueued", approvalId: "appr-1" });
    dispatchTool.mockResolvedValue({
      success: false,
      output: "approval required",
      pendingApproval: { actionKind: "read" },
    });

    const detector = createToolCallLoopDetector();
    for (let turn = 0; turn < 5; turn++) {
      const outcome = await runBatch({ calls: identicalCalls(1), detector });
      expect(outcome.kind).toBe("approval_break");
    }
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });

  it("user-form parks are never detector inputs", async () => {
    parkTurnOnUserForm.mockResolvedValue({ kind: "parked" });
    dispatchTool.mockResolvedValue({
      success: true,
      output: "form drafted",
      pendingUserForm: { intentId: "intent-1" },
    });

    const detector = createToolCallLoopDetector();
    for (let turn = 0; turn < 5; turn++) {
      const outcome = await runBatch({ calls: identicalCalls(1), detector });
      expect(outcome.kind).toBe("user_form_pause");
    }
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });

  it("engine signals are never detector inputs - five identical defers do not loop", async () => {
    dispatchTool.mockResolvedValue({
      success: true,
      output: "deferred",
      engineSignal: { type: "defer_until", summary: "later", reason: "waiting", dueAt: null },
    });

    const detector = createToolCallLoopDetector();
    for (let turn = 0; turn < 5; turn++) {
      const outcome = await runBatch({ calls: identicalCalls(1), detector });
      expect(outcome.kind).toBe("waiting_for_wake");
    }
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });

  it("a batch run WITHOUT a detector behaves exactly as before", async () => {
    // The parameter is optional, so every pre-existing call site and test is
    // unaffected: no observation, no correction, no stop.
    const outcome = await processTurnToolBatch({
      context: context(),
      turnResult: { content: null, reasoning: null, toolCalls: identicalCalls(7) },
      liveMessages: [],
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });
    expect(outcome.kind).toBe("normal_complete");
    expect(dispatchTool).toHaveBeenCalledTimes(7);
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });
});

describe("polling is not a loop, inside the batch too", () => {
  it("seven identical calls with CHANGING results all dispatch and nothing fires", async () => {
    let n = 0;
    dispatchTool.mockImplementation(async () => {
      n += 1;
      return { success: true, output: `confirmations: ${n}` };
    });

    const outcome = await runBatch({
      calls: identicalCalls(7),
      detector: createToolCallLoopDetector(),
    });

    expect(dispatchTool).toHaveBeenCalledTimes(7);
    expect(outcome.kind).toBe("normal_complete");
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });
});
