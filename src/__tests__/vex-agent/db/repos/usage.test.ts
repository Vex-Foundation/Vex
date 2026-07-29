/**
 * usage repo — logUsage column wiring. Pins the two cache-savings columns
 * added by migration 032 (`cached_savings`, `cache_write_tokens`): values
 * flow through when provided (negative savings included — recorded
 * truthfully) and default to 0 when absent.
 *
 * Also pins the two provenance columns added by migration 055
 * (`generation_id`, `finish_reason`). These assert POSITIONALLY on purpose:
 * `logUsage` is awaited WITHOUT a try/catch on the turn path, so a parameter
 * list that drifts out of step with the column list would fail EVERY turn.
 * Their absent case is NULL, not 0 — "the provider reported nothing" is not
 * the same claim as "the provider reported zero".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  execute: (...a: unknown[]) => mockExecute(...a),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

const { logUsage } = await import("@vex-agent/db/repos/usage.js");

describe("usage repo — logUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("inserts cached_savings + cache_write_tokens with provided values (negative savings preserved)", async () => {
    await logUsage("session-1", {
      promptTokens: 1000,
      completionTokens: 200,
      cost: 0.001,
      cachedTokens: 600,
      cachedSavings: -0.0033,
      cacheWriteTokens: 8000,
      reasoningTokens: 0,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      currency: "USD",
      generationId: "gen-1751234567-abcdef",
      finishReason: "stop",
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("cached_savings");
    expect(sql).toContain("cache_write_tokens");
    expect(sql).toContain("generation_id");
    expect(sql).toContain("finish_reason");
    // Positional params:
    // [..., currency, cached_savings, cache_write_tokens, generation_id, finish_reason]
    expect(params).toEqual([
      "session-1", 1000, 200, 1200, 600, 0, 0.001,
      "openrouter", "anthropic/claude-sonnet-4", "USD",
      -0.0033, 8000,
      "gen-1751234567-abcdef", "stop",
    ]);
  });

  it("defaults cachedSavings and cacheWriteTokens to 0 when omitted", async () => {
    await logUsage("session-1", {
      promptTokens: 10,
      completionTokens: 5,
      cost: 0,
    });

    const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(params[10]).toBe(0); // cached_savings
    expect(params[11]).toBe(0); // cache_write_tokens
  });

  it("writes NULL — not 0 or '' — for generation_id / finish_reason when unreported", async () => {
    await logUsage("session-1", {
      promptTokens: 10,
      completionTokens: 5,
      cost: 0,
    });

    const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(params[12]).toBeNull(); // generation_id
    expect(params[13]).toBeNull(); // finish_reason
  });

  it("carries an explicit null through unchanged (aborted turn, nothing reported)", async () => {
    await logUsage("session-1", {
      promptTokens: 10,
      completionTokens: 5,
      cost: 0,
      generationId: null,
      finishReason: null,
    });

    const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(params[12]).toBeNull();
    expect(params[13]).toBeNull();
  });

  it("keeps the parameter count in step with the column list", async () => {
    // Guards the failure mode that makes this repo dangerous: a column added
    // to the INSERT list without a matching `$n` (or vice versa) throws on
    // EVERY turn, because the turn path awaits logUsage with no try/catch.
    await logUsage("session-1", { promptTokens: 1, completionTokens: 1, cost: 0 });

    const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    const columnCount = sql.split("INSERT INTO usage_log (")[1].split(")")[0].split(",").length;
    const placeholderCount = sql.split("VALUES (")[1].split(")")[0].split(",").length;
    expect(columnCount).toBe(placeholderCount);
    expect(params).toHaveLength(columnCount);
  });
});
