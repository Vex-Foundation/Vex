/**
 * The pre-inference ceiling must not DROP the lease owner on its way into the
 * critical ladder.
 *
 * Why this is its own file rather than a case in `pre-inference-ceiling.test.ts`:
 * that file mocks `tryCriticalBandFallback`, so it can only assert what the
 * ceiling passes. The defect this covers lives one level down — a missing owner
 * makes `resolveCriticalCompaction` SILENTLY skip the prepared apply and run the
 * deterministic fallback instead. Proving C8's "force the prepared apply when
 * one is ready" therefore needs the REAL ladder underneath, with only its two
 * leaves (the forced apply and the deterministic fallback) mocked.
 *
 * The property: a ceiling breach with a `summary_ready` preparation applies the
 * prepared summary, and NEVER reaches the deterministic fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  InferenceConfig,
  ProviderMessage,
  ToolDefinition,
} from "../../../../vex-agent/inference/types.js";
import type { PreparationPressureState } from "../../../../vex-agent/engine/core/preparation-pressure-state.js";

const mockForcePreparedApply = vi.fn();
const mockForcedFallback = vi.fn();
const mockReadPreparationState = vi.fn();

vi.mock("../../../../vex-agent/engine/compaction/apply/index.js", () => ({
  forcePreparedApply: (...a: unknown[]) => mockForcePreparedApply(...a),
}));
vi.mock("../../../../vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) => mockForcedFallback(...a),
}));
vi.mock("../../../../vex-agent/db/repos/compaction-preparations/index.js", () => ({
  getLivePreparationPressureState: (...a: unknown[]) =>
    mockReadPreparationState(...a),
}));

const { checkPreInferenceGate } = await import(
  "../../../../vex-agent/engine/core/turn-loop/pre-inference-ceiling.js"
);

const READY: PreparationPressureState = {
  kind: "summary_ready",
  preparationId: "p1",
};

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

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "prefix", cacheHint: "static_prefix" },
  { role: "user", content: "hello" },
];

const TOOLS: ToolDefinition[] = [];

const OWNER = "wake-executor-42";

describe("pre-inference ceiling — lease ownership reaches the critical ladder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPreparationState.mockResolvedValue(READY);
    mockForcePreparedApply.mockResolvedValue({
      kind: "applied",
      generation: 7,
      archivedMessages: 12,
    });
    mockForcedFallback.mockResolvedValue({ kind: "committed", generation: 8 });
  });

  it("forces the prepared apply on a breach with a ready summary, and never falls back", async () => {
    const outcome = await checkPreInferenceGate({
      sessionId: "s-1",
      missionRunId: null,
      sessionPermission: "restricted",
      preparationBypassesBarrier: true,
      providerMessages: MESSAGES,
      tools: TOOLS,
      config: CONFIG,
      // A ceiling far below the envelope ⇒ guaranteed breach.
      contextLimit: 10,
      currentTokenCount: 9,
      criticalNoopCounter: 0,
      runnerOwnerId: OWNER,
    });

    expect(mockForcePreparedApply).toHaveBeenCalledTimes(1);
    expect(mockForcePreparedApply.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "s-1",
      runnerOwnerId: OWNER,
    });
    // The whole point: the deterministic fallback is NOT the path taken.
    expect(mockForcedFallback).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "retry_iteration",
      committed: true,
      nextCriticalNoopCounter: 0,
    });
  });

  it("falls back deterministically when the caller genuinely holds no lease", async () => {
    const outcome = await checkPreInferenceGate({
      sessionId: "s-1",
      missionRunId: null,
      sessionPermission: "restricted",
      preparationBypassesBarrier: true,
      providerMessages: MESSAGES,
      tools: TOOLS,
      config: CONFIG,
      contextLimit: 10,
      currentTokenCount: 9,
      criticalNoopCounter: 0,
      runnerOwnerId: undefined,
    });

    // Fail-closed: no proven ownership ⇒ no forced apply, ever.
    expect(mockForcePreparedApply).not.toHaveBeenCalled();
    expect(mockForcedFallback).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("retry_iteration");
  });
});
