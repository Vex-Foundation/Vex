/**
 * THE TURN'S TRACE HEAD AND ITS STEPS (`turnSteps.ts`,
 * docs/design/H3-DESKTOP.md section 1.7 and Appendix A.7: "{n} steps" on a
 * turn reopened from history). Pure: the count is what a reader can count in
 * the turn's rows, the head stands on the turn's first step, and only whole
 * turns get one.
 */

import { describe, expect, it } from "vitest";
import {
  entrySteps,
  foldsWhole,
  turnThinkingHeads,
  turnTraces,
} from "../../SessionTranscript/turnSteps.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

const ISO = "2026-11-03T14:29:00.000Z";

function user(id: number): TranscriptEntry {
  return { id, variant: "user", label: null, content: "ask", createdAt: ISO };
}

function assistant(id: number, reasoning: string | null): TranscriptEntry {
  return { id, variant: "assistant", label: null, content: "answer", createdAt: ISO, reasoning };
}

function call(id: number, reasoning: string | null, calls: number): TranscriptEntry {
  return {
    id,
    variant: "tool",
    toolKind: "call",
    label: null,
    content: "",
    createdAt: ISO,
    reasoning,
    toolActs: Array.from({ length: calls }, (_, i) => ({
      toolCallId: `c${String(id)}-${String(i)}`,
      toolName: "wallet_balances",
      toolArgs: null,
      output: null,
    })),
  };
}

describe("entrySteps", () => {
  it("counts each persisted trace and each tool call, and nothing else", () => {
    expect(entrySteps(assistant(1, "thought"))).toBe(1);
    expect(entrySteps(assistant(1, null))).toBe(0);
    expect(entrySteps(assistant(1, ""))).toBe(0);
    expect(entrySteps(call(2, "why", 2))).toBe(3);
    expect(entrySteps(call(2, null, 1))).toBe(1);
    expect(
      entrySteps({ id: 3, variant: "tool", toolKind: "result", label: null, content: "x", createdAt: ISO }),
    ).toBe(1);
    expect(
      entrySteps({
        variant: "tool_group",
        id: 4,
        createdAt: ISO,
        distinctToolNames: ["a"],
        calls: [
          { toolCallId: "a", toolName: "a", toolArgs: null, output: null },
          { toolCallId: "b", toolName: "a", toolArgs: null, output: null },
        ],
        reasonings: ["one", ""],
      }),
    ).toBe(3);
    expect(
      entrySteps({ id: 5, variant: "notice", label: null, content: "n", createdAt: ISO }),
    ).toBe(0);
  });
});

describe("turnThinkingHeads", () => {
  it("puts the whole turn's count on its first row that carries a step", () => {
    const heads = turnThinkingHeads([
      user(10),
      call(11, null, 1),
      call(12, "quote it", 1),
      assistant(13, "done thinking"),
      user(20),
      assistant(21, null),
    ]);
    // Turn one: 2 tool calls and 2 traces; its head stands on its first step,
    // the prose-less call row (11), though that row has no trace: a turn that
    // only called tools still has its head (VEX Cloud's trace).
    expect(heads.get("t-11")).toEqual({ steps: 4, anchorId: 10, outcome: "completed" });
    expect(heads.has("t-12")).toBe(false);
    expect(heads.has("13")).toBe(false);
    // Turn two has no step at all, so it has no head.
    expect(heads.has("21")).toBe(false);
    expect(heads.size).toBe(1);
  });

  it("gives no count to the part of a turn whose opening message is not loaded", () => {
    const heads = turnThinkingHeads([
      assistant(5, "an older turn's tail"),
      user(10),
      assistant(11, "this turn"),
    ]);
    expect(heads.has("5")).toBe(false);
    expect(heads.get("11")).toEqual({ steps: 1, anchorId: 10, outcome: "completed" });
  });

  it("says a stopped turn and a failed turn, which never fold", () => {
    const stopped: TranscriptEntry = {
      id: 13,
      variant: "assistant_stopped",
      label: null,
      content: "half",
      createdAt: ISO,
      reasoning: null,
    };
    const error: TranscriptEntry = {
      id: 23,
      variant: "notice",
      noticeTone: "error",
      label: null,
      content: "provider failed",
      createdAt: ISO,
    };
    const heads = turnThinkingHeads([
      user(10),
      call(11, "why", 1),
      stopped,
      user(20),
      call(21, null, 2),
      error,
    ]);
    expect(heads.get("t-11")?.outcome).toBe("stopped");
    expect(heads.get("t-21")?.outcome).toBe("failed");
  });
});

describe("turnTraces", () => {
  it("knows the turn of every row of a whole turn, and the newest turn", () => {
    const traces = turnTraces([
      assistant(5, "older"),
      user(10),
      call(11, null, 1),
      assistant(12, "x"),
      user(20),
    ]);
    expect(traces.turnOf.has("5")).toBe(false);
    expect(traces.turnOf.get("t-11")).toBe(10);
    expect(traces.turnOf.get("12")).toBe(10);
    expect(traces.lastAnchorId).toBe(20);
  });
});

describe("foldsWhole", () => {
  it("is a row of nothing but steps: a prose-less call row, an orphan result, a fold", () => {
    expect(foldsWhole(call(11, "why", 2))).toBe(true);
    expect(
      foldsWhole({ id: 3, variant: "tool", toolKind: "result", label: null, content: "x", createdAt: ISO }),
    ).toBe(true);
    expect(
      foldsWhole({
        variant: "tool_group",
        id: 4,
        createdAt: ISO,
        distinctToolNames: ["a"],
        calls: [{ toolCallId: "a", toolName: "a", toolArgs: null, output: null }],
      }),
    ).toBe(true);
  });

  it("keeps a row with prose, or one whose act carries a mission result", () => {
    expect(foldsWhole({ ...call(11, null, 1), content: "Checking." } as TranscriptEntry)).toBe(false);
    expect(foldsWhole(assistant(12, "t"))).toBe(false);
    expect(foldsWhole(user(13))).toBe(false);
  });
});
