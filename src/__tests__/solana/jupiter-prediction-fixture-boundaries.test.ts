/**
 * Fixture-boundary tests for `prediction-api/` (W1-A, prediction SDK contract
 * repair). Pins the field-by-field unit classifications documented in
 * `JupiterPredictionUnits.md` against REAL recorded live-API responses (see
 * `./fixtures/prediction/README.md` for provenance) — not synthetic mocks.
 *
 * Each fixture is parsed through the actual zod response schema, and the
 * parsed result is assigned to the hand-written wire-interface type (the
 * same `z.infer<schema>` → interface assignability the schemas barrel's own
 * module doc promises), so a shape drift between `schemas/` and `types/`
 * would fail to compile, not just fail an assertion.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  jupiterPredictionEventsResponseSchema,
  jupiterPredictionHistoryResponseSchema,
  jupiterPredictionSearchEventsResponseSchema,
  jupiterPredictionMarketResponseSchema,
  jupiterPredictionOrderbookResponseSchema,
  jupiterPredictionPositionsResponseSchema,
  jupiterPredictionSuggestedEventsResponseSchema,
  jupiterPredictionTradesResponseSchema,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/schemas.js";
import { jupiterPredictionCloseTimeToIso } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/close-time.js";
import {
  validateJupiterPredictionEventsParams,
  validateJupiterPredictionGetEventParams,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/validation.js";
import type {
  JupiterPredictionEvent,
  JupiterPredictionHistoryEvent,
  JupiterPredictionMarket,
  JupiterPredictionPosition,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types.js";
import { toPredictView } from "@vex-agent/tools/protocols/solana-jupiter/predict-projector.js";
import { convertPredictionHistoryEventMoney } from "@vex-agent/tools/protocols/solana-jupiter/predict-money.js";

function loadFixture(name: string): unknown {
  const path = resolve(import.meta.dirname, "fixtures", "prediction", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("prediction fixture boundaries — /events?includeMarkets=true", () => {
  const raw = loadFixture("events-limit1-includemarkets.json");
  const parsed = jupiterPredictionEventsResponseSchema.parse(raw);

  it("parses the recorded event + nested market without throwing", () => {
    expect(parsed.data).toHaveLength(1);
    expect(parsed.pagination).toEqual({ start: 0, end: 1, total: 3774, hasNext: true });
  });

  it("pins event-level volume fields as micro-USD strings (fixture-confirmed)", () => {
    const event: JupiterPredictionEvent = parsed.data[0]!;
    expect(event.volumeUsd).toBe("26003599000000");
    expect(event.volume24hr).toBe("8151817000000");
    expect(typeof event.volumeUsd).toBe("string");
    expect(typeof event.volume24hr).toBe("string");
  });

  it("keeps the new event-level fields that were absent from the pre-fixture type", () => {
    const event: JupiterPredictionEvent = parsed.data[0]!;
    expect(event.sportsMarketGroups).toEqual([]);
    expect(event.tags).toContain("fifa-world-cup");
  });

  it("exposes the wire Market object flat — no nested `metadata` (fixture-corrected shape)", () => {
    const market: JupiterPredictionMarket | undefined = parsed.data[0]!.markets?.[0];
    expect(market).toBeDefined();
    expect(market!.marketId).toBe("POLY-2470848");
    expect(market!.provider).toBe("polymarket");
    expect(market!.title).toBe("Yes");
    expect(market!.status).toBe("open");
    expect(market!.isTeamMarket).toBe(false);
    expect(market!.team).toBeNull();
    expect(market!.outcomes).toEqual(["Yes", "No"]);
    expect(market!.clobTokenIds).toHaveLength(2);
    expect(market!.marketOptions).toEqual([
      { label: "Yes", buyYes: true },
      { label: "No", buyYes: false },
    ]);
    expect(market!.sportsMarketType).toBeNull();
    expect(market!.sportsLine).toBeNull();
    expect(market!.gameNumber).toBeNull();
    // `metadata` is not part of the flat shape at all — the raw object must
    // not carry it (three live captures confirmed it never appears on the wire).
    expect(market).not.toHaveProperty("metadata");
  });

  it("pins the market pricing unit classification (UNIT HAZARD — see JupiterPredictionUnits.md)", () => {
    const pricing = parsed.data[0]!.markets?.[0]?.pricing;
    expect(pricing).toBeDefined();
    // The 4 price fields are micro-USD NUMBERS (1,000,000 = $1.00) — NOT
    // plain decimal dollars as an earlier assumption held.
    expect(pricing!.buyYesPriceUsd).toBe(1_000_000);
    expect(pricing!.sellYesPriceUsd).toBe(999_000);
    expect(pricing!.buyNoPriceUsd).toBe(1_000);
    expect(pricing!.sellNoPriceUsd).toBe(0);
    // `volume` is a DIFFERENT scale in the same object: already whole-dollar.
    // Confirmed by cross-checking against the parent event's micro-USD
    // `volumeUsd` string divided by 1e6 — both equal 26003599 exactly.
    const parentVolumeUsdMicro = BigInt(parsed.data[0]!.volumeUsd);
    expect(pricing!.volume).toBe(Number(parentVolumeUsdMicro / 1_000_000n));
  });
});

describe("prediction fixture boundaries — /events/search", () => {
  const raw = loadFixture("events-search.json");
  const parsed = jupiterPredictionSearchEventsResponseSchema.parse(raw);

  it("parses 10 events with no nested markets", () => {
    expect(parsed.data).toHaveLength(10);
    for (const event of parsed.data) {
      expect(event.markets).toEqual([]);
    }
  });

  it("accepts an empty-string subcategory (real edge case, not a validation gap)", () => {
    const withEmptySubcategory = parsed.data.find((e) => e.eventId === "POLY-73897");
    expect(withEmptySubcategory?.subcategory).toBe("");
  });

  it("accepts a non-null beginAt as a decimal-timestamp string", () => {
    const first = parsed.data[0]!;
    expect(first.beginAt).toBe("1748555553.385");
  });
});

describe("prediction fixture boundaries — /markets/{marketId} (standalone)", () => {
  const raw = loadFixture("market-detail.json");
  const parsed: JupiterPredictionMarket = jupiterPredictionMarketResponseSchema.parse(raw);

  it("carries eventId when fetched standalone (absent when nested under its event)", () => {
    expect(parsed.eventId).toBe("POLY-572993");
    expect(parsed.marketId).toBe("POLY-2470848");
  });

  it("matches the nested market's flat shape and values", () => {
    expect(parsed.provider).toBe("polymarket");
    expect(parsed.title).toBe("Yes");
    expect(parsed.rulesSecondary).toBe("");
    expect(parsed.resolveAt).toBeNull();
    expect(parsed.marketResultPubkey).toBeNull();
  });
});

describe("prediction fixture boundaries — /events?includeMarkets=true (resolved market) — LIVE-GATE FIX 2 regression", () => {
  // Confirmed live 2026-07-24: `resolveAt` on a closed/resolved market is an
  // ISO-8601 STRING (docs/older captures only ever showed `null`), while the
  // pre-fix schema required `z.number().nullable()`. `openTime`/`closeTime`
  // were re-checked across 50+ live markets in the same sweep and stayed
  // consistently numeric — no widening needed for those two siblings.
  const raw = loadFixture("events-resolved-market.json");
  const parsed = jupiterPredictionEventsResponseSchema.parse(raw);

  it("parses a closed market carrying a live ISO-8601 string resolveAt", () => {
    const market: JupiterPredictionMarket | undefined = parsed.data[0]!.markets?.[0];
    expect(market).toBeDefined();
    expect(market!.status).toBe("closed");
    expect(market!.resolveAt).toBe("2026-07-24T05:14:12.365Z");
    expect(typeof market!.resolveAt).toBe("string");
  });

  it("keeps openTime/closeTime numeric on the same market (siblings unaffected)", () => {
    const market = parsed.data[0]!.markets?.[0];
    expect(typeof market!.openTime).toBe("number");
    expect(typeof market!.closeTime).toBe("number");
  });
});

describe("prediction fixture boundaries — /events/suggested (LIVE-GATE FIX 1 URL + LIVE-GATE FIX 2 shared schema)", () => {
  // Proves the SAME marketSchema instance used by /events above also parses
  // a live /events/suggested response end-to-end (envelope has no
  // `pagination` key, unlike /events) — the resolveAt widening applies to
  // both call sites at once since they share one zod schema object.
  const raw = loadFixture("events-suggested.json");
  const parsed = jupiterPredictionSuggestedEventsResponseSchema.parse(raw);

  it("parses the { data: [...] } envelope with no pagination key", () => {
    expect(parsed.data.length).toBeGreaterThan(0);
    expect((parsed as Record<string, unknown>).pagination).toBeUndefined();
  });

  it("accepts resolveAt: null on every returned market (observed live for this pubkey)", () => {
    for (const event of parsed.data) {
      for (const market of event.markets ?? []) {
        expect(market.resolveAt).toBeNull();
      }
    }
  });
});

describe("prediction fixture boundaries — /orderbook/{marketId}", () => {
  const raw = loadFixture("orderbook.json");
  const parsed = jupiterPredictionOrderbookResponseSchema.parse(raw);

  it("parses the 4-key depth shape with one side empty", () => {
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed!.yes)).toBe(true);
    expect(parsed!.no).toEqual([]);
    expect(parsed!.no_dollars).toEqual([]);
    expect(parsed!.yes.length).toBeGreaterThan(0);
    expect(parsed!.yes_dollars.length).toBe(parsed!.yes.length);
  });

  it("pins the dollar-mirror as an already-decimal string (distinct from the native-unit level)", () => {
    const [nativePrice, nativeSize] = parsed!.yes[0]!;
    const [dollarPrice, dollarSize] = parsed!.yes_dollars[0]!;
    expect(nativePrice).toBe(0);
    expect(dollarPrice).toBe("0.0010");
    expect(dollarSize).toBe(nativeSize);
  });
});

describe("prediction fixture boundaries — /positions + /history on a REAL open position (2026-07-25 outage regression)", () => {
  // Both endpoints returned an empty `data: []` for the entire life of this
  // integration, so no row was ever validated. The first time the wallet
  // actually held a position, `solana.predict.positions` and
  // `solana.predict.history` both failed `provider_error` on two display-only
  // fields the schema had modeled too strictly:
  //   data.0.eventMetadata.closeTime: expected string, received number
  //   data.0.marketMetadata.result:   expected string, received null
  // `.position` and `.orderStatus` then failed downstream for want of a
  // pubkey to chain from. These two fixtures are the recorded wire responses
  // from that window (account identity scrubbed — see ./fixtures/prediction/README.md).
  const positions = jupiterPredictionPositionsResponseSchema.parse(loadFixture("positions-open.json"));
  const history = jupiterPredictionHistoryResponseSchema.parse(loadFixture("history-rows.json"));

  it("parses a real open position — the exact response that used to be rejected", () => {
    expect(positions.data).toHaveLength(1);
    const position: JupiterPredictionPosition = positions.data[0]!;
    // The two offenders, in the exact wire form the provider sent.
    expect(position.eventMetadata.closeTime).toBe(1785283200);
    expect(typeof position.eventMetadata.closeTime).toBe("number");
    expect(position.marketMetadata.result).toBeNull();
    // Still an OPEN market — which is precisely why `result` is null.
    expect(position.marketMetadata.status).toBe("open");
  });

  it("parses every real history row — the same two fields, across multiple rows", () => {
    expect(history.data).toHaveLength(3);
    for (const row of history.data) {
      expect(typeof row.eventMetadata.closeTime).toBe("number");
      expect(row.marketMetadata.result).toBeNull();
    }
    expect(history.data.map((r) => r.eventType)).toEqual([
      "order_closed",
      "order_filled",
      "order_created",
    ]);
  });

  it("projects the position to its agent-facing view without throwing", () => {
    const view = toPredictView(positions.data[0]) as Record<string, unknown>;
    // Money still converts (the outage was upstream of this, but the whole
    // point of the fix is that the agent can now SEE its own open position).
    expect(view.sizeUsd).toBe("4.665593");
    expect(view.sizeUsdMicro).toBe("4665593");
    const marketMetadata = view.marketMetadata as Record<string, unknown>;
    // `result: null` survives projection as null — an honest "unresolved",
    // not a fabricated outcome.
    expect(marketMetadata.result).toBeNull();
    expect(marketMetadata.status).toBe("open");
  });

  it("projects every history row and states the closeTime unit explicitly", () => {
    const rows = history.data.map((row: JupiterPredictionHistoryEvent) =>
      convertPredictionHistoryEventMoney(row),
    );
    expect(rows).toHaveLength(3);
    const eventMetadata = rows[0]!.eventMetadata as Record<string, unknown>;
    const marketMetadata = rows[0]!.marketMetadata as Record<string, unknown>;
    // `/history` is the one projection that forwards these metadata objects
    // whole, so it is the one place a bare `1785283200` could reach the agent.
    // The raw value is preserved AND restated as an unambiguous instant.
    expect(eventMetadata.closeTime).toBe(1785283200);
    expect(eventMetadata.closeTimeIso).toBe("2026-07-29T00:00:00.000Z");
    expect(marketMetadata.closeTimeIso).toBe("2026-07-29T00:00:00.000Z");
    expect(marketMetadata.result).toBeNull();
  });
});

describe("prediction closeTime — one field, two live wire forms", () => {
  // The STRING form is not hypothetical: all four recorded /events fixtures
  // carry `metadata.closeTime` as ISO-8601, and they feed the SAME
  // `eventMetadataSchema` object as the numeric /positions form. Relaxing for
  // the number must not cost the string.
  it("still parses the ISO-8601 string form on every recorded /events fixture", () => {
    for (const name of [
      "events-limit1-includemarkets.json",
      "events-search.json",
      "events-suggested.json",
      "events-resolved-market.json",
    ]) {
      const parsed = jupiterPredictionEventsResponseSchema
        .omit({ pagination: true })
        .parse({ data: (loadFixture(name) as { data: unknown[] }).data });
      const closeTime = parsed.data[0]!.metadata?.closeTime;
      expect(typeof closeTime).toBe("string");
      expect(closeTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("normalises both wire forms of the same instant to one ISO value", () => {
    // 2026-07-20T03:59:00Z is exactly 1784519940 unix seconds.
    expect(jupiterPredictionCloseTimeToIso("2026-07-20T03:59:00Z")).toBe("2026-07-20T03:59:00.000Z");
    expect(jupiterPredictionCloseTimeToIso(1784519940)).toBe("2026-07-20T03:59:00.000Z");
  });

  it("reads the numeric form as SECONDS, not milliseconds (checked against the live value)", () => {
    // The live value from the open position. As seconds it is a plausible
    // market close; as milliseconds it would be 1970-01-21, which no open
    // market can be.
    expect(jupiterPredictionCloseTimeToIso(1785283200)).toBe("2026-07-29T00:00:00.000Z");
  });

  it("handles a digits-only string, which Date.parse alone reads as NaN", () => {
    // The sibling `beginAt` field arrives as "1748555553.385" on the wire, so
    // a seconds-in-a-string closeTime is a realistic third serialization.
    expect(jupiterPredictionCloseTimeToIso("1785283200")).toBe("2026-07-29T00:00:00.000Z");
    expect(Number.isNaN(Date.parse("1785283200"))).toBe(true);
  });

  it("returns null rather than a guess for absent, malformed, or mis-scaled values", () => {
    expect(jupiterPredictionCloseTimeToIso(undefined)).toBeNull();
    expect(jupiterPredictionCloseTimeToIso(null)).toBeNull();
    expect(jupiterPredictionCloseTimeToIso("")).toBeNull();
    expect(jupiterPredictionCloseTimeToIso("not a date")).toBeNull();
    expect(jupiterPredictionCloseTimeToIso({})).toBeNull();
    // A millisecond-scaled value read as seconds would be the year 58543 —
    // outside the plausible window, so it degrades to "unit unknown" instead
    // of a confidently wrong instant. The raw value is preserved alongside.
    expect(jupiterPredictionCloseTimeToIso(1785283200000)).toBeNull();
  });
});

describe("prediction display-only tolerance — image URLs (2026-07-25 audit)", () => {
  // Same class as the outage, found by auditing the surface rather than by an
  // incident: a missing image is `null` in this API, not an absent key (92 of
  // 97 `imageUrl` values across the live captures are null). Both fields below
  // are display-only, and both would have failed an ENTIRE read on one null
  // row — `/trades` is a global feed, so a single image-less trade would have
  // taken down the whole feed.
  it("accepts a null imageUrl on embedded event metadata", () => {
    const raw = loadFixture("positions-open.json") as { data: Array<Record<string, unknown>> };
    const withNullImage = {
      ...raw,
      data: [
        {
          ...raw.data[0]!,
          eventMetadata: { ...(raw.data[0]!.eventMetadata as object), imageUrl: null },
        },
      ],
    };
    const parsed = jupiterPredictionPositionsResponseSchema.parse(withNullImage);
    expect(parsed.data[0]!.eventMetadata.imageUrl).toBeNull();
  });

  it("accepts a null eventImageUrl on a global trade-feed row", () => {
    const trade = {
      id: "order-2782520",
      ownerPubkey: "owner",
      marketId: "POLY-1654958",
      message: "bought 6 contracts",
      timestamp: 1784951136,
      action: "buy",
      side: "yes",
      eventTitle: "Fed Decision in July?",
      marketTitle: "No change",
      amountUsd: "4665593",
      priceUsd: "728998",
      eventImageUrl: null,
      eventId: "POLY-287395",
    };
    const parsed = jupiterPredictionTradesResponseSchema.parse({ data: [trade] });
    expect(parsed.data[0]!.eventImageUrl).toBeNull();
    // The string form must keep working — relaxing is not replacing.
    const withImage = jupiterPredictionTradesResponseSchema.parse({
      data: [{ ...trade, eventImageUrl: "https://img/event.png" }],
    });
    expect(withImage.data[0]!.eventImageUrl).toBe("https://img/event.png");
  });
});

describe("prediction SDK contract repair — new provider/filter/param values validate", () => {
  it("accepts the bisonfi provider and upcoming filter added in this card", () => {
    const result = validateJupiterPredictionEventsParams({
      provider: "bisonfi",
      filter: "upcoming",
    });
    expect(result.provider).toBe("bisonfi");
    expect(result.filter).toBe("upcoming");
  });

  it("accepts tags and includeAllMarkets on /events", () => {
    const result = validateJupiterPredictionEventsParams({
      tags: "soccer",
      includeAllMarkets: true,
    });
    expect(result.tags).toBe("soccer");
    expect(result.includeAllMarkets).toBe(true);
  });

  it("rejects a blank tags value the same way other optional string filters do", () => {
    expect(() => validateJupiterPredictionEventsParams({ tags: "   " })).toThrow();
  });

  it("accepts includeAllMarkets on /events/{eventId}", () => {
    const result = validateJupiterPredictionGetEventParams({
      eventId: "POLY-572993",
      includeAllMarkets: true,
    });
    expect(result.includeAllMarkets).toBe(true);
  });
});
