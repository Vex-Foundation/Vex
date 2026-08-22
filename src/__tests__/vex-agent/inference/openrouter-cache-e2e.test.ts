/**
 * END-TO-END cache-breakpoint assertion (P3 / Codex P2 add b).
 *
 * Beyond the mapper unit tests (openrouter-cache-breakpoints.test.ts), this
 * exercises the FULL path for an explicit-cache (Anthropic) model:
 *
 *   build the NEW assembled prompt stack (buildPromptStack, post-P3 layers)
 *     → construct the 4-segment provider messages exactly like engine/core/turn.ts
 *       (static_prefix system, history w/ history_tail, turn_state system)
 *         → buildOpenRouterParams → assert:
 *            - breakpoint A lands ONLY on the static_prefix system message,
 *            - breakpoint B lands ONLY on the history_tail message,
 *            - turn_state (and summary) stay uncached plain strings.
 *
 * This pins the P2 owner requirement that the decomposition preserves the
 * cache-hint contract: the reordered/renamed static layers still form ONE
 * cache-prefix breakpoint, and the volatile turn-state is never cached.
 */

import { describe, it, expect } from "vitest";

import type { EngineContext } from "../../../vex-agent/engine/types.js";
import { buildPromptStack } from "../../../vex-agent/engine/prompts/index.js";
import { buildRuntimeClockSnapshot } from "../../../vex-agent/engine/runtime-clock.js";
import { buildOpenRouterParams } from "../../../vex-agent/inference/openrouter/params.js";
import type {
  InferenceConfig,
  ProviderMessage,
} from "../../../vex-agent/inference/types.js";

function makeContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: "session-e2e",
    sessionKind: "agent",
    sessionPermission: "full",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    ...overrides,
  } as EngineContext;
}

function anthropicConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    contextLimit: 200_000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: 0.3,
    cacheWritePricePerM: 3.75,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
    ...overrides,
  };
}

/**
 * Replicates engine/core/turn.ts message layout: static prefix system
 * (static_prefix) → history (last non-empty marked history_tail) → turn-state
 * system (turn_state). The joins mirror turn.ts exactly.
 */
function buildProviderMessagesFromStack(context: EngineContext): ProviderMessage[] {
  const stack = buildPromptStack(context, {
    runtimeClock: buildRuntimeClockSnapshot({
      now: new Date("2026-05-03T08:39:18.126Z"),
      timezone: "UTC",
      sessionStartedAt: null,
      missionRunStartedAt: null,
      missionDeadline: null,
    }),
    memorySection: "# Memory\n\n# Memory Routing\n\n- routing line",
    toolCatalogPrompt: "# Available Tool Map\n\n- wallet_balances (read)",
  });

  const staticPrompt = stack.staticLayers.join("\n\n---\n\n");
  const turnStatePrompt = stack.turnLayers.join("\n\n---\n\n");

  return [
    { role: "system", content: staticPrompt, cacheHint: "static_prefix" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "what's my ETH balance?", cacheHint: "history_tail" },
    { role: "system", content: turnStatePrompt, cacheHint: "turn_state" },
  ];
}

interface TextPart {
  type: string;
  text: string;
  cacheControl?: { type: string };
}

function cacheControlledIndices(messages: ReadonlyArray<{ content?: unknown }>): number[] {
  const indices: number[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    if ((m.content as TextPart[]).some((p) => p.cacheControl !== undefined)) indices.push(i);
  });
  return indices;
}

describe("cache breakpoints land on the NEW assembled prompt stack (P3 e2e)", () => {
  it("breakpoint A on static_prefix only, B on history_tail only, turn_state uncached", () => {
    const messages = buildProviderMessagesFromStack(makeContext());
    const params = buildOpenRouterParams(messages, [], anthropicConfig(), false);

    // The static system message (index 0) carries the WHOLE decomposed prefix
    // as a single cache-controlled text part — proving the reordered/renamed
    // layers still form ONE breakpoint.
    const staticParts = params.messages[0].content as TextPart[];
    expect(Array.isArray(staticParts)).toBe(true);
    expect(staticParts).toHaveLength(1);
    expect(staticParts[0].cacheControl).toEqual({ type: "ephemeral" });
    // The prefix really is the new assembled stack (authority-first order).
    expect(staticParts[0].text).toContain("# Identity");
    expect(staticParts[0].text).toContain("# Execution Policy");
    expect(staticParts[0].text).toContain("# Safety Contract");
    expect(staticParts[0].text).toContain("# Tool Model");
    expect(staticParts[0].text).toContain("# Protocols");
    expect(staticParts[0].text).toContain("# Memory & Learning");
    expect(staticParts[0].text).toContain("# Research");
    expect(staticParts[0].text).toContain("# Response Formatting");
    // Identity is FIRST, Execution Policy is right after it (slot 2).
    expect(staticParts[0].text.indexOf("# Identity")).toBeLessThan(
      staticParts[0].text.indexOf("# Execution Policy"),
    );

    // Breakpoint B: the history_tail user message.
    const tailIdx = params.messages.findIndex(
      (m) => Array.isArray(m.content) && (m.content as TextPart[]).some((p) => p.text === "what's my ETH balance?"),
    );
    expect(params.messages[tailIdx].role).toBe("user");
    const tailParts = params.messages[tailIdx].content as TextPart[];
    expect(tailParts[tailParts.length - 1].cacheControl).toEqual({ type: "ephemeral" });

    // EXACTLY two breakpoint carriers: static_prefix (A) + history_tail (B).
    expect(cacheControlledIndices(params.messages)).toEqual([0, tailIdx]);

    // turn_state is the LAST message and stays a plain uncached string; it
    // carries the volatile runtime clock (never in the static prefix).
    const turnState = params.messages[params.messages.length - 1];
    expect(turnState.role).toBe("system");
    expect(typeof turnState.content).toBe("string");
    expect(turnState.content as string).toContain("# Runtime Clock");
  });

  it("auto-prefix (non-Anthropic) model keeps the exact byte-shape: all plain strings", () => {
    const messages = buildProviderMessagesFromStack(makeContext());
    const params = buildOpenRouterParams(messages, [], anthropicConfig({ model: "deepseek/deepseek-chat" }), false);
    for (const m of params.messages) {
      expect(typeof m.content === "string" || m.content === undefined).toBe(true);
    }
  });
});
