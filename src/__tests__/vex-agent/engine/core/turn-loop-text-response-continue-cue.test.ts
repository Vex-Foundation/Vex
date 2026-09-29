/**
 * The mission continue cue does not pile up.
 *
 * An active mission run does not end on text: every text-only reply is
 * followed by the `[Engine: continue ...]` system cue. Before, each reply
 * appended a fresh cue, so a run of text replies left one cue per reply in
 * the persisted transcript and in the live tape, all re-sent every round.
 *
 * Pinned here:
 *   - consecutive text replies leave exactly ONE cue (persisted and live);
 *   - the cue is still there, so the model is still told to continue, and
 *     the loop still continues on every reply;
 *   - real work in between (a tool round, an operator instruction) earns a
 *     fresh cue, because the old one is no longer the latest instruction;
 *   - a lost lease still writes no cue and ends on `lease_lost`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@vex-agent/db/repos/messages.js";
import { createRunnerLeaseGuard } from "@vex-agent/engine/runtime/lease-guard.js";
import { makeEngineContext } from "../_engine-context.js";

const appendMessage = vi.fn().mockResolvedValue({ id: 1 });
const appendEngineMessage = vi.fn().mockResolvedValue({ id: 2 });
const appendMessagesUnderLease = vi.fn();

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => appendMessage(...args),
  appendEngineMessage: (...args: unknown[]) => appendEngineMessage(...args),
  appendMessagesUnderLease: (...args: unknown[]) => appendMessagesUnderLease(...args),
  streamDeltaBus: { emit: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

const { handleTextResponse, MISSION_CONTINUE_CUE, tailAlreadyCarriesContinueCue } =
  await import("../../../../vex-agent/engine/core/turn-loop-text-response.js");

const SESSION = "session-continue-cue";

function missionContext() {
  return makeEngineContext({ sessionId: SESSION, missionRunId: "run-1" });
}

function cueRows(tape: readonly Message[]): Message[] {
  return tape.filter(m => m.role === "system" && m.content === MISSION_CONTINUE_CUE);
}

function persistedCueCount(): number {
  return appendEngineMessage.mock.calls.filter(call => call[1] === MISSION_CONTINUE_CUE)
    .length;
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMessage.mockResolvedValue({ id: 1 });
  appendEngineMessage.mockResolvedValue({ id: 2 });
});

describe("mission continue cue", () => {
  it("three consecutive text replies leave ONE cue and every reply continues", async () => {
    const tape: Message[] = [];
    for (const content of ["first", "second", "third"]) {
      const outcome = await handleTextResponse({
        context: missionContext(),
        liveMessages: tape,
        content,
        reasoning: null,
        mergeOperatorInstructions: vi.fn().mockResolvedValue(undefined),
      });
      expect(outcome.kind).toBe("mission_run_continue");
    }

    expect(persistedCueCount()).toBe(1);
    expect(cueRows(tape)).toHaveLength(1);
    // The persisted cue carries the same engine metadata as before.
    expect(appendEngineMessage).toHaveBeenCalledWith(SESSION, MISSION_CONTINUE_CUE, {
      source: "engine",
      messageType: "continue",
      visibility: "internal",
    });
    // Every reply is still saved; only the redundant cues are gone.
    expect(tape.map(m => m.role)).toEqual(["assistant", "system", "assistant", "assistant"]);
  });

  it("keeps the cue in the tape the model reads after the first reply", async () => {
    const tape: Message[] = [];
    await handleTextResponse({
      context: missionContext(),
      liveMessages: tape,
      content: "status update",
      reasoning: null,
      mergeOperatorInstructions: vi.fn().mockResolvedValue(undefined),
    });

    const last = tape.at(-1);
    expect(last?.role).toBe("system");
    expect(last?.content).toBe(MISSION_CONTINUE_CUE);
  });

  it("writes a fresh cue after tool work since the last one", async () => {
    const tape: Message[] = [
      { role: "assistant", content: "earlier", timestamp: "t0" },
      { role: "system", content: MISSION_CONTINUE_CUE, timestamp: "t1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", command: "WalletBalance", args: {} }],
        timestamp: "t2",
      },
      { role: "tool", content: "{}", toolCallId: "c1", timestamp: "t3" },
    ];

    await handleTextResponse({
      context: missionContext(),
      liveMessages: tape,
      content: "balance checked",
      reasoning: null,
      mergeOperatorInstructions: vi.fn().mockResolvedValue(undefined),
    });

    expect(persistedCueCount()).toBe(1);
    expect(tape.at(-1)?.content).toBe(MISSION_CONTINUE_CUE);
  });

  it("writes a fresh cue when an operator instruction was merged after the last one", async () => {
    const tape: Message[] = [
      { role: "assistant", content: "earlier", timestamp: "t0" },
      { role: "system", content: MISSION_CONTINUE_CUE, timestamp: "t1" },
    ];

    await handleTextResponse({
      context: missionContext(),
      liveMessages: tape,
      content: "noted",
      reasoning: null,
      mergeOperatorInstructions: async () => {
        tape.push({ role: "system", content: "[Operator] stop buying", timestamp: "t2" });
      },
    });

    expect(persistedCueCount()).toBe(1);
    expect(tape.at(-1)?.content).toBe(MISSION_CONTINUE_CUE);
    expect(cueRows(tape)).toHaveLength(2);
  });

  it("a lost lease writes no cue and ends on lease_lost", async () => {
    const leaseGuard = createRunnerLeaseGuard({
      ownerId: "owner-a",
      fence: { sessionId: SESSION, claimToken: "token-a" },
    });
    // The fenced assistant save is where the takeover is seen.
    appendMessagesUnderLease.mockImplementationOnce(async () => {
      leaseGuard.markLost("taken_over", "fence");
      return null;
    });
    const merge = vi.fn().mockResolvedValue(undefined);
    const tape: Message[] = [];

    const outcome = await handleTextResponse({
      context: makeEngineContext({ sessionId: SESSION, missionRunId: "run-1", leaseGuard }),
      liveMessages: tape,
      content: "interim",
      reasoning: null,
      mergeOperatorInstructions: merge,
    });

    expect(outcome.kind).toBe("lease_lost");
    expect(appendEngineMessage).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(cueRows(tape)).toHaveLength(0);
  });

  it("chat text still ends the loop without a cue", async () => {
    const tape: Message[] = [];
    const outcome = await handleTextResponse({
      context: makeEngineContext({ sessionId: SESSION }),
      liveMessages: tape,
      content: "done",
      reasoning: null,
      mergeOperatorInstructions: vi.fn().mockResolvedValue(undefined),
    });

    expect(outcome.kind).toBe("break_on_text");
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });
});

describe("tailAlreadyCarriesContinueCue", () => {
  it("is false on an empty tape and on a tape ending in a user message", () => {
    expect(tailAlreadyCarriesContinueCue([])).toBe(false);
    expect(
      tailAlreadyCarriesContinueCue([
        { role: "system", content: MISSION_CONTINUE_CUE, timestamp: "t0" },
        { role: "user", content: "go", timestamp: "t1" },
      ]),
    ).toBe(false);
  });

  it("looks past text-only assistant rows to the cue", () => {
    expect(
      tailAlreadyCarriesContinueCue([
        { role: "system", content: MISSION_CONTINUE_CUE, timestamp: "t0" },
        { role: "assistant", content: "a", timestamp: "t1" },
        { role: "assistant", content: "b", timestamp: "t2" },
      ]),
    ).toBe(true);
  });
});
