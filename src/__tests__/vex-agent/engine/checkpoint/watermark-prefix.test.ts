/**
 * Unit tests for `selectWatermarkBoundedPrefix` — pure, no DB.
 *
 * These pin the two properties the APPLY cutover depends on:
 *   1. the archived span is EXACTLY the messages branch A summarised
 *      (`id <= watermark`), never one row more;
 *   2. no `assistant.tool_calls` ↔ `role:'tool'` batch is split.
 *
 * Property 2 carries the Gate-0 §19 correction: a watermark landing ON a tool
 * result is already pair-closed (its parent and earlier siblings are inside the
 * prefix). Shrinking happens ONLY when the first RETAINED message is a tool
 * result. Both directions are tested, because the naive reading ("watermark is
 * a tool row → shrink") silently under-archives on every multi-tool turn.
 */

import { describe, it, expect } from "vitest";

import { selectWatermarkBoundedPrefix } from "../../../../vex-agent/engine/checkpoint/watermark-prefix.js";
import type { MessageWithId } from "../../../../vex-agent/db/repos/messages.js";

type Role = MessageWithId["role"];

function msg(
  id: number,
  role: Role,
  extras: {
    toolCallId?: string;
    toolCalls?: Array<{ id: string; command: string; args: Record<string, unknown> }>;
  } = {},
): MessageWithId {
  return {
    id,
    role,
    content: `m${id}`,
    ...(extras.toolCallId === undefined ? {} : { toolCallId: extras.toolCallId }),
    ...(extras.toolCalls === undefined ? {} : { toolCalls: extras.toolCalls }),
    timestamp: `2026-07-29T00:00:${String(id).padStart(2, "0")}Z`,
  };
}

/** assistant(id) with tool_calls + one `role:'tool'` result per call id. */
function toolBatch(assistantId: number, resultIds: readonly number[]): MessageWithId[] {
  return [
    msg(assistantId, "assistant", {
      toolCalls: resultIds.map((rid) => ({ id: `tc-${rid}`, command: "probe", args: {} })),
    }),
    ...resultIds.map((rid) => msg(rid, "tool", { toolCallId: `tc-${rid}` })),
  ];
}

describe("selectWatermarkBoundedPrefix", () => {
  it("noops on an empty session", () => {
    expect(selectWatermarkBoundedPrefix([], 10)).toEqual({
      mode: "noop",
      reason: "empty_session",
    });
  });

  it("noops as watermark_not_live when every message <= watermark is already archived", () => {
    const messages = [msg(40, "user"), msg(41, "assistant")];
    expect(selectWatermarkBoundedPrefix(messages, 39)).toEqual({
      mode: "noop",
      reason: "watermark_not_live",
    });
  });

  it("archives the whole transcript when the watermark equals the last live id", () => {
    const messages = [msg(1, "user"), msg(2, "assistant"), msg(3, "user")];
    const plan = selectWatermarkBoundedPrefix(messages, 3);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(plan.tail).toEqual([]);
    expect(plan.cutoffMessageId).toBe(3);
  });

  it("archives the whole transcript when the watermark is above every live id", () => {
    const messages = [msg(1, "user"), msg(2, "assistant")];
    const plan = selectWatermarkBoundedPrefix(messages, 999);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1, 2]);
    expect(plan.tail).toEqual([]);
  });

  it("cuts exactly at the watermark mid-transcript", () => {
    const messages = [
      msg(1, "user"),
      msg(2, "assistant"),
      msg(3, "user"),
      msg(4, "assistant"),
      msg(5, "user"),
    ];
    const plan = selectWatermarkBoundedPrefix(messages, 3);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(plan.tail.map((m) => m.id)).toEqual([4, 5]);
    expect(plan.cutoffMessageId).toBe(3);
  });

  it("does NOT shrink when the watermark lands on the LAST tool result of a batch", () => {
    // Gate-0 §19: the batch is entirely inside the prefix, so the boundary is
    // already pair-closed and the assistant must NOT be dragged back out.
    const messages = [msg(1, "user"), ...toolBatch(2, [3, 4]), msg(5, "assistant")];
    const plan = selectWatermarkBoundedPrefix(messages, 4);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(plan.tail.map((m) => m.id)).toEqual([5]);
    expect(plan.cutoffMessageId).toBe(4);
  });

  it("shrinks past the whole batch when the watermark splits it", () => {
    // Watermark on result 3 leaves result 4 live → the first RETAINED message
    // is a tool row, so assistant 2 and result 3 must come back out.
    const messages = [msg(1, "user"), ...toolBatch(2, [3, 4]), msg(5, "assistant")];
    const plan = selectWatermarkBoundedPrefix(messages, 3);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1]);
    expect(plan.tail.map((m) => m.id)).toEqual([2, 3, 4, 5]);
    expect(plan.cutoffMessageId).toBe(1);
  });

  it("shrinks past the assistant when the watermark lands ON the assistant of a batch", () => {
    const messages = [msg(1, "user"), ...toolBatch(2, [3, 4])];
    const plan = selectWatermarkBoundedPrefix(messages, 2);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([1]);
    expect(plan.tail.map((m) => m.id)).toEqual([2, 3, 4]);
  });

  it("noops as no_compactable when pair integrity swallows the entire prefix", () => {
    const messages = [...toolBatch(1, [2, 3]), msg(4, "assistant")];
    expect(selectWatermarkBoundedPrefix(messages, 2)).toEqual({
      mode: "noop",
      reason: "no_compactable",
    });
  });

  it("honours non-contiguous ids left by an earlier archive or giant-tool fork", () => {
    const messages = [msg(7, "user"), msg(19, "assistant"), msg(20, "user"), msg(44, "assistant")];
    const plan = selectWatermarkBoundedPrefix(messages, 30);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([7, 19, 20]);
    expect(plan.tail.map((m) => m.id)).toEqual([44]);
    expect(plan.cutoffMessageId).toBe(20);
  });

  it("treats a watermark id absent from the live set as an ordinary bound", () => {
    // Row 21 was forked to archive by the legacy giant-tool path; the bound is
    // still meaningful for the rows around it.
    const messages = [msg(20, "user"), msg(22, "assistant"), msg(23, "user")];
    const plan = selectWatermarkBoundedPrefix(messages, 21);
    expect(plan.mode).toBe("prefix");
    if (plan.mode !== "prefix") return;
    expect(plan.prefix.map((m) => m.id)).toEqual([20]);
    expect(plan.tail.map((m) => m.id)).toEqual([22, 23]);
  });

  it("never returns a plan whose tail begins with a tool row", () => {
    const messages = [msg(1, "user"), ...toolBatch(2, [3, 4, 5]), ...toolBatch(6, [7, 8])];
    for (let watermark = 0; watermark <= 9; watermark++) {
      const plan = selectWatermarkBoundedPrefix(messages, watermark);
      if (plan.mode !== "prefix") continue;
      expect(plan.tail[0]?.role).not.toBe("tool");
      // and the archived span never reaches past the watermark
      expect(plan.cutoffMessageId).toBeLessThanOrEqual(watermark);
    }
  });
});
