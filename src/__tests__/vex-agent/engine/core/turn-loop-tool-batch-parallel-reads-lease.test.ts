/**
 * Kairos T-1 x S-1: lease loss inside a PARALLEL read segment.
 *
 * Pinned here:
 *   - the fenced token check runs immediately before EVERY call the segment
 *     starts, exactly as it does per call on the serial path;
 *   - a lease lost while reads are in flight starts nothing new, the in-flight
 *     reads settle (the lost signal never reaches them) and are recorded
 *     truthfully, and the batch ends on `lease_lost`;
 *   - the transcript still goes out as ONE fenced write in which every call
 *     of the full batch is paired with exactly one result, in call order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import type { EngineContext } from "@vex-agent/engine/types.js";
import type {
  LeaseFence,
  LeaseFenceOutcome,
  LeaseFenceSite,
  LeaseFenceState,
} from "@vex-agent/db/lease-fence.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { fakeLeaseHandle } from "../../../helpers/lease-guard.js";
import { testPoolClient } from "../../../helpers/pool-client.js";

interface DispatchRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId: string;
}

const dispatchTool = vi.fn<
  (req: DispatchRequest, ctx: { abortSignal?: AbortSignal }) => Promise<ToolResult>
>();
const addMessageReturningId = vi.fn();
const readLeaseFenceState = vi.fn<() => Promise<LeaseFenceState>>();
const withLeaseFenceSpy = vi.fn<(site: LeaseFenceSite) => void>();

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (req: DispatchRequest, ctx: { abortSignal?: AbortSignal }) => dispatchTool(req, ctx),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/execute.js", () => ({
  buildToolContext: (
    context: Record<string, unknown>,
    _band: unknown,
    _bypass: unknown,
    abortSignal: AbortSignal | undefined,
  ) => ({ ...context, abortSignal, approved: false, contextUsageBand: "normal" }),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js", () => ({
  assertApprovalActionKind: () => "read",
  enqueueApprovalIntent: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/messages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addMessageReturningId: (...args: unknown[]) => addMessageReturningId(...args),
}));
vi.mock("@vex-agent/db/lease-fence.js", () => ({
  readLeaseFenceState: () => readLeaseFenceState(),
  logFencedWriteRefused: () => {},
  withLeaseFence: async <T>(
    _fence: LeaseFence,
    fn: (client: PoolClient) => Promise<T>,
    opts: { readonly site: LeaseFenceSite },
  ): Promise<LeaseFenceOutcome<T>> => {
    withLeaseFenceSpy(opts.site);
    return { fenced: true, state: "held", value: await fn(testPoolClient({})) };
  },
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);
const { BATCH_ABORTED_BY_LEASE_LOST_OUTPUT } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/results.js"
);

type Handle = ReturnType<typeof fakeLeaseHandle>;

function context(leaseGuard: Handle): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "full",
    missionId: "mission-1",
    missionRunId: "run-1",
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    leaseGuard,
  };
}

/** Four distinct allowlisted reads. */
const READS = ["a", "b", "c", "d"].map((id) => ({
  id,
  name: "UnitsConvert",
  arguments: { tag: id },
}));

async function runBatch(guard: Handle) {
  return processTurnToolBatch({
    context: context(guard),
    turnResult: { content: null, reasoning: null, toolCalls: READS },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
  });
}

function writtenContents(): string[] {
  return addMessageReturningId.mock.calls.map((call) => {
    const msg: unknown = call[1];
    return typeof msg === "object" && msg !== null && "content" in msg
      ? String(msg.content)
      : "";
  });
}

let rowId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  rowId = 0;
  vi.stubEnv("AGENT_TOOL_READ_CONCURRENCY", "2");
  readLeaseFenceState.mockResolvedValue("held");
  dispatchTool.mockImplementation(async (req) => ({
    success: true,
    output: `result:${req.toolCallId}`,
  }));
  addMessageReturningId.mockImplementation(async () => {
    rowId += 1;
    return { id: rowId, role: "assistant", content: "", timestamp: new Date().toISOString() };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parallel read segment - lease fencing", () => {
  it("checks the lease token before every call it starts and writes ONE fenced transcript", async () => {
    const outcome = await runBatch(fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" }));

    expect(outcome.kind).toBe("normal_complete");
    expect(dispatchTool).toHaveBeenCalledTimes(4);
    expect(readLeaseFenceState).toHaveBeenCalledTimes(4);
    expect(withLeaseFenceSpy).toHaveBeenCalledTimes(1);
    expect(withLeaseFenceSpy).toHaveBeenCalledWith("tool_batch_transcript");
    expect(writtenContents()).toEqual(["", "result:a", "result:b", "result:c", "result:d"]);
  });

  it("a lease lost mid-segment starts nothing new; in-flight reads settle and are recorded", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    const seenSignals: Array<AbortSignal | undefined> = [];
    dispatchTool.mockImplementation(async (req, ctx) => {
      seenSignals.push(ctx.abortSignal);
      if (req.toolCallId === "b") guard.markLost("released", "heartbeat");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { success: true, output: `result:${req.toolCallId}` };
    });

    const outcome = await runBatch(guard);

    // a and b were in flight together (limit 2); nothing started after the loss.
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    // The lost signal is never handed to a tool.
    expect(seenSignals).toEqual([undefined, undefined]);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
    expect(withLeaseFenceSpy).toHaveBeenCalledTimes(1);
    expect(writtenContents()).toEqual([
      "",
      "result:a",
      "result:b",
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
    ]);
  });

  it("the token check refusing the third call drains it and everything after", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    readLeaseFenceState
      .mockResolvedValueOnce("held")
      .mockResolvedValueOnce("held")
      .mockResolvedValue("released");

    const outcome = await runBatch(guard);

    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(guard.lostReason()).toBe("released");
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
    expect(writtenContents()).toEqual([
      "",
      "result:a",
      "result:b",
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
    ]);
  });
});
