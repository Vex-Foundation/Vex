/**
 * Availability ranking of the endpoint catalogue.
 *
 * The first block replays a REAL, non-empty recorded response (21 endpoints,
 * see `fixtures/openrouter-endpoints/README.md`) through the REAL production
 * wiring — default client, `HTTPClient`, the SDK's own strict inbound schema —
 * with only `fetch` intercepted. A hand-written double cannot prove that
 * OpenRouter actually sends these fields, or that the SDK still accepts them.
 *
 * The later blocks drive `normalizeEndpoint` and the comparator directly for
 * the shapes the capture does not contain (absent uptime, hostile values).
 *
 * Uptime percentages move constantly, so nothing here asserts a specific
 * number from the fixture — only the ORDERING RULES and field presence, which
 * survive a refresh.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEndpointOption } from "@shared/schemas/provider-endpoints.js";
import { providerListEndpointsResultSchema } from "@shared/schemas/provider-endpoints.js";
import {
  __resetProviderEndpointCatalogForTests,
  loadProviderEndpointCatalog,
  normalizeEndpoint,
} from "../provider-endpoint-catalog.js";
import {
  compareEndpointsByAvailability,
  computeAvailabilityScore,
  suggestedEndpointTagOf,
} from "../provider-endpoint-availability.js";

const FIXTURE_BODY = readFileSync(
  fileURLToPath(
    new URL(
      "./fixtures/openrouter-endpoints/deepseek-deepseek-v4-flash.json",
      import.meta.url,
    ),
  ),
  "utf8",
);

const FIXTURE_MODEL_ID = "deepseek/deepseek-v4-flash";

function loadFromFixture() {
  return loadProviderEndpointCatalog(FIXTURE_MODEL_ID, {
    fetcher: async () =>
      new Response(FIXTURE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

/** A normalized row; availability fields default to "measured and healthy". */
function option(
  overrides: Partial<ProviderEndpointOption> = {},
): ProviderEndpointOption {
  return {
    tag: "example/fp8",
    providerName: "Example",
    contextLength: 131_072,
    quantization: "fp8",
    pricingInputPerMillion: 1,
    pricingOutputPerMillion: 2,
    pricingCacheReadPerMillion: null,
    pricingCacheWritePerMillion: null,
    pricingReasoningPerMillion: null,
    uptimeLast5mPercent: 99,
    uptimeLast30mPercent: 99,
    uptimeLast1dPercent: 99,
    statusCode: 0,
    isDeranked: false,
    availabilityScore: 99,
    ...overrides,
  };
}

/** A raw SDK-shaped row matching the recorded capture. */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    tag: "deepinfra/fp4",
    providerName: "DeepInfra",
    contextLength: 131_072,
    quantization: "fp4",
    supportedParameters: ["tools", "tool_choice", "max_tokens"],
    status: 0,
    uptimeLast5m: 98.97954128894834,
    uptimeLast30m: 98.30070569157087,
    uptimeLast1d: 98.9190288166244,
    pricing: { prompt: "0.0000002", completion: "0.0000008" },
    ...overrides,
  };
}

beforeEach(() => __resetProviderEndpointCatalogForTests());

describe("recorded live response — availability crosses the boundary", () => {
  it("parses under the SDK schema and yields a NON-EMPTY ranked list", async () => {
    const result = await loadFromFixture();
    expect(result.endpoints.length).toBeGreaterThan(1);
  });

  it("satisfies the IPC output schema, so the new fields really cross IPC", async () => {
    const result = await loadFromFixture();
    expect(() => providerListEndpointsResultSchema.parse(result)).not.toThrow();
  });

  it("carries the uptime windows OpenRouter actually sent, unauthenticated", async () => {
    const result = await loadFromFixture();
    // Every row in this capture has real uptime data — the point of recording
    // it. If OpenRouter stops publishing uptime keylessly, this fails loudly
    // instead of the picker silently ranking on nothing.
    for (const endpoint of result.endpoints) {
      expect(endpoint.uptimeLast5mPercent).not.toBeNull();
      expect(endpoint.uptimeLast1dPercent).not.toBeNull();
      expect(endpoint.availabilityScore).not.toBeNull();
    }
  });

  it("ranks by the documented rule: measured before unknown, healthy before deranked, then score descending", async () => {
    const result = await loadFromFixture();

    // Re-applying the comparator to the returned order must be a no-op.
    const resorted = [...result.endpoints].sort(compareEndpointsByAvailability);
    expect(resorted.map((e) => e.tag)).toEqual(result.endpoints.map((e) => e.tag));

    // No deranked row may precede a healthy one.
    const firstDeranked = result.endpoints.findIndex((e) => e.isDeranked);
    if (firstDeranked !== -1) {
      expect(
        result.endpoints.slice(firstDeranked).some((e) => !e.isDeranked),
      ).toBe(false);
    }
  });

  it("exercises the derank tier with REAL status values, not invented ones", async () => {
    const result = await loadFromFixture();
    const statuses = new Set(result.endpoints.map((e) => e.statusCode));
    // The capture genuinely contains both a normal and a deranked endpoint.
    expect(statuses.has(0)).toBe(true);
    expect([...statuses].some((s) => s !== null && s < 0)).toBe(true);
  });

  it("suggests the top-ranked endpoint and nothing else", async () => {
    const result = await loadFromFixture();
    expect(result.suggestedEndpointTag).toBe(result.endpoints[0]?.tag);
    expect(result.suggestedEndpointTag).not.toBeNull();
  });

  it("does NOT carry latency/throughput — the keyless client always gets null for them", async () => {
    const result = await loadFromFixture();
    for (const endpoint of result.endpoints) {
      expect("latencyLast30m" in endpoint).toBe(false);
      expect("throughputLast30m" in endpoint).toBe(false);
    }
  });
});

describe("normalizeEndpoint — availability is validated at the boundary", () => {
  it("carries real uptime windows and derives the score", () => {
    const normalized = normalizeEndpoint(rawRow());
    expect(normalized?.uptimeLast5mPercent).toBeCloseTo(98.9795, 3);
    expect(normalized?.uptimeLast30mPercent).toBeCloseTo(98.3007, 3);
    expect(normalized?.uptimeLast1dPercent).toBeCloseTo(98.919, 3);
    expect(normalized?.statusCode).toBe(0);
    expect(normalized?.isDeranked).toBe(false);
    // 0.5*98.97954 + 0.3*98.30071 + 0.2*98.91903
    //   = 49.48977 + 29.49021 + 19.78381 = 98.76379
    expect(normalized?.availabilityScore).toBeCloseTo(98.76379, 4);
  });

  it("reports a missing uptime window as UNKNOWN, never as a perfect score", () => {
    const normalized = normalizeEndpoint(
      rawRow({ uptimeLast5m: null, uptimeLast30m: null, uptimeLast1d: null }),
    );
    expect(normalized?.uptimeLast5mPercent).toBeNull();
    expect(normalized?.availabilityScore).toBeNull();
  });

  it("renormalises the score over the windows present rather than counting a missing one as zero", () => {
    const normalized = normalizeEndpoint(
      rawRow({ uptimeLast5m: null, uptimeLast30m: null, uptimeLast1d: 90 }),
    );
    // Only the 1d window is present, so the score IS that window — not
    // 0.2*90 = 18, and not 90 padded toward 100.
    expect(normalized?.availabilityScore).toBe(90);
  });

  it("marks a negative status as deranked and keeps the raw enum value", () => {
    const normalized = normalizeEndpoint(rawRow({ status: -5 }));
    expect(normalized?.statusCode).toBe(-5);
    expect(normalized?.isDeranked).toBe(true);
  });

  it("treats an ABSENT status as not-deranked rather than inventing a derank", () => {
    const { status: _dropped, ...withoutStatus } = rawRow();
    const normalized = normalizeEndpoint(withoutStatus);
    expect(normalized?.statusCode).toBeNull();
    expect(normalized?.isDeranked).toBe(false);
  });

  it.each([
    ["a string percentage", "99.5"],
    ["out of range above 100", 1000],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { p50: 99 }],
  ])("rejects a hostile uptime value (%s) as UNKNOWN", (_label, hostile) => {
    const normalized = normalizeEndpoint(
      rawRow({ uptimeLast5m: hostile, uptimeLast30m: hostile, uptimeLast1d: hostile }),
    );
    expect(normalized?.uptimeLast5mPercent).toBeNull();
    expect(normalized?.availabilityScore).toBeNull();
  });

  it.each([
    ["a non-integer", -2.5],
    ["a string", "-2"],
    ["absurdly out of range", -100_000],
  ])("rejects a hostile status value (%s) without claiming a derank", (_l, hostile) => {
    const normalized = normalizeEndpoint(rawRow({ status: hostile }));
    expect(normalized?.statusCode).toBeNull();
    expect(normalized?.isDeranked).toBe(false);
  });

  it("still produces a row the IPC schema accepts when EVERY availability field is hostile", () => {
    const normalized = normalizeEndpoint(
      rawRow({
        status: "boom",
        uptimeLast5m: "boom",
        uptimeLast30m: [],
        uptimeLast1d: {},
      }),
    );
    expect(normalized).not.toBeNull();
    expect(() =>
      providerListEndpointsResultSchema.parse({
        modelId: FIXTURE_MODEL_ID,
        endpoints: [normalized],
        suggestedEndpointTag: null,
      }),
    ).not.toThrow();
  });
});

describe("computeAvailabilityScore", () => {
  it("weights the 5-minute window above the day window", () => {
    const shortHealthy = computeAvailabilityScore({
      uptimeLast5mPercent: 100,
      uptimeLast30mPercent: null,
      uptimeLast1dPercent: 50,
    });
    const shortSick = computeAvailabilityScore({
      uptimeLast5mPercent: 50,
      uptimeLast30mPercent: null,
      uptimeLast1dPercent: 100,
    });
    expect(shortHealthy).toBeGreaterThan(shortSick!);
  });

  it("returns null when no window has data", () => {
    expect(
      computeAvailabilityScore({
        uptimeLast5mPercent: null,
        uptimeLast30mPercent: null,
        uptimeLast1dPercent: null,
      }),
    ).toBeNull();
  });
});

describe("compareEndpointsByAvailability", () => {
  function order(rows: ReadonlyArray<ProviderEndpointOption>) {
    return [...rows].sort(compareEndpointsByAvailability).map((r) => r.tag);
  }

  it("ranks an endpoint WITHOUT availability data below one with it — even a mediocre one", () => {
    const measured = option({ tag: "measured", availabilityScore: 60 });
    const unknown = option({
      tag: "unknown",
      uptimeLast5mPercent: null,
      uptimeLast30mPercent: null,
      uptimeLast1dPercent: null,
      availabilityScore: null,
    });
    expect(order([unknown, measured])).toEqual(["measured", "unknown"]);
  });

  it("never lets an unmeasured endpoint win on price", () => {
    const measured = option({
      tag: "measured",
      availabilityScore: 60,
      pricingInputPerMillion: 100,
    });
    const unknownAndFree = option({
      tag: "unknown",
      availabilityScore: null,
      pricingInputPerMillion: 0,
    });
    expect(order([unknownAndFree, measured])).toEqual(["measured", "unknown"]);
  });

  it("ranks a deranked endpoint below a healthy one even when its score is higher", () => {
    const healthy = option({ tag: "healthy", availabilityScore: 95 });
    const deranked = option({
      tag: "deranked",
      availabilityScore: 99.9,
      statusCode: -2,
      isDeranked: true,
    });
    expect(order([deranked, healthy])).toEqual(["healthy", "deranked"]);
  });

  it("orders equally-healthy endpoints by score, highest first", () => {
    const rows = [
      option({ tag: "low", availabilityScore: 97 }),
      option({ tag: "high", availabilityScore: 99.9 }),
      option({ tag: "mid", availabilityScore: 98.5 }),
    ];
    expect(order(rows)).toEqual(["high", "mid", "low"]);
  });

  it("reproduces the live incident: the 429'd endpoint ranks below the one that served", () => {
    // Real 5m/30m/1d values from the recorded capture.
    const deepinfra = option({
      tag: "deepinfra/fp4",
      availabilityScore: computeAvailabilityScore({
        uptimeLast5mPercent: 98.97954128894834,
        uptimeLast30mPercent: 98.30070569157087,
        uptimeLast1dPercent: 98.9190288166244,
      }),
      // Cheaper — under the OLD price-first rule this won.
      pricingInputPerMillion: 0.2,
    });
    const baidu = option({
      tag: "baidu/fp8",
      availabilityScore: computeAvailabilityScore({
        uptimeLast5mPercent: 99.92645332916047,
        uptimeLast30mPercent: 99.95161395784747,
        uptimeLast1dPercent: 99.9192208652951,
      }),
      pricingInputPerMillion: 0.5,
    });
    expect(order([deepinfra, baidu])).toEqual(["baidu/fp8", "deepinfra/fp4"]);
  });

  it("falls back to price then tag so the order is total and stable", () => {
    const cheap = option({ tag: "b-cheap", pricingInputPerMillion: 1 });
    const dear = option({ tag: "a-dear", pricingInputPerMillion: 5 });
    expect(order([dear, cheap])).toEqual(["b-cheap", "a-dear"]);

    const same = [option({ tag: "b" }), option({ tag: "a" })];
    expect(order(same)).toEqual(["a", "b"]);
  });
});

describe("suggestedEndpointTagOf", () => {
  it("suggests the top-ranked row", () => {
    expect(suggestedEndpointTagOf([option({ tag: "top" }), option({ tag: "next" })])).toBe(
      "top",
    );
  });

  it("suggests nothing when the best row has no measured availability", () => {
    expect(suggestedEndpointTagOf([option({ availabilityScore: null })])).toBeNull();
  });

  it("suggests nothing when even the best row is deranked", () => {
    expect(
      suggestedEndpointTagOf([option({ isDeranked: true, statusCode: -2 })]),
    ).toBeNull();
  });

  it("suggests nothing for an empty list", () => {
    expect(suggestedEndpointTagOf([])).toBeNull();
  });
});

/**
 * The runtime consumes these rows as `InferenceConfig.endpointCandidates`
 * (`EndpointCandidate` in `src/vex-agent/inference/types.ts`, owned by the
 * runtime half). This asserts the catalogue can satisfy that shape 1:1.
 *
 * The runtime type is NOT imported: `src/vex-agent` is off-limits to `vex-app`
 * by the process-boundary check. The mapping is asserted structurally instead,
 * so this test documents the contract without crossing the boundary.
 */
describe("EndpointCandidate mapping — this catalogue is the producer", () => {
  it("maps every candidate field from a real recorded row, with null preserved", async () => {
    const result = await loadFromFixture();
    const row = result.endpoints[0]!;

    const candidate = {
      tag: row.tag,
      providerName: row.providerName,
      // The runtime prefers the 1-day window for a like-for-like comparison.
      uptimePercent: row.uptimeLast1dPercent,
      contextLength: row.contextLength,
      inputPricePerM: row.pricingInputPerMillion,
      outputPricePerM: row.pricingOutputPerMillion,
      cachePricePerM: row.pricingCacheReadPerMillion,
      cacheWritePricePerM: row.pricingCacheWritePerMillion,
      reasoningPricePerM: row.pricingReasoningPerMillion,
    };

    expect(typeof candidate.tag).toBe("string");
    expect(typeof candidate.providerName).toBe("string");
    expect(typeof candidate.uptimePercent).toBe("number");
    // This capture reports no cache-write or reasoning price. They must stay
    // NULL — coercing an unreported money field to 0 is the rules/90 failure.
    expect(candidate.cacheWritePricePerM).toBeNull();
    expect(candidate.reasoningPricePerM).toBeNull();
    for (const value of Object.values(candidate)) {
      expect(value).not.toBeNaN();
    }
  });

  it("never coerces an unreported price to zero", () => {
    const normalized = normalizeEndpoint(
      rawRow({ pricing: { prompt: "0.0000002", completion: "0.0000008" } }),
    );
    expect(normalized?.pricingCacheReadPerMillion).toBeNull();
    expect(normalized?.pricingCacheWritePerMillion).toBeNull();
    expect(normalized?.pricingReasoningPerMillion).toBeNull();
  });

  it("carries a reasoning price through when OpenRouter does publish one", () => {
    const normalized = normalizeEndpoint(
      rawRow({
        pricing: {
          prompt: "0.0000002",
          completion: "0.0000008",
          internalReasoning: "0.0000004",
        },
      }),
    );
    expect(normalized?.pricingReasoningPerMillion).toBeCloseTo(0.4, 10);
  });

  it("orders candidates so the runtime's no-data-sorts-last rule already holds", async () => {
    const result = await loadFromFixture();
    const uptimes = result.endpoints.map((e) => e.uptimeLast1dPercent);
    const firstNull = uptimes.indexOf(null);
    if (firstNull !== -1) {
      expect(uptimes.slice(firstNull).every((u) => u === null)).toBe(true);
    }
  });
});

describe("suggestion is a hint, not an action", () => {
  it("does not alter the endpoint list or imply a selection", async () => {
    const result = await loadFromFixture();
    // The suggestion names a row that is in the list; it adds/removes nothing.
    expect(
      result.endpoints.some((e) => e.tag === result.suggestedEndpointTag),
    ).toBe(true);
  });

  it("never fabricates a suggestion when the catalogue is empty", async () => {
    const list = vi.fn().mockResolvedValue({ data: { endpoints: [] } });
    const result = await loadProviderEndpointCatalog(FIXTURE_MODEL_ID, {
      clientFactory: () => ({ endpoints: { list } }) as never,
    });
    expect(result.endpoints).toEqual([]);
    expect(result.suggestedEndpointTag).toBeNull();
  });
});
