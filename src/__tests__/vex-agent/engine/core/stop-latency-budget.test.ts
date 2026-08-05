/**
 * T1 — the owner's stop-latency decree, made executable.
 *
 * > Stop must abort everything push-based within about one second, with exactly
 * > one exception: a sign→broadcast→persist window runs to completion.
 *
 * Before the cancellation contract, a Stop pressed while a tool was running
 * could not land until the tool returned on its own — the batch only polled the
 * signal BETWEEN calls. The worst measured read-side case was a khalani order
 * poll at 24 × 5 s, so this test failed by roughly 120 seconds.
 *
 * What is real here, deliberately: `buildToolContext` (the injection site),
 * `dispatchTool` (the catch branch that classifies the abort), the
 * `TOOL_ABORTED_BY_USER_STOP_OUTPUT` constant, and `processTurnToolBatch`
 * itself. Only the TOOL is a double — it stands in for any handler that awaits
 * a read, a poll, a sleep, or a quota wait.
 *
 * REAL TIMERS, on purpose. `delay(ms, signal)` is backed by
 * `node:timers/promises`, which vitest's fake timers do not intercept — so the
 * assertion is on real elapsed wall clock, which is also exactly what the
 * decree is written in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { delay } from "@utils/cancellation.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { EngineContext } from "@vex-agent/engine/types.js";
import { makeEngineContext } from "../_engine-context.js";

const persistBatchTranscript = vi.fn().mockResolvedValue(undefined);

/**
 * The tool under test: it does what every interruptible handler does — take the
 * turn's signal from its context and hand it to a wait.
 */
const routeToolCall = vi.fn(async (_call: unknown, context: InternalToolContext) => {
  await delay(120_000, context.abortSignal);
  return { success: true, output: "the tool ran to completion" };
});

vi.mock("@vex-agent/tools/dispatcher/protocol-route.js", () => ({
  routeToolCall: (...args: [unknown, InternalToolContext]) => routeToolCall(...args),
  toModelDiscoveryResult: (r: unknown) => r,
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js", () => ({
  assertApprovalActionKind: () => "read",
  enqueueApprovalIntent: vi.fn(),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch.js"
);
const { TOOL_ABORTED_BY_USER_STOP_OUTPUT } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch/results.js"
);
const { buildToolContext } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch/execute.js"
);

function engineContext(): EngineContext {
  return makeEngineContext({ sessionId: "session-1", sessionPermission: "full" });
}

/** The executed (not drained) results the batch persisted, in order. */
function executedOutputs(): string[] {
  const call = persistBatchTranscript.mock.calls[0];
  if (call === undefined) throw new Error("persistBatchTranscript not called");
  const { executedResults } = call[0] as { executedResults: Array<{ output: string }> };
  return executedResults.map((r) => r.output);
}

beforeEach(() => {
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
});

describe("buildToolContext — the injection site", () => {
  it("hands the turn's signal to the tool, and only when there is one", () => {
    const controller = new AbortController();
    expect(buildToolContext(engineContext(), "normal", false, controller.signal))
      .toMatchObject({ abortSignal: controller.signal });

    // ABSENT means "no cancellation", never "cancelled" — the key is omitted
    // rather than set to `undefined`.
    expect(buildToolContext(engineContext(), "normal", false, undefined))
      .not.toHaveProperty("abortSignal");
  });
});

describe("operator Stop while a tool is running", () => {
  it("lands in well under a second, not when the tool's own 120s wait expires", async () => {
    const controller = new AbortController();
    // The Stop arrives once the tool is genuinely in flight, so this exercises
    // the mid-dispatch path rather than the pre-dispatch boundary poll.
    const stopPress = setTimeout(() => { controller.abort(); }, 20);
    const startedAt = Date.now();

    const outcome = await processTurnToolBatch({
      context: engineContext(),
      turnResult: {
        content: null,
        reasoning: null,
        toolCalls: [{ id: "call-0", name: "slow_read", arguments: {} }],
      },
      liveMessages: [],
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
      abortSignal: controller.signal,
    });

    clearTimeout(stopPress);
    const elapsedMs = Date.now() - startedAt;

    // THE DECREE. The tool's own wait was 120_000 ms; measured here at 28 ms.
    expect(elapsedMs).toBeLessThan(1_000);

    // The tool really was dispatched — this is a cancellation, not a skip.
    expect(routeToolCall).toHaveBeenCalledTimes(1);

    // And it reports itself truthfully: not "Tool slow_read failed: The
    // operation was aborted", which is the generic label the truthful-error
    // decree exists to kill.
    expect(executedOutputs()).toEqual([TOOL_ABORTED_BY_USER_STOP_OUTPUT]);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
  });

  it("leaves a batch with no Stop completely unaffected", async () => {
    routeToolCall.mockImplementationOnce(async () => ({ success: true, output: "ok" }));

    const outcome = await processTurnToolBatch({
      context: engineContext(),
      turnResult: {
        content: null,
        reasoning: null,
        toolCalls: [{ id: "call-0", name: "fast_read", arguments: {} }],
      },
      liveMessages: [],
      currentTokenCount: 0,
      contextLimit: 100_000,
      lastTextSoFar: null,
    });

    expect(executedOutputs()).toEqual(["ok"]);
    expect(outcome.kind).toBe("normal_complete");
  });
});
