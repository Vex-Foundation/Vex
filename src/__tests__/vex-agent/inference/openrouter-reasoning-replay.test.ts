/**
 * Reasoning replay (Kairos R-7), shipped switch OFF.
 *
 * Pins the parts that hold whatever the switch says: the family gate, the
 * all-or-nothing sealing rules, the streamed-fragment merge, the redaction of
 * the opaque payload, and the stream-bus projection. Then pins the OFF
 * contract itself: with the shipped constant, a message that carries a replay
 * payload produces the SAME wire body as one that does not, for every family,
 * and nothing is captured from a stream or a buffered response.
 */

import { inspect } from "node:util";

import { describe, it, expect } from "vitest";

import type { ReasoningDetailUnion } from "@openrouter/sdk/models/reasoningdetailunion.js";

import {
  MAX_REPLAY_ROUND_BYTES,
  REASONING_REPLAY_ENABLED,
  ReasoningDetailsAccumulator,
  isReasoningReplayFamily,
  replayDetailsOf,
  replayFromCompleteDetails,
  shouldReplayReasoning,
} from "@vex-agent/inference/openrouter/reasoning-replay.js";
import { buildOpenRouterParams } from "@vex-agent/inference/openrouter/params.js";
import { parseNonStreamingResponse } from "@vex-agent/inference/openrouter/mappers.js";
import { toStreamDeltaEvent } from "@vex-agent/engine/events/stream-bus.js";
import { requireValue } from "../../helpers/require-value.js";
import {
  FAMILY_DETAILS,
  TOOLS,
  bufferedThroughSdk,
  captureWireBody,
  configFor,
  sseChunk,
  streamThroughSdk,
  toolLoopMessages,
} from "./reasoning-replay-fixtures.js";

describe("R-7 switch and family gate", () => {
  it("ships OFF", () => {
    expect(REASONING_REPLAY_ENABLED).toBe(false);
  });

  it("allow-lists only the documented families", () => {
    for (const model of Object.keys(FAMILY_DETAILS)) {
      expect(isReasoningReplayFamily(model)).toBe(true);
    }
    for (const model of ["qwen/qwen3-max", "meta-llama/llama-4", "moonshotai/kimi-k2", "mistralai/x", "anthropicx/fake"]) {
      expect(isReasoningReplayFamily(model)).toBe(false);
    }
  });

  it("never opens the gate with the switch off, and only for the family with it on", () => {
    expect(shouldReplayReasoning("anthropic/claude-sonnet-4.5", false)).toBe(false);
    expect(shouldReplayReasoning("anthropic/claude-sonnet-4.5", true)).toBe(true);
    expect(shouldReplayReasoning("qwen/qwen3-max", true)).toBe(false);
  });
});

describe("R-7 sealing: all or nothing per round", () => {
  it("keeps a complete buffered sequence verbatim", () => {
    const details = requireValue(FAMILY_DETAILS["openai/gpt-5"]);
    const replay = requireValue(replayFromCompleteDetails(details));
    expect(replay.detailCount).toBe(2);
    expect(replayDetailsOf(replay)).toEqual(details);
  });

  it("refuses a round with an unknown member or a server-tool record", () => {
    const unknownMember: ReasoningDetailUnion = { type: "UNKNOWN", raw: { type: "reasoning.future" }, isUnknown: true };
    const serverTool: ReasoningDetailUnion = {
      type: "reasoning.server_tool_call",
      arguments: "{}",
      result: "{}",
      toolName: "openrouter:web",
    };
    const text: ReasoningDetailUnion = { type: "reasoning.text", text: "t", index: 0 };
    expect(replayFromCompleteDetails([text, unknownMember])).toBeNull();
    expect(replayFromCompleteDetails([text, serverTool])).toBeNull();
  });

  it("refuses redacted or empty encrypted data, empty text, and empty sequences", () => {
    expect(replayFromCompleteDetails([{ type: "reasoning.encrypted", data: "[REDACTED]" }])).toBeNull();
    expect(replayFromCompleteDetails([{ type: "reasoning.encrypted", data: "" }])).toBeNull();
    expect(replayFromCompleteDetails([{ type: "reasoning.text", text: "", signature: null }])).toBeNull();
    expect(replayFromCompleteDetails([])).toBeNull();
    expect(replayFromCompleteDetails(undefined)).toBeNull();
  });

  it("refuses an oversized round instead of truncating it", () => {
    const big = "x".repeat(MAX_REPLAY_ROUND_BYTES + 1);
    expect(replayFromCompleteDetails([{ type: "reasoning.text", text: big }])).toBeNull();
  });

  it("prints a count, never content, when serialised or inspected", () => {
    const replay = requireValue(replayFromCompleteDetails(FAMILY_DETAILS["anthropic/claude-sonnet-4.5"]));
    const dumped = JSON.stringify({ replay }) + inspect(replay) + String(inspect({ nested: replay }));
    expect(dumped).not.toContain("sig-anthropic-1");
    expect(dumped).not.toContain("cmVkYWN0ZWQtdGhpbmtpbmc=");
    expect(dumped).not.toContain("Check the balance");
    expect(JSON.stringify(replay)).toBe("\"[reasoning replay: 2 details]\"");
  });

  it("hands out copies, so the captured sequence cannot be mutated", () => {
    const replay = requireValue(replayFromCompleteDetails(FAMILY_DETAILS["x-ai/grok-4"]));
    const first = requireValue(replayDetailsOf(replay));
    const firstDetail = requireValue(first[0]);
    Reflect.set(firstDetail, "data", "tampered");
    expect(replayDetailsOf(replay)).toEqual(FAMILY_DETAILS["x-ai/grok-4"]);
  });
});

describe("R-7 streamed fragment merge", () => {
  it("merges fragments of one index: text concatenated, late signature kept", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: "reasoning.text", text: "Check ", index: 0, format: "anthropic-claude-v1" }]);
    acc.add([{ type: "reasoning.text", text: "the balance.", index: 0 }]);
    acc.add([{ type: "reasoning.text", text: "", signature: "sig-1", index: 0 }]);
    acc.add([{ type: "reasoning.encrypted", data: "opaque", index: 1 }]);
    const replay = requireValue(acc.finish());
    expect(replayDetailsOf(replay)).toEqual([
      { type: "reasoning.text", text: "Check the balance.", signature: "sig-1", index: 0, format: "anthropic-claude-v1" },
      { type: "reasoning.encrypted", data: "opaque", index: 1 },
    ]);
  });

  it("poisons the round on conflicting fragments for one index", () => {
    const typeClash = new ReasoningDetailsAccumulator();
    typeClash.add([{ type: "reasoning.text", text: "a", index: 0 }]);
    typeClash.add([{ type: "reasoning.summary", summary: "b", index: 0 }]);
    expect(typeClash.finish()).toBeNull();

    const twoPayloads = new ReasoningDetailsAccumulator();
    twoPayloads.add([{ type: "reasoning.encrypted", data: "one", index: 0 }]);
    twoPayloads.add([{ type: "reasoning.encrypted", data: "two", index: 0 }]);
    expect(twoPayloads.finish()).toBeNull();
  });

  it("replaces a streamed [REDACTED] placeholder with the real payload when it arrives", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: "reasoning.encrypted", data: "[REDACTED]", index: 0 }]);
    acc.add([{ type: "reasoning.encrypted", data: "real-opaque", index: 0 }]);
    expect(replayDetailsOf(acc.finish() ?? undefined)).toEqual([
      { type: "reasoning.encrypted", data: "real-opaque", index: 0 },
    ]);
  });

  it("stays null when nothing arrived", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add(undefined);
    expect(acc.sawDetails).toBe(false);
    expect(acc.finish()).toBeNull();
  });
});

describe("R-7 stream-bus projection", () => {
  it("drops the replay payload from the renderer-bound done delta", () => {
    const reasoningReplay = requireValue(replayFromCompleteDetails(FAMILY_DETAILS["openai/gpt-5"]));
    const event = toStreamDeltaEvent("s", "stream", 0, { type: "done", finishReason: "tool_calls", reasoningReplay });
    expect(event.delta).toEqual({ kind: "done" });
    expect(JSON.stringify(event)).not.toContain("gAAAAB-openai-opaque");
  });
});

describe("R-7 OFF == pre-R-7 wire request", () => {
  for (const [model, details] of Object.entries(FAMILY_DETAILS)) {
    it(`${model}: a replay payload on the message changes nothing on the wire`, async () => {
      const replay = requireValue(replayFromCompleteDetails(details));
      const config = configFor(model);
      const withReplay = await captureWireBody(
        buildOpenRouterParams(toolLoopMessages(replay), TOOLS, config, false),
      );
      const without = await captureWireBody(
        buildOpenRouterParams(toolLoopMessages(undefined), TOOLS, config, false),
      );
      expect(withReplay).toBe(without);
      expect(withReplay).not.toContain("reasoning_details");
    });
  }
});

describe("R-7 OFF captures nothing", () => {
  const streamed = [
    sseChunk({ reasoning_details: [{ type: "reasoning.text", text: "think", index: 0 }] }),
    sseChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "wallet_balance", arguments: "{}" } }] }),
    sseChunk({}, "tool_calls"),
  ];

  it("streams no payload on done when capture is off", async () => {
    const chunks = await streamThroughSdk(streamed, false);
    const done = requireValue(chunks.find((c) => c.type === "done"));
    expect("reasoningReplay" in done).toBe(false);
  });

  it("parses no payload from a buffered response when capture is off", async () => {
    const result = await bufferedThroughSdk({
      id: "gen-b",
      model: "m",
      object: "chat.completion",
      created: 1,
      system_fingerprint: "fp",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning_details: [{ type: "reasoning.text", text: "think", index: 0 }],
          tool_calls: [{ id: "call_1", type: "function", function: { name: "wallet_balance", arguments: "{}" } }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const parsed = parseNonStreamingResponse(result);
    expect("reasoningReplay" in parsed).toBe(false);
  });
});
