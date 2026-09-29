import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ChatToolCall } from "@openrouter/sdk/models/chattoolcall.js";

const mockLoggerWarn = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { parseNonStreamingResponse } = await import(
  "../../../vex-agent/inference/openrouter/mappers.js"
);

/**
 * The buffered (non-streaming) parse path must report dropped tool calls the
 * same way the stream consumer does, so the turn loop refuses an incomplete
 * batch no matter which path served the round.
 */

function call(id: string, name: string, args: string): ChatToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function result(toolCalls: ChatToolCall[], finishReason: "stop" | "length" | "tool_calls"): ChatResult {
  return {
    id: "gen-1",
    model: "m",
    object: "chat.completion",
    created: 1,
    systemFingerprint: null,
    choices: [
      {
        index: 0,
        finishReason,
        message: { role: "assistant", content: null, toolCalls },
      },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("parseNonStreamingResponse - malformed tool calls", () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
  });

  it("reports zero for a fully valid batch", () => {
    const res = parseNonStreamingResponse(
      result([call("c0", "a", "{}"), call("c1", "b", '{"x":1}')], "tool_calls"),
    );
    expect(res.toolCalls).toHaveLength(2);
    expect(res.malformedToolCallCount).toBe(0);
  });

  it("reports zero on a plain text response", () => {
    const res = parseNonStreamingResponse(result([], "stop"));
    expect(res.toolCalls).toBe(null);
    expect(res.malformedToolCallCount).toBe(0);
  });

  it("counts a truncated call alongside a valid one", () => {
    const res = parseNonStreamingResponse(
      result([call("c0", "good", '{"ok":1}'), call("c1", "cut", '{"amount":"12')], "length"),
    );
    expect(res.toolCalls).toEqual([{ id: "c0", name: "good", arguments: { ok: 1 } }]);
    expect(res.malformedToolCallCount).toBe(1);
    expect(res.finishReason).toBe("length");
  });

  it("counts every call when all are malformed and falls through to text", () => {
    const res = parseNonStreamingResponse(
      result([call("c0", "a", "nope"), call("c1", "b", "{")], "stop"),
    );
    expect(res.toolCalls).toBe(null);
    expect(res.content).toBe("");
    expect(res.malformedToolCallCount).toBe(2);
  });

  it("drops and counts a call with no id or no name, without inventing an id", () => {
    const res = parseNonStreamingResponse(
      result([call("", "no_id", "{}"), call("c1", "", "{}"), call("c2", "ok", "{}")], "tool_calls"),
    );
    expect(res.toolCalls).toEqual([{ id: "c2", name: "ok", arguments: {} }]);
    expect(res.malformedToolCallCount).toBe(2);
  });

  it("never logs argument text", () => {
    const secret = '{"to":"0xdeadbeefcafe","amount":"999';
    parseNonStreamingResponse(result([call("c0", "transfer", secret)], "length"));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "inference.openrouter.malformed_tool_args",
      { name: "transfer", argsLength: secret.length, reason: "invalid_json" },
    );
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain("0xdeadbeefcafe");
  });
});
