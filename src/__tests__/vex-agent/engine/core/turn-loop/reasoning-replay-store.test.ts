/**
 * The per-run reasoning-replay store (Kairos R-7): exact tool-call matching,
 * the OFF identity, and the run bounds.
 */

import { describe, it, expect } from "vitest";

import {
  MAX_REPLAY_ROUNDS_PER_RUN,
  createReasoningReplayStore,
} from "@vex-agent/engine/core/turn-loop/reasoning-replay-store.js";
import type { TurnEnvelope } from "@vex-agent/engine/core/turn-envelope.js";
import { replayFromCompleteDetails } from "@vex-agent/inference/openrouter/reasoning-replay.js";
import type { ParsedToolCall, ProviderMessage } from "@vex-agent/inference/types.js";
import { requireValue } from "../../../../helpers/require-value.js";

const MODEL = "deepseek/deepseek-v4-flash";
const REPLAY = requireValue(replayFromCompleteDetails([
  { type: "reasoning.text", text: "call the tool", index: 0 },
]));

function calls(...ids: string[]): ParsedToolCall[] {
  return ids.map((id) => ({ id, name: "wallet_balance", arguments: {} }));
}

function envelopeWith(...batches: string[][]): TurnEnvelope {
  const providerMessages: ProviderMessage[] = [{ role: "system", content: "SYS", cacheHint: "static_prefix" }];
  for (const ids of batches) {
    providerMessages.push({
      role: "assistant",
      content: "",
      toolCalls: ids.map((id) => ({ id, command: "wallet_balance", args: {} })),
    });
    for (const id of ids) providerMessages.push({ role: "tool", content: "{}", toolCallId: id });
  }
  return { providerMessages, insertedPlaceholders: 0 };
}

describe("reasoning-replay store", () => {
  it("OFF returns the very envelope it was given and records nothing", () => {
    const store = createReasoningReplayStore(false);
    store.observeRound({ model: MODEL, toolCalls: calls("a"), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
    const envelope = envelopeWith(["a"]);
    const result = store.attach(envelope, MODEL);
    expect(result.envelope).toBe(envelope);
    expect(result.attachedMessages).toBe(0);
  });

  it("attaches only to the message with the exact same ordered call ids", () => {
    const store = createReasoningReplayStore(true);
    store.observeRound({ model: MODEL, toolCalls: calls("a", "b"), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
    // A trimmed batch (only "a" was persisted) must not get reasoning that
    // describes a call which is not there.
    expect(store.attach(envelopeWith(["a"]), MODEL).attachedMessages).toBe(0);
    expect(store.attach(envelopeWith(["b", "a"]), MODEL).attachedMessages).toBe(0);
    const matched = store.attach(envelopeWith(["a", "b"]), MODEL);
    expect(matched.attachedMessages).toBe(1);
    expect(matched.attachedBytes).toBe(REPLAY.byteLength);
  });

  it("does not mutate the envelope it was given", () => {
    const store = createReasoningReplayStore(true);
    store.observeRound({ model: MODEL, toolCalls: calls("a"), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
    const envelope = envelopeWith(["a"]);
    const result = store.attach(envelope, MODEL);
    expect(result.envelope).not.toBe(envelope);
    expect(envelope.providerMessages.some((m) => m.reasoningReplay !== undefined)).toBe(false);
  });

  it("refuses a different model, an unknown serving provider, and blank ids", () => {
    const store = createReasoningReplayStore(true);
    store.observeRound({ model: MODEL, toolCalls: calls("a"), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
    expect(store.attach(envelopeWith(["a"]), "anthropic/claude-sonnet-4.5").attachedMessages).toBe(0);

    const unknownProvider = createReasoningReplayStore(true);
    unknownProvider.observeRound({ model: MODEL, toolCalls: calls("a"), reasoningReplay: REPLAY, servingProvider: null });
    expect(unknownProvider.attach(envelopeWith(["a"]), MODEL).attachedMessages).toBe(0);

    const blank = createReasoningReplayStore(true);
    blank.observeRound({ model: MODEL, toolCalls: calls(""), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
    expect(blank.attach(envelopeWith([""]), MODEL).attachedMessages).toBe(0);
  });

  it("keeps the earliest rounds and stops recording at the run bound", () => {
    const store = createReasoningReplayStore(true);
    const batches: string[][] = [];
    for (let i = 0; i <= MAX_REPLAY_ROUNDS_PER_RUN; i++) {
      store.observeRound({ model: MODEL, toolCalls: calls(`c${i}`), reasoningReplay: REPLAY, servingProvider: "DeepSeek" });
      batches.push([`c${i}`]);
    }
    const result = store.attach(envelopeWith(...batches), MODEL);
    expect(result.attachedMessages).toBe(MAX_REPLAY_ROUNDS_PER_RUN);
    const last = requireValue(result.envelope.providerMessages.filter((m) => m.role === "assistant").at(-1));
    expect(last.reasoningReplay).toBeUndefined();
  });
});
