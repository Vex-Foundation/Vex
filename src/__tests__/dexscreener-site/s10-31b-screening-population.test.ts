/**
 * S10-31b, the screening half: the divergence median is taken over the rows the
 * fetched pages carried, never over the offset window sliced out of them.
 *
 * The boards had the same defect as `token_pairs_list` and for the same reason:
 * `runBoard` sliced the fetched pages down to the offset window and only then
 * ran the detector, so `limit` and `offset` decided the reference population.
 *
 * THE EVIDENCE IS UNMUTATED PROVIDER BYTES. The committed
 * `screener-pairs-solana-trending-h24` capture turns out to carry a real
 * instance of the artefact, which was not noticed when the fixture was taken:
 * the token `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` has three pools in
 * that one page, two agreeing at 0.004946 and 0.004942, and one priced at
 * 22.93, which is about 4,636x the median. Nothing here is synthetic.
 *
 * THE ROW POSITIONS ARE THE WHOLE POINT. Those three pools sit at page
 * positions 19, 78 and 80 of 100. So an ordinary `limit: 30` window contains
 * exactly ONE of them, the detector's three-row minimum is not met, and the
 * post-slice implementation reported nothing at all. The provider had sent the
 * evidence; the display bound threw it away before anything read it.
 *
 * It also pins the property that makes the fix worth having: the flagged pool
 * is at position 80 and is therefore NOT among the rows shown. A correct answer
 * still reports the disagreement, and `flaggedInReturnedRows` is empty because
 * none of the flagged pools are on screen. Reporting a divergence the reader
 * cannot see in the row list is the honest outcome; staying silent is not.
 *
 * REVERT-DETECTOR: pass the offset window instead of the fetched pages to
 * `divergencePopulation` in `handlers/screening.ts` and this file goes red,
 * with the whole `priceDivergence` block absent. It was verified red that way
 * before being committed.
 */

import { describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { registerDexScreenerTransport } from "../../tools/dexscreener/transport.js";
import type { DexScreenerTransport } from "../../tools/dexscreener/transport.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

const CHAINS = loadJsonFixture("chains-by-trending").bytes;
const LATEST_BLOCK = loadFixture("screener-latestblock-solana").bytes;
const TRENDING_PAGE = loadFixture("screener-pairs-solana-trending-h24").bytes;

/** The token whose three pools in this page do not agree on its price. */
const SPLIT_TOKEN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

/** Its outlier pool, at page position 80 of 100 and priced at 22.93. */
const OUTLIER_PAIR = "4C8KctYZtMTZwV83Y5AcTPVT2aXYYu2t9ZhHdotFGnno";

interface DivergenceBlock {
  readonly rows: readonly {
    readonly pairAddress: string;
    readonly priceUsd: string;
    readonly ratioToMedian: number;
  }[];
  readonly inconsistentTokens: readonly {
    readonly baseTokenAddress: string;
    readonly medianPriceUsd: string;
    readonly pricedRowCount: number;
  }[];
  readonly populationRowCount: number;
  readonly flaggedInReturnedRows: readonly string[];
}

async function trendingBoard(limit: number): Promise<Record<string, unknown>> {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url: string) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: CHAINS,
      }),
    wsExchange: () => Promise.resolve([LATEST_BLOCK, TRENDING_PAGE]),
  };
  const release = registerDexScreenerTransport(transport);
  try {
    const handler = DEXSCREENER_HANDLERS["dexscreener.pairs.trending"];
    if (handler === undefined) throw new Error("no trending handler");
    const result = await handler(
      { chainIds: "solana", window: "h24", limit, disableQualityFloor: true },
      makeProtocolContext()
    );
    expect(result.success, result.output).toBe(true);
    return result.data as Record<string, unknown>;
  } finally {
    release();
  }
}

function divergence(data: Record<string, unknown>): DivergenceBlock {
  const block = data["priceDivergence"];
  expect(block, "the board carried no priceDivergence block at all").toBeDefined();
  return block as DivergenceBlock;
}

describe("S10-31b: a screening board assesses the fetched page, not the window", () => {
  it("still finds the disagreement when limit shows only one of the three pools", async () => {
    const data = await trendingBoard(30);
    const block = divergence(data);

    // THE POPULATION IS THE FETCHED PAGE. Thirty rows are emitted; all one
    // hundred the provider sent were assessed.
    expect(data["returned"]).toBe(30);
    expect(block.populationRowCount).toBe(100);

    // THE GROUP IS WHOLE. Only one of these three pools is inside the window,
    // so post-slice the token had a single priced row and was never assessed.
    expect(block.inconsistentTokens).toHaveLength(1);
    expect(block.inconsistentTokens[0]?.baseTokenAddress).toBe(SPLIT_TOKEN);
    expect(block.inconsistentTokens[0]?.pricedRowCount).toBe(3);
    expect(block.inconsistentTokens[0]?.medianPriceUsd).toBe("0.004946");

    // THE OUTLIER IS NAMED, with the ratio the provider's own numbers imply.
    expect(block.rows).toHaveLength(1);
    expect(block.rows[0]?.pairAddress).toBe(OUTLIER_PAIR);
    expect(block.rows[0]?.priceUsd).toBe("22.93");
    expect(block.rows[0]?.ratioToMedian).toBeGreaterThan(4000);
  });

  it("reports a disagreement that is not visible in the rows shown, and says so", async () => {
    const data = await trendingBoard(30);
    const block = divergence(data);

    // The flagged pool sits at page position 80, outside a 30-row window. The
    // answer must still carry the finding, and must not imply the reader can
    // see it among the rows: `flaggedInReturnedRows` is the field that keeps
    // those two facts apart.
    const shown = data["rows"] as { pairAddress: string }[];
    expect(shown.map((row) => row.pairAddress)).not.toContain(OUTLIER_PAIR);
    expect(block.flaggedInReturnedRows).toStrictEqual([]);
  });

  it("reaches the same verdict whatever the window shows", async () => {
    // Sequential: the transport registry is exclusive by design.
    const narrow = await trendingBoard(30);
    const wide = await trendingBoard(100);
    const verdict = (data: Record<string, unknown>): string => {
      const block = divergence(data);
      return JSON.stringify({
        rows: block.rows.map((row) => row.pairAddress).sort(),
        tokens: block.inconsistentTokens,
        population: block.populationRowCount,
      });
    };
    expect(verdict(narrow)).toBe(verdict(wide));
  });
});
