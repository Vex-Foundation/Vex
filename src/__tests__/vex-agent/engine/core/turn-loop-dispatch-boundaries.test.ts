import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerLeaseLostError } from "../../../../vex-agent/engine/runtime/lease-loss.js";

const dispatchTool = vi.fn();
const persistBatchTranscript = vi.fn().mockResolvedValue(undefined);

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
  assertApprovalActionKind: vi.fn(),
  enqueueApprovalIntent: vi.fn(),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", () => ({
  BATCH_ABORTED_BY_COMPACT_OUTPUT: "aborted",
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
  mapBatchOutcome: (args: {
    batchStopReason: string | null;
    toolCallsExecuted: number;
    lastText: string | null;
  }) => args.batchStopReason
    ? {
        kind: "engine_stop",
        stopReason: args.batchStopReason,
        text: args.lastText,
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      }
    : {
        kind: "normal_complete",
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      },
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);

const toolCalls = [
  { id: "call-1", name: "first_tool", arguments: {} },
  { id: "call-2", name: "second_tool", arguments: {} },
];

function run(controls: {
  abortSignal?: AbortSignal;
  leaseSignal?: AbortSignal;
  missionDeadlineMs?: number;
} = {}) {
  return processTurnToolBatch({
    context: {
      sessionId: "session-1",
      sessionKind: "mission",
      sessionPermission: "full",
      missionId: "mission-1",
      missionRunId: "run-1",
      isSubagent: false,
      loadedDocuments: new Map(),
      walletPolicy: { kind: "none" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    turnResult: { content: null, toolCalls },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 128_000,
    lastTextSoFar: null,
    ...controls,
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
});

describe("tool dispatch control boundaries", () => {
  it("does not dispatch later calls after operator Stop", async () => {
    const controller = new AbortController();
    dispatchTool.mockImplementationOnce(async () => {
      controller.abort();
      return { success: true, output: "first completed" };
    });

    const outcome = await run({ abortSignal: controller.signal });

    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: "engine_stop",
      stopReason: "user_stopped",
      toolCallsExecuted: 1,
    });
    expect(persistBatchTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        executedCalls: [expect.objectContaining({ id: "call-1" })],
        executedResults: [expect.objectContaining({ output: "first completed" })],
      }),
    );
  });

  it("does not dispatch later calls after the hard deadline", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-21T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    const deadline = startedAt.getTime() + 1_000;
    dispatchTool.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline);
      return { success: true, output: "first completed" };
    });

    const outcome = await run({ missionDeadlineMs: deadline });

    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: "engine_stop",
      stopReason: "deadline_reached",
      toolCallsExecuted: 1,
    });
  });

  it("persists completed calls then exits without finalizing when the lease is lost", async () => {
    const leaseController = new AbortController();
    dispatchTool.mockImplementationOnce(async () => {
      leaseController.abort(new RunnerLeaseLostError("session-1"));
      return { success: true, output: "first completed" };
    });

    await expect(run({ leaseSignal: leaseController.signal })).rejects.toBeInstanceOf(
      RunnerLeaseLostError,
    );

    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(persistBatchTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        executedCalls: [expect.objectContaining({ id: "call-1" })],
        executedResults: [expect.objectContaining({ output: "first completed" })],
      }),
    );
  });

  it("discards a model batch when ownership was already lost", async () => {
    const leaseController = new AbortController();
    leaseController.abort(new RunnerLeaseLostError("session-1"));

    await expect(run({ leaseSignal: leaseController.signal })).rejects.toBeInstanceOf(
      RunnerLeaseLostError,
    );

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(persistBatchTranscript).not.toHaveBeenCalled();
  });
});
