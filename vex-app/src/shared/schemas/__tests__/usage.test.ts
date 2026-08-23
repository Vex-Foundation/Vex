import { describe, expect, it } from "vitest";
import {
  contextWindowDtoSchema,
  contextWindowResultSchema,
  lastTurnUsageResultSchema,
  sessionUsageTotalsDtoSchema,
  turnUsageRollupDtoSchema,
  usageInputSchema,
  USAGE_DEFAULT_CURRENCY,
} from "../usage.js";

const SESSION = "00000000-0000-4000-8000-000000000005";
const ISO = "2026-05-21T10:00:00.000Z";

describe("usage schemas", () => {
  // Canonical strict fixtures — the new cache-savings fields are REQUIRED.
  function turnFixture(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: SESSION,
      latestRoundPromptTokens: 100,
      latestRoundCachedTokens: 10,
      turnCompletionTokens: 50,
      turnReasoningTokens: 5,
      turnCacheWriteTokens: 12,
      turnCost: 0.001,
      turnCachedSavings: 0.0004,
      roundCount: 3,
      currency: "USD",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.7",
      latestRoundAt: ISO,
      ...overrides,
    };
  }

  function totalsFixture(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: SESSION,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCachedTokens: 0,
      totalCost: null,
      totalCachedSavings: null,
      currency: "USD",
      requestCount: 0,
      lastRequestAt: null,
      ...overrides,
    };
  }

  it("turnUsageRollupDtoSchema accepts a typical multi-round rollup", () => {
    expect(turnUsageRollupDtoSchema.safeParse(turnFixture()).success).toBe(true);
  });

  it("turnUsageRollupDtoSchema requires the cache fields", () => {
    const { turnCachedSavings: _s, turnCacheWriteTokens: _w, ...without } = turnFixture();
    expect(turnUsageRollupDtoSchema.safeParse(without).success).toBe(false);
  });

  it("turnUsageRollupDtoSchema accepts NEGATIVE turnCachedSavings (net cache overhead is real - no .min(0))", () => {
    const parsed = turnUsageRollupDtoSchema.safeParse(
      turnFixture({ turnCachedSavings: -0.0021, turnCacheWriteTokens: 8000 }),
    );
    expect(parsed.success).toBe(true);
  });

  it("turnUsageRollupDtoSchema rejects negative turnCacheWriteTokens (int >= 0)", () => {
    expect(
      turnUsageRollupDtoSchema.safeParse(turnFixture({ turnCacheWriteTokens: -1 })).success,
    ).toBe(false);
  });

  it("turnUsageRollupDtoSchema rejects unknown keys (strict)", () => {
    expect(
      turnUsageRollupDtoSchema.safeParse(turnFixture({ extraKey: true })).success,
    ).toBe(false);
  });

  it("turnUsageRollupDtoSchema rejects negative token counts", () => {
    expect(
      turnUsageRollupDtoSchema.safeParse(turnFixture({ latestRoundPromptTokens: -1 })).success,
    ).toBe(false);
    expect(
      turnUsageRollupDtoSchema.safeParse(turnFixture({ turnCompletionTokens: -1 })).success,
    ).toBe(false);
  });

  // A rollup describes at least one model round by construction: `getLastTurn`
  // returns `null`, never a zero-round DTO, for an empty window. Pinning
  // `min(1)` keeps "no usage yet" from being expressible as a fake turn.
  it("turnUsageRollupDtoSchema rejects roundCount below 1", () => {
    expect(turnUsageRollupDtoSchema.safeParse(turnFixture({ roundCount: 0 })).success).toBe(false);
  });

  it("turnUsageRollupDtoSchema permits nullable provider/model/cost/savings for legacy rows", () => {
    const parsed = turnUsageRollupDtoSchema.safeParse(
      turnFixture({
        turnCost: null,
        turnCachedSavings: null,
        provider: null,
        model: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("sessionUsageTotalsDtoSchema accepts all-zero totals (empty session)", () => {
    const parsed = sessionUsageTotalsDtoSchema.safeParse(totalsFixture());
    expect(parsed.success).toBe(true);
  });

  it("sessionUsageTotalsDtoSchema requires the new cache totals fields", () => {
    const { totalCachedTokens: _t, totalCachedSavings: _s, ...without } = totalsFixture();
    expect(sessionUsageTotalsDtoSchema.safeParse(without).success).toBe(false);
  });

  it("sessionUsageTotalsDtoSchema accepts a NEGATIVE totalCachedSavings (no .min(0))", () => {
    const parsed = sessionUsageTotalsDtoSchema.safeParse(
      totalsFixture({
        totalPromptTokens: 1000,
        totalTokens: 1100,
        totalCachedTokens: 200,
        totalCost: 0.01,
        totalCachedSavings: -0.0033,
        requestCount: 1,
        lastRequestAt: ISO,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("sessionUsageTotalsDtoSchema rejects negative totalCachedTokens and unknown keys", () => {
    expect(
      sessionUsageTotalsDtoSchema.safeParse(totalsFixture({ totalCachedTokens: -1 })).success,
    ).toBe(false);
    expect(
      sessionUsageTotalsDtoSchema.safeParse(totalsFixture({ extraKey: 1 })).success,
    ).toBe(false);
  });

  it("usageInputSchema defaults currency to USD", () => {
    const parsed = usageInputSchema.safeParse({ sessionId: SESSION });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currency).toBe(USAGE_DEFAULT_CURRENCY);
  });

  it("lastTurnUsageResultSchema accepts null (empty session) and a turn rollup", () => {
    expect(lastTurnUsageResultSchema.safeParse(null).success).toBe(true);
    expect(
      lastTurnUsageResultSchema.safeParse(turnFixture({ roundCount: 1 })).success,
    ).toBe(true);
  });

  it("contextWindowDtoSchema accepts a numeric limit and a null limit", () => {
    expect(
      contextWindowDtoSchema.safeParse({
        sessionId: SESSION,
        tokensUsed: 1234,
        contextLimit: 128_000,
      }).success,
    ).toBe(true);
    expect(
      contextWindowDtoSchema.safeParse({
        sessionId: SESSION,
        tokensUsed: 0,
        contextLimit: null,
      }).success,
    ).toBe(true);
  });

  it("contextWindowDtoSchema rejects negative tokensUsed and a non-positive limit", () => {
    expect(
      contextWindowDtoSchema.safeParse({
        sessionId: SESSION,
        tokensUsed: -1,
        contextLimit: 128_000,
      }).success,
    ).toBe(false);
    expect(
      contextWindowDtoSchema.safeParse({
        sessionId: SESSION,
        tokensUsed: 0,
        contextLimit: 0,
      }).success,
    ).toBe(false);
  });

  it("contextWindowDtoSchema rejects unknown keys (strict)", () => {
    expect(
      contextWindowDtoSchema.safeParse({
        sessionId: SESSION,
        tokensUsed: 1,
        contextLimit: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("contextWindowResultSchema accepts null (missing/deleted session)", () => {
    expect(contextWindowResultSchema.safeParse(null).success).toBe(true);
  });
});

/**
 * The context-pressure band edges the meter draws. They have exactly ONE
 * owner — the engine's `context-pressure-policy.ts` — and travel to the
 * renderer on this DTO so no marker can drift from the fraction that actually
 * gates compaction. The fields are OPTIONAL so a payload minted by an older
 * main still parses (both sides validate this DTO).
 */
describe("contextWindowDtoSchema - pressure bands (additive)", () => {
  const BASE = { sessionId: SESSION, tokensUsed: 100, contextLimit: 200_000 };

  it("accepts a payload WITHOUT the fractions (older main, backward compatible)", () => {
    expect(contextWindowDtoSchema.safeParse(BASE).success).toBe(true);
  });

  it("accepts the engine's real band edges", () => {
    const parsed = contextWindowDtoSchema.safeParse({
      ...BASE,
      pressureWarningFraction: 0.85,
      pressureBarrierFraction: 0.88,
      pressureCriticalFraction: 0.92,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pressureBarrierFraction).toBe(0.88);
  });

  it("rejects out-of-range fractions - a marker outside the bar is meaningless", () => {
    for (const bad of [0, -0.1, 1.5]) {
      expect(
        contextWindowDtoSchema.safeParse({
          ...BASE,
          pressureBarrierFraction: bad,
        }).success,
      ).toBe(false);
    }
  });
});
