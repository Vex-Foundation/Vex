/**
 * A first-time Lighter trader moves from the status tool directly into the
 * desktop setup dialog. This test protects the important negative behavior:
 * no second tool and no second inference round may run after the handoff.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchTool = vi.fn();
const mockAppendMessage = vi.fn().mockResolvedValue({
  id: 1,
  role: "assistant",
  content: "",
  timestamp: new Date().toISOString(),
});
const mockEmitLighterSetupRequested = vi.fn();

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...args: unknown[]) => mockDispatchTool(...args),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
  appendEngineMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
  streamDeltaBus: { emit: vi.fn(), subscribe: vi.fn(), size: vi.fn(), clear: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/messages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addMessage: (...args: unknown[]) => mockAppendMessage(...args),
  addMessageReturningId: (...args: unknown[]) => mockAppendMessage(...args),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/engine/runtime/lighter-setup-bus.js", () => ({
  emitLighterSetupRequested: (...args: unknown[]) =>
    mockEmitLighterSetupRequested(...args),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) => fn({}),
  ),
}));

const { processTurnToolBatch } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch.js"
);
const { applyToolBatchOutcome } = await import(
  "@vex-agent/engine/core/turn-loop/tool-batch-step.js"
);

function context(sessionKind: "agent" | "mission" = "agent") {
  return {
    sessionId: "session-lighter-setup",
    missionId: sessionKind === "mission" ? "mission-1" : null,
    missionRunId: sessionKind === "mission" ? "run-1" : null,
    sessionPermission: "restricted",
    sessionKind,
  } as never;
}

function batch(...names: string[]) {
  return {
    content: null,
    reasoning: null,
    toolCalls: names.map((name, index) => ({
      id: `call_${index}`,
      name,
      arguments: {},
    })),
  } as never;
}

function handoffResult() {
  return {
    success: true,
    output: "Live status: the Core trading key is not registered.",
    data: {
      environment: "core",
      tradingKeyRegistered: false,
    },
    lighterSetupHandoff: { environment: "core" as const },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lighter setup turn handoff", () => {
  it("persists the status, drains later calls, then emits the desktop request", async () => {
    mockDispatchTool.mockResolvedValueOnce(handoffResult());

    const outcome = await processTurnToolBatch({
      context: context(),
      turnResult: batch("lighter_core_onboarding_status", "WalletBalances"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      kind: "lighter_setup_handoff",
      toolCallsExecuted: 1,
    });

    const toolRows = mockAppendMessage.mock.calls.filter((call) => {
      const message = call[1] as { role?: string } | undefined;
      return message?.role === "tool";
    });
    expect(toolRows).toHaveLength(2);
    expect((toolRows[0]?.[1] as { content: string }).content).toContain(
      "trading key is not registered",
    );
    expect((toolRows[1]?.[1] as { content: string }).content).toContain(
      "batch_aborted_by_lighter_setup",
    );
    expect(mockEmitLighterSetupRequested).toHaveBeenCalledWith({
      sessionId: "session-lighter-setup",
      environment: "core",
    });
    expect(
      mockEmitLighterSetupRequested.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockAppendMessage.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it("does not divert a mission into the desktop modal", async () => {
    mockDispatchTool
      .mockResolvedValueOnce(handoffResult())
      .mockResolvedValueOnce({ success: true, output: "second completed" });

    const outcome = await processTurnToolBatch({
      context: context("mission"),
      turnResult: batch("lighter_core_onboarding_status", "WalletBalances"),
      liveMessages: [] as never,
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(mockDispatchTool).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("normal_complete");
    expect(mockEmitLighterSetupRequested).not.toHaveBeenCalled();
  });

  it("ends the agent turn with no redundant assistant response", async () => {
    const step = await applyToolBatchOutcome({
      batchOutcome: {
        kind: "lighter_setup_handoff",
        toolCallsExecuted: 1,
        lastText: "I will explain the setup.",
      },
      sessionId: "session-lighter-setup",
      missionRunId: null,
      sessionPermission: "restricted",
      runnerOwnerId: undefined,
      currentTokenCount: 0,
      contextLimit: 100_000,
      totalToolCalls: 1,
      pendingApprovals: [],
      lastText: "I will explain the setup.",
      handlePostCompactBookkeeping: vi.fn(),
      mergeOperatorInstructions: vi.fn(),
    });

    expect(step).toEqual({
      kind: "return",
      result: {
        text: null,
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: null,
      },
    });
  });
});
