/**
 * M6 - the durable, typed acknowledgement of an operator instruction.
 *
 * What this replaced: `QUEUED_INTERRUPT_TEXT`, one paragraph returned as
 * `TurnResult.text` from three ingress branches with three different meanings.
 * It was not durable (a reload lost it), not distinguishable (the branch that
 * had actually preempted a scheduled wake and resumed the run said the same
 * words as the branch that had merely saved a row onto an errored run), and
 * anything downstream that wanted to know what happened could only have
 * compared prose.
 *
 * What is pinned here:
 *   - the disposition is a TYPED value on the instruction row's own payload -
 *     an existing JSONB column, no schema change anywhere;
 *   - the engine's acknowledgement is a durable, USER-visible engine notice
 *     row, not assistant text, one per instruction row;
 *   - both rows commit in ONE transaction, and BOTH events are emitted only
 *     after that commit returns - an acknowledgement without its instruction
 *     would tell the operator the agent has a message that nothing has;
 *   - each disposition says something DIFFERENT about when the agent reads it,
 *     which is the fact the single paragraph could not tell the truth about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendMessage = vi.fn();
const appendEngineMessage = vi.fn();
const emitTranscriptAppend = vi.fn();
const withTransaction = vi.fn();

vi.mock("@vex-agent/engine/events/index.js", () => ({
  TRANSCRIPT_APPEND_EVENT_TYPE: "engine.transcript.append",
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  appendEngineMessage: (...a: unknown[]) => appendEngineMessage(...a),
  emitTranscriptAppend: (...a: unknown[]) => emitTranscriptAppend(...a),
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: (...a: unknown[]) => withTransaction(...a),
}));
vi.mock("@vex-agent/db/repos/messages.js", () => ({
  getOperatorInstructionsAfter: vi.fn(),
}));

const {
  OPERATOR_INSTRUCTION_ACK_MESSAGE_TYPE,
  OPERATOR_INTERRUPT_MESSAGE_TYPE,
  addOperatorInstruction,
} = await import("../../../../vex-agent/engine/core/operator-instructions.js");

const CLIENT = { fake: "client" };

interface AppendCall {
  readonly sessionId: string;
  readonly content: string;
  readonly metadata: {
    source?: string;
    messageType?: string;
    visibility?: string;
    payload?: Record<string, unknown>;
  };
  readonly opts?: { client?: unknown };
}

function instructionCall(): AppendCall {
  const [sessionId, msg, metadata, opts] = appendMessage.mock.calls[0] as [
    string, { content: string }, AppendCall["metadata"], AppendCall["opts"],
  ];
  return { sessionId, content: msg.content, metadata, opts };
}

function ackCall(): AppendCall {
  const [sessionId, content, metadata, opts] = appendEngineMessage.mock.calls[0] as [
    string, string, AppendCall["metadata"], AppendCall["opts"],
  ];
  return { sessionId, content, metadata, opts };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMessage.mockResolvedValue({ id: 11, role: "user", timestamp: "2026-08-28T00:00:00.000Z" });
  appendEngineMessage.mockResolvedValue({ id: 12, role: "system", timestamp: "2026-08-28T00:00:01.000Z" });
  withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));
});

describe("addOperatorInstruction - the instruction row", () => {
  it("carries the typed disposition on its payload", async () => {
    await addOperatorInstruction("s1", "steer this", "steered", { target: "agent_turn" });

    const call = instructionCall();
    expect(call.metadata.messageType).toBe(OPERATOR_INTERRUPT_MESSAGE_TYPE);
    expect(call.metadata.payload).toMatchObject({
      operatorInstruction: true,
      target: "agent_turn",
      disposition: "steered",
    });
  });

  it("a caller-supplied `disposition` in the free-form payload cannot override the typed one", async () => {
    // The whole point of the typed argument is that it is the single answer.
    // A loose fourth value arriving through the context bag is exactly the
    // drift this field exists to end.
    await addOperatorInstruction("s1", "x", "queued_interrupt", {
      disposition: "definitely_delivered",
    });

    expect(instructionCall().metadata.payload?.["disposition"]).toBe("queued_interrupt");
  });
});

describe("addOperatorInstruction - the acknowledgement row", () => {
  it("is a USER-visible engine notice, never assistant prose", async () => {
    await addOperatorInstruction("s1", "x", "steered");

    const ack = ackCall();
    expect(ack.metadata.source).toBe("engine");
    expect(ack.metadata.messageType).toBe(OPERATOR_INSTRUCTION_ACK_MESSAGE_TYPE);
    // The agent did not say this; the runtime did. A user-visible engine row
    // renders as a runtime notice, not as a turn from the model.
    expect(ack.metadata.visibility).toBe("user");
    expect(ack.metadata.messageType).not.toBe(OPERATOR_INTERRUPT_MESSAGE_TYPE);
  });

  it("is emitted exactly once per instruction row", async () => {
    await addOperatorInstruction("s1", "x", "steered");
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendEngineMessage).toHaveBeenCalledTimes(1);
  });

  it("says something DIFFERENT for each disposition, and names the typed value", async () => {
    const texts = new Map<string, string>();
    for (const disposition of ["steered", "queued_interrupt", "preempted_wake"] as const) {
      vi.clearAllMocks();
      appendMessage.mockResolvedValue({ id: 11, role: "user", timestamp: "t" });
      appendEngineMessage.mockResolvedValue({ id: 12, role: "system", timestamp: "t" });
      withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));

      await addOperatorInstruction("s1", "x", disposition);
      const ack = ackCall();
      texts.set(disposition, ack.content);
      // Every channel derives from the typed value, never from prose.
      expect(ack.metadata.payload).toMatchObject({ disposition });
    }

    expect(new Set(texts.values()).size).toBe(3);
    // The two claims that must not be confused: one promises the agent is
    // mid-turn, the other admits it is not running.
    expect(texts.get("steered")).toContain("mid-turn");
    expect(texts.get("queued_interrupt")).toContain("not running a turn");
    expect(texts.get("preempted_wake")).toContain("resuming now");
  });
});

describe("both rows, one transaction, events after the commit", () => {
  it("writes both rows on the SAME client inside one withTransaction", async () => {
    await addOperatorInstruction("s1", "x", "queued_interrupt");

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(instructionCall().opts?.client).toBe(CLIENT);
    expect(ackCall().opts?.client).toBe(CLIENT);
  });

  it("emits one event per row, and only after the transaction resolves", async () => {
    let committed = false;
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const value = await fn(CLIENT);
      expect(emitTranscriptAppend).not.toHaveBeenCalled();
      committed = true;
      return value;
    });

    await addOperatorInstruction("s1", "x", "steered");

    expect(committed).toBe(true);
    expect(emitTranscriptAppend).toHaveBeenCalledTimes(2);
    expect(emitTranscriptAppend.mock.calls.map(([e]) => (e as { messageId: number }).messageId))
      .toEqual([11, 12]);
  });

  it("emits NOTHING when the transaction fails - no phantom acknowledgement", async () => {
    // An event implies a row a reader can fetch. Telling the operator their
    // message was delivered when the write rolled back is the worst available
    // failure, so the throw reaches the caller instead.
    withTransaction.mockRejectedValue(new Error("db down"));

    await expect(addOperatorInstruction("s1", "x", "steered")).rejects.toThrow("db down");
    expect(emitTranscriptAppend).not.toHaveBeenCalled();
  });
});

/**
 * The classifier, as a truth table. It is the ONE place `steered` may be
 * decided, and both ingress routes now defer to it - they used to disagree
 * with each other in opposite directions on the same session.
 */
describe("classifyOperatorInterruptDisposition", () => {
  it("says steered ONLY for executing work with a live matching lease", async () => {
    const { classifyOperatorInterruptDisposition } = await import(
      "@vex-agent/engine/core/operator-instructions.js"
    );
    const cases: ReadonlyArray<
      [string | null, boolean, "steered" | "queued_interrupt"]
    > = [
      // A live mission run whose runner holds the lease: the loop merges it.
      ["running", true, "steered"],
      // `running` is a ROW STATUS. With a dead lease it is the crashed-runner
      // state the restart-orphan sweep reclaims, and nothing is alive to merge.
      ["running", false, "queued_interrupt"],
      // An agent session has no run row; the lease is the whole question.
      [null, true, "steered"],
      [null, false, "queued_interrupt"],
      // Parked states. A live lease does not make a parked run executing - it
      // is held for work that is waiting on a human or a clock.
      ["paused_approval", true, "queued_interrupt"],
      ["paused_approval", false, "queued_interrupt"],
      ["paused_error", true, "queued_interrupt"],
      ["paused_error", false, "queued_interrupt"],
      ["paused_wake", true, "queued_interrupt"],
      ["paused_user", true, "queued_interrupt"],
      ["paused_user_form", true, "queued_interrupt"],
      ["paused_plan_acceptance", true, "queued_interrupt"],
    ];
    for (const [runStatus, hasLiveMatchingLease, expected] of cases) {
      expect(
        classifyOperatorInterruptDisposition({ runStatus, hasLiveMatchingLease }),
      ).toBe(expected);
    }
  });

  /**
   * `preempted_wake` is a fact about an ACTION that won its race, not a
   * derivation from state. Only the code that performed the claim and saw it
   * succeed may assert it - deriving it from `paused_wake` would claim a
   * preempt that may have lost.
   */
  it("never produces preempted_wake from state alone", async () => {
    const { classifyOperatorInterruptDisposition } = await import(
      "@vex-agent/engine/core/operator-instructions.js"
    );
    for (const runStatus of [null, "running", "paused_wake", "paused_error"]) {
      for (const hasLiveMatchingLease of [true, false]) {
        expect(
          classifyOperatorInterruptDisposition({
            runStatus,
            hasLiveMatchingLease,
          }),
        ).not.toBe("preempted_wake");
      }
    }
  });
});
