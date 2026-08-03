/**
 * Wall-clock bounds observed INSIDE a tool batch.
 *
 * Before this, both bounds were sampled only at iteration boundaries, and one
 * iteration is a model turn plus its ENTIRE parallel tool batch — so a batch of
 * slow DEX/RPC calls overshot the turn timeout (and the mission's contract
 * deadline) by an unbounded margin.
 *
 * What is pinned here:
 *   - overshoot is bounded to ONE tool call, not the whole batch;
 *   - a call already in flight ALWAYS completes (never checked mid-dispatch) —
 *     the signing/broadcast rule, identical to operator Stop;
 *   - undispatched calls are drained with synthetic results so the
 *     tool_call/tool_result pairing survives a reload (mirrors the abort drain);
 *   - an operator Stop outranks an expired bound;
 *   - the mission's contract deadline outranks the turn's slice guard, because
 *     `timeout` schedules a continuation and `deadline_reached` must not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  evaluateBatchDeadlines,
  type BatchDeadlines,
} from "@vex-agent/engine/core/turn-loop-tool-batch/deadline.js";

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
  assertApprovalActionKind: () => "read",
  enqueueApprovalIntent: vi.fn(),
}));
// Only the DB write is stubbed — the real synthetic-output constants and the
// real `mapBatchOutcome` stay in play, so this asserts production behaviour
// rather than a re-implementation of it.
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (
  importOriginal,
) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);
const {
  BATCH_ABORTED_BY_DEADLINE_OUTPUT,
  BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
} = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/results.js"
);

// ── Pure evaluation ────────────────────────────────────────────

describe("evaluateBatchDeadlines", () => {
  const base: BatchDeadlines = {
    turnTimeoutAtMs: 1_000,
    missionDeadlineAtMs: null,
  };

  it("returns null while both bounds are in the future", () => {
    expect(evaluateBatchDeadlines(base, 999)).toBeNull();
  });

  it("is inclusive at the boundary (>=, matching the iteration-entry guard)", () => {
    expect(evaluateBatchDeadlines(base, 1_000)).toEqual({ kind: "turn_timeout" });
  });

  it("returns null when no bounds were threaded (setup / legacy callers)", () => {
    expect(evaluateBatchDeadlines(undefined, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("reports the mission deadline when BOTH have passed", () => {
    expect(
      evaluateBatchDeadlines(
        { turnTimeoutAtMs: 1_000, missionDeadlineAtMs: 500 },
        2_000,
      ),
    ).toEqual({ kind: "mission_deadline" });
  });

  it("reports the turn timeout when only it has passed", () => {
    expect(
      evaluateBatchDeadlines(
        { turnTimeoutAtMs: 1_000, missionDeadlineAtMs: 9_000 },
        1_500,
      ),
    ).toEqual({ kind: "turn_timeout" });
  });
});

// ── Behaviour inside the batch ─────────────────────────────────

function context() {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "full",
    missionId: "mission-1",
    missionRunId: "run-1",
    loadedDocuments: new Map(),
    walletPolicy: { kind: "none" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function toolCalls(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `call-${i}`,
    name: `tool_${i}`,
    arguments: {},
  }));
}

async function runBatch(args: {
  deadlines?: BatchDeadlines;
  abortSignal?: AbortSignal;
  calls?: number;
}) {
  return processTurnToolBatch({
    context: context(),
    turnResult: {
      content: null,
      reasoning: null,
      toolCalls: toolCalls(args.calls ?? 3),
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
    ...(args.abortSignal !== undefined ? { abortSignal: args.abortSignal } : {}),
    ...(args.deadlines !== undefined ? { deadlines: args.deadlines } : {}),
  });
}

/** The synthetic outputs the batch drained, in order. */
function drainedOutputs(): string[] {
  const call = persistBatchTranscript.mock.calls[0];
  if (call === undefined) throw new Error("persistBatchTranscript not called");
  const { executedResults } = call[0] as {
    executedResults: Array<{ output: string }>;
  };
  return executedResults.map((r) => r.output);
}

function pairingIsBalanced(): boolean {
  const call = persistBatchTranscript.mock.calls[0];
  const { executedCalls, executedResults } = call![0] as {
    executedCalls: unknown[];
    executedResults: unknown[];
  };
  return executedCalls.length === executedResults.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
  dispatchTool.mockResolvedValue({ success: true, output: "ok" });
});

describe("processTurnToolBatch — wall-clock bounds", () => {
  it("dispatches the whole batch while both bounds are in the future", async () => {
    const outcome = await runBatch({
      deadlines: {
        turnTimeoutAtMs: Date.now() + 60_000,
        missionDeadlineAtMs: null,
      },
    });

    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(outcome.kind).toBe("normal_complete");
  });

  it("stops the batch on an expired turn timeout and drains the rest", async () => {
    const outcome = await runBatch({
      deadlines: { turnTimeoutAtMs: Date.now() - 1, missionDeadlineAtMs: null },
    });

    // Nothing was dispatched: the FIRST call already saw the expired bound.
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "timeout" });
    expect(drainedOutputs()).toEqual([
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
    ]);
    expect(pairingIsBalanced()).toBe(true);
  });

  it("uses `deadline_reached` (not `timeout`) for an expired mission deadline", async () => {
    const outcome = await runBatch({
      deadlines: {
        turnTimeoutAtMs: Date.now() + 60_000,
        missionDeadlineAtMs: Date.now() - 1,
      },
    });

    expect(outcome).toMatchObject({
      kind: "engine_stop",
      stopReason: "deadline_reached",
    });
    expect(drainedOutputs()).toEqual([
      BATCH_ABORTED_BY_DEADLINE_OUTPUT,
      BATCH_ABORTED_BY_DEADLINE_OUTPUT,
      BATCH_ABORTED_BY_DEADLINE_OUTPUT,
    ]);
  });

  it("bounds the overshoot to ONE call — a call in flight always completes", async () => {
    // The bound expires DURING the first dispatch. That call must still finish
    // and be persisted truthfully; the second must never start.
    const deadlineAt = Date.now() + 20;
    dispatchTool.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { success: true, output: "in-flight completed" };
    });

    const outcome = await runBatch({
      calls: 2,
      deadlines: { turnTimeoutAtMs: deadlineAt, missionDeadlineAtMs: null },
    });

    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "timeout" });
    expect(drainedOutputs()).toEqual([
      "in-flight completed",
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
    ]);
    expect(pairingIsBalanced()).toBe(true);
  });

  it("an operator Stop outranks an expired bound", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await runBatch({
      abortSignal: controller.signal,
      deadlines: { turnTimeoutAtMs: Date.now() - 1, missionDeadlineAtMs: null },
    });

    expect(outcome).toMatchObject({
      kind: "engine_stop",
      stopReason: "user_stopped",
    });
    expect(drainedOutputs().every((o) => o === BATCH_ABORTED_BY_USER_STOP_OUTPUT))
      .toBe(true);
  });

  it("callers that thread no bounds are unaffected", async () => {
    const outcome = await runBatch({});

    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(outcome.kind).toBe("normal_complete");
  });
});
