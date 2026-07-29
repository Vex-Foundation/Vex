/**
 * D-4 — tool results are persisted VERBATIM and INLINE.
 *
 * The tool-output blob mechanism (blob table + readback tool + transcript
 * stub) was removed: an oversized output is no longer externalised, it goes
 * into the transcript and into `liveMessages` in full. These tests pin that
 * contract on the one production persistence site,
 * `persistBatchTranscript` in `turn-loop-tool-batch/results.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@vex-agent/db/repos/messages.js";

const appendMessage = vi.fn().mockResolvedValue(undefined);
const saveAssistantMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => appendMessage(...args),
}));

vi.mock("../../../../vex-agent/engine/core/turn.js", () => ({
  saveAssistantMessage: (...args: unknown[]) => saveAssistantMessage(...args),
}));

const { persistBatchTranscript } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/results.js"
);

/** Comfortably past the 16 KiB the removed mechanism used to externalise at. */
const OVERSIZED_OUTPUT = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({ id: i, text: "x".repeat(120) })),
});

const EXPLORER_REFS = [{ chain: "solana", txRef: "5".repeat(64) }] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persistBatchTranscript — inline tool-result persistence", () => {
  it("persists an oversized output verbatim, with no overflow/blob markers", async () => {
    expect(Buffer.byteLength(OVERSIZED_OUTPUT, "utf8")).toBeGreaterThan(16 * 1024);

    const liveMessages: Message[] = [];
    await persistBatchTranscript({
      sessionId: "s1",
      content: null,
      executedCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      executedResults: [{
        toolCallId: "tc-1",
        toolName: "web_research",
        output: OVERSIZED_OUTPUT,
        success: true,
        explorerRefs: [],
      }],
      liveMessages,
    });

    // (a) the DB append carries the exact full output string.
    const toolAppend = appendMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    expect(toolAppend).toBeDefined();
    expect((toolAppend![1] as { content: string }).content).toBe(OVERSIZED_OUTPUT);

    const metadata = toolAppend![2] as {
      source?: string;
      messageType?: string;
      visibility?: string;
      payload?: Record<string, unknown>;
    };
    expect(metadata.source).toBe("tool");
    expect(metadata.messageType).toBe("tool_result");
    expect(metadata.visibility).toBe("internal");

    // (b) liveMessages receives that same full output.
    const liveTool = liveMessages.find((m) => m.role === "tool");
    expect(liveTool).toBeDefined();
    expect(liveTool!.content).toBe(OVERSIZED_OUTPUT);

    // (c) no overflow/blob key survives anywhere in the payload.
    expect(metadata.payload).toEqual({ success: true });
    const serialized = JSON.stringify(metadata.payload);
    expect(serialized).not.toContain("overflow");
    expect(serialized).not.toContain("blobKey");
    expect(JSON.stringify(liveTool!.metadata?.payload)).not.toContain("blobKey");
  });

  it("keeps non-empty explorerRefs on the persisted payload", async () => {
    const liveMessages: Message[] = [];
    await persistBatchTranscript({
      sessionId: "s1",
      content: null,
      executedCalls: [{ id: "tc-2", name: "swap_execute", arguments: {} }],
      executedResults: [{
        toolCallId: "tc-2",
        toolName: "swap_execute",
        output: "ok",
        success: true,
        explorerRefs: EXPLORER_REFS,
      }],
      liveMessages,
    });

    const toolAppend = appendMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    // (d) non-empty explorerRefs remain persisted under `payload`.
    expect((toolAppend![2] as { payload?: Record<string, unknown> }).payload).toEqual({
      success: true,
      explorerRefs: EXPLORER_REFS,
    });
  });

  it("persists durationMs for an executed entry and omits it for a synthetic one", async () => {
    const liveMessages: Message[] = [];
    await persistBatchTranscript({
      sessionId: "s1",
      content: null,
      executedCalls: [
        { id: "tc-3", name: "web_research", arguments: {} },
        { id: "tc-4", name: "token_find", arguments: {} },
      ],
      executedResults: [
        {
          toolCallId: "tc-3",
          toolName: "web_research",
          output: "ok",
          success: true,
          explorerRefs: [],
          durationMs: 1234,
        },
        // Compact-drained / never-executed shape: no duration at all.
        {
          toolCallId: "tc-4",
          toolName: "token_find",
          output: "batch_aborted_by_compact: …",
          success: false,
          explorerRefs: [],
        },
      ],
      liveMessages,
    });

    const payloads = appendMessage.mock.calls
      .filter(([, msg]) => (msg as { role?: string }).role === "tool")
      .map(([, , meta]) => (meta as { payload?: Record<string, unknown> }).payload);

    expect(payloads[0]).toEqual({ success: true, durationMs: 1234 });
    // Never 0 — the key is absent so the app reads "unknown", not "instant".
    expect(payloads[1]).toEqual({ success: false });
  });

  it("forwards the turn's reasoning to the deferred assistant save", async () => {
    await persistBatchTranscript({
      sessionId: "s1",
      content: "working on it",
      executedCalls: [{ id: "tc-5", name: "web_research", arguments: {} }],
      executedResults: [],
      liveMessages: [],
      reasoning: "I should search first",
    });

    expect(saveAssistantMessage).toHaveBeenCalledWith(
      "s1",
      "working on it",
      [{ id: "tc-5", name: "web_research", arguments: {} }],
      expect.objectContaining({ reasoning: "I should search first" }),
    );
  });
});
