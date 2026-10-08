/**
 * Reasoning replay (Kairos R-7) with the switch ON: request shape per family.
 *
 * The constant is module-level, so it is replaced through `vi.mock`; every
 * other export of the module stays real. Every assertion is on the JSON the
 * REAL SDK would send (snake_case `reasoning_details`), and the capture side
 * goes through the real SDK's SSE and JSON parsers.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../vex-agent/inference/openrouter/reasoning-replay.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../vex-agent/inference/openrouter/reasoning-replay.js")
  >();
  return { ...actual, REASONING_REPLAY_ENABLED: true };
});

import {
  REASONING_REPLAY_ENABLED,
  replayDetailsOf,
  replayFromCompleteDetails,
} from "@vex-agent/inference/openrouter/reasoning-replay.js";
import { buildOpenRouterParams } from "@vex-agent/inference/openrouter/params.js";
import { parseNonStreamingResponse } from "@vex-agent/inference/openrouter/mappers.js";
import type { ProviderMessage } from "@vex-agent/inference/types.js";
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
  wireMessages,
} from "./reasoning-replay-fixtures.js";

/** The SDK outbound form of our camelCase fixture: snake_case, nulls kept. */
function snakeCase(details: readonly object[]): unknown[] {
  return details.map((detail) =>
    Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value]),
    ),
  );
}

describe("R-7 ON: request shape per family", () => {
  it("runs with the switch replaced", () => {
    expect(REASONING_REPLAY_ENABLED).toBe(true);
  });

  for (const [model, details] of Object.entries(FAMILY_DETAILS)) {
    it(`${model}: reasoning_details ride verbatim on the assistant tool-call message only`, async () => {
      const replay = requireValue(replayFromCompleteDetails(details));
      const body = await captureWireBody(
        buildOpenRouterParams(toolLoopMessages(replay), TOOLS, configFor(model), false),
      );
      const messages = wireMessages(body);
      const carriers = messages.filter((m) => "reasoning_details" in m);
      expect(carriers).toHaveLength(1);
      const carrier = requireValue(carriers[0]);
      expect(carrier.role).toBe("assistant");
      expect(Array.isArray(carrier.tool_calls)).toBe(true);
      expect(carrier.reasoning_details).toEqual(snakeCase(details));
    });
  }

  it("never sends a replay to a family outside the allow-list", async () => {
    const replay = requireValue(replayFromCompleteDetails(FAMILY_DETAILS["anthropic/claude-sonnet-4.5"]));
    for (const model of ["qwen/qwen3-max", "moonshotai/kimi-k2", "meta-llama/llama-4"]) {
      const withReplay = await captureWireBody(
        buildOpenRouterParams(toolLoopMessages(replay), TOOLS, configFor(model), false),
      );
      const without = await captureWireBody(
        buildOpenRouterParams(toolLoopMessages(undefined), TOOLS, configFor(model), false),
      );
      expect(withReplay).toBe(without);
    }
  });

  it("never puts a replay on an assistant message without tool calls", async () => {
    const replay = requireValue(replayFromCompleteDetails(FAMILY_DETAILS["openai/gpt-5"]));
    const messages: ProviderMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoningReplay: replay },
      { role: "user", content: "again" },
    ];
    const body = await captureWireBody(buildOpenRouterParams(messages, TOOLS, configFor("openai/gpt-5"), false));
    expect(body).not.toContain("reasoning_details");
  });

  it("a message with no replay keeps the pre-R-7 shape even with the switch on", async () => {
    const config = configFor("anthropic/claude-sonnet-4.5");
    const body = await captureWireBody(buildOpenRouterParams(toolLoopMessages(undefined), TOOLS, config, false));
    expect(body).not.toContain("reasoning_details");
  });
});

describe("R-7 ON: capture through the real SDK parsers round-trips to the wire", () => {
  it("streamed fragments become one replay that is sent back as the merged sequence", async () => {
    const chunks = await streamThroughSdk([
      sseChunk({ reasoning: "Check ", reasoning_details: [{ type: "reasoning.text", text: "Check ", format: "anthropic-claude-v1", index: 0 }] }),
      sseChunk({ reasoning: "balance.", reasoning_details: [{ type: "reasoning.text", text: "balance.", index: 0 }] }),
      sseChunk({ reasoning_details: [{ type: "reasoning.text", text: "", signature: "sig-stream", index: 0 }] }),
      sseChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "wallet_balance", arguments: "{}" } }] }),
      sseChunk({}, "tool_calls"),
    ], true);

    const done = requireValue(chunks.find((c) => c.type === "done"));
    const replay = requireValue(done.reasoningReplay);
    expect(replay.detailCount).toBe(1);

    const body = await captureWireBody(
      buildOpenRouterParams(toolLoopMessages(replay), TOOLS, configFor("anthropic/claude-sonnet-4.5"), false),
    );
    const carrier = requireValue(wireMessages(body).find((m) => "reasoning_details" in m));
    expect(carrier.reasoning_details).toEqual([
      { type: "reasoning.text", text: "Check balance.", signature: "sig-stream", format: "anthropic-claude-v1", index: 0 },
    ]);
  });

  it("a stream whose encrypted block only ever said [REDACTED] yields no replay", async () => {
    const chunks = await streamThroughSdk([
      sseChunk({ reasoning_details: [{ type: "reasoning.encrypted", data: "[REDACTED]", index: 0 }] }),
      sseChunk({}, "tool_calls"),
    ], true);
    const done = requireValue(chunks.find((c) => c.type === "done"));
    expect(done.reasoningReplay).toBeUndefined();
  });

  it("a buffered response's details are captured verbatim when capture is on", async () => {
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
          reasoning_details: [
            { type: "reasoning.summary", summary: "Plan.", id: "rs_1", format: "openai-responses-v1", index: 0 },
            { type: "reasoning.encrypted", data: "opaque", id: "rs_1", format: "openai-responses-v1", index: 1 },
          ],
          tool_calls: [{ id: "call_1", type: "function", function: { name: "wallet_balance", arguments: "{}" } }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const parsed = parseNonStreamingResponse(result, true);
    expect(replayDetailsOf(parsed.reasoningReplay ?? undefined)).toEqual([
      { type: "reasoning.summary", summary: "Plan.", id: "rs_1", format: "openai-responses-v1", index: 0 },
      { type: "reasoning.encrypted", data: "opaque", id: "rs_1", format: "openai-responses-v1", index: 1 },
    ]);
  });
});
