/**
 * Row projection against REAL captured screener frames.
 *
 * Two fixtures, chosen because they are the two populations the surface has to
 * be honest about at once:
 *
 *  - `screener-pairs-solana-trending-h24`: ordinary pool rows, where every
 *    derived metric of plan 4.8 is computable;
 *  - `screener-pairs-solana-bonding-pumpfun`: bonding-curve rows, where the
 *    provider sends NO `liquidity` field at all. The 2026-08-24 re-test
 *    measured 0 of 100 bonding rows with complete derived metrics and 0 of 100
 *    carrying liquidity; these tests assert exactly that against the captured
 *    frame, so a future change that starts reporting a zero turnover ratio
 *    there fails here.
 */

import { describe, expect, it } from "vitest";
import { decodeDexScreenerMessageToJson } from "../../tools/dexscreener/codec/protobuf.js";
import {
  projectMarketStats,
  projectPairRow,
} from "../../tools/dexscreener/screen-core/project.js";
import { loadFixture } from "./_fixtures.js";

/** The capture time of both pair fixtures, so ages are deterministic. */
const NOW_MS = Date.parse("2026-08-24T09:39:00Z");
const ONE_DAY_SECONDS = 86_400;

function loadFrame(name: string): {
  readonly rows: readonly unknown[];
  readonly stats: unknown;
  readonly pairsCount: unknown;
} {
  const fixture = loadFixture(name);
  const json = decodeDexScreenerMessageToJson(
    "dex_screener.PairsChannelMessage",
    fixture.bytes,
    { maxBytes: fixture.bytes.byteLength }
  ) as { pairs: { pairs: unknown[]; stats: unknown; pairsCount: unknown } };
  return {
    rows: json.pairs.pairs,
    stats: json.pairs.stats,
    pairsCount: json.pairs.pairsCount,
  };
}

describe("projectPairRow: ordinary pool rows", () => {
  const frame = loadFrame("screener-pairs-solana-trending-h24");
  const stats = projectMarketStats(frame.stats, null);
  const project = (index: number): ReturnType<typeof projectPairRow> =>
    projectPairRow(frame.rows[index], {
      window: "h24",
      nowMs: NOW_MS,
      frameVolumeUsd: stats.h24.volumeUsd,
      freshPairMaxAgeSeconds: ONE_DAY_SECONDS,
    });

  it("projects the decision-relevant subset of the top trending row", () => {
    const row = project(0);
    expect(row.chainId).toBe("solana");
    expect(row.dexId).toBe("raydium");
    expect(row.labels).toStrictEqual(["CPMM"]);
    expect(row.pairAddress).toBe(
      "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh"
    );
    expect(row.baseToken).toStrictEqual({
      address: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
      name: "CyberLeek",
      symbol: "CYBERLEEK",
      decimals: 9,
    });
    expect(row.quoteToken.symbol).toBe("SOL");
    expect(row.ammId).toBe("solamm");
    expect(row.launchpad).toBeNull();
  });

  it("keeps provider decimal strings verbatim and 64-bit counts exact", () => {
    const row = project(0);
    expect(row.priceUsd).toBe("0.02670");
    expect(row.priceNative).toBe("0.0002818");
    expect(row.buys).toBe("119060");
    expect(row.sells).toBe("73331");
    expect(row.buyers).toBe("29971");
    expect(row.sellers).toBe("17294");
    expect(row.makers).toBe("36675");
  });

  it("computes every derived metric of plan 4.8 when every input is present", () => {
    const row = project(0);
    expect(row.derived).toStrictEqual({
      netFlowUsd: 39_908.53,
      buySellRatio: 1.6236,
      buyerSellerRatio: 1.73303,
      transactionsPerMaker: 5.24584,
      buysPerBuyer: 3.97251,
      sellsPerSeller: 4.24026,
      buyVolumeSharePct: 50.0634,
      turnoverRatio: 15.8834,
      volumeAccelerationRatio: 1.71813,
      chainVolumeSharePct: 0.490193,
      freshPairFlag: false,
    });
    expect(row.missingInputs).toStrictEqual([]);
    expect(row.derivedUnavailable).toStrictEqual([]);
  });

  it("derives the age from the provider timestamp and the caller's clock", () => {
    const row = project(0);
    expect(row.pairCreatedAtMs).toBe(Date.parse("2026-08-15T21:07:26Z"));
    expect(row.pairAgeSeconds).toBe(
      Math.round((NOW_MS - Date.parse("2026-08-15T21:07:26Z")) / 1000)
    );
  });

  it("projects both pool reserves beside the USD figure, which cannot show a lopsided pool", () => {
    const row = project(0);
    // The descriptor (`dex_screener_schema.Pair.Liquidity`) declares exactly
    // usd, base and quote; only usd was ever read, so the one signal that
    // distinguishes a balanced pool from a nearly-empty side was invisible.
    expect(row.liquidityUsd).toBe(1_980_301.17);
    expect(row.liquidityBaseTokens).toBe(37_008_037);
    expect(row.liquidityQuoteTokens).toBe(10_467);
  });

  it("carries both reserves on every row of the capture, not only the first", () => {
    const rows = frame.rows.map((_, index) => project(index));
    expect(rows).toHaveLength(100);
    expect(
      rows.filter((row) => row.liquidityBaseTokens !== null)
    ).toHaveLength(100);
    expect(
      rows.filter((row) => row.liquidityQuoteTokens !== null)
    ).toHaveLength(100);
  });

  it("projects a second complete row, so the first is not a lucky one", () => {
    const row = project(1);
    expect(row.derivedUnavailable).toStrictEqual([]);
    expect(row.liquidityUsd).toBeGreaterThan(0);
    expect(row.derived.turnoverRatio).not.toBeNull();
  });

  // The two halves of ONE contract, and either alone passes for the wrong
  // reason. A metric a channel does not carry is ABSENT and silent; a value
  // the provider normally sends and did not is NULL and named. Collapsing them
  // made the single-pair channel, which has no stats block by design, report
  // `missingInputs: ["frameVolumeUsd"]` on every answer forever, and a
  // permanent entry trains the reader to ignore the list.
  it("omits the volume share, and names nothing missing, on a channel with no frame stats", () => {
    const row = projectPairRow(frame.rows[0], {
      window: "h24",
      nowMs: NOW_MS,
    });
    expect(row.derived).not.toHaveProperty("chainVolumeSharePct");
    expect(row.derived).not.toHaveProperty("filteredSetVolumeSharePct");
    expect(row.missingInputs).not.toContain("frameVolumeUsd");
    // Absent, so it is not "unavailable" either: the row must not claim a
    // metric failed when the channel never offered it.
    expect(row.derivedUnavailable).not.toContain("chainVolumeSharePct");
    // Same rule, the existing precedent this follows: no threshold declared,
    // so `freshPairFlag` is absent and the internal option is never named in
    // `missingInputs` (whose contract is "provider inputs this row did not
    // carry").
    expect(row.derived).not.toHaveProperty("freshPairFlag");
    expect(row.missingInputs).not.toContain("freshPairMaxAgeSeconds");
  });

  it("still reports frameVolumeUsd missing when the caller HAS stats and this window is absent from them", () => {
    // The other half. An explicit null means the stats block exists and did
    // not carry this window, which IS a provider input the row did not get, so
    // the share is present-and-null and the input is named. Removing this
    // assertion would let the fix above silence a real gap.
    const row = projectPairRow(frame.rows[0], {
      window: "h24",
      nowMs: NOW_MS,
      frameVolumeUsd: null,
    });
    expect(row.derived).toHaveProperty("chainVolumeSharePct");
    expect(row.derived.chainVolumeSharePct).toBeNull();
    expect(row.missingInputs).toContain("frameVolumeUsd");
    expect(row.derivedUnavailable).toContain("chainVolumeSharePct");
  });

  it("offers freshPairFlag as a present boolean when a threshold is declared", () => {
    const row = project(0);
    expect(row.derived).toHaveProperty("freshPairFlag");
    expect(typeof row.derived.freshPairFlag).toBe("boolean");
    expect(row.missingInputs).not.toContain("freshPairMaxAgeSeconds");
  });

  it("reports the same window it was asked for and reads that window's metrics", () => {
    const h24 = project(0);
    const m5 = projectPairRow(frame.rows[0], { window: "m5", nowMs: NOW_MS });
    expect(h24.window).toBe("h24");
    expect(m5.window).toBe("m5");
    expect(m5.volumeUsd).not.toBe(h24.volumeUsd);
    expect(m5.buys).toBe("233");
  });

  it("labels the issuer-authored fields as external content on every row", () => {
    expect(project(0).externalContentFields).toStrictEqual([
      "baseToken.name",
      "baseToken.symbol",
      "quoteToken.name",
      "quoteToken.symbol",
    ]);
  });
});

describe("projectPairRow: bonding-curve rows", () => {
  const frame = loadFrame("screener-pairs-solana-bonding-pumpfun");
  const stats = projectMarketStats(frame.stats, null);
  const rows = frame.rows.map((row) =>
    projectPairRow(row, {
      window: "h24",
      nowMs: NOW_MS,
      frameVolumeUsd: stats.h24.volumeUsd,
      freshPairMaxAgeSeconds: ONE_DAY_SECONDS,
    })
  );

  it("reproduces the measured field gaps: no liquidity, no labels, no boosts, on all 100 rows", () => {
    expect(rows).toHaveLength(100);
    expect(rows.filter((row) => row.liquidityUsd === null)).toHaveLength(100);
    expect(rows.filter((row) => row.labels.length === 0)).toHaveLength(100);
    expect(rows.filter((row) => row.boostsActive === null)).toHaveLength(100);
    // The reserves follow the pool, not the row: a bonding-curve row carries
    // no `liquidity` block at all, so both sides are null on all 100 rows
    // rather than zero. Zero reserves would read as a drained pool.
    expect(
      rows.filter((row) => row.liquidityBaseTokens === null)
    ).toHaveLength(100);
    expect(
      rows.filter((row) => row.liquidityQuoteTokens === null)
    ).toHaveLength(100);
  });

  it("reports a null turnover ratio with the input marked not-applicable, never a zero", () => {
    for (const row of rows) {
      expect(row.derived.turnoverRatio).toBeNull();
      // A bonding-curve row has no liquidity POOL: `liquidityUsd` is
      // not-applicable, not an unreported measurement, so it is absent from
      // `missingInputs` and present in `notApplicableInputs` instead.
      expect(row.missingInputs).not.toContain("liquidityUsd");
      expect(row.notApplicableInputs).toContain("liquidityUsd");
    }
  });

  it("matches the measured 0 of 100 rows with complete derived metrics", () => {
    expect(
      rows.filter((row) => row.derivedUnavailable.length === 0)
    ).toHaveLength(0);
  });

  it("still projects market cap, which is the size column for this stage", () => {
    expect(rows.every((row) => row.marketCapUsd !== null)).toBe(true);
  });

  it("projects the launchpad block on every bonding row", () => {
    expect(rows.filter((row) => row.launchpad !== null)).toHaveLength(100);
    expect(rows[0]?.launchpad).toStrictEqual({
      progressPct: 0.26,
      creator: "DHBuseJn5PQhwphR9LiuHcH633PtWeCHjRksjg4ddiPL",
      migrationDexId: null,
      launchpadId: null,
    });
  });

  it("names the missing sell-side volume without also naming the not-applicable liquidity", () => {
    const row = rows[0];
    expect(row?.missingInputs).toStrictEqual(["volumeSellUsd"]);
    expect(row?.notApplicableInputs).toStrictEqual(["liquidityUsd"]);
    expect(row?.derived.netFlowUsd).toBeNull();
  });

  it("distinguishes an absent input from an undefined ratio", () => {
    const row = rows[0];
    // `sells` is present and is zero, so the input is not missing; the ratio
    // simply does not exist. The reader can tell the two apart.
    expect(row?.sells).toBe("0");
    expect(row?.missingInputs).not.toContain("sells");
    expect(row?.derived.buySellRatio).toBeNull();
    expect(row?.derivedUnavailable).toContain("buySellRatio");
  });

  it("keeps a tiny volume share non-zero instead of rounding it away", () => {
    const share = rows[0]?.derived.chainVolumeSharePct;
    expect(share).not.toBeNull();
    expect(share).toBeGreaterThan(0);
  });
});

describe("projectMarketStats", () => {
  it("projects all four windows of the frame's own stats block", () => {
    const frame = loadFrame("screener-pairs-solana-trending-h24");
    const stats = projectMarketStats(frame.stats, null);
    expect(stats.h24).toStrictEqual({
      txns: "29633593",
      volumeUsd: 6_416_636_949.74005,
    });
    expect(stats.m5.txns).toBe("91874");
    expect(stats.latestBlockNumber).toBeNull();
  });

  it("carries the latest block when the channel sent one", () => {
    const stats = projectMarketStats(null, {
      blockNumber: "441366346",
      blockTimestampMs: Date.parse("2026-08-24T09:38:51Z"),
    });
    expect(stats.latestBlockNumber).toBe("441366346");
    expect(stats.latestBlockTimestampMs).toBe(
      Date.parse("2026-08-24T09:38:51Z")
    );
    expect(stats.h24).toStrictEqual({ txns: null, volumeUsd: null });
  });

  it("measures the filtered set, not the chain", () => {
    // The bonding frame's own h24 volume is two orders of magnitude below the
    // unfiltered solana frame's, because the stats block describes whatever the
    // filters selected. A caller that calls this "chain volume" is wrong.
    const bonding = projectMarketStats(
      loadFrame("screener-pairs-solana-bonding-pumpfun").stats,
      null
    );
    const all = projectMarketStats(
      loadFrame("screener-pairs-solana-trending-h24").stats,
      null
    );
    expect(bonding.h24.volumeUsd).toBeLessThan(all.h24.volumeUsd as number);
  });
});

describe("projectPairRow: boosted rows", () => {
  /**
   * The population the other two fixtures cannot speak for.
   *
   * `boosts.active` is `uint64` in the descriptor, so protobuf JSON renders it
   * as a decimal STRING. A number-only reader returns null for every boosted
   * pair, which reads as "this pair is not boosted" for a pair the provider
   * says IS boosted, and it silently emptied the `sortBy: "boosts"` board -
   * the rank key was invisible on every row it ranked. The trending and
   * bonding fixtures carry no boosts at all, so a green assertion against them
   * cannot tell a correct reader from a broken one; this frame was captured by
   * ranking on the provider's own `activeBoosts` key precisely so that it can.
   */
  const frame = loadFrame("screener-pairs-solana-boosts-h24");
  const stats = projectMarketStats(frame.stats, null);
  const rows = frame.rows.map((row) =>
    projectPairRow(row, {
      window: "h24",
      nowMs: NOW_MS,
      frameVolumeUsd: stats.h24.volumeUsd,
      freshPairMaxAgeSeconds: ONE_DAY_SECONDS,
    })
  );

  it("reads the uint64-as-string boost count on all 100 boosted rows, never null", () => {
    expect(rows).toHaveLength(100);
    expect(rows.filter((row) => row.boostsActive === null)).toHaveLength(0);
    for (const row of rows) {
      expect(typeof row.boostsActive).toBe("number");
      expect(Number.isSafeInteger(row.boostsActive)).toBe(true);
    }
  });

  it("projects the provider's own decimal-string lexeme as that exact number", () => {
    // The raw frame's leading rows, read straight from the capture:
    // active "1000", "500", "200", "110", "100" - descending, because the
    // capture ranked on activeBoosts.
    expect(rows.slice(0, 5).map((row) => row.boostsActive)).toStrictEqual([
      1000, 500, 200, 110, 100,
    ]);
  });

  it("keeps the boosted board monotone in the key it was ranked by", () => {
    const counts = rows.map((row) => row.boostsActive as number);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]).toBeLessThanOrEqual(counts[index - 1] as number);
    }
  });

  it("does not name a boost count among the missing inputs when it is present", () => {
    for (const row of rows) {
      expect(row.missingInputs).not.toContain("boostsActive");
    }
  });
});

describe("projectPairRow: shape failures", () => {
  it("refuses a row that is not an object rather than inventing fields", () => {
    expect(() => projectPairRow(null, { window: "h24", nowMs: NOW_MS })).toThrow(
      /pair row/
    );
  });

  it("refuses a row with no pair address", () => {
    expect(() =>
      projectPairRow(
        { chainId: "solana", dexId: "raydium" },
        { window: "h24", nowMs: NOW_MS }
      )
    ).toThrow(/pairAddress/);
  });
});
