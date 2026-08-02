/**
 * Transcript-integrity — orphan tool_call repair (in-flight, chronological).
 */

import { describe, it, expect } from "vitest";
import {
  TOOL_RESULT_PLACEHOLDER_CONTENT,
  repairOrphanedToolCalls,
} from "../../../../vex-agent/engine/core/transcript-integrity.js";
import type { ProviderMessage } from "../../../../vex-agent/inference/types.js";

function user(content: string): ProviderMessage {
  return { role: "user", content };
}

function assistantWithCalls(callIds: string[], text = ""): ProviderMessage {
  return {
    role: "assistant",
    content: text,
    toolCalls: callIds.map((id) => ({ id, command: "noop", args: {} })),
  };
}

function toolResult(callId: string, content = "ok"): ProviderMessage {
  return { role: "tool", content, toolCallId: callId };
}

describe("repairOrphanedToolCalls", () => {
  it("is a no-op for clean text-only sequences", () => {
    const input: ProviderMessage[] = [
      { role: "system", content: "sys" },
      user("hi"),
      { role: "assistant", content: "hello" },
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(0);
    expect(out.messages).toEqual(input);
  });

  it("is a no-op when tool_calls are followed by matching tool results", () => {
    const input: ProviderMessage[] = [
      user("go"),
      assistantWithCalls(["c1", "c2"]),
      toolResult("c1"),
      toolResult("c2"),
      { role: "assistant", content: "done" },
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(0);
    expect(out.messages).toEqual(input);
  });

  it("synthesises placeholders adjacent to the assistant when the next msg is user", () => {
    // The repro: hydrate appended a fresh user message AFTER the orphan
    // assistant turn, so the orphan is no longer trailing.
    const input: ProviderMessage[] = [
      user("first"),
      assistantWithCalls(["c1", "c2"]),
      user("second"),
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(2);
    expect(out.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(out.messages[2].toolCallId).toBe("c1");
    expect(out.messages[2].content).toBe(TOOL_RESULT_PLACEHOLDER_CONTENT);
    expect(out.messages[3].toolCallId).toBe("c2");
  });

  it("handles partial orphans (one matched, one missing)", () => {
    const input: ProviderMessage[] = [
      assistantWithCalls(["c1", "c2"]),
      toolResult("c1"),
      user("next"),
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(1);
    // c1 result kept in original position; c2 placeholder inserted after.
    expect(out.messages.map((m) => ({ role: m.role, id: m.toolCallId }))).toEqual([
      { role: "assistant", id: undefined },
      { role: "tool", id: "c1" },
      { role: "tool", id: "c2" },
      { role: "user", id: undefined },
    ]);
  });

  it("repairs multiple orphans in a single message array", () => {
    const input: ProviderMessage[] = [
      assistantWithCalls(["a"]),
      user("after-a"),
      assistantWithCalls(["b"]),
      user("after-b"),
      assistantWithCalls(["c"], "with content"),
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(3);
    // Each placeholder lands right after its assistant.
    expect(out.messages.map((m) => m.role)).toEqual([
      "assistant", "tool",
      "user",
      "assistant", "tool",
      "user",
      "assistant", "tool",
    ]);
  });

  it("preserves assistant content when both content and tool_calls are present", () => {
    const input: ProviderMessage[] = [assistantWithCalls(["c1"], "thinking…")];
    const out = repairOrphanedToolCalls(input);
    expect(out.insertedPlaceholders).toBe(1);
    expect(out.messages[0].content).toBe("thinking…");
    expect(out.messages[1].toolCallId).toBe("c1");
  });

  it("assigns a synthetic id to a blank tool_call and still answers it", () => {
    // Previously a blank id was skipped, which left the provider with an
    // unanswerable call. Normalization now gives it a real id, so the orphan
    // walk can synthesize its placeholder.
    const input: ProviderMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "", command: "noop", args: {} },
          { id: "real", command: "noop", args: {} },
        ],
      },
      user("after"),
    ];
    const out = repairOrphanedToolCalls(input);
    expect(out.assignedBlankIds).toBe(1);
    expect(out.insertedPlaceholders).toBe(2);
    const assigned = out.messages[0].toolCalls?.[0].id ?? "";
    expect(assigned).toMatch(/^call_vex_b\d+_c\d+$/);
    expect(out.messages[1].toolCallId).toBe(assigned);
    expect(out.messages[2].toolCallId).toBe("real");
  });

  it("returns a fresh array; input is not mutated", () => {
    const input: ProviderMessage[] = [assistantWithCalls(["c1"])];
    const original = JSON.parse(JSON.stringify(input));
    repairOrphanedToolCalls(input);
    expect(input).toEqual(original);
  });
});

describe("repairOrphanedToolCalls — tool-call id normalization", () => {
  it("composes an id rewrite with placeholder synthesis", () => {
    const input: ProviderMessage[] = [
      assistantWithCalls(["fc_2"]),
      toolResult("fc_2"),
      user("again"),
      // Duplicate id AND no result at all: both repairs must fire together.
      assistantWithCalls(["fc_2"]),
      user("end"),
    ];
    const out = repairOrphanedToolCalls(input);

    expect(out.rewrittenDuplicateIds).toBe(1);
    expect(out.insertedPlaceholders).toBe(1);
    const rewritten = out.messages[3].toolCalls?.[0].id ?? "";
    expect(rewritten).not.toBe("fc_2");
    expect(out.messages[4]).toMatchObject({
      role: "tool",
      toolCallId: rewritten,
      content: TOOL_RESULT_PLACEHOLDER_CONTENT,
    });
    expect(out.messages[5]).toMatchObject({ role: "user", content: "end" });
  });

  it("reports sourceMessageIndexes: original index per row, null per placeholder", () => {
    const input: ProviderMessage[] = [
      user("go"),
      assistantWithCalls(["c1"]),
      user("next"),
    ];
    const out = repairOrphanedToolCalls(input);

    expect(out.sourceMessageIndexes).toHaveLength(out.messages.length);
    expect(out.sourceMessageIndexes).toEqual([0, 1, null, 2]);
  });

  it("maps a rewritten row back to its ORIGINAL input index", () => {
    const input: ProviderMessage[] = [
      assistantWithCalls(["dup", "dup"]),
      toolResult("dup", "A"),
      toolResult("dup", "B"),
    ];
    const out = repairOrphanedToolCalls(input);

    expect(out.rewrittenDuplicateIds).toBe(1);
    expect(out.insertedPlaceholders).toBe(0);
    expect(out.sourceMessageIndexes).toEqual([0, 1, 2]);
  });

  it("is a no-op on a clean tape (zero counts, identical bytes)", () => {
    const input: ProviderMessage[] = [
      user("go"),
      assistantWithCalls(["c1", "c2"]),
      toolResult("c1"),
      toolResult("c2"),
    ];
    const out = repairOrphanedToolCalls(input);

    expect(out.rewrittenDuplicateIds).toBe(0);
    expect(out.assignedBlankIds).toBe(0);
    expect(out.insertedPlaceholders).toBe(0);
    expect(JSON.stringify(out.messages)).toBe(JSON.stringify(input));
  });
});
