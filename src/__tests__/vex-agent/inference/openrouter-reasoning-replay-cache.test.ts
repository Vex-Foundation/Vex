/**
 * Reasoning replay (Kairos R-7) against a fake prefix-caching provider.
 *
 * Measures what the switch does to the two numbers the Phase 1 timing rows
 * record per attempt, `promptTokens` and `cachedTokens`, for a scripted
 * session: run 1 is a three-round tool loop (tool, tool, answer), run 2 is
 * the next user turn on the same tape. Every request body is the JSON the
 * REAL SDK would send; the fake provider bills ceil(bytes / 4) tokens per
 * message and serves from cache the longest message prefix it has already
 * seen (automatic prefix caching: DeepSeek, OpenAI; Anthropic breakpoints
 * behave the same at message granularity). The envelope assembly mirrors the
 * turn loop: static prefix, history, trailing turn state that changes every
 * round, and the replay store attaching before the send.
 *
 * What it pins:
 *  - OFF rows are exactly the pre-R-7 rows.
 *  - ON never caches less than OFF within a run: a replayed message is
 *    stable from the round after it was produced, so its tokens join the
 *    cached prefix (no bust).
 *  - ON costs a one-time miss on the next run's first request, from the first
 *    replayed message onward, because the next run does not carry this run's
 *    reasoning. That is the trade the switch must be measured on live.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../vex-agent/inference/openrouter/reasoning-replay.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../vex-agent/inference/openrouter/reasoning-replay.js")
  >();
  return { ...actual, REASONING_REPLAY_ENABLED: true };
});

import { replayFromCompleteDetails } from "@vex-agent/inference/openrouter/reasoning-replay.js";
import { buildOpenRouterParams } from "@vex-agent/inference/openrouter/params.js";
import { createReasoningReplayStore } from "@vex-agent/engine/core/turn-loop/reasoning-replay-store.js";
import type { ProviderMessage, ReasoningReplayPayload } from "@vex-agent/inference/types.js";
import { requireValue } from "../../helpers/require-value.js";
import { TOOLS, captureWireBody, configFor, wireMessages } from "./reasoning-replay-fixtures.js";

const MODEL = "deepseek/deepseek-v4-flash";
const STATIC_PREFIX = "S".repeat(8_000);

interface AttemptRow {
  readonly run: number;
  readonly iteration: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
}

/** Fake automatic-prefix-cache provider over the real wire body. */
function prefixCacheProvider() {
  const seen: string[][] = [];
  return {
    async bill(messages: ProviderMessage[]): Promise<{ promptTokens: number; cachedTokens: number }> {
      const body = await captureWireBody(buildOpenRouterParams(messages, TOOLS, configFor(MODEL), false));
      const wire = wireMessages(body).map((m) => JSON.stringify(m));
      const tokens = wire.map((m) => Math.ceil(Buffer.byteLength(m, "utf8") / 4));
      let cachedMessages = 0;
      for (const prior of seen) {
        let shared = 0;
        while (shared < wire.length && shared < prior.length && wire[shared] === prior[shared]) shared += 1;
        cachedMessages = Math.max(cachedMessages, shared);
      }
      seen.push(wire);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      return { promptTokens: sum(tokens), cachedTokens: sum(tokens.slice(0, cachedMessages)) };
    },
  };
}

function reasoning(round: number): ReasoningReplayPayload {
  return requireValue(replayFromCompleteDetails([
    { type: "reasoning.text", text: `Round ${round}: `.padEnd(1_200, "r"), format: "unknown", index: 0 },
  ]));
}

/** Run the scripted session; `replayOn` is the store's switch position. */
async function simulate(replayOn: boolean): Promise<AttemptRow[]> {
  const provider = prefixCacheProvider();
  const rows: AttemptRow[] = [];
  const tape: ProviderMessage[] = [{ role: "user", content: "What is my balance and the SOL price?" }];
  let clock = 0;
  const envelopeOf = (history: ProviderMessage[]) => ({
    providerMessages: [
      { role: "system" as const, content: STATIC_PREFIX, cacheHint: "static_prefix" as const },
      ...history,
      { role: "system" as const, content: `Current time UTC: t+${clock++}`, cacheHint: "turn_state" as const },
    ],
    insertedPlaceholders: 0,
  });

  // Run 1: tool, tool, answer. One store for the run, as in `runTurnLoop`.
  const run1 = createReasoningReplayStore(replayOn);
  const script = [
    { id: "call-1", output: "{\"usd\":12}" },
    { id: "call-2", output: "{\"sol\":151.2}" },
  ];
  for (let iteration = 0; iteration < 3; iteration++) {
    const envelope = run1.attach(envelopeOf(tape), MODEL).envelope;
    rows.push({ run: 1, iteration, ...(await provider.bill(envelope.providerMessages)) });
    const step = script[iteration];
    if (step === undefined) {
      run1.observeRound({ model: MODEL, toolCalls: null, servingProvider: "DeepSeek" });
      tape.push({ role: "assistant", content: "12 USD; SOL is 151.2." });
      break;
    }
    run1.observeRound({
      model: MODEL,
      toolCalls: [{ id: step.id, name: "wallet_balance", arguments: {} }],
      reasoningReplay: reasoning(iteration),
      servingProvider: "DeepSeek",
    });
    tape.push({ role: "assistant", content: "", toolCalls: [{ id: step.id, command: "wallet_balance", args: {} }] });
    tape.push({ role: "tool", content: step.output, toolCallId: step.id });
  }

  // Run 2: the next user turn. A fresh store, as a fresh `runTurnLoop` has.
  tape.push({ role: "user", content: "And ETH?" });
  const run2 = createReasoningReplayStore(replayOn);
  const envelope = run2.attach(envelopeOf(tape), MODEL).envelope;
  rows.push({ run: 2, iteration: 0, ...(await provider.bill(envelope.providerMessages)) });
  return rows;
}

describe("R-7 prompt and cached tokens against a prefix-caching provider", () => {
  it("OFF rows are the pre-R-7 rows, and ON trades a next-run miss for in-run reasoning", async () => {
    const off = await simulate(false);
    const on = await simulate(true);

    // The measured table (pinned so a change to the trade is a visible diff).
    expect(off).toEqual([
      { run: 1, iteration: 0, promptTokens: 2038, cachedTokens: 0 },
      { run: 1, iteration: 1, promptTokens: 2085, cachedTokens: 2025 },
      { run: 1, iteration: 2, promptTokens: 2133, cachedTokens: 2072 },
      { run: 2, iteration: 0, promptTokens: 2156, cachedTokens: 2120 },
    ]);
    expect(on).toEqual([
      { run: 1, iteration: 0, promptTokens: 2038, cachedTokens: 0 },
      { run: 1, iteration: 1, promptTokens: 2407, cachedTokens: 2025 },
      { run: 1, iteration: 2, promptTokens: 2777, cachedTokens: 2394 },
      { run: 2, iteration: 0, promptTokens: 2156, cachedTokens: 2025 },
    ]);

    // Invariants behind the numbers.
    for (let i = 0; i < 3; i++) {
      const onRow = requireValue(on[i]);
      const offRow = requireValue(off[i]);
      // Within the run, ON never serves less from cache than OFF.
      expect(onRow.cachedTokens).toBeGreaterThanOrEqual(offRow.cachedTokens);
      // Uncached work per round grows only by the NEWEST round's reasoning
      // (one ~1.2 KB detail, about 330 tokens with its JSON framing).
      expect(onRow.promptTokens - onRow.cachedTokens).toBeLessThanOrEqual(
        offRow.promptTokens - offRow.cachedTokens + 330,
      );
    }
    // Next run: same prompt as OFF (no replay carried), one-time cache miss
    // from the first replayed message of run 1 onward.
    const offNext = requireValue(off[3]);
    const onNext = requireValue(on[3]);
    expect(onNext.promptTokens).toBe(offNext.promptTokens);
    expect(onNext.cachedTokens).toBeLessThan(offNext.cachedTokens);
  });
});
