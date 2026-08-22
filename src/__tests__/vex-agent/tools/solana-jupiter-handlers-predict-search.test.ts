import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";

/**
 * Search + single-event lookup domain split out of solana-jupiter-handlers-
 * predict.test.ts (F1, over the 500-line cap) — projection behavior for
 * solana.predict.search and solana.predict.event. Both reuse the same
 * lean/`includeMarkets` projection shape as the events-list domain (see the
 * sibling solana-jupiter-handlers-predict.test.ts), so the projection
 * fixtures/helpers are duplicated here rather than shared across files.
 */
const {
  searchJupiterPredictionEvents,
  getJupiterPredictionEvent,
} = vi.hoisted(() => ({
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  searchJupiterPredictionEvents,
  getJupiterPredictionEvent,
  // Re-exported by the handler module but unused by these tests; provide inert
  // stubs so the mock fully replaces the real (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
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

describe("solana-jupiter handlers — predict search + event lookup", () => {
  beforeEach(() => {
    searchJupiterPredictionEvents.mockReset();
    getJupiterPredictionEvent.mockReset();
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

  it("search: passes the validated provider and limit through to the SDK", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({ data: [] });
    await searchHandler({ query: "btc", provider: "kalshi", limit: 5 }, ctx());
    expect(searchJupiterPredictionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kalshi", query: "btc", limit: 5 }),
    );
  });

  // ── Local window enforcement (F2) ──────────────────────────────────
  // LIVE FACT (coordinator, 2026-07-24): /events/search ignores its own
  // `limit` param entirely — always returns a fixed row count regardless of
  // what was requested. Vex enforces the agent's requested window LOCALLY by
  // slicing the response, so the agent-visible result count is always
  // correct even though the provider cannot be trusted to honor it.
  it("search: enforces the requested limit locally even when the provider ignores it and returns more rows", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({
      data: [structuredClone(FULL_EVENT), structuredClone(FULL_EVENT), structuredClone(FULL_EVENT)],
    });
    const result = await searchHandler({ query: "btc", limit: 2 }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    expect(data.data).toHaveLength(2);
  });

  // ── The local slice is DISCLOSED (O4, owner ruling D16) ────────────
  // `bounded_non_pageable` (parameter-vocabulary.md 4.1): the slice above
  // drops rows and this search has no cursor, page or offset, so the reply
  // must state the drop and name the only recoveries that exist. The boundary
  // is what these pin: exactly `limit` rows is not truncation.
  const searchHandler = SOLANA_JUPITER_HANDLERS["solana.predict.search"];
  if (!searchHandler) throw new Error("solana.predict.search is not registered in SOLANA_JUPITER_HANDLERS");

  it("search: reports returned/totalMatched and truncated:false at exactly `limit` rows", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({
      data: [structuredClone(FULL_EVENT), structuredClone(FULL_EVENT)],
    });
    const result = await searchHandler({ query: "btc", limit: 2 }, ctx());
    const data = result.data as Record<string, unknown>;
    expect(data.returned).toBe(2);
    expect(data.totalMatched).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.truncationNote).toBeUndefined();
  });

  it("search: reports truncated:true with the drop and both recoveries one row later", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({
      data: [structuredClone(FULL_EVENT), structuredClone(FULL_EVENT), structuredClone(FULL_EVENT)],
    });
    const result = await searchHandler({ query: "btc", limit: 2 }, ctx());
    const data = result.data as Record<string, unknown>;
    expect(data.returned).toBe(2);
    expect(data.totalMatched).toBe(3);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("1 of the 3 matching events");
    expect(String(data.truncationNote)).toContain("NO continuation");
    expect(String(data.truncationNote)).toContain("more specific `query`");
    expect(String(data.truncationNote)).toContain("raise `limit` (maximum 20)");
  });

  it("search: at the maximum `limit` the note offers only a narrower query, never a higher limit", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({
      data: Array.from({ length: 21 }, () => structuredClone(FULL_EVENT)),
    });
    const result = await searchHandler({ query: "btc", limit: 20 }, ctx());
    const data = result.data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("more specific `query`");
    expect(String(data.truncationNote)).not.toContain("raise `limit`");
  });

  it("search: defaults the local window to 20 when limit is omitted", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({ data: [] });
    await SOLANA_JUPITER_HANDLERS["solana.predict.search"]!({ query: "btc" }, ctx());
    expect(searchJupiterPredictionEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("search: rejects a limit above 20 instead of clamping, without calling the SDK", async () => {
    const result = await searchHandler({ query: "btc", limit: 21 }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(searchJupiterPredictionEvents).not.toHaveBeenCalled();
  });

  it("search: rejects a limit below 1 instead of clamping, without calling the SDK", async () => {
    const result = await searchHandler({ query: "btc", limit: 0 }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(searchJupiterPredictionEvents).not.toHaveBeenCalled();
  });

  it("search: rejects an invalid provider value instead of silently dropping it", async () => {
    const result = await searchHandler({ query: "btc", provider: "coinbase" }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("provider");
    expect(searchJupiterPredictionEvents).not.toHaveBeenCalled();
  });

  it("search: projects each event in the result, lean by default", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({ data: [structuredClone(FULL_EVENT)] });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.search"]!({ query: "btc" }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    expectLeanProjectedEvent(data.data[0]!);
  });

  it("search: includeMarkets:true restores the nested markets array", async () => {
    searchJupiterPredictionEvents.mockResolvedValue({ data: [structuredClone(FULL_EVENT)] });
    const result = await searchHandler({ query: "btc", includeMarkets: true }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    expectProjectedEventWithMarkets(data.data[0]!);
  });

  it("event: projects the single event, lean by default, and requests includeMarkets:false upstream (P1)", async () => {
    getJupiterPredictionEvent.mockResolvedValue(structuredClone(FULL_EVENT));
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.event"]!({ eventId: "evt-1" }, ctx());
    expect(result.success).toBe(true);
    // P1: same transport optimization as `.events` — a lean request now also
    // asks the provider for a lean response (the provider genuinely honors
    // it, see predict-projector.ts's PredictViewOptions doc comment).
    expect(getJupiterPredictionEvent).toHaveBeenCalledWith({ eventId: "evt-1", includeMarkets: false });
    expectLeanProjectedEvent(result.data as Record<string, unknown>);
  });

  it("event: includeMarkets:true restores the nested markets array and requests it upstream", async () => {
    getJupiterPredictionEvent.mockResolvedValue(structuredClone(FULL_EVENT));
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.event"]!({ eventId: "evt-1", includeMarkets: true }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionEvent).toHaveBeenCalledWith({ eventId: "evt-1", includeMarkets: true });
    expectProjectedEventWithMarkets(result.data as Record<string, unknown>);
  });
});
