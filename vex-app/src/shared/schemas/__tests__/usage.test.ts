import { describe, expect, it } from "vitest";
import {
  contextWindowDtoSchema,
  contextWindowResultSchema,
  lastTurnUsageResultSchema,
  sessionUsageTotalsDtoSchema,
  turnUsageDtoSchema,
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
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 10,
      reasoningTokens: 5,
      cost: 0.001,
      cachedSavings: 0.0004,
      cacheWriteTokens: 12,
      currency: "USD",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.7",
      createdAt: ISO,
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

  it("turnUsageDtoSchema accepts a typical row with USD currency", () => {
    const parsed = turnUsageDtoSchema.safeParse(turnFixture());
    expect(parsed.success).toBe(true);
  });

  it("turnUsageDtoSchema requires the cache fields (missing cachedSavings/cacheWriteTokens fails)", () => {
    const { cachedSavings: _s, cacheWriteTokens: _w, ...withoutCacheFields } = turnFixture();
    expect(turnUsageDtoSchema.safeParse(withoutCacheFields).success).toBe(false);
  });

  it("turnUsageDtoSchema accepts NEGATIVE cachedSavings (net cache overhead is real - no .min(0))", () => {
    const parsed = turnUsageDtoSchema.safeParse(
      turnFixture({ cachedSavings: -0.0021, cacheWriteTokens: 8000 }),
    );
    expect(parsed.success).toBe(true);
  });

  it("turnUsageDtoSchema rejects negative cacheWriteTokens (int ≥ 0)", () => {
    expect(
      turnUsageDtoSchema.safeParse(turnFixture({ cacheWriteTokens: -1 })).success,
    ).toBe(false);
  });

  it("turnUsageDtoSchema rejects unknown keys (strict)", () => {
    expect(
      turnUsageDtoSchema.safeParse(turnFixture({ extraKey: true })).success,
    ).toBe(false);
  });

  it("turnUsageDtoSchema rejects negative token counts", () => {
    const parsed = turnUsageDtoSchema.safeParse(
      turnFixture({
        promptTokens: -1,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        cost: null,
        provider: null,
        model: null,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("turnUsageDtoSchema permits nullable provider/model/cost/cachedSavings for legacy rows", () => {
    const parsed = turnUsageDtoSchema.safeParse(
      turnFixture({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        cost: null,
        cachedSavings: null,
        cacheWriteTokens: 0,
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

  it("lastTurnUsageResultSchema accepts null (empty session) and a turn DTO", () => {
    expect(lastTurnUsageResultSchema.safeParse(null).success).toBe(true);
    expect(
      lastTurnUsageResultSchema.safeParse(
        turnFixture({
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          cachedSavings: 0,
          cacheWriteTokens: 0,
          provider: null,
          model: null,
        }),
      ).success,
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
