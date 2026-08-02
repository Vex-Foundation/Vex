/**
 * Tape-wide tool-call id integrity.
 *
 * A provider rejects a request whose tool-call ids repeat ("Duplicate item
 * found with id fc_2") or are blank. Vex persists and replays whatever ids a
 * provider gave it, with no uniqueness validation, so one bad turn poisons
 * every later replay of that session. `normalizeToolCallIds` is the in-flight
 * repair: keep the FIRST occurrence of an id, rewrite later ones, and never
 * leave a blank on either side of a call/result pair.
 */

import { describe, it, expect } from "vitest";

import { normalizeToolCallIds } from "@vex-agent/inference/tool-call-id-normalization.js";
import type { ProviderMessage } from "@vex-agent/inference/types.js";

function assistant(callIds: readonly string[], content = ""): ProviderMessage {
  return {
    role: "assistant",
    content,
    toolCalls: callIds.map((id) => ({ id, command: "noop", args: {} })),
  };
}

function toolResult(toolCallId: string, content = "ok"): ProviderMessage {
  return { role: "tool", content, toolCallId };
}

function callIdsOf(message: ProviderMessage | undefined): string[] {
  return (message?.toolCalls ?? []).map((call) => call.id);
}

describe("normalizeToolCallIds", () => {
  it("rewrites a duplicate id in a LATER turn and leaves the first untouched", () => {
    const input: ProviderMessage[] = [
      assistant(["fc_2"]),
      toolResult("fc_2", "first result"),
      { role: "user", content: "again" },
      assistant(["fc_2"]),
      toolResult("fc_2", "second result"),
    ];

    const out = normalizeToolCallIds(input);

    expect(out.rewrittenDuplicateIds).toBe(1);
    expect(out.assignedBlankIds).toBe(0);
    // First occurrence is the cache-stable prefix — it must not move.
    expect(callIdsOf(out.messages[0])).toEqual(["fc_2"]);
    expect(out.messages[1]?.toolCallId).toBe("fc_2");

    const rewritten = callIdsOf(out.messages[3])[0];
    expect(rewritten).not.toBe("fc_2");
    expect(rewritten).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rewritten.length).toBeLessThan(64);
    // Both sides move together, so adjacency and pairing survive.
    expect(out.messages[4]?.toolCallId).toBe(rewritten);
    expect(out.messages[4]?.content).toBe("second result");
    expect(out.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("pairs same-block duplicates by occurrence order, rewriting both sides", () => {
    const input: ProviderMessage[] = [
      assistant(["fc_2", "fc_2"]),
      toolResult("fc_2", "result A"),
      toolResult("fc_2", "result B"),
    ];

    const out = normalizeToolCallIds(input);

    expect(out.rewrittenDuplicateIds).toBe(1);
    const [firstId, secondId] = callIdsOf(out.messages[0]);
    expect(firstId).toBe("fc_2");
    expect(secondId).not.toBe("fc_2");
    // Occurrence queue: result A answers the first call, result B the second.
    expect(out.messages[1]).toMatchObject({
      toolCallId: firstId,
      content: "result A",
    });
    expect(out.messages[2]).toMatchObject({
      toolCallId: secondId,
      content: "result B",
    });
  });

  it("disambiguates a generated id that collides with an id already on the tape", () => {
    // The synthetic scheme is `call_vex_b<block>_c<call>`; a tape that already
    // carries that exact string must not be shadowed by the repair.
    const input: ProviderMessage[] = [
      assistant(["call_vex_b2_c2"]),
      toolResult("call_vex_b2_c2"),
      { role: "user", content: "again" },
      assistant(["dup", "dup"]),
      toolResult("dup", "A"),
      toolResult("dup", "B"),
    ];

    const out = normalizeToolCallIds(input);

    const generated = callIdsOf(out.messages[3])[1];
    expect(generated).not.toBe("call_vex_b2_c2");
    expect(generated).toMatch(/^call_vex_b\d+_c\d+_n\d+$/);
    expect(out.messages[5]?.toolCallId).toBe(generated);
  });

  it("assigns a synthetic id to a blank call AND its blank adjacent result", () => {
    const input: ProviderMessage[] = [
      assistant([""]),
      { role: "tool", content: "result", toolCallId: "" },
    ];

    const out = normalizeToolCallIds(input);

    expect(out.assignedBlankIds).toBe(1);
    const assigned = callIdsOf(out.messages[0])[0];
    expect(assigned).toMatch(/^call_vex_b\d+_c\d+$/);
    expect(out.messages[1]?.toolCallId).toBe(assigned);
    // Still a tool row: the mapper's truthy `toolCallId` check would otherwise
    // demote it to `role:"user"` and destroy the pairing.
    expect(out.messages[1]?.role).toBe("tool");
  });

  it("is idempotent and byte-identical on a clean tape", () => {
    const clean: ProviderMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      assistant(["c1", "c2"], "thinking"),
      toolResult("c1"),
      toolResult("c2"),
      { role: "assistant", content: "done" },
    ];

    const once = normalizeToolCallIds(clean);
    expect(once.rewrittenDuplicateIds).toBe(0);
    expect(once.assignedBlankIds).toBe(0);
    expect(JSON.stringify(once.messages)).toBe(JSON.stringify(clean));

    const twice = normalizeToolCallIds(once.messages);
    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages));
    expect(twice.rewrittenDuplicateIds).toBe(0);
  });

  it("is idempotent over an already-repaired dirty tape", () => {
    const dirty: ProviderMessage[] = [
      assistant(["fc_2", "fc_2"]),
      toolResult("fc_2", "A"),
      toolResult("fc_2", "B"),
    ];
    const once = normalizeToolCallIds(dirty);
    const twice = normalizeToolCallIds(once.messages);

    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages));
    expect(twice.rewrittenDuplicateIds).toBe(0);
    expect(twice.assignedBlankIds).toBe(0);
  });

  it("is deterministic — the same tape produces the same ids every run", () => {
    const build = (): ProviderMessage[] => [
      assistant(["fc_2", "fc_2"]),
      toolResult("fc_2", "A"),
      toolResult("fc_2", "B"),
      { role: "user", content: "next" },
      assistant([""]),
      { role: "tool", content: "C", toolCallId: "" },
    ];
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(normalizeToolCallIds(build()).messages),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("does not mutate the input array or any message, call, or nested object", () => {
    const input: ProviderMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "dup", command: "noop", args: { a: 1 } },
          { id: "dup", command: "noop", args: { a: 2 } },
        ],
      },
      toolResult("dup", "A"),
      toolResult("dup", "B"),
    ];
    const before = JSON.stringify(input);
    const messageRefs = [...input];
    const callRefs = [...(input[0].toolCalls ?? [])];

    const out = normalizeToolCallIds(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(input).toHaveLength(3);
    expect([...input]).toEqual(messageRefs);
    expect(input[0].toolCalls).toEqual(callRefs);
    // The rewritten message must be a clone, not the input object.
    expect(out.messages[0]).not.toBe(input[0]);
    expect(out.messages[0].toolCalls).not.toBe(input[0].toolCalls);
    // Untouched rows are index-aligned with the input.
    expect(out.messages).toHaveLength(input.length);
  });

  it("leaves a tool result that answers no adjacent call alone", () => {
    const input: ProviderMessage[] = [
      { role: "user", content: "hi" },
      toolResult("stray"),
    ];
    const out = normalizeToolCallIds(input);
    expect(JSON.stringify(out.messages)).toBe(JSON.stringify(input));
  });
});
