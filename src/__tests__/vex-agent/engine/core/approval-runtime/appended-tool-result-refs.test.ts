/**
 * Stage 2 — `appendApprovedToolResult` carries `explorerRefs` under
 * `metadata.payload` for approval-gated (financial) actions. The append is the
 * only side effect exercised here; the derivation happens in the caller. This
 * is a metadata-only attachment — the approval/dispatch behavior is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendMessage = vi.fn();

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
}));

const { appendApprovedToolResult } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendApprovedToolResult — explorerRefs", () => {
  it("attaches explorerRefs to payload when present", async () => {
    const refs = [{ chain: "hyperliquid", txRef: "0xdeadbeef" }];
    await appendApprovedToolResult(
      "s1",
      "tc-1",
      { success: true, output: "{}" },
      refs,
    );

    const call = mockAppendMessage.mock.calls[0]!;
    expect((call[1] as { role: string; content: string })).toMatchObject({
      role: "tool",
      content: "{}",
    });
    const meta = call[2] as { payload?: Record<string, unknown> };
    expect(meta.payload).toEqual({ success: true, explorerRefs: refs });
  });

  it("omits explorerRefs when none / arg omitted (back-compat)", async () => {
    await appendApprovedToolResult("s1", "tc-1", { success: false, output: "err" });

    const meta = mockAppendMessage.mock.calls[0]![2] as {
      payload?: Record<string, unknown>;
    };
    expect(meta.payload).toEqual({ success: false });
    expect(meta.payload).not.toHaveProperty("explorerRefs");
  });
});
