/**
 * `loop_defer` and the THIRD watch outcome: the condition is already true.
 *
 * The other two outcomes both park. This one must not: arming a watch for an
 * event that has already happened would sleep the session until its timer
 * expires, which is the exact opposite of what the model asked for. So no wake
 * row is written, no `defer_until` signal is emitted, and the model is told to
 * act now.
 *
 * A rejected condition sitting NEXT TO a satisfied one does not change that -
 * the reason to stay awake is the satisfied one, and a warning about the other
 * still travels back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTestContext } from "../_test-context.js";
import { validateTokensPairsResponse } from "@tools/dexscreener/validation.js";
import { TOKEN_PRICE_WATCH_BUDGET } from "@vex-agent/engine/wake/watch/token-price.js";
import {
  WakeWatchSatisfiedError,
  registerWakeWatchEvaluator,
} from "@vex-agent/engine/wake/watch-registry.js";

const mockEnqueue = vi.fn();
const mockGetPendingWithWatchType = vi.fn();
const mockGetTokenPairs = vi.fn();

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  cancelForSession: vi.fn(),
  claimDue: vi.fn(),
  getPendingForSession: vi.fn(),
  getPendingWithWatchType: (...args: unknown[]) => mockGetPendingWithWatchType(...args),
}));

vi.mock("@tools/dexscreener/client.js", () => ({
  getDexScreenerClient: () => ({
    getTokenPairs: (...args: unknown[]) => mockGetTokenPairs(...args),
  }),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  queryOneWith: vi.fn().mockResolvedValue(null),
  getPool: () => ({ connect: vi.fn() }),
}));

const { handleLoopDefer } = await import(
  "../../../../vex-agent/tools/internal/loop-defer.js"
);

registerWakeWatchEvaluator({
  type: "already_true",
  validate: async () => {
    throw new WakeWatchSatisfiedError("the price is ALREADY above your threshold: 1.62 USD.");
  },
  isTriggered: () => false,
});

registerWakeWatchEvaluator({
  type: "never_armable",
  validate: async () => {
    throw new Error("unknown order id");
  },
  isTriggered: () => false,
});

function ctxMissionActive() {
  return makeTestContext({
    sessionId: "session-mission-1",
    sessionPermission: "restricted",
    sessionKind: "mission",
    missionRunId: "run-abc",
  });
}

beforeEach(() => {
  mockGetPendingWithWatchType.mockReset().mockResolvedValue([]);
  mockGetTokenPairs.mockReset().mockResolvedValue([]);
  mockEnqueue.mockReset().mockResolvedValue({
    id: "wake-uuid-xyz",
    sessionId: "session-mission-1",
    missionRunId: "run-abc",
    dueAt: "2026-08-10T12:05:00.000Z",
    status: "pending",
    reason: "waiting",
    payload: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
  });
});

describe("loop_defer - a satisfied watch cancels the sleep", () => {
  it("writes no wake row and emits no defer signal", async () => {
    const result = await handleLoopDefer(
      { after_ms: 600_000, reason: "waiting for the price", watch: [{ type: "already_true" }] },
      ctxMissionActive(),
    );

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.engineSignal).toBeUndefined();
    expect(result.output).toMatch(/already/i);
    expect(result.output).toContain("1.62");
    expect(result.data?.deferred).toBe(false);
    expect(result.data?.watch_satisfied).toHaveLength(1);
  });

  it("still reports an unarmable sibling condition, and still does not park", async () => {
    const result = await handleLoopDefer(
      {
        after_ms: 600_000,
        reason: "waiting for the price",
        watch: [{ type: "never_armable" }, { type: "already_true" }],
      },
      ctxMissionActive(),
    );

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.output).toContain("unknown order id");
    expect(result.data?.watch_rejected).toHaveLength(1);
  });

  it("parks normally when nothing is satisfied, so the fail-open law is intact", async () => {
    const result = await handleLoopDefer(
      { after_ms: 600_000, reason: "waiting", watch: [{ type: "never_armable" }] },
      ctxMissionActive(),
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(result.engineSignal?.type).toBe("defer_until");
    expect(result.data?.watch_rejected).toHaveLength(1);
  });
});

// ── The real token_price evaluator, at the budget ceiling ──────────

describe("loop_defer - an over-budget token_price condition that is already true", () => {
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  function usdcPools() {
    const path = fileURLToPath(
      new URL("../../../dexscreener/fixtures/token-pairs-usdc-base.json", import.meta.url),
    );
    return validateTokensPairsResponse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Every one of the budget's slots taken by OTHER tokens. */
  function budgetFull() {
    return Array.from({ length: TOKEN_PRICE_WATCH_BUDGET }, (_v, index) => ({
      payload: {
        watchId: `watch-${index}`,
        conditions: [{
          type: "token_price",
          chain: "base",
          tokenAddress: `0x${String(index).padStart(40, "0")}`,
          direction: "above",
          priceUsd: "5",
        }],
      },
    }));
  }

  it("does not park, and does not blame the budget - the watch it would need is free", async () => {
    mockGetPendingWithWatchType.mockResolvedValue(budgetFull());
    mockGetTokenPairs.mockResolvedValue(usdcPools());

    const result = await handleLoopDefer(
      {
        after_ms: 600_000,
        reason: "waiting for USDC above 0.5",
        // The fixture prices USDC at 1, so this threshold is already crossed.
        watch: [{
          type: "token_price",
          chain: "base",
          tokenAddress: USDC_BASE,
          direction: "above",
          priceUsd: "0.5",
        }],
      },
      ctxMissionActive(),
    );

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result.engineSignal).toBeUndefined();
    expect(result.data?.deferred).toBe(false);
    expect(result.data?.watch_satisfied).toHaveLength(1);
    expect(result.output).not.toMatch(/budget/i);
    expect(result.output).toMatch(/already/i);
  });

  it("still refuses an over-budget condition that is NOT yet true, and parks on the timer", async () => {
    mockGetPendingWithWatchType.mockResolvedValue(budgetFull());
    mockGetTokenPairs.mockResolvedValue(usdcPools());

    const result = await handleLoopDefer(
      {
        after_ms: 600_000,
        reason: "waiting for USDC above 5",
        watch: [{
          type: "token_price",
          chain: "base",
          tokenAddress: USDC_BASE,
          direction: "above",
          priceUsd: "5",
        }],
      },
      ctxMissionActive(),
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(result.engineSignal?.type).toBe("defer_until");
    const rejected = result.data?.watch_rejected as readonly string[] | undefined;
    expect(rejected?.[0]).toMatch(/budget/i);
  });
});
