/**
 * Kairos S-1 - lease loss observed INSIDE a tool batch.
 *
 * What is pinned here:
 *   - a lost lease starts NO new dispatch (checked at the top of every call,
 *     after the Stop, plus a token check on the lease row right before each
 *     dispatch);
 *   - a call already in flight when the lease is lost ALWAYS settles, and the
 *     lost signal never reaches the tool (the tool only ever sees the Stop);
 *   - the batch ends on the distinct `lease_lost` stop, never `user_stopped`;
 *   - an operator Stop outranks lease loss, so Stop semantics are unchanged;
 *   - the batch transcript goes out as ONE fenced write, and a refused write
 *     (the lease was taken over) affects nothing and never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import type { EngineContext } from "@vex-agent/engine/types.js";
import type {
  LeaseFence,
  LeaseFenceOutcome,
  LeaseFenceSite,
  LeaseFenceState,
} from "@vex-agent/db/lease-fence.js";
import { fakeLeaseHandle } from "../../../helpers/lease-guard.js";
import { testPoolClient } from "../../../helpers/pool-client.js";

const dispatchTool = vi.fn();
const addMessageReturningId = vi.fn();
const readLeaseFenceState = vi.fn<() => Promise<LeaseFenceState>>();
const withLeaseFenceSpy = vi.fn<(site: LeaseFenceSite) => void>();
let fenceRefuses = false;

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...args: unknown[]) => dispatchTool(...args),
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
    if (fenceRefuses) return { fenced: false, state: "taken_over" };
    return { fenced: true, state: "held", value: await fn(testPoolClient({})) };
  },
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);
const {
  BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
} = await import(
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

function toolCalls(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `call-${i}`,
    name: `tool_${i}`,
    arguments: {},
  }));
}

async function runBatch(guard: Handle, abortSignal?: AbortSignal) {
  return processTurnToolBatch({
    context: context(guard),
    turnResult: { content: null, reasoning: null, toolCalls: toolCalls(3) },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

/** Contents written by the batch's ONE fenced transaction, in order. */
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
  fenceRefuses = false;
  rowId = 0;
  readLeaseFenceState.mockResolvedValue("held");
  dispatchTool.mockResolvedValue({ success: true, output: "ok" });
  addMessageReturningId.mockImplementation(async () => {
    rowId += 1;
    return { id: rowId, role: "assistant", content: "", timestamp: new Date().toISOString() };
  });
});

describe("processTurnToolBatch - lease loss (S-1)", () => {
  it("dispatches the whole batch and writes it in ONE fenced transaction while the lease holds", async () => {
    const outcome = await runBatch(fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" }));

    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(readLeaseFenceState).toHaveBeenCalledTimes(3);
    expect(outcome.kind).toBe("normal_complete");
    expect(withLeaseFenceSpy).toHaveBeenCalledTimes(1);
    expect(withLeaseFenceSpy).toHaveBeenCalledWith("tool_batch_transcript");
    // Assistant row + three results, all inside that one transaction.
    expect(addMessageReturningId).toHaveBeenCalledTimes(4);
  });

  it("starts NO dispatch once the lease is lost, and ends on lease_lost (not user_stopped)", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    guard.markLost("taken_over", "heartbeat");

    const outcome = await runBatch(guard);

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
    // Taken over: the fence refuses locally, nothing is written.
    expect(addMessageReturningId).not.toHaveBeenCalled();
  });

  it("the pre-dispatch token check refuses a NEW call when another claim holds the row", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    readLeaseFenceState.mockResolvedValue("taken_over");

    const outcome = await runBatch(guard);

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(guard.lostReason()).toBe("taken_over");
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
  });

  it("lets a call IN FLIGHT settle, never hands it the lost signal, and dispatches nothing after it", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    const seenSignals: Array<AbortSignal | undefined> = [];
    dispatchTool.mockImplementation(async (_call: unknown, toolContext: { abortSignal?: AbortSignal }) => {
      seenSignals.push(toolContext.abortSignal);
      // The lease is lost WHILE this call is running.
      guard.markLost("released", "heartbeat");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { success: true, output: "in-flight completed" };
    });

    const outcome = await runBatch(guard);

    expect(dispatchTool).toHaveBeenCalledTimes(1);
    // The tool never saw an aborted signal: lease loss is not the Stop.
    expect(seenSignals).toEqual([undefined]);
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
    // Released (not taken over): the closing write is still offered to the fence.
    expect(writtenContents()).toEqual([
      "",
      "in-flight completed",
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
      BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
    ]);
  });

  it("an operator Stop outranks lease loss - Stop semantics are unchanged", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    guard.markLost("released", "heartbeat");
    const stop = new AbortController();
    stop.abort();

    const outcome = await runBatch(guard, stop.signal);

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
    expect(writtenContents()).toEqual([
      "",
      BATCH_ABORTED_BY_USER_STOP_OUTPUT,
      BATCH_ABORTED_BY_USER_STOP_OUTPUT,
      BATCH_ABORTED_BY_USER_STOP_OUTPUT,
    ]);
  });

  it("a fenced write refused after a takeover affects nothing and never throws into the loop", async () => {
    const guard = fakeLeaseHandle({ ownerId: "runner-a", sessionId: "session-1" });
    fenceRefuses = true;

    const outcome = await runBatch(guard);

    expect(outcome.kind).toBe("normal_complete");
    expect(addMessageReturningId).not.toHaveBeenCalled();
    // The refusal marks the guard lost, so the loop ends on its next check.
    expect(guard.lostReason()).toBe("taken_over");
    expect(guard.lostSignal.aborted).toBe(true);
  });
});
