/**
 * B-1 honest idle, at the text-response boundary.
 *
 * A mission run that already called `LoopDefer` in this slice, and whose wake
 * is pending, ends the slice on its next text reply: no continue cue, and a
 * `deferred_idle` outcome the turn loop parks on. Everything else keeps the
 * continue cue, so real work still continues:
 *   - no `LoopDefer` this slice (no wake read at all);
 *   - a `LoopDefer` that scheduled nothing (no pending wake);
 *   - a pending wake that belongs to a different run;
 *   - an operator instruction that arrived with the reply;
 *   - a wake read that fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@vex-agent/db/repos/messages.js";
import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import { makeEngineContext } from "../_engine-context.js";

const appendMessage = vi.fn().mockResolvedValue({ id: 1 });
const appendEngineMessage = vi.fn().mockResolvedValue({ id: 2 });
const getPendingForSession = vi.fn<(sessionId: string) => Promise<LoopWakeRequest | null>>();

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => appendMessage(...args),
  appendEngineMessage: (...args: unknown[]) => appendEngineMessage(...args),
  appendMessagesUnderLease: vi.fn(),
  streamDeltaBus: { emit: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  getPendingForSession: (sessionId: string) => getPendingForSession(sessionId),
}));

const { handleTextResponse, MISSION_CONTINUE_CUE } =
  await import("../../../../vex-agent/engine/core/turn-loop-text-response.js");

const SESSION = "session-honest-idle";
const RUN = "run-1";

function wake(overrides: Partial<LoopWakeRequest> = {}): LoopWakeRequest {
  return {
    id: "wake-1",
    sessionId: SESSION,
    missionRunId: RUN,
    dueAt: "2026-09-29T12:00:00.000Z",
    status: "pending",
    reason: "waiting for the bridge fill",
    payload: null,
    createdAt: "2026-09-29T11:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    ...overrides,
  };
}

function cueCount(tape: readonly Message[]): number {
  return tape.filter((m) => m.role === "system" && m.content === MISSION_CONTINUE_CUE).length;
}

async function reply(options: {
  loopDeferCalledThisSlice?: boolean;
  merge?: (tape: Message[]) => Promise<void>;
} = {}) {
  const tape: Message[] = [];
  const merge = options.merge ?? (async () => undefined);
  const outcome = await handleTextResponse({
    context: makeEngineContext({ sessionId: SESSION, missionRunId: RUN }),
    liveMessages: tape,
    content: "Nothing to do until the bridge fills.",
    reasoning: null,
    mergeOperatorInstructions: () => merge(tape),
    ...(options.loopDeferCalledThisSlice === undefined
      ? {}
      : { loopDeferCalledThisSlice: options.loopDeferCalledThisSlice }),
  });
  return { outcome, tape };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMessage.mockResolvedValue({ id: 1 });
  appendEngineMessage.mockResolvedValue({ id: 2 });
  getPendingForSession.mockResolvedValue(null);
});

describe("mission honest idle (B-1)", () => {
  it("after LoopDefer with this run's wake pending, text ends the slice with no continue cue", async () => {
    getPendingForSession.mockResolvedValue(wake());
    const { outcome, tape } = await reply({ loopDeferCalledThisSlice: true });

    expect(outcome).toEqual({
      kind: "deferred_idle",
      wake: { dueAt: "2026-09-29T12:00:00.000Z", reason: "waiting for the bridge fill" },
    });
    expect(appendEngineMessage).not.toHaveBeenCalled();
    expect(cueCount(tape)).toBe(0);
    // The reply itself is still saved.
    expect(tape.map((m) => m.role)).toEqual(["assistant"]);
    expect(getPendingForSession).toHaveBeenCalledWith(SESSION);
  });

  it("without a LoopDefer this slice, no wake is read and the run continues with the cue", async () => {
    getPendingForSession.mockResolvedValue(wake());
    for (const flag of [undefined, false]) {
      vi.clearAllMocks();
      const { outcome, tape } = await reply({ loopDeferCalledThisSlice: flag });
      expect(outcome.kind).toBe("mission_run_continue");
      expect(cueCount(tape)).toBe(1);
      expect(getPendingForSession).not.toHaveBeenCalled();
    }
  });

  it("a LoopDefer that scheduled nothing leaves no pending wake, so real work continues", async () => {
    getPendingForSession.mockResolvedValue(null);
    const { outcome, tape } = await reply({ loopDeferCalledThisSlice: true });
    expect(outcome.kind).toBe("mission_run_continue");
    expect(cueCount(tape)).toBe(1);
  });

  it("a pending wake of a different run does not park this one", async () => {
    getPendingForSession.mockResolvedValue(wake({ missionRunId: "run-other" }));
    const { outcome } = await reply({ loopDeferCalledThisSlice: true });
    expect(outcome.kind).toBe("mission_run_continue");
  });

  it("an operator instruction that arrived with the reply is new work and wins over parking", async () => {
    getPendingForSession.mockResolvedValue(wake());
    const { outcome, tape } = await reply({
      loopDeferCalledThisSlice: true,
      merge: async (live) => {
        live.push({ role: "user", content: "sell half now", timestamp: "t1" });
      },
    });
    expect(outcome.kind).toBe("mission_run_continue");
    expect(cueCount(tape)).toBe(1);
    expect(getPendingForSession).not.toHaveBeenCalled();
  });

  it("a failed wake read keeps the continue cue instead of parking on an unverified wake", async () => {
    getPendingForSession.mockRejectedValue(new Error("db down"));
    const { outcome, tape } = await reply({ loopDeferCalledThisSlice: true });
    expect(outcome.kind).toBe("mission_run_continue");
    expect(cueCount(tape)).toBe(1);
  });

  it("chat text is untouched by the flag: it still ends the loop and reads no wake", async () => {
    const tape: Message[] = [];
    const outcome = await handleTextResponse({
      context: makeEngineContext({ sessionId: SESSION }),
      liveMessages: tape,
      content: "done",
      reasoning: null,
      mergeOperatorInstructions: async () => undefined,
      loopDeferCalledThisSlice: true,
    });
    expect(outcome.kind).toBe("break_on_text");
    expect(getPendingForSession).not.toHaveBeenCalled();
  });
});
