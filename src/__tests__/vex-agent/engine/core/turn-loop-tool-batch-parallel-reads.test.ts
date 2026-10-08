/**
 * Kairos T-1: consecutive AUDITED parallel-safe reads run concurrently inside
 * one tool batch.
 *
 * Pinned here (only the dispatcher and the DB writes are stubbed; the real
 * allowlist, planner, scheduler, drain constants and `mapBatchOutcome` run):
 *   - results are persisted and returned in the ORIGINAL call order;
 *   - 3 x 300 ms reads take about 300 ms, not about 900 ms (real timers);
 *   - `AGENT_TOOL_READ_CONCURRENCY` and the per-provider caps are honoured;
 *   - a non-allowlisted call is a serial barrier in the middle of reads;
 *   - Stop and the deadline mid-segment start nothing new, in-flight reads
 *     settle and are recorded truthfully, the rest is drained;
 *   - one read failing among N changes nothing for its siblings;
 *   - the loop detector observes results in the original call order;
 *   - each call still records its own timing row;
 *   - `AGENT_TOOL_READ_CONCURRENCY=1` is the previous serial path exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolDispatchTimingRecord } from "@vex-agent/db/repos/runtime-timings.js";
import type { EngineContext } from "@vex-agent/engine/types/engine-context.js";
import type { ToolCallLoopDetector } from "@vex-agent/engine/core/runner/tool-call-loop-detector.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { requireValue } from "../../../helpers/require-value.js";

interface DispatchRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId: string;
}
interface PersistedBatchArg {
  readonly executedCalls: ReadonlyArray<{ readonly id: string }>;
  readonly executedResults: ReadonlyArray<{
    readonly toolCallId: string;
    readonly output: string;
    readonly success: boolean;
  }>;
}

const dispatchTool = vi.fn<(req: DispatchRequest, ctx: unknown) => Promise<ToolResult>>();
const persistBatchTranscript = vi
  .fn<(batch: PersistedBatchArg, ...rest: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);
const insertToolDispatchTiming = vi
  .fn<(record: ToolDispatchTimingRecord) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertToolDispatchTiming: (record: ToolDispatchTimingRecord) => insertToolDispatchTiming(record),
  recordInBackground: (_label: string, write: () => Promise<void>) => {
    void write();
  },
}));
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (req: DispatchRequest, ctx: unknown) => dispatchTool(req, ctx),
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
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (...args: Parameters<typeof persistBatchTranscript>) =>
    persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);
const { planReadSegment } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/read-segment.js"
);
const {
  BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
} = await import("../../../../vex-agent/engine/core/turn-loop-tool-batch/results.js");

function context(): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: "full",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    loadedDocuments: new Map<string, string>(),
    walletPolicy: { kind: "none" },
  };
}

interface Call {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** A read on the allowlist; `delayMs` rides in the args (and makes each call distinct). */
function read(id: string, delayMs: number, name = "UnitsConvert"): Call {
  return { id, name, arguments: { delayMs, tag: id } };
}

/** Timeline of dispatch starts / ends, and the live in-flight high-water mark. */
let events: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
const perName = new Map<string, number>();
const maxPerName = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installTimedDispatch(outcomes: Record<string, Partial<ToolResult>> = {}): void {
  dispatchTool.mockImplementation(async (req) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const load = (perName.get(req.name) ?? 0) + 1;
    perName.set(req.name, load);
    maxPerName.set(req.name, Math.max(maxPerName.get(req.name) ?? 0, load));
    events.push(`start:${req.toolCallId}`);
    const delay = typeof req.args.delayMs === "number" ? req.args.delayMs : 0;
    await sleep(delay);
    events.push(`end:${req.toolCallId}`);
    inFlight -= 1;
    perName.set(req.name, (perName.get(req.name) ?? 1) - 1);
    return {
      success: true,
      output: `result:${req.toolCallId}`,
      actionKind: "read",
      ...outcomes[req.toolCallId],
    };
  });
}

async function runBatch(
  calls: readonly Call[],
  extra: {
    readonly abortSignal?: AbortSignal;
    readonly deadlineInMs?: number;
    readonly loopDetector?: ToolCallLoopDetector;
    readonly telemetry?: { readonly turnRunId: string; readonly iteration: number };
  } = {},
) {
  return processTurnToolBatch({
    context: context(),
    turnResult: { content: null, reasoning: null, toolCalls: [...calls] },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
    ...(extra.abortSignal === undefined ? {} : { abortSignal: extra.abortSignal }),
    ...(extra.deadlineInMs === undefined
      ? {}
      : {
        deadlines: {
          turnTimeoutAtMs: Date.now() + extra.deadlineInMs,
          missionDeadlineAtMs: null,
        },
      }),
    ...(extra.loopDetector === undefined ? {} : { loopDetector: extra.loopDetector }),
    ...(extra.telemetry === undefined ? {} : { telemetry: extra.telemetry }),
  });
}

function persisted(): PersistedBatchArg {
  return requireValue(persistBatchTranscript.mock.calls[0])[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
  events = [];
  inFlight = 0;
  maxInFlight = 0;
  perName.clear();
  maxPerName.clear();
  vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "3");
  installTimedDispatch();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parallel reads - ordering and timing", () => {
  it("persists results in the ORIGINAL call order although they finish in reverse", async () => {
    const outcome = await runBatch([read("a", 90), read("b", 50), read("c", 10)]);

    expect(outcome.kind).toBe("normal_complete");
    expect(outcome.toolCallsExecuted).toBe(3);
    // They really overlapped and finished out of order...
    expect(events.slice(0, 3)).toEqual(["start:a", "start:b", "start:c"]);
    expect(events.slice(3)).toEqual(["end:c", "end:b", "end:a"]);
    // ...and the transcript still pairs them in the model's order.
    const { executedCalls, executedResults } = persisted();
    expect(executedCalls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(executedResults.map((r) => [r.toolCallId, r.output])).toEqual([
      ["a", "result:a"],
      ["b", "result:b"],
      ["c", "result:c"],
    ]);
  });

  it("3 x 300 ms reads take about 300 ms, not about 900 ms", async () => {
    const started = performance.now();
    await runBatch([read("a", 300), read("b", 300), read("c", 300)]);
    const elapsed = performance.now() - started;

    expect(maxInFlight).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(295);
    expect(elapsed).toBeLessThan(600);
  });

  it("with AGENT_TOOL_READ_CONCURRENCY=1 the same reads take about 900 ms, one at a time", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "1");
    const started = performance.now();
    await runBatch([read("a", 300), read("b", 300), read("c", 300)]);
    const elapsed = performance.now() - started;

    expect(maxInFlight).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(895);
  });
});

describe("parallel reads - limits", () => {
  it("honours the batch concurrency limit", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "2");
    await runBatch([read("a", 30), read("b", 30), read("c", 30), read("d", 30), read("e", 30)]);

    expect(maxInFlight).toBe(2);
    expect(dispatchTool).toHaveBeenCalledTimes(5);
    expect(persisted().executedResults.map((r) => r.toolCallId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("honours a per-provider cap below the batch limit (EVM RPC: 2)", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "8");
    await runBatch([
      read("a", 30, "ChainRead"),
      read("b", 30, "ChainRead"),
      read("c", 30, "ChainRead"),
      read("d", 30, "ChainRead"),
    ]);

    expect(maxPerName.get("ChainRead")).toBe(2);
  });

  it("never runs two calls to a cap-1 provider at once (Jupiter)", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "8");
    await runBatch([
      read("a", 20, "solana__token_prices_get"),
      read("b", 20, "solana__token_prices_get"),
      read("c", 20, "solana__token_prices_get"),
    ]);

    expect(maxPerName.get("solana__token_prices_get")).toBe(1);
    expect(persisted().executedResults.map((r) => r.toolCallId)).toEqual(["a", "b", "c"]);
  });
});

describe("parallel reads - barriers", () => {
  it("a non-allowlisted call in the middle is a serial barrier", async () => {
    await runBatch([
      read("a", 40),
      read("b", 20),
      { id: "w", name: "WalletSendPrepare", arguments: { delayMs: 10 } },
      read("c", 20),
      read("d", 40),
    ]);

    expect(events).toEqual([
      "start:a", "start:b", "end:b", "end:a",
      "start:w", "end:w",
      "start:c", "start:d", "end:c", "end:d",
    ]);
    expect(persisted().executedResults.map((r) => r.toolCallId)).toEqual(["a", "b", "w", "c", "d"]);
  });

  it("an identical repeat of a read in the same run is a barrier, so it runs after its twin", async () => {
    const same = { id: "a2", name: "UnitsConvert", arguments: { delayMs: 20, tag: "a" } };
    await runBatch([read("a", 20), same, read("b", 20)]);

    expect(events.slice(0, 2)).toEqual(["start:a", "end:a"]);
    expect(events.slice(2, 4)).toEqual(["start:a2", "start:b"]);
  });

  it("a single read between barriers takes the serial path (no segment of one)", () => {
    expect(planReadSegment([read("a", 0)], 0, 3)).toBeNull();
    expect(
      planReadSegment(
        [read("a", 0), { id: "t", name: "ToolSearch", arguments: {} }, read("b", 0)],
        0,
        3,
      ),
    ).toBeNull();
  });
});

describe("parallel reads - Stop and deadline mid-segment", () => {
  it("a Stop mid-segment starts nothing new; in-flight reads settle and are recorded truthfully", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "2");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 15);

    const outcome = await runBatch(
      [read("a", 40), read("b", 40), read("c", 10), read("d", 10)],
      { abortSignal: stop.signal },
    );

    // Only the two already in flight ran, and both finished.
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["start:a", "start:b", "end:a", "end:b"]);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
    expect(persisted().executedResults.map((r) => r.output)).toEqual([
      "result:a",
      "result:b",
      BATCH_ABORTED_BY_USER_STOP_OUTPUT,
      BATCH_ABORTED_BY_USER_STOP_OUTPUT,
    ]);
  });

  it("a deadline that expires mid-segment drains what has not started", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "2");

    const outcome = await runBatch(
      [read("a", 60), read("b", 60), read("c", 10), read("d", 10)],
      { deadlineInMs: 30 },
    );

    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "timeout" });
    expect(persisted().executedResults.map((r) => r.output)).toEqual([
      "result:a",
      "result:b",
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
      BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
    ]);
  });
});

describe("parallel reads - failures, detector, telemetry", () => {
  it("one read failing among N leaves its siblings and the batch untouched", async () => {
    installTimedDispatch({ b: { success: false, output: "provider 503" } });

    const outcome = await runBatch([read("a", 10), read("b", 5), read("c", 10)]);

    expect(outcome.kind).toBe("normal_complete");
    expect(persisted().executedResults.map((r) => [r.toolCallId, r.success, r.output])).toEqual([
      ["a", true, "result:a"],
      ["b", false, "provider 503"],
      ["c", true, "result:c"],
    ]);
  });

  it("a dispatch that THROWS rethrows only after its in-flight siblings settled, and starts nothing new", async () => {
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "2");
    dispatchTool.mockImplementation(async (req) => {
      events.push(`start:${req.toolCallId}`);
      if (req.toolCallId === "a") throw new Error("boom");
      await sleep(30);
      events.push(`end:${req.toolCallId}`);
      return { success: true, output: `result:${req.toolCallId}` };
    });

    await expect(runBatch([read("a", 0), read("b", 0), read("c", 0)])).rejects.toThrow("boom");

    // `b` was already in flight when `a` rejected: it SETTLED before the
    // rethrow, and `c` never started. Like the serial path, a throwing
    // dispatch ends the batch without a transcript write.
    expect(events).toEqual(["start:a", "start:b", "end:b"]);
    expect(persistBatchTranscript).not.toHaveBeenCalled();
  });

  it("the loop detector observes results in the ORIGINAL call order", async () => {
    const observed: string[] = [];
    const detector: ToolCallLoopDetector = {
      observe: (input) => {
        observed.push(input.toolCallId);
        return { kind: "clear" };
      },
    };

    await runBatch([read("a", 60), read("b", 30), read("c", 5)], { loopDetector: detector });

    expect(events.slice(3)).toEqual(["end:c", "end:b", "end:a"]);
    expect(observed).toEqual(["a", "b", "c"]);
  });

  it("each call records its own tool_dispatch_timings row", async () => {
    await runBatch([read("a", 10), read("b", 10), read("c", 10)], {
      telemetry: { turnRunId: "turn-1", iteration: 2 },
    });

    expect(insertToolDispatchTiming).toHaveBeenCalledTimes(3);
    const rows = insertToolDispatchTiming.mock.calls.map(([row]) => row);
    expect(rows.map((r) => r.toolCallId).sort()).toEqual(["a", "b", "c"]);
    for (const row of rows) {
      expect(row).toMatchObject({ turnRunId: "turn-1", iteration: 2, outcome: "success" });
    }
  });
});

describe("AGENT_TOOL_READ_CONCURRENCY=1 is the previous serial path", () => {
  it("plans no segment at all for any batch", () => {
    const batch = [read("a", 0), read("b", 0), read("c", 0), read("d", 0, "ChainRead")];
    for (let i = 0; i < batch.length; i++) {
      expect(planReadSegment(batch, i, 1)).toBeNull();
    }
  });

  it("dispatches strictly one after another and persists the same transcript as the parallel lane", async () => {
    const batch = [read("a", 20), read("b", 10), read("c", 5)];

    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "1");
    const serialOutcome = await runBatch(batch);
    const serialEvents = [...events];
    const serialTranscript = persisted();

    vi.clearAllMocks();
    events = [];
    installTimedDispatch();
    vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "3");
    const parallelOutcome = await runBatch(batch);

    expect(serialEvents).toEqual([
      "start:a", "end:a", "start:b", "end:b", "start:c", "end:c",
    ]);
    expect(parallelOutcome).toEqual(serialOutcome);
    expect(persisted()).toEqual(serialTranscript);
  });
});
