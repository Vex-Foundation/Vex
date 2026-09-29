/**
 * Kairos S-1, end to end on a real (disposable, testcontainers) Postgres: a
 * runner's lease is STOLEN while one of its tools is in flight.
 *
 * Only the tool dispatcher (and the tool-context builder it is handed) is
 * faked. The lease row, the claim tokens, the heartbeat's loss detection
 * (`createLeaseHandle` with a hand-fired timer), the FOR SHARE write fence and
 * the transcript writes are all real.
 *
 * Proven:
 *   - the in-flight call settles and is never handed an aborted signal;
 *   - the old runner starts NO further tool and ends the batch on `lease_lost`;
 *   - every write the old runner attempts afterwards affects zero rows,
 *     including the batch transcript that would have recorded the in-flight
 *     result and a late append issued after the batch ended;
 *   - the new owner's own batch dispatches every call and its fenced
 *     transcript write lands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "@vex-agent/engine/types.js";
import type { LeaseHandle } from "@vex-agent/engine/runtime/lease-handle.js";

const dispatchTool = vi.fn();

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

const client = await import("@vex-agent/db/client.js");
const leases = await import("@vex-agent/db/repos/runner-leases.js");
const { createLeaseHandle } = await import("@vex-agent/engine/runtime/lease-handle.js");
const events = await import("@vex-agent/engine/events/index.js");
const { processTurnToolBatch } = await import("@vex-agent/engine/core/turn-loop-tool-batch.js");
const { makeSession, resetDb } = await import("../setup/fixtures.js");

const TTL_MS = 60_000;

function manualTimer() {
  let callback: (() => void) | null = null;
  return {
    timer: {
      setInterval: (cb: () => void, _ms: number): ReturnType<typeof setInterval> => {
        callback = cb;
        return setInterval(() => undefined, 2 ** 30);
      },
      clearInterval: (handle: ReturnType<typeof setInterval>): void => {
        clearInterval(handle);
        callback = null;
      },
    },
    fire: (): void => {
      if (callback === null) throw new Error("heartbeat not armed");
      callback();
    },
  };
}

async function claimWithHandle(sessionId: string, ownerId: string) {
  const lease = await leases.acquireLease({ sessionId, ownerId, processKind: "test", ttlMs: TTL_MS });
  if (lease === null) throw new Error(`expected ${ownerId} to claim the lease`);
  const clock = manualTimer();
  const handle = createLeaseHandle({ lease, ownerId, ttlMs: TTL_MS, timer: clock.timer });
  return { lease, handle, clock };
}

function context(sessionId: string, leaseGuard: LeaseHandle): EngineContext {
  return {
    sessionId,
    sessionKind: "agent",
    sessionPermission: "full",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    leaseGuard,
  };
}

function toolCalls(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-call-${i}`,
    name: `tool_${i}`,
    arguments: {},
  }));
}

async function runBatch(sessionId: string, guard: LeaseHandle, prefix: string) {
  return processTurnToolBatch({
    context: context(sessionId, guard),
    turnResult: { content: null, reasoning: null, toolCalls: toolCalls(prefix, 3) },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
  });
}

async function messages(sessionId: string): Promise<Array<{ role: string; content: string | null }>> {
  return client.query<{ role: string; content: string | null }>(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id",
    [sessionId],
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe("lease stolen mid-turn (disposable Postgres)", () => {
  it("the old runner starts no new tool and writes nothing; the new owner proceeds", async () => {
    const db = await client.queryOne<{ name: string }>("SELECT current_database() AS name");
    // Disposable testcontainers database only, never the owner's app DB.
    expect(db?.name).toBe("vex_test");

    const sessionId = await makeSession();
    const runnerA = await claimWithHandle(sessionId, "runner-a");
    const stolen: { runnerB: Awaited<ReturnType<typeof claimWithHandle>> | null } = { runnerB: null };
    const signalAbortedAtSettle: boolean[] = [];

    // Call 0 of runner A is in flight when the lease is stolen: A's claim
    // expires, B takes it over, and A's own heartbeat discovers the loss.
    dispatchTool.mockImplementationOnce(async (_call: unknown, toolContext: { abortSignal?: AbortSignal }) => {
      await client.execute(
        "UPDATE runner_leases SET expires_at = NOW() - interval '1 second' WHERE session_id = $1",
        [sessionId],
      );
      stolen.runnerB = await claimWithHandle(sessionId, "runner-b");
      runnerA.clock.fire();
      await vi.waitFor(() => {
        expect(runnerA.handle.lostReason()).toBe("taken_over");
      }, { timeout: 5_000, interval: 20 });
      signalAbortedAtSettle.push(toolContext.abortSignal?.aborted ?? false);
      return { success: true, output: "in-flight completed" };
    });

    const outcomeA = await runBatch(sessionId, runnerA.handle, "a");

    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(signalAbortedAtSettle).toEqual([false]);
    expect(outcomeA).toMatchObject({ kind: "engine_stop", stopReason: "lease_lost" });
    expect(runnerA.handle.lostSignal.aborted).toBe(true);
    // Taken over: the batch transcript (assistant row + results) is refused.
    expect(await messages(sessionId)).toEqual([]);

    // A late write from the stale runner after the batch ended: zero rows.
    const late = await events.appendMessagesUnderLease(
      sessionId,
      [{
        msg: { role: "assistant", content: "late stale write", timestamp: new Date().toISOString() },
        metadata: { source: "assistant", messageType: "chat", visibility: "user" },
      }],
      runnerA.handle,
      "tool_batch_transcript",
    );
    expect(late).toBeNull();
    expect(await messages(sessionId)).toEqual([]);

    // A's release presents its (stale) token: B's row survives.
    await runnerA.handle.release();
    const b = stolen.runnerB;
    if (b === null) throw new Error("runner B never claimed");
    expect(b.lease.tookOver).toBe(true);
    expect((await leases.getLease(sessionId))?.ownerId).toBe("runner-b");

    // The new owner proceeds: every call dispatched, its transcript lands.
    dispatchTool.mockResolvedValue({ success: true, output: "b ok" });
    const outcomeB = await runBatch(sessionId, b.handle, "b");
    expect(outcomeB.kind).toBe("normal_complete");
    expect(dispatchTool).toHaveBeenCalledTimes(4);
    const written = await messages(sessionId);
    expect(written.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "tool"]);
    expect(written.slice(1).map((m) => m.content)).toEqual(["b ok", "b ok", "b ok"]);
    expect(b.handle.lostReason()).toBeNull();
    await b.handle.release();
    expect(await leases.getLease(sessionId)).toBeNull();
  });
});
