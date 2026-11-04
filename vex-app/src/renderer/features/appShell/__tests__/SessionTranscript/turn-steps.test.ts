/**
 * THE TURN'S THINKING ROW AND ITS STEPS (`turnSteps.ts`,
 * docs/design/H3-DESKTOP.md Appendix A.7: "{n} steps" on a turn reopened
 * from history). Pure: the count is what a reader can count in the turn's
 * rows, and only whole turns get one.
 */

import { describe, expect, it } from "vitest";
import { entrySteps, turnThinkingHeads } from "../../SessionTranscript/turnSteps.js";
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
  it("puts the whole turn's count on its first row that carries a trace", () => {
    const heads = turnThinkingHeads([
      user(10),
      call(11, null, 1),
      call(12, "quote it", 1),
      assistant(13, "done thinking"),
      user(20),
      assistant(21, null),
    ]);
    // Turn one: 2 tool calls and 2 traces; its thinking row is the first row
    // with a trace (12), not the prose-less row without one (11).
    expect(heads.get("t-12")).toEqual({ steps: 4, anchorId: 10 });
    expect(heads.has("t-11")).toBe(false);
    expect(heads.has("13")).toBe(false);
    // Turn two has no trace, so it has no thinking row at all.
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
    expect(heads.get("11")).toEqual({ steps: 1, anchorId: 10 });
  });
});
