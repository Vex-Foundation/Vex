/**
 * The property that matters: on a ceiling breach the request is NEVER issued.
 *
 * Everything else in this gate is bookkeeping. If a breach could ever reach
 * `executeTurn`, the barrier bypass would have removed the only thing stopping
 * an over-limit request, which is the exact failure C8 exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  InferenceConfig,
  ProviderMessage,
  ToolDefinition,
} from "../../../../vex-agent/inference/types.js";
import type { PreInferenceGateInput } from "../../../../vex-agent/engine/core/turn-loop/pre-inference-ceiling.js";

const mockTryCriticalBandFallback = vi.fn();
vi.mock("../../../../vex-agent/engine/core/turn-loop-critical-fallback.js", () => ({
  tryCriticalBandFallback: (...a: unknown[]) => mockTryCriticalBandFallback(...a),
  COMPACT_MAX_CONSECUTIVE_NOOPS: 2,
}));

const { checkPreInferenceGate } = await import(
  "../../../../vex-agent/engine/core/turn-loop/pre-inference-ceiling.js"
);

const CONFIG: InferenceConfig = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4",
  contextLimit: 200_000,
  maxOutputTokens: 8192,
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceCurrency: "USD",
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
  supportsReasoningEffort: false,
};

const SMALL_MESSAGES: ProviderMessage[] = [
  { role: "system", content: "prefix", cacheHint: "static_prefix" },
  { role: "user", content: "hello" },
  { role: "system", content: "turn state", cacheHint: "turn_state" },
];

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "execute_swap",
      description: "Moves funds.",
      parameters: { type: "object", properties: { amount: { type: "string" } } },
    },
  },
];

function input(over: Partial<PreInferenceGateInput> = {}): PreInferenceGateInput {
  return {
    sessionId: "s-1",
    missionRunId: null,
    sessionPermission: "restricted",
    preparationBypassesBarrier: true,
    providerMessages: SMALL_MESSAGES,
    tools: TOOLS,
    config: CONFIG,
    contextLimit: 200_000,
    currentTokenCount: 180_000,
    criticalNoopCounter: 0,
    // The gate's ladder needs a lease owner to force a prepared apply; these
    // tests drive the deterministic path, so the explicit fail-closed answer.
    runnerOwnerId: undefined,
    ...over,
  };
}

describe("pre-inference ceiling gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT run at all when the barrier is intact", async () => {
    const outcome = await checkPreInferenceGate(
      input({ preparationBypassesBarrier: false, contextLimit: 1 }),
    );

    // Even with an absurd limit that would certainly breach: the barrier is
    // already doing this job, and the ceiling is the bypass's price.
    expect(outcome).toEqual({ kind: "proceed" });
    expect(mockTryCriticalBandFallback).not.toHaveBeenCalled();
  });

  it("proceeds when the measured request fits", async () => {
    const outcome = await checkPreInferenceGate(input());

    expect(outcome).toEqual({ kind: "proceed" });
    expect(mockTryCriticalBandFallback).not.toHaveBeenCalled();
  });

  it("BREACH ⇒ never proceeds; relieves pressure and restarts the iteration", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "committed",
      nextCriticalNoopCounter: 0,
    });

    const outcome = await checkPreInferenceGate(input({ contextLimit: 10 }));

    expect(outcome).toEqual({
      kind: "retry_iteration",
      committed: true,
      nextCriticalNoopCounter: 0,
    });
    expect(mockTryCriticalBandFallback).toHaveBeenCalledTimes(1);
  });

  it("forces the ladder to run as CRITICAL and overrides the one-shot skip", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "committed",
      nextCriticalNoopCounter: 0,
    });

    await checkPreInferenceGate(input({ contextLimit: 10 }));

    // A measured over-limit envelope IS the critical condition, whatever the
    // one-turn-lagging token count says — and there is nothing stale to skip.
    expect(mockTryCriticalBandFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        turnBand: "critical",
        skipCriticalCheckNextIter: false,
      }),
    );
  });

  it("a queued Stop (gate_deferred) still blocks the request, counter untouched", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "gate_deferred",
      nextCriticalNoopCounter: 1,
      reason: "stop_queued",
    });

    const outcome = await checkPreInferenceGate(
      input({ contextLimit: 10, criticalNoopCounter: 1 }),
    );

    expect(outcome).toEqual({
      kind: "retry_iteration",
      committed: false,
      nextCriticalNoopCounter: 1,
    });
  });

  it("a NOOP still blocks the request, and advances the counter so it can escalate", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "noop",
      nextCriticalNoopCounter: 1,
      reason: "no_compactable",
    });

    const outcome = await checkPreInferenceGate(input({ contextLimit: 10 }));

    expect(outcome).toEqual({
      kind: "retry_iteration",
      committed: false,
      nextCriticalNoopCounter: 1,
    });
  });

  it("escalation propagates the stop reason instead of retrying forever", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "escalated",
      stopReason: "compact_unable_at_critical",
      consecutiveNoops: 2,
      pressureFraction: 0.99,
    });

    const outcome = await checkPreInferenceGate(input({ contextLimit: 10 }));

    expect(outcome).toEqual({
      kind: "escalated",
      stopReason: "compact_unable_at_critical",
    });
  });

  it("an UNMEASURABLE request is treated as a breach, not waved through", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "noop",
      nextCriticalNoopCounter: 1,
      reason: "no_compactable",
    });

    const outcome = await checkPreInferenceGate(
      input({ config: { ...CONFIG, provider: "some-future-provider" } }),
    );

    // Fail-closed: with the barrier bypassed there is no other evidence the
    // request fits, so an unmeasured one must not be issued.
    expect(outcome.kind).toBe("retry_iteration");
    expect(mockTryCriticalBandFallback).toHaveBeenCalledTimes(1);
  });

  it("measures the messages it is GIVEN — a bigger tape breaches where a small one does not", async () => {
    mockTryCriticalBandFallback.mockResolvedValue({
      kind: "noop",
      nextCriticalNoopCounter: 1,
      reason: "no_compactable",
    });
    const big: ProviderMessage[] = [
      { role: "system", content: "x".repeat(50_000), cacheHint: "static_prefix" },
      { role: "system", content: "turn state", cacheHint: "turn_state" },
    ];

    const small = await checkPreInferenceGate(input({ contextLimit: 40_000 }));
    const large = await checkPreInferenceGate(
      input({ contextLimit: 40_000, providerMessages: big }),
    );

    expect(small.kind).toBe("proceed");
    expect(large.kind).toBe("retry_iteration");
  });
});
