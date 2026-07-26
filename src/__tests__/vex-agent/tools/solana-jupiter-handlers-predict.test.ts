import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { providerHttpError } from "./_provider-http-error.js";

// Mock the prediction service so the projection (P1-11 compact-JSON) and
// pagination plumbing can be asserted without hitting the network. Only the
// `events` read handler is mocked here; sibling F1 domain files mock their
// own subset (positions in -predict-positions.test.ts, search+event in
// -predict-search.test.ts, history in -predict-history.test.ts) — this file
// was split from a single 559-line solana-jupiter-handlers-predict.test.ts
// that exceeded the 500-line cap (F1). Mutating handlers (buy/sell/...) are
// covered by the param-validation tests below and never resolve here.
const { getJupiterPredictionEvents } = vi.hoisted(() => ({
  getJupiterPredictionEvents: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionEvents,
  // Re-exported by the handler module but unused by these tests; provide inert
  // stubs so the mock fully replaces the real (network-bound) module.
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
}));

// ── Prediction projection fixtures (full SDK-shaped objects) ──────
// Heavy/agent-irrelevant fields (imageUrl, rulesPdf, marketResultPubkey, event
// metadata.{slug,series,closeTime,imageUrl}) are present so the projection
// assertions prove they are dropped. Money fields use REALISTIC micro-USD
// wire values (1,000,000 native units = $1.00, per developers.jup.ag/docs/
// prediction's "Numeric-format hazard" note) so the W1-B money-conversion
// assertions below exercise the real conversion, not a naive already-dollar
// value. `title` is a top-level field (FIXTURE-CORRECTED Market shape,
// W1-A): the wire Market object is flat, no nested `metadata` exists.

const FULL_MARKET = {
  marketId: "mkt-1",
  status: "open",
  result: null,
  openTime: 1,
  closeTime: 2,
  resolveAt: null,
  marketResultPubkey: "MarketResultPubkeyShouldBeDropped",
  imageUrl: "https://img/should-be-dropped.png",
  title: "Market title",
  // buyYesPriceUsd 600000 micro = $0.60; buyNoPriceUsd 400000 micro = $0.40;
  // volume is already whole-dollar per the fixture-confirmed unit hazard.
  pricing: { buyYesPriceUsd: 600000, buyNoPriceUsd: 400000, volume: 100 },
};

const FULL_EVENT = {
  eventId: "evt-1",
  isActive: true,
  isLive: true,
  category: "crypto",
  subcategory: "btc",
  tags: ["a", "b"],
  metadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub", slug: "slug-drop", series: "series-drop", closeTime: "2026-01-01", imageUrl: "https://img/drop.png", isLive: true },
  markets: [FULL_MARKET],
  // 12345000000 micro-USD = $12,345.00.
  volumeUsd: "12345000000",
  closeCondition: "cond",
  beginAt: null,
  rulesPdf: "https://rules/should-be-dropped.pdf",
};

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

// Predict-domain slice of the original combined solana-jupiter-handlers.test.ts
// (required-param validation + events compact-JSON projection/pagination).
// Positions/search/event/position/history domains live in the sibling F1
// split files listed above.
describe("solana-jupiter handlers — predict", () => {
  // ── Required param validation (handlers should fail on missing) ──

  it("solana.predict.market fails without marketId", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.market"]!(
      {},
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("marketId");
  });

  it("solana.predict.buy fails without required params", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.buy"]!(
      { marketId: "abc" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("solana.predict.buy rejects invalid side", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.buy"]!(
      { marketId: "abc", side: "maybe", amountUsdc: 10 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("yes");
    expect(result.output).toContain("no");
  });

  it("solana.predict.buy rejects typo side silently treated as NO before fix", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.buy"]!(
      { marketId: "abc", side: "Yes!", amountUsdc: 10 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("yes");
  });

  it("solana.predict.event fails without eventId", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.event"]!(
      {},
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("eventId");
  });

  it("solana.predict.search fails without query", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.search"]!(
      {},
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
  });

  // ── Prediction compact-JSON projection + pagination (P1-11 / W1-C) ────

  describe("events — projection + pagination + filters", () => {
    beforeEach(() => {
      getJupiterPredictionEvents.mockReset();
    });

    /**
     * Event-shape assertions shared across events/search/event handlers,
     * WITHOUT `markets` — the W1-C default (`includeMarkets` omitted/false is
     * lean by construction, see `predict-projector.ts`'s `PredictViewOptions`).
     */
    function expectLeanProjectedEvent(event: Record<string, unknown>): void {
      expect(event).toEqual({
        eventId: "evt-1",
        category: "crypto",
        // Money (W1-B): 12345000000 micro-USD → "12345.000000" + raw sibling.
        volumeUsd: "12345.000000",
        volumeUsdMicro: "12345000000",
        metadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub" },
      });
      expect(event).not.toHaveProperty("markets");
      // Explicit drop guards (event + event-metadata noise).
      expect(event).not.toHaveProperty("rulesPdf");
      expect(event).not.toHaveProperty("isActive");
      const metadata = event.metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("slug");
      expect(metadata).not.toHaveProperty("series");
      expect(metadata).not.toHaveProperty("closeTime");
      expect(metadata).not.toHaveProperty("imageUrl");
    }

    /** Same event, requested with `includeMarkets: true` — nested markets[] is present and projected. */
    function expectProjectedEventWithMarkets(event: Record<string, unknown>): void {
      expect(event).toEqual({
        eventId: "evt-1",
        category: "crypto",
        volumeUsd: "12345.000000",
        volumeUsdMicro: "12345000000",
        metadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub" },
        markets: [
          {
            marketId: "mkt-1",
            status: "open",
            result: null,
            openTime: 1,
            closeTime: 2,
            resolveAt: null,
            // FIXTURE-CORRECTED (W1-A): title now read from the flat top-level
            // field instead of the nonexistent `market.metadata`.
            title: "Market title",
            pricing: {
              buyYesPriceUsd: "0.600000", buyYesPriceUsdMicro: "600000",
              buyNoPriceUsd: "0.400000", buyNoPriceUsdMicro: "400000",
              sellYesPriceUsd: null, sellYesPriceUsdMicro: null,
              sellNoPriceUsd: null, sellNoPriceUsdMicro: null,
              volumeUsd: "100",
            },
          },
        ],
      });
      const market = (event.markets as Record<string, unknown>[])[0]!;
      expect(market).not.toHaveProperty("imageUrl");
      expect(market).not.toHaveProperty("marketResultPubkey");
      expect(market).not.toHaveProperty("metadata");
    }

    it("events: lean by default (no markets key) when includeMarkets is omitted, and requests includeMarkets:false upstream (P1)", async () => {
      getJupiterPredictionEvents.mockResolvedValue({
        data: [structuredClone(FULL_EVENT)],
        pagination: { start: 0, end: 20, total: 1, hasNext: false },
      });
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({}, ctx());
      expect(result.success).toBe(true);
      // P1: the provider genuinely honors includeMarkets (see
      // predict-projector.ts's PredictViewOptions doc comment, F2/P1
      // correction) — a lean request now also asks the provider for a lean
      // response, a transport optimization. The projector remains the
      // enforcement point for the agent-facing contract either way.
      expect(getJupiterPredictionEvents).toHaveBeenCalledWith(
        expect.objectContaining({ includeMarkets: false }),
      );
      const data = result.data as { data: Record<string, unknown>[] };
      expectLeanProjectedEvent(data.data[0]!);
    });

    it("events: includeMarkets:true restores the nested, projected markets array and requests it upstream", async () => {
      getJupiterPredictionEvents.mockResolvedValue({
        data: [structuredClone(FULL_EVENT)],
        pagination: { start: 5, end: 8, total: 50, hasNext: true },
      });
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!(
        { category: "crypto", filter: "trending", limit: 3, offset: 5, includeMarkets: true },
        ctx(),
      );
      expect(result.success).toBe(true);
      expect(getJupiterPredictionEvents).toHaveBeenCalledWith(
        expect.objectContaining({ category: "crypto", filter: "trending", includeMarkets: true, start: 5, end: 8 }),
      );
      const data = result.data as { data: Record<string, unknown>[]; pagination: unknown };
      expect(data.pagination).toEqual({ start: 5, end: 8, total: 50, hasNext: true });
      expectProjectedEventWithMarkets(data.data[0]!);
    });

    it("events: passes provider/subcategory/tags/sortBy/sortDirection through to the SDK", async () => {
      getJupiterPredictionEvents.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
      await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!(
        { provider: "bisonfi", subcategory: "nfl,nba", tags: "soccer", sortBy: "volume", sortDirection: "asc", filter: "upcoming" },
        ctx(),
      );
      expect(getJupiterPredictionEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "bisonfi",
          subcategory: "nfl,nba",
          tags: "soccer",
          sortBy: "volume",
          sortDirection: "asc",
          filter: "upcoming",
        }),
      );
    });

    it("events: defaults to start=0,end=20 when limit/offset absent (default limit raised 10→20, W1-C)", async () => {
      getJupiterPredictionEvents.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
      await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({}, ctx());
      expect(getJupiterPredictionEvents).toHaveBeenCalledWith(
        expect.objectContaining({ start: 0, end: 20 }),
      );
    });

    // Owner limits rule (never clamp — reject with a clear error). A negative
    // offset or an out-of-[1,100] limit must fail closed, not silently clamp
    // to a valid value (the pre-W1-C behavior).
    it("events: rejects a negative offset instead of clamping", async () => {
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({ offset: -3 }, ctx());
      expect(result.success).toBe(false);
      expect(result.output).toContain("offset");
      expect(getJupiterPredictionEvents).not.toHaveBeenCalled();
    });

    it("events: rejects a limit above 100 instead of clamping", async () => {
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({ limit: 101 }, ctx());
      expect(result.success).toBe(false);
      expect(result.output).toContain("limit");
      expect(getJupiterPredictionEvents).not.toHaveBeenCalled();
    });

    it("events: rejects a limit below 1 instead of clamping", async () => {
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({ limit: 0 }, ctx());
      expect(result.success).toBe(false);
      expect(result.output).toContain("limit");
      expect(getJupiterPredictionEvents).not.toHaveBeenCalled();
    });

    it("events: accepts the owner-max limit of exactly 100", async () => {
      getJupiterPredictionEvents.mockResolvedValue({ data: [], pagination: { start: 0, end: 100, total: 0, hasNext: false } });
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({ limit: 100 }, ctx());
      expect(result.success).toBe(true);
      expect(getJupiterPredictionEvents).toHaveBeenCalledWith(expect.objectContaining({ start: 0, end: 100 }));
    });

    // ── Strict enum params (F2) ───────────────────────────────────────
    // A PRESENT-but-invalid enum value must FAIL with a clear error, never
    // silently coerce to undefined/defaults (owner rule). Before F2, an
    // invalid value like provider:"coinbase" silently became `undefined` and
    // the call proceeded as if no filter was requested at all.
    it.each([
      ["provider", "coinbase"],
      ["category", "weather"],
      ["filter", "closed"],
      ["sortBy", "price"],
      ["sortDirection", "sideways"],
    ])("events: rejects an invalid %s value instead of silently dropping it", async (key, value) => {
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({ [key]: value }, ctx());
      expect(result.success).toBe(false);
      expect(result.output).toContain(key);
      expect(result.output).toContain(String(value));
      expect(getJupiterPredictionEvents).not.toHaveBeenCalled();
    });

    it("events: omitted enum params still resolve to undefined (no filter), not rejected", async () => {
      getJupiterPredictionEvents.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
      const result = await SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({}, ctx());
      expect(result.success).toBe(true);
      const call = getJupiterPredictionEvents.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.provider).toBeUndefined();
      expect(call.category).toBeUndefined();
      expect(call.filter).toBeUndefined();
      expect(call.sortBy).toBeUndefined();
      expect(call.sortDirection).toBeUndefined();
    });

    // ── Regional-block mapping (W1-C) ────────────────────────────────

    // `wrapPredictionRead` (handlers/predict.ts) re-throws — it does not return a
    // ToolResult itself. In production `executeProtocolTool`'s outer
    // try/catch converts this into a failed ToolResult; called directly here
    // (matching the rest of this file), the handler promise rejects.
    it("events: maps an HTTP 403 (geo-block) into a clear regional message", async () => {
      getJupiterPredictionEvents.mockRejectedValue(providerHttpError(403, "HTTP 403: Forbidden"));
      await expect(SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({}, ctx())).rejects.toThrow(
        /not available from your current region/,
      );
    });

    it("events: a non-403 error is NOT rewritten", async () => {
      getJupiterPredictionEvents.mockRejectedValue(providerHttpError(500, "HTTP 500: Internal Server Error"));
      await expect(SOLANA_JUPITER_HANDLERS["solana.predict.events"]!({}, ctx())).rejects.toThrow("HTTP 500");
    });
  });
});
