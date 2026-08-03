import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { providerHttpError } from "./_provider-http-error.js";

/**
 * W1-F — discovery & social tools: profile, pnlHistory, leaderboards,
 * vaultInfo, suggestedEvents. New tools, so this is a NEW test file (not an
 * addition to solana-jupiter-handlers-predict.test.ts) covering: required-
 * param validation (including the required-but-SDK-optional enum fields on
 * pnlHistory/leaderboards), money conversion on Profile/PnlHistory/
 * Leaderboard rows (W1-B convention), vaultInfo's verbatim passthrough (no
 * `Usd`-suffixed field to convert), and suggestedEvents' reuse of the shared
 * `toPredictView` lean-by-default projector.
 */
const {
  getJupiterPredictionProfile,
  getJupiterPredictionPnlHistory,
  getJupiterPredictionLeaderboards,
  getJupiterPredictionVaultInfo,
  getJupiterPredictionSuggestedEvents,
} = vi.hoisted(() => ({
  getJupiterPredictionProfile: vi.fn(),
  getJupiterPredictionPnlHistory: vi.fn(),
  getJupiterPredictionLeaderboards: vi.fn(),
  getJupiterPredictionVaultInfo: vi.fn(),
  getJupiterPredictionSuggestedEvents: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionProfile,
  getJupiterPredictionPnlHistory,
  getJupiterPredictionLeaderboards,
  getJupiterPredictionVaultInfo,
  getJupiterPredictionSuggestedEvents,
  // Re-exported by the aggregator's other handler modules (predict.ts,
  // predict-orders.ts) but unused by these tests; inert stubs so the mock
  // fully replaces the real (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
  getJupiterPredictionOrderbook: vi.fn(),
  getJupiterPredictionTradingStatus: vi.fn(),
  getJupiterPredictionOrders: vi.fn(),
  getJupiterPredictionOrder: vi.fn(),
  getJupiterPredictionOrderStatus: vi.fn(),
  getJupiterPredictionTrades: vi.fn(),
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("solana-jupiter handlers — predict discovery & social (W1-F)", () => {
  beforeEach(() => {
    getJupiterPredictionProfile.mockReset();
    getJupiterPredictionPnlHistory.mockReset();
    getJupiterPredictionLeaderboards.mockReset();
    getJupiterPredictionVaultInfo.mockReset();
    getJupiterPredictionSuggestedEvents.mockReset();
  });

  // ── profile ──────────────────────────────────────────────────────

  const FULL_PROFILE = {
    ownerPubkey: ADDRESS,
    // Money (W1-B): micro-USD wire values (1,000,000 native units = $1.00).
    realizedPnlUsd: "12340000",
    totalVolumeUsd: "500000000",
    predictionsCount: "10",
    correctPredictions: "7",
    wrongPredictions: "3",
    totalActiveContracts: "5",
    totalActiveContractsMicro: "5000000",
    totalActiveContractsDecimal: "5.000000",
    totalPositionsValueUsd: "250000000",
  };

  it("profile: resolves the owner wallet and converts the 3 *Usd money fields", async () => {
    getJupiterPredictionProfile.mockResolvedValue(structuredClone(FULL_PROFILE));
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.profile"]({ walletAddress: ADDRESS }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionProfile).toHaveBeenCalledWith(ADDRESS);
    expect(result.data).toEqual({
      ownerPubkey: ADDRESS,
      predictionsCount: "10",
      correctPredictions: "7",
      wrongPredictions: "3",
      totalActiveContracts: "5",
      totalActiveContractsMicro: "5000000",
      totalActiveContractsDecimal: "5.000000",
      realizedPnlUsd: "12.340000", realizedPnlUsdMicro: "12340000",
      totalVolumeUsd: "500.000000", totalVolumeUsdMicro: "500000000",
      totalPositionsValueUsd: "250.000000", totalPositionsValueUsdMicro: "250000000",
    });
  });

  // ── Regional-block mapping (P1 — extends W1-C's wrapPredictionRead to
  // every W1-F read; `.profile` stands in for the group, same convention
  // W1-C used to prove the shared wrapper on one representative handler) ──

  it("profile: appends the region hint to an HTTP 403 without replacing the provider words", async () => {
    getJupiterPredictionProfile.mockRejectedValue(providerHttpError(403, "HTTP 403: Forbidden"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.profile"]({ walletAddress: ADDRESS }, ctx()),
    ).rejects.toThrow(/United States and South Korea/);
  });

  it("profile: a non-403 error is NOT rewritten", async () => {
    getJupiterPredictionProfile.mockRejectedValue(providerHttpError(500, "HTTP 500: Internal Server Error"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.profile"]({ walletAddress: ADDRESS }, ctx()),
    ).rejects.toThrow("HTTP 500");
  });

  // ── pnlHistory ───────────────────────────────────────────────────

  it("pnlHistory fails without a required interval", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"]({ walletAddress: ADDRESS }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("interval");
    expect(getJupiterPredictionPnlHistory).not.toHaveBeenCalled();
  });

  it("pnlHistory rejects an invalid interval value (never silently forwarded)", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
      { walletAddress: ADDRESS, interval: "1y" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("interval");
    expect(getJupiterPredictionPnlHistory).not.toHaveBeenCalled();
  });

  // F2: Vex's owner-wide cap (100) is STRICTER than the SDK's own validator
  // (allows up to 1000) — reject above 100, never let a bigger value reach
  // the wire.
  it("pnlHistory rejects a count above the owner-wide 100 cap (stricter than the SDK's 1000 bound)", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
      { walletAddress: ADDRESS, interval: "1w", count: 101 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("count");
    expect(getJupiterPredictionPnlHistory).not.toHaveBeenCalled();
  });

  it("pnlHistory accepts a count of exactly 100", async () => {
    getJupiterPredictionPnlHistory.mockResolvedValue({ ownerPubkey: ADDRESS, history: [] });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
      { walletAddress: ADDRESS, interval: "1w", count: 100 },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(getJupiterPredictionPnlHistory).toHaveBeenCalledWith(
      expect.objectContaining({ count: 100 }),
    );
  });

  it("pnlHistory: resolves the owner wallet, passes interval/count, converts each point's realizedPnlUsd", async () => {
    getJupiterPredictionPnlHistory.mockResolvedValue({
      ownerPubkey: ADDRESS,
      history: [
        { timestamp: 1, realizedPnlUsd: "1000000" },
        { timestamp: 2, realizedPnlUsd: "-500000" },
      ],
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
      { walletAddress: ADDRESS, interval: "1w", count: 2 },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(getJupiterPredictionPnlHistory).toHaveBeenCalledWith({ ownerPubkey: ADDRESS, interval: "1w", count: 2 });
    const data = result.data as { ownerPubkey: string; history: Record<string, unknown>[] };
    expect(data.history).toEqual([
      { timestamp: 1, realizedPnlUsd: "1.000000", realizedPnlUsdMicro: "1000000" },
      { timestamp: 2, realizedPnlUsd: "-0.500000", realizedPnlUsdMicro: "-500000" },
    ]);
  });

  // LIVE-GATE (2026-07-24): the provider's documented pnl-history route
  // returns a bare 404 live (a provider-side outage, NOT a removal — docs
  // still publish it and the 404 reproduces on both hosts).
  //
  // W2g: the outage note is APPENDED, not substituted. A 404 proves the
  // provider answered and did not find the route or the resource; it does not
  // prove WHICH, and Jupiter may start answering "no history for this wallet"
  // on the same status. So the provider's own words come first and the status
  // survives, with the known-outage context behind them.
  it("pnlHistory: appends the known-outage note to a 404, keeping the provider's words and status", async () => {
    getJupiterPredictionPnlHistory.mockRejectedValue(providerHttpError(404, "HTTP 404: Not Found"));
    const thrown: unknown = await SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
      { walletAddress: ADDRESS, interval: "1w" },
      ctx(),
    ).catch((err: unknown) => err);

    const message = (thrown as Error).message;
    expect(message).toContain("HTTP 404: Not Found");
    expect(message).toMatch(/returned 404 for every wallet/);
    expect(message).toContain("solana.predict.profile");
    expect(message.indexOf("HTTP 404: Not Found")).toBeLessThan(message.indexOf("returned 404 for every wallet"));
    expect((thrown as { httpStatus?: number }).httpStatus).toBe(404);
  });

  it("pnlHistory: a non-404 error is NOT rewritten by the removed-upstream mapping", async () => {
    getJupiterPredictionPnlHistory.mockRejectedValue(providerHttpError(500, "HTTP 500: Internal Server Error"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.pnlHistory"](
        { walletAddress: ADDRESS, interval: "1w" },
        ctx(),
      ),
    ).rejects.toThrow("HTTP 500");
  });

  // ── leaderboards ─────────────────────────────────────────────────

  it("leaderboards fails without a required period/metric/limit", async () => {
    const missingPeriod = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { metric: "pnl", limit: 10 }, ctx(),
    );
    expect(missingPeriod.success).toBe(false);
    expect(missingPeriod.output).toContain("period");

    const missingMetric = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { period: "weekly", limit: 10 }, ctx(),
    );
    expect(missingMetric.success).toBe(false);
    expect(missingMetric.output).toContain("metric");

    const missingLimit = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { period: "weekly", metric: "pnl" }, ctx(),
    );
    expect(missingLimit.success).toBe(false);
    expect(missingLimit.output).toContain("limit");

    expect(getJupiterPredictionLeaderboards).not.toHaveBeenCalled();
  });

  // F2: a PRESENT-but-invalid enum value must FAIL clearly, not be silently
  // dropped and treated as if the (required) field were absent.
  it("leaderboards rejects an invalid period or metric value instead of silently dropping it", async () => {
    const invalidPeriod = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { period: "daily", metric: "pnl", limit: 10 }, ctx(),
    );
    expect(invalidPeriod.success).toBe(false);
    expect(invalidPeriod.output).toContain("period");

    const invalidMetric = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { period: "weekly", metric: "streak", limit: 10 }, ctx(),
    );
    expect(invalidMetric.success).toBe(false);
    expect(invalidMetric.output).toContain("metric");

    expect(getJupiterPredictionLeaderboards).not.toHaveBeenCalled();
  });

  it("leaderboards: passes period/metric/limit through, converts each row + the summary buckets", async () => {
    getJupiterPredictionLeaderboards.mockResolvedValue({
      data: [{
        ownerPubkey: "o1",
        realizedPnlUsd: "2000000",
        totalVolumeUsd: "10000000",
        predictionsCount: 5,
        correctPredictions: 4,
        wrongPredictions: 1,
        winRatePct: "80.00",
        period: "weekly",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-07",
      }],
      summary: {
        all_time: { totalVolumeUsd: "100000000", predictionsCount: 50 },
        weekly: { totalVolumeUsd: "10000000", predictionsCount: 5 },
        monthly: { totalVolumeUsd: "40000000", predictionsCount: 20 },
      },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.leaderboards"](
      { period: "weekly", metric: "pnl", limit: 10 },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(getJupiterPredictionLeaderboards).toHaveBeenCalledWith({ period: "weekly", metric: "pnl", limit: 10 });
    const data = result.data as { data: Record<string, unknown>[]; summary: Record<string, unknown> };
    expect(data.data[0]).toEqual({
      ownerPubkey: "o1",
      predictionsCount: 5,
      correctPredictions: 4,
      wrongPredictions: 1,
      // winRatePct: left untouched — unit unconfirmed (not a money field).
      winRatePct: "80.00",
      period: "weekly",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-07",
      realizedPnlUsd: "2.000000", realizedPnlUsdMicro: "2000000",
      totalVolumeUsd: "10.000000", totalVolumeUsdMicro: "10000000",
    });
    expect(data.summary).toEqual({
      all_time: { predictionsCount: 50, totalVolumeUsd: "100.000000", totalVolumeUsdMicro: "100000000" },
      weekly: { predictionsCount: 5, totalVolumeUsd: "10.000000", totalVolumeUsdMicro: "10000000" },
      monthly: { predictionsCount: 20, totalVolumeUsd: "40.000000", totalVolumeUsdMicro: "40000000" },
    });
  });

  // ── vaultInfo ────────────────────────────────────────────────────

  it("vaultInfo: passes the response through verbatim (no *Usd field to convert)", async () => {
    getJupiterPredictionVaultInfo.mockResolvedValue({
      walletAddress: "vault-1", data: { foo: "bar" }, vaultBalance: "123456789",
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.vaultInfo"]({}, ctx());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ walletAddress: "vault-1", data: { foo: "bar" }, vaultBalance: "123456789" });
  });

  // ── suggestedEvents ──────────────────────────────────────────────

  const SUGGESTED_EVENT = {
    eventId: "evt-1",
    category: "crypto",
    metadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub", slug: "drop" },
    markets: [{ marketId: "mkt-1", status: "open", result: null, title: "Market title" }],
    volumeUsd: "5000000",
  };

  it("suggestedEvents fails without pubkey", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.suggestedEvents"]({}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("walletAddress");
    expect(getJupiterPredictionSuggestedEvents).not.toHaveBeenCalled();
  });

  it("suggestedEvents rejects an invalid provider value instead of silently dropping it (F2)", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.suggestedEvents"](
      { walletAddress: ADDRESS, provider: "coinbase" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("provider");
    expect(getJupiterPredictionSuggestedEvents).not.toHaveBeenCalled();
  });

  it("suggestedEvents: passes pubkey/provider through, lean by default (no markets key)", async () => {
    getJupiterPredictionSuggestedEvents.mockResolvedValue({ data: [structuredClone(SUGGESTED_EVENT)] });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.suggestedEvents"](
      { walletAddress: ADDRESS, provider: "polymarket" },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(getJupiterPredictionSuggestedEvents).toHaveBeenCalledWith({ pubkey: ADDRESS, provider: "polymarket" });
    const data = result.data as { data: Record<string, unknown>[] };
    expect(data.data[0]).not.toHaveProperty("markets");
    expect(data.data[0]).toEqual({
      eventId: "evt-1",
      category: "crypto",
      metadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub" },
      volumeUsd: "5.000000", volumeUsdMicro: "5000000",
    });
  });

  it("suggestedEvents: includeMarkets:true restores the nested, projected markets array", async () => {
    getJupiterPredictionSuggestedEvents.mockResolvedValue({ data: [structuredClone(SUGGESTED_EVENT)] });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.suggestedEvents"](
      { walletAddress: ADDRESS, includeMarkets: true },
      ctx(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    expect(data.data[0]!.markets).toEqual([{ marketId: "mkt-1", status: "open", result: null, title: "Market title" }]);
  });
});
