/**
 * THE SPOTLIGHT SECTIONS, one suite per honesty rule.
 *
 * Each section of the owner's mockup makes a CLAIM about a token, and every
 * case below pins the claim to what the provider actually measured rather than
 * to what the layout suggests. The four rules under test come straight from the
 * live probes:
 *
 *  - the leaderboard is a 30-day recomputed window, so it is labelled with it;
 *  - momentum is normalized by window length, because four raw totals are not
 *    comparable and a raw h24 always dwarfs a raw m5;
 *  - other pools counts what a bounded RELEVANCE window showed, never what
 *    exists, and excludes the pool on screen BEFORE ranking;
 *  - promotion reads the pair row, because a pair carrying ten boosts was
 *    measured ABSENT from the global boost feed at the same moment.
 */

import { describe, expect, it, vi } from "vitest";

import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import type { NarrativeIdentity } from "@tools/dexscreener/endpoints/metas.js";
import type { TopTraderRow } from "@tools/dexscreener/endpoints/top-traders.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { SCREEN_WINDOWS } from "@tools/dexscreener/screen-core/request.js";
import { boardMomentumWindows } from "@shared/schemas/board-spotlight.js";
import {
  createBoardSpotlightService,
  type BoardSpotlightServiceDeps,
} from "../board-spotlight-service.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SUBJECT = { chain: "ethereum", pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E" } as const;

const PAIR: PairSubject = {
  chainId: "ethereum",
  pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E",
  ammId: "uniswap",
  baseTokenAddress: "0x85c13aC395BE3277046cd715277c34d283581dac",
  baseTokenSymbol: "ETHCATE",
  quoteTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  quoteTokenSymbol: "WETH",
  dexId: "uniswap",
  labels: [],
  priceUsd: "0.0001877",
  liquidityUsd: 111_300,
  pairCreatedAtMs: 1_787_700_000_000,
  resolutionBasis: "explicit_pair_address",
  resolvedFromToken: null,
  searchWindowSize: null,
  fetchedAtMs: 1_787_741_000_000,
};

/**
 * A raw `dex_screener_schema.Pair` row shaped as the provider sends it, so the
 * real `projectPairRow` runs over it rather than a hand-shaped projection.
 */
function pairRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chainId: "ethereum",
    dexId: "uniswap",
    pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E",
    baseToken: {
      address: "0x85c13aC395BE3277046cd715277c34d283581dac",
      name: "ETHCATE",
      symbol: "ETHCATE",
    },
    quoteToken: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      name: "Wrapped Ether",
      symbol: "WETH",
    },
    price: "0.0001877",
    priceUsd: "0.0001877",
    liquidity: { usd: 111_300, base: 1_000, quote: 2 },
    // Every window the provider reports, in its own per-window key shape.
    volume: { m5: 120_000, h1: 900_000, h6: 2_400_000, h24: 3_400_000 },
    volumeBuy: { m5: 90_000, h1: 540_000, h6: 1_200_000, h24: 1_700_000 },
    volumeSell: { m5: 30_000, h1: 360_000, h6: 1_200_000, h24: 1_700_000 },
    // uint64 counts arrive as STRINGS, which is why the projector reads them
    // with a string reader: a double would lose exactness past 2^53.
    txns: {
      m5: { buys: "60", sells: "20" },
      h1: { buys: "300", sells: "200" },
      h6: { buys: "900", sells: "900" },
      h24: { buys: "1000", sells: "900" },
    },
    priceChange: { m5: 12, h1: 40, h6: 210, h24: 661 },
    pairCreatedAt: "2026-08-26T05:00:00Z",
    typeAMM: { a: "uniswap" },
    ...overrides,
  };
}

function traderRow(rank: number, overrides: Partial<TopTraderRow> = {}): TopTraderRow {
  return {
    maker: `0xmaker${rank}`,
    label: null,
    url: null,
    buys: 10,
    sells: 4,
    volumeUsdBuy: 100_000 / rank,
    volumeUsdSell: 40_000 / rank,
    amountBuy: "1000",
    amountSell: "400",
    balanceAmount: "600",
    retainedBoughtPct: 60,
    firstSwapAtMs: 1_787_700_000_000,
    lastSwapAtMs: 1_787_741_000_000,
    netCashFlowUsd: -60_000 / rank,
    activeSpanSeconds: 41_000,
    providerRank: rank,
    ...overrides,
  };
}

function build(
  overrides: Partial<BoardSpotlightServiceDeps> = {},
): ReturnType<typeof createBoardSpotlightService> {
  return createBoardSpotlightService({
    resolveSubject: async () => PAIR,
    fetchTraders: async () => ({
      rows: [1, 2, 3, 4, 5, 6, 7].map((rank) => traderRow(rank)),
      fetchedAtMs: 1_787_741_000_000,
    }),
    fetchRow: async () => ({ row: pairRow(), fetchedAtMs: 1_787_741_000_000 }),
    fetchTokenPools: async () => ({
      rows: [],
      providerCapped: false,
      fetchedAtMs: 1_787_741_000_000,
    }),
    fetchNarratives: async () => [],
    ...overrides,
  });
}

describe("smart money is a 30-day pair-local cash flow panel and says so", () => {
  it("labels the window and carries the lookback the figures were computed over", async () => {
    // Probe P3: every money figure is RECOMPUTED over the lookback rather than
    // filtered by it, measured at a 28x difference for one wallet between a
    // 30-day and a 1-day window. A panel under any other heading is wrong by
    // that factor.
    const service = build();
    const outcome = await service.topTraders(SUBJECT);

    expect(outcome.kind).toBe("traders");
    if (outcome.kind !== "traders") return;
    expect(outcome.lookbackDays).toBe(30);
    expect(outcome.windowLabel).toBe("30-day pair-local cash flow");
    await service.dispose();
  });

  it("makes no accumulation, profit or smart-money claim in its frozen copy", async () => {
    const service = build();
    const outcome = await service.topTraders(SUBJECT);
    expect(outcome.kind).toBe("traders");
    if (outcome.kind !== "traders") return;
    const note = outcome.semanticsNote.toLowerCase();
    expect(note).toContain("not profit");
    for (const forbidden of ["accumulat", "smart money", "distribut"]) {
      expect(note).not.toContain(forbidden);
    }
    await service.dispose();
  });

  it("keeps the provider's ranking FROZEN and reports how many rows existed", async () => {
    const service = build();
    const outcome = await service.topTraders(SUBJECT);
    expect(outcome.kind).toBe("traders");
    if (outcome.kind !== "traders") return;
    // Cut to the panel size, never re-ranked here.
    expect(outcome.rows.map((row) => row.providerRank)).toEqual([1, 2, 3, 4, 5]);
    // And the count is honest about what was withheld by the cut.
    expect(outcome.rowsAvailable).toBe(7);
    await service.dispose();
  });

  it("names the columns for what they MEASURE, with net as cash flow", async () => {
    const service = build();
    const outcome = await service.topTraders(SUBJECT);
    expect(outcome.kind).toBe("traders");
    if (outcome.kind !== "traders") return;
    const first = outcome.rows[0];
    expect(first?.boughtUsd).toBe(100_000);
    expect(first?.soldUsd).toBe(40_000);
    expect(first?.netCashFlowUsd).toBe(-60_000);
    await service.dispose();
  });

  it("passes the provider's own quote spelling through untouched", async () => {
    // A lower-cased spelling of the CORRECT address answers 200 with the whole
    // leaderboard inverted and every net figure's sign flipped, with no error.
    let seen: string | null = null;
    const service = build({
      fetchTraders: async (args) => {
        seen = args.pair.quoteTokenAddress;
        return { rows: [], fetchedAtMs: 1 };
      },
    });
    await service.topTraders(SUBJECT);
    expect(seen).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    await service.dispose();
  });
});

describe("momentum is a view-time sidecar over the four windows", () => {
  it("uses the provider's own window vocabulary rather than a hand-written list", () => {
    expect([...boardMomentumWindows]).toEqual([...SCREEN_WINDOWS]);
  });

  it("returns one row per window, in the provider's order", async () => {
    const service = build();
    const outcome = await service.momentum(SUBJECT);
    expect(outcome.kind).toBe("momentum");
    if (outcome.kind !== "momentum") return;
    expect(outcome.rows.map((row) => row.window)).toEqual([...SCREEN_WINDOWS]);
    await service.dispose();
  });

  it("normalizes volume and trades by the window's own length in hours", async () => {
    const service = build();
    const outcome = await service.momentum(SUBJECT);
    expect(outcome.kind !== "momentum" ? null : outcome.rows).not.toBeNull();
    if (outcome.kind !== "momentum") return;

    const m5 = outcome.rows[0];
    const h24 = outcome.rows[3];
    // m5 is a twelfth of an hour, so 120,000 USD over it is 1.44M per hour...
    expect(m5?.hours).toBeCloseTo(5 / 60, 10);
    expect(m5?.volumeUsdPerHour).toBeCloseTo(120_000 / (5 / 60), 6);
    // ...while h24's 3.4M over 24 hours is only about 141,667 per hour. The
    // raw totals rank the other way round, which is exactly why the raw ones
    // cannot answer "is this accelerating".
    expect(h24?.volumeUsdPerHour).toBeCloseTo(3_400_000 / 24, 6);
    expect(m5?.volumeUsd).toBeLessThan(h24?.volumeUsd ?? 0);
    expect(m5?.volumeUsdPerHour ?? 0).toBeGreaterThan(h24?.volumeUsdPerHour ?? 0);

    expect(m5?.tradesPerHour).toBeCloseTo((60 + 20) / (5 / 60), 6);
    await service.dispose();
  });

  it("computes the buy share as a share, which needs no normalization", async () => {
    const service = build();
    const outcome = await service.momentum(SUBJECT);
    if (outcome.kind !== "momentum") return;
    // m5: 90k buy against 30k sell is 75 percent.
    expect(outcome.rows[0]?.buySharePct).toBeCloseTo(75, 6);
    // h6: an even split reports 50 because it was MEASURED as even.
    expect(outcome.rows[2]?.buySharePct).toBeCloseTo(50, 6);
    await service.dispose();
  });

  it("returns null, never zero, for a window the provider did not report", async () => {
    // "Nothing traded" is a signal; "the provider said nothing" is a gap. A
    // momentum row that showed the second as the first would invent a reading.
    const service = build({
      fetchRow: async () => ({
        row: pairRow({ volume: { h1: 900_000, h6: 2_400_000, h24: 3_400_000 } }),
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.momentum(SUBJECT);
    if (outcome.kind !== "momentum") return;
    expect(outcome.rows[0]?.volumeUsd).toBeNull();
    expect(outcome.rows[0]?.volumeUsdPerHour).toBeNull();
    await service.dispose();
  });

  it("returns a null buy share when both sides are zero rather than an even split", async () => {
    const service = build({
      fetchRow: async () => ({
        row: pairRow({
          volumeBuy: { m5: 0, h1: 0, h6: 0, h24: 0 },
          volumeSell: { m5: 0, h1: 0, h6: 0, h24: 0 },
        }),
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.momentum(SUBJECT);
    if (outcome.kind !== "momentum") return;
    expect(outcome.rows[0]?.buySharePct).toBeNull();
    await service.dispose();
  });
});

describe("other pools counts what a bounded relevance window showed", () => {
  const otherPool = (address: string, liquidityUsd: number): Record<string, unknown> =>
    pairRow({
      pairAddress: address,
      dexId: "sushiswap",
      liquidity: { usd: liquidityUsd, base: 1, quote: 1 },
    });

  it("excludes the pool on screen BEFORE ranking, so the deepest OTHER pool leads", async () => {
    const service = build({
      fetchTokenPools: async () => ({
        // The pool on screen is the deepest of the three; if it were excluded
        // after ranking it would still be the one named.
        rows: [pairRow(), otherPool("0xdeep", 90_000), otherPool("0xthin", 10_000)],
        providerCapped: false,
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.otherPools(SUBJECT);
    expect(outcome.kind).toBe("other-pools");
    if (outcome.kind !== "other-pools") return;
    expect(outcome.pools.map((pool) => pool.pairAddress)).toEqual(["0xdeep", "0xthin"]);
    expect(outcome.poolsSeen).toBe(2);
    await service.dispose();
  });

  it("removes and COUNTS rows for a different token that rode along the window", async () => {
    // The window ranks by RELEVANCE, not by exact match, so rows for other
    // tokens arrive. Counting them corrupts the bar; dropping them silently
    // hides that the window was noisy.
    const stranger = pairRow({
      pairAddress: "0xstranger",
      baseToken: { address: "0xother", name: "OTHER", symbol: "OTHER" },
      quoteToken: { address: "0xnope", name: "NOPE", symbol: "NOPE" },
    });
    const service = build({
      fetchTokenPools: async () => ({
        rows: [otherPool("0xdeep", 90_000), stranger],
        providerCapped: false,
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.otherPools(SUBJECT);
    if (outcome.kind !== "other-pools") return;
    expect(outcome.poolsSeen).toBe(1);
    expect(outcome.unrelatedRowsDropped).toBe(1);
    await service.dispose();
  });

  it("says SEEN rather than EXIST, and reports the provider cap", async () => {
    const service = build({
      fetchTokenPools: async () => ({
        rows: [otherPool("0xdeep", 90_000)],
        providerCapped: true,
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.otherPools(SUBJECT);
    if (outcome.kind !== "other-pools") return;
    expect(outcome.providerCapped).toBe(true);
    expect(outcome.windowNote).toContain("not a count of every pool");
    await service.dispose();
  });

  it("reports rows withheld by the display cap instead of pretending it showed the window", async () => {
    const rows = Array.from({ length: 12 }, (_unused, index) =>
      otherPool(`0xpool${index}`, 1_000 * (index + 1)),
    );
    const service = build({
      fetchTokenPools: async () => ({ rows, providerCapped: false, fetchedAtMs: 1 }),
    });
    const outcome = await service.otherPools(SUBJECT);
    if (outcome.kind !== "other-pools") return;
    expect(outcome.pools).toHaveLength(8);
    expect(outcome.poolsSeen).toBe(12);
    expect(outcome.withheldByLimit).toBe(4);
    await service.dispose();
  });

  it("sorts a pool with no reported liquidity last, because missing is not empty", async () => {
    const unreported = pairRow({ pairAddress: "0xunknown", liquidity: undefined });
    const service = build({
      fetchTokenPools: async () => ({
        rows: [unreported, otherPool("0xthin", 10)],
        providerCapped: false,
        fetchedAtMs: 1,
      }),
    });
    const outcome = await service.otherPools(SUBJECT);
    if (outcome.kind !== "other-pools") return;
    expect(outcome.pools.map((pool) => pool.pairAddress)).toEqual(["0xthin", "0xunknown"]);
    await service.dispose();
  });
});

describe("promotion reads the pair row, never the global boost feed", () => {
  it("carries boostsActive from the row", async () => {
    // Probe P4: ETHCATE carried boostsActive 10 and was ABSENT from the
    // 30-row spotlight feed at the same moment.
    const service = build({
      fetchRow: async () => ({ row: pairRow({ boosts: { active: 10 } }), fetchedAtMs: 1 }),
    });
    const outcome = await service.context({ subject: SUBJECT, metaIds: [] });
    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    expect(outcome.boostsActive).toBe(10);
    expect(outcome.promotionNote).toContain("visibility, not demand");
    await service.dispose();
  });

  it("reports a row with no boost column as null rather than zero", async () => {
    const service = build();
    const outcome = await service.context({ subject: SUBJECT, metaIds: [] });
    if (outcome.kind !== "context") return;
    // Null is "the row carried none", which is the ordinary answer. Zero would
    // be a claim the provider never made.
    expect(outcome.boostsActive).toBeNull();
    await service.dispose();
  });
});

describe("the narrative join", () => {
  const catalog: readonly NarrativeIdentity[] = [
    {
      id: "KAxVtm2QhpF8vU6RkrBl",
      name: "Meme Hall of Fame",
      slug: "meme-hall-of-fame",
      alternativeSlugs: [],
      description: null,
      iconType: null,
      iconValue: null,
    },
  ];

  it("joins on the opaque id, which is the key the provider itself matches on", async () => {
    // Probe P6, demonstrated end to end: screening by this id returned a pair
    // whose profile.metaIds was exactly this id. The SLUG matches zero pairs.
    const service = build({ fetchNarratives: async () => catalog });
    const outcome = await service.context({
      subject: SUBJECT,
      metaIds: ["KAxVtm2QhpF8vU6RkrBl"],
    });
    if (outcome.kind !== "context") return;
    expect(outcome.narratives).toEqual([
      { id: "KAxVtm2QhpF8vU6RkrBl", name: "Meme Hall of Fame", slug: "meme-hall-of-fame" },
    ]);
    expect(outcome.unjoinedMetaIds).toEqual([]);
    await service.dispose();
  });

  it("renders an EMPTY join as a designed state and spends no catalog request on it", async () => {
    // Both probed memecoin subjects returned []. This is the common case, so
    // fetching a global document for it would be a request per card for a
    // guaranteed empty answer.
    let fetched = 0;
    const service = build({
      fetchNarratives: async () => {
        fetched += 1;
        return catalog;
      },
    });
    const outcome = await service.context({ subject: SUBJECT, metaIds: [] });
    if (outcome.kind !== "context") return;
    expect(outcome.narratives).toEqual([]);
    expect(fetched).toBe(0);
    await service.dispose();
  });

  it("names an id the catalog could not resolve instead of quietly shrinking the list", async () => {
    const service = build({ fetchNarratives: async () => catalog });
    const outcome = await service.context({
      subject: SUBJECT,
      metaIds: ["KAxVtm2QhpF8vU6RkrBl", "unknown-id"],
    });
    if (outcome.kind !== "context") return;
    expect(outcome.narratives).toHaveLength(1);
    expect(outcome.unjoinedMetaIds).toEqual(["unknown-id"]);
    await service.dispose();
  });

  it("keeps the promotion flag when the catalog itself is unreachable", async () => {
    // A narrative section is context. A failed join must never turn the
    // promotion flag beside it into an error.
    const service = build({
      fetchRow: async () => ({ row: pairRow({ boosts: { active: 3 } }), fetchedAtMs: 1 }),
      fetchNarratives: async () => {
        throw Object.assign(new Error("refused"), {
          code: DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
        });
      },
    });
    const outcome = await service.context({ subject: SUBJECT, metaIds: ["x"] });
    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    expect(outcome.boostsActive).toBe(3);
    expect(outcome.narratives).toEqual([]);
    expect(outcome.unjoinedMetaIds).toEqual(["x"]);
    await service.dispose();
  });
});

describe("failures are typed and none of them is remembered", () => {
  it.each([
    [DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT, "transport"],
    [DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE, "not_mounted"],
    ["SOMETHING_ELSE", "provider"],
  ])("maps %s to %s on the traders channel", async (code, reason) => {
    const service = build({
      fetchTraders: async () => {
        throw Object.assign(new Error("refused"), { code });
      },
    });
    expect(await service.topTraders(SUBJECT)).toEqual({ kind: "unavailable", reason });
    await service.dispose();
  });

  it("re-asks after a failure rather than serving the failure from cache", async () => {
    let calls = 0;
    const service = build({
      fetchTraders: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("x"), { code: "X" });
        return { rows: [traderRow(1)], fetchedAtMs: 1 };
      },
    });
    expect((await service.topTraders(SUBJECT)).kind).toBe("unavailable");
    // A transient says nothing about the pool. Remembering one would keep the
    // section empty for the whole window after a single bad second.
    expect((await service.topTraders(SUBJECT)).kind).toBe("traders");
    expect(calls).toBe(2);
    await service.dispose();
  });

  it("turns a failed subject resolution into a typed section, not a throw", async () => {
    const service = build({
      resolveSubject: async () => {
        throw Object.assign(new Error("no such pair"), {
          code: DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
        });
      },
    });
    expect(await service.topTraders(SUBJECT)).toEqual({
      kind: "unavailable",
      reason: "transport",
    });
    await service.dispose();
  });
});

describe("one subject serves every section", () => {
  it("resolves the pair once across the sections that need it", async () => {
    let resolved = 0;
    const service = build({
      resolveSubject: async () => {
        resolved += 1;
        return PAIR;
      },
    });
    await service.topTraders(SUBJECT);
    await service.otherPools(SUBJECT);
    await service.tape.poll({ subject: SUBJECT, reset: true });
    // Five sections asking five times would be four wasted exchanges and four
    // chances for one of them to describe a different pool.
    expect(resolved).toBe(1);
    await service.dispose();
  });

  it("single-flights a burst of identical reads onto one exchange", async () => {
    let calls = 0;
    const service = build({
      fetchTraders: async () => {
        calls += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        return { rows: [traderRow(1)], fetchedAtMs: 1 };
      },
    });
    const [a, b, c] = await Promise.all([
      service.topTraders(SUBJECT),
      service.topTraders(SUBJECT),
      service.topTraders(SUBJECT),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    await service.dispose();
  });
});

describe("dispose", () => {
  it("refuses new reads once torn down", async () => {
    const service = build();
    await service.dispose();
    expect(await service.topTraders(SUBJECT)).toEqual({
      kind: "unavailable",
      reason: "not_mounted",
    });
    expect(await service.tape.poll({ subject: SUBJECT, reset: false })).toEqual({
      kind: "unavailable",
      reason: "not_mounted",
    });
  });
});
