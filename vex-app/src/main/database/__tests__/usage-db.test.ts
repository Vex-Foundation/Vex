/**
 * usage-db tests — numeric coercion + zero-row fallback.
 *
 * `pg` returns NUMERIC columns as strings to preserve precision; the
 * mapper coerces to finite JS numbers and falls back to `null` when
 * the value is unparseable or non-finite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getContextWindow, getLastTurn, getSessionTotals } = await import(
  "../usage-db.js"
);

const SESSION = "00000000-0000-4000-8000-00000000dddd";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("usage-db mapper", () => {
  it("returns all-zero totals when no usage_log rows for session", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          total_prompt: "0",
          total_completion: "0",
          total_total: "0",
          total_cached_tokens: "0",
          total_cost: null,
          total_cached_savings: null,
          request_count: "0",
          last_request_at: null,
        },
      ],
    });
    const result = await getSessionTotals(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
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
    });
  });

  it("zero-row result (no rows at all) falls back to the all-zero DTO with new fields", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const result = await getSessionTotals(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
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
    });
  });

  it("coerces NUMERIC strings to JS numbers (incl. cached SUMs)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          total_prompt: "1500",
          total_completion: "750",
          total_total: "2250",
          total_cached_tokens: "900",
          total_cost: "0.0023",
          total_cached_savings: "0.0011",
          request_count: "5",
          last_request_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });
    const result = await getSessionTotals(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalPromptTokens).toBe(1500);
    expect(result.data.totalCompletionTokens).toBe(750);
    expect(result.data.totalCachedTokens).toBe(900);
    expect(result.data.totalCost).toBeCloseTo(0.0023, 6);
    expect(result.data.totalCachedSavings).toBeCloseTo(0.0011, 6);
    expect(result.data.requestCount).toBe(5);
  });

  it("preserves a NEGATIVE cached-savings sum (write-heavy session - never clamped)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          total_prompt: "1000",
          total_completion: "100",
          total_total: "1100",
          total_cached_tokens: "200",
          total_cost: "0.01",
          total_cached_savings: "-0.0033",
          request_count: "1",
          last_request_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });
    const result = await getSessionTotals(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalCachedSavings).toBeCloseTo(-0.0033, 6);
  });

  it("collapses unparseable NUMERIC strings to null cost", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          total_prompt: "10",
          total_completion: "5",
          total_total: "15",
          total_cached_tokens: "0",
          total_cost: "not-a-number",
          total_cached_savings: "not-a-number",
          request_count: "1",
          last_request_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });
    const result = await getSessionTotals(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalCost).toBeNull();
    expect(result.data.totalCachedSavings).toBeNull();
  });

  /**
   * `getLastTurn` reads ONE aggregate row over the turn's window. It is not a
   * `usage_log` row mapper any more, and that is the whole point: the engine
   * writes one row per MODEL ROUND, `runTurnLoop` runs many rounds per turn, so
   * the old `ORDER BY created_at DESC LIMIT 1` described the last round while
   * the panel labelled it a turn (v0.2.6: `OUT 1 / $0.0405` for fifty rounds).
   */
  function rollupRow(over: Record<string, unknown> = {}) {
    return {
      latest_prompt_tokens: "38200",
      latest_cached_tokens: "0",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      latest_created_at: "2026-05-21T10:00:00.000Z",
      turn_completion_tokens: "24600",
      turn_reasoning_tokens: "1200",
      turn_cache_write_tokens: "0",
      turn_cost: "0.0405",
      turn_cached_savings: "0.0004",
      round_count: "50",
      ...over,
    };
  }

  it("getLastTurn returns null for empty session, never an error", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const result = await getLastTurn(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  // An aggregate ALWAYS returns a row; an empty window returns it with
  // `round_count = 0`. That is "no usage yet", not a zero-round turn - the DTO
  // cannot even express `roundCount: 0`.
  it("getLastTurn returns null for a zero-round window, never a fabricated turn", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [rollupRow({ round_count: "0", latest_created_at: null })],
    });
    const result = await getLastTurn(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  it("getLastTurn reports SUMMED output and cost against the LATEST round's input", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [rollupRow()] });
    const result = await getLastTurn(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    // Input is a snapshot: every round re-sends the whole conversation, so
    // summing would count the same tokens fifty times.
    expect(result.data.latestRoundPromptTokens).toBe(38_200);
    // Output and cost are the TURN's sums - the figures the old single-row
    // read under-reported by roughly the round count.
    expect(result.data.turnCompletionTokens).toBe(24_600);
    expect(result.data.turnCost).toBeCloseTo(0.0405, 6);
    expect(result.data.turnReasoningTokens).toBe(1_200);
    expect(result.data.roundCount).toBe(50);
    expect(result.data.provider).toBe("openrouter");
  });

  it("getLastTurn scopes the window to the transcript, not the whole session", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [rollupRow()] });
    await getLastTurn(SESSION, "USD");
    const [sql, params] = mocks.query.mock.calls[0] as [string, readonly unknown[]];
    // The turn boundary is the newest user-sourced message. `messages_archive`
    // is unioned in because compaction moves older messages there; without it a
    // compacted session would lose its boundary and silently widen the window
    // to every round the session ever ran.
    expect(sql).toContain("source = 'user'");
    expect(sql).toContain("messages_archive");
    expect(sql).toContain("created_at >= COALESCE");
    expect(params).toEqual([SESSION, "USD"]);
  });

  it("getLastTurn preserves NEGATIVE summed cached_savings (cache overhead) via toCost", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [rollupRow({ turn_cached_savings: "-0.0021", turn_cache_write_tokens: "8000" })],
    });
    const result = await getLastTurn(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    expect(result.data.turnCachedSavings).toBeCloseTo(-0.0021, 6);
    expect(result.data.turnCacheWriteTokens).toBe(8000);
  });

  it("getLastTurn keeps an uncoercible NUMERIC cost null, never $0", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [rollupRow({ turn_cost: "not-a-number" })],
    });
    const result = await getLastTurn(SESSION, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    expect(result.data.turnCost).toBeNull();
  });

  it("getContextWindow returns null when the session row is missing/deleted/out-of-scope", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const result = await getContextWindow(SESSION, 128_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  it("getContextWindow maps token_count and passes the limit through", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ token_count: "4096" }] });
    const result = await getContextWindow(SESSION, 128_000);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    expect(result.data).toEqual({
      sessionId: SESSION,
      tokensUsed: 4096,
      contextLimit: 128_000,
    });
  });

  it("getContextWindow carries a null limit through (invalid config)", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ token_count: 0 }] });
    const result = await getContextWindow(SESSION, null);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    expect(result.data.contextLimit).toBeNull();
    expect(result.data.tokensUsed).toBe(0);
  });
});
