/**
 * Envelope assembly: the offset-to-page arithmetic and the accounting
 * invariant.
 *
 * Both exist to keep one promise: the reader can always tell what was left out
 * and how to get it. Offset paging maps onto the provider's fixed pages of
 * 100, and every row the provider returned is either in `rows` or counted in
 * `clientFiltering.dropped` with a reason.
 */

import { describe, expect, it } from "vitest";
import {
  buildScreenEnvelope,
  planOffsetWindow,
  PROVIDER_ROWS_PER_PAGE,
  TOTAL_MATCHED_INSTABILITY_WARNING,
  type BuildScreenEnvelopeInput,
  readCacheObservation,
} from "../../tools/dexscreener/screen-core/envelope.js";

describe("planOffsetWindow", () => {
  it("maps the first window onto page 1", () => {
    expect(planOffsetWindow(0, 20)).toStrictEqual({
      firstPage: 1,
      lastPage: 1,
      pageCount: 1,
      sliceStart: 0,
      sliceEnd: 20,
    });
  });

  it("spans two pages when the window straddles the page boundary", () => {
    expect(planOffsetWindow(99, 20)).toStrictEqual({
      firstPage: 1,
      lastPage: 2,
      pageCount: 2,
      sliceStart: 99,
      sliceEnd: 119,
    });
  });

  it("starts a fresh page exactly at the boundary", () => {
    expect(planOffsetWindow(100, 20)).toStrictEqual({
      firstPage: 2,
      lastPage: 2,
      pageCount: 1,
      sliceStart: 0,
      sliceEnd: 20,
    });
  });

  it("handles a deep offset with a full-page limit", () => {
    expect(planOffsetWindow(250, 100)).toStrictEqual({
      firstPage: 3,
      lastPage: 4,
      pageCount: 2,
      sliceStart: 50,
      sliceEnd: 150,
    });
  });

  it("keeps a whole page on one page when the limit fills it exactly", () => {
    expect(planOffsetWindow(0, 100)).toStrictEqual({
      firstPage: 1,
      lastPage: 1,
      pageCount: 1,
      sliceStart: 0,
      sliceEnd: 100,
    });
    expect(planOffsetWindow(200, 100).pageCount).toBe(1);
  });

  it("uses the provider's page size by default", () => {
    expect(PROVIDER_ROWS_PER_PAGE).toBe(100);
    expect(planOffsetWindow(30, 10, 30)).toStrictEqual({
      firstPage: 2,
      lastPage: 2,
      pageCount: 1,
      sliceStart: 0,
      sliceEnd: 10,
    });
  });

  it("refuses arguments that cannot describe a window", () => {
    expect(() => planOffsetWindow(-1, 20)).toThrow(RangeError);
    expect(() => planOffsetWindow(0, 0)).toThrow(RangeError);
    expect(() => planOffsetWindow(1.5, 20)).toThrow(RangeError);
  });
});

function envelopeInput(
  overrides: Partial<BuildScreenEnvelopeInput<string>> = {}
): BuildScreenEnvelopeInput<string> {
  return {
    summary: "20 solana pairs by 24 hour volume.",
    rows: Array.from({ length: 20 }, (_, index) => `row-${index}`),
    offset: 0,
    providerCount: 52_479,
    providerReturned: 20,
    filtersApplied: [
      { filter: "chainIds", key: "filters[chainIds][0]", value: "solana" },
    ],
    rankApplied: { key: "volume", order: "desc" },
    qualityFloorApplied: true,
    exclusionDefaultReplaced: false,
    endpoint: "/dex/screener/v7/pairs/h24/1",
    pagesFetched: 1,
    lastPageWasFull: true,
    marketStats: null,
    sourceObservation: {
      transport: "site_bridge",
      fetchedAtMs: 1_787_564_326_000,
      cacheState: "not_cached",
    },
    ...overrides,
  };
}

describe("buildScreenEnvelope", () => {
  it("reports the window, the continuation and the provider's own facts", () => {
    const envelope = buildScreenEnvelope(envelopeInput());
    expect(envelope.returned).toBe(20);
    expect(envelope.offset).toBe(0);
    expect(envelope.hasMore).toBe(true);
    expect(envelope.nextOffset).toBe(20);
    expect(envelope.providerWindow).toStrictEqual({
      endpoint: "/dex/screener/v7/pairs/h24/1",
      rowsPerPage: 100,
      serverSide: true,
      pagesFetched: 1,
      pagesMayOverlap: false,
    });
  });

  it("advances the cursor by PROVIDER rows consumed, not by the rows that survived filtering", () => {
    // The cursor is a PROVIDER cursor: planOffsetWindow maps `offset` straight
    // onto provider pages. Advancing it by survivors re-serves every dropped
    // row on the next call, so an agent walking a filtered board sees the same
    // provider rows twice while believing it is moving forward.
    //
    // Here the provider served 20 rows at offset 0 and client-side filtering
    // kept 15. The next page must start at 20, not at 15.
    const envelope = buildScreenEnvelope(
      envelopeInput({
        rows: Array.from({ length: 15 }, (_unused, index) => `row-${index}`),
        providerReturned: 20,
        droppedByReason: { minLiquidityUsd: 5 },
      })
    );
    expect(envelope.returned).toBe(15);
    expect(envelope.hasMore).toBe(true);
    expect(envelope.nextOffset).toBe(20);
  });

  it("keeps walking when client filtering removed EVERY row of a page", () => {
    // `returned === 0` used to end the traversal. But an empty page after
    // filtering says nothing about the provider: it had 20 rows there, and the
    // rows the agent is looking for may be on the next page. Ending here loses
    // them silently, which is the opposite of what the accounting exists for.
    const envelope = buildScreenEnvelope(
      envelopeInput({
        rows: [],
        providerReturned: 20,
        droppedByReason: { minLiquidityUsd: 20 },
      })
    );
    expect(envelope.returned).toBe(0);
    expect(envelope.hasMore).toBe(true);
    expect(envelope.nextOffset).toBe(20);
  });

  it("still ends the traversal when the PROVIDER ran out", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({
        rows: [],
        providerReturned: 0,
        droppedByReason: {},
        lastPageWasFull: false,
        providerCount: 0,
      })
    );
    expect(envelope.hasMore).toBe(false);
    expect(envelope.nextOffset).toBeUndefined();
  });

  it("never presents the provider count as a total", () => {
    const total = buildScreenEnvelope(envelopeInput()).totalMatchedApprox;
    expect(total.value).toBe(52_479);
    expect(total.isApproximate).toBe(true);
    expect(total.totalUnavailable).toBe(false);
    expect(total.warning).toBe(TOTAL_MATCHED_INSTABILITY_WARNING);
    expect(total.warning).toContain("6.6 percent");
  });

  it("reports no total at all for a channel that publishes none", () => {
    const total = buildScreenEnvelope(
      envelopeInput({ providerCount: 100, totalUnavailable: true })
    ).totalMatchedApprox;
    expect(total.value).toBeNull();
    expect(total.totalUnavailable).toBe(true);
    expect(total.warning).toContain("length of the page");
  });

  it("accounts for every row the provider returned when the client filters", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({
        providerReturned: 27,
        droppedByReason: { missing_liquidity: 5, below_client_floor: 2 },
      })
    );
    expect(envelope.clientFiltering).toStrictEqual({
      providerReturned: 27,
      returned: 20,
      dropped: 7,
      droppedByReason: { missing_liquidity: 5, below_client_floor: 2 },
    });
    const account = envelope.clientFiltering;
    expect((account?.returned ?? 0) + (account?.dropped ?? 0)).toBe(
      account?.providerReturned
    );
  });

  it("refuses to assemble an envelope whose accounting does not add up", () => {
    expect(() =>
      buildScreenEnvelope(
        envelopeInput({
          providerReturned: 30,
          droppedByReason: { missing_liquidity: 5 },
        })
      )
    ).toThrow(/does not equal the 30 rows/);
  });

  it("omits the client-filtering block when no filtering happened", () => {
    expect(buildScreenEnvelope(envelopeInput()).clientFiltering).toBeUndefined();
  });

  it("keeps the block when filtering ran and removed nothing, so zero is stated", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({ droppedByReason: {} })
    );
    expect(envelope.clientFiltering?.dropped).toBe(0);
  });

  it("has no next page when the provider ran out mid-page", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({
        rows: ["row-0"],
        providerReturned: 1,
        providerCount: 1,
        lastPageWasFull: false,
      })
    );
    expect(envelope.hasMore).toBe(false);
    expect(envelope.nextOffset).toBeUndefined();
  });

  it("still offers a next page when the drifting count disagrees with a full page", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({ providerCount: 20, lastPageWasFull: true })
    );
    expect(envelope.hasMore).toBe(true);
    expect(envelope.nextOffset).toBe(20);
  });

  it("has no next page when nothing was returned", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({
        rows: [],
        providerReturned: 0,
        lastPageWasFull: false,
      })
    );
    expect(envelope.hasMore).toBe(false);
  });

  it("continues from the offset it was given, not from zero", () => {
    const envelope = buildScreenEnvelope(envelopeInput({ offset: 240 }));
    expect(envelope.nextOffset).toBe(260);
  });

  it("labels issuer-authored text when the rows carry any", () => {
    const envelope = buildScreenEnvelope(
      envelopeInput({
        externalContentFields: ["baseToken.name", "baseToken.symbol"],
      })
    );
    expect(envelope.externalContentFields).toStrictEqual([
      "baseToken.name",
      "baseToken.symbol",
    ]);
    expect(envelope.externalContentWarning).toContain("untrusted");
    expect(envelope.sanitizedFields).toBeUndefined();
  });

  it("omits the external-content labels when the rows carry none", () => {
    const envelope = buildScreenEnvelope(envelopeInput());
    expect(envelope.externalContentWarning).toBeUndefined();
    expect(envelope.externalContentFields).toBeUndefined();
  });

  it("carries the exclusion-trap flag through untouched", () => {
    expect(
      buildScreenEnvelope(envelopeInput({ exclusionDefaultReplaced: true }))
        .exclusionDefaultReplaced
    ).toBe(true);
  });

  it("carries the overlap warning for a channel whose pages repeat rows", () => {
    expect(
      buildScreenEnvelope(envelopeInput({ pagesMayOverlap: true }))
        .providerWindow.pagesMayOverlap
    ).toBe(true);
  });

  it("marks a stitched offset window as possibly overlapping even without an explicit flag", () => {
    // A deep offset (e.g. offset 50, limit 100) stitches two live provider
    // pages together; between the two fetches the ranking can drift, so the
    // combined window can genuinely repeat a row. Measured: a losers window at
    // offset 50 limit 100 returned 2 duplicate pairs while `pagesFetched: 2`
    // carried no explicit `pagesMayOverlap`, and the envelope still asserted
    // `false`. It must be derived from the page count, not only from a
    // caller-supplied flag.
    const envelope = buildScreenEnvelope(
      envelopeInput({ pagesFetched: 2 })
    );
    expect(envelope.providerWindow.pagesMayOverlap).toBe(true);
  });

  it("does not flag overlap for a single-page window with no explicit flag", () => {
    const envelope = buildScreenEnvelope(envelopeInput({ pagesFetched: 1 }));
    expect(envelope.providerWindow.pagesMayOverlap).toBe(false);
  });
});

describe("readCacheObservation", () => {
  // MEASURED (EP6 + EP8): the site's HTTP endpoints are edge-cached even when
  // the origin says no-store. metas served `cf-cache-status: HIT` with `age`
  // 13-25 s under `public, max-age=30`; spotlight served HIT with `age` 2-4 s.
  // Every one of those answers reported `cacheState: "not_cached"` from a
  // hardcoded literal, so the envelope denied a staleness the headers stated.
  const headers = (entries: Record<string, string>): ReadonlyMap<string, string> =>
    new Map(Object.entries(entries));

  it("reports an edge hit as a hit, carrying the age the edge reported", () => {
    expect(
      readCacheObservation(headers({ "cf-cache-status": "HIT", age: "25" }))
    ).toStrictEqual({ cacheState: "cache_hit", cacheAgeMs: 25_000 });
  });

  it("reports a hit without an age as a hit with no age, never as age zero", () => {
    // Zero would read as "served this instant", which is a stronger claim than
    // the headers support.
    expect(
      readCacheObservation(headers({ "cf-cache-status": "HIT" }))
    ).toStrictEqual({ cacheState: "cache_hit" });
  });

  it("treats a stale or revalidated edge answer as a hit too", () => {
    for (const status of ["STALE", "REVALIDATED", "UPDATING"]) {
      expect(
        readCacheObservation(headers({ "cf-cache-status": status, age: "3" }))
      ).toStrictEqual({ cacheState: "cache_hit", cacheAgeMs: 3000 });
    }
  });

  it("separates a miss, where a cache was consulted, from no cache at all", () => {
    expect(readCacheObservation(headers({ "cf-cache-status": "MISS" }))).toStrictEqual({
      cacheState: "cache_miss",
    });
    expect(readCacheObservation(headers({ "cf-cache-status": "EXPIRED" }))).toStrictEqual({
      cacheState: "cache_miss",
    });
    // DYNAMIC is what the WS-upgrade and screener hosts actually send.
    expect(readCacheObservation(headers({ "cf-cache-status": "DYNAMIC" }))).toStrictEqual({
      cacheState: "not_cached",
    });
    expect(readCacheObservation(headers({ "cf-cache-status": "BYPASS" }))).toStrictEqual({
      cacheState: "not_cached",
    });
  });

  it("degrades an unknown or absent verdict to not_cached rather than guessing", () => {
    expect(readCacheObservation(undefined)).toStrictEqual({ cacheState: "not_cached" });
    expect(readCacheObservation(headers({}))).toStrictEqual({ cacheState: "not_cached" });
    expect(
      readCacheObservation(headers({ "cf-cache-status": "something-new" }))
    ).toStrictEqual({ cacheState: "not_cached" });
  });

  it("ignores an age that is not a whole non-negative number of seconds", () => {
    expect(
      readCacheObservation(headers({ "cf-cache-status": "HIT", age: "not-a-number" }))
    ).toStrictEqual({ cacheState: "cache_hit" });
    expect(
      readCacheObservation(headers({ "cf-cache-status": "HIT", age: "-4" }))
    ).toStrictEqual({ cacheState: "cache_hit" });
  });
});
