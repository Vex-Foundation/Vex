/**
 * S10-31b: the price-divergence median is taken over the PROVIDER's population,
 * never over the rows that survived `limit`.
 *
 * THE DEFECT. `token_pairs_list` applied `limit` and only then ran the
 * same-token divergence detector, so the reference median was computed over the
 * slice rather than over the answer the provider actually sent. A detector
 * whose verdict is decided by a display bound is not a detector.
 *
 * THE EVIDENCE is one live capture, and it is why these assertions are pinned
 * to a fixture rather than to hand-written numbers. JUP on solana, 30 pools in
 * one provider window, 2026-08-25:
 *
 *  - 21 rows agree at a median of 0.2150;
 *  - 9 rows are priced through a broken quote between 1053.18 and 1109.33, and
 *    report liquidity inflated by that same roughly 5,000x factor;
 *  - BECAUSE the inflation hits liquidity too, and this tool orders by
 *    `liquidityUsd` descending, the junk rows are the DEEPEST rows. The 5
 *    deepest pools are all junk and agree with each other to within 1.05x.
 *
 * So the post-limit detector had two distinct failure modes on one capture, and
 * both are asserted below:
 *
 *  - `limit: 5` takes an all-junk slice whose members agree, so it flagged
 *    NOTHING and still published the 173.79 million USD fabricated pool as
 *    `deepestPair`;
 *  - `limit: 10` takes a slice where junk is 8 of 10, so the median moved to
 *    1091.73 and the two HONEST pools were flagged instead.
 *
 * REVERT-DETECTOR: move `assessPriceDivergence` in `handlers/resolve.ts` back
 * onto the emitted `rows` instead of `matching`, and the `limit: 5` case loses
 * every flag while the `limit: 10` case flags the honest pools. Both were
 * verified red that way before this file was committed.
 */

import { describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { registerDexScreenerTransport } from "../../tools/dexscreener/transport.js";
import type { DexScreenerTransport } from "../../tools/dexscreener/transport.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

const JUP_SEARCH = loadFixture("search-jup-solana-pricedivergence").bytes;
/** The tool validates the chain slug against the catalog before it searches. */
const CHAINS = loadJsonFixture("chains-by-trending").bytes;

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

/** The deepest pool in the capture, and the fabricated one. */
const JUNK_DEEPEST = "3xNGdc58axYtrJ64STQz5TrdQWVtWHLR888iRBbWZnEe";

/** Two rows from the honest cluster, both outside the 5 deepest. */
const HONEST_ROWS = [
  "C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz",
  "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
];

interface DivergenceBlock {
  readonly rows: readonly { readonly pairAddress: string }[];
  readonly inconsistentTokens: readonly {
    readonly baseTokenAddress: string;
    readonly medianPriceUsd: string;
    readonly divergingRowCount: number;
  }[];
  readonly populationRowCount: number;
  readonly populationBasis: string;
  readonly flaggedInReturnedRows: readonly string[];
}

async function tokenPairs(limit: number): Promise<Record<string, unknown>> {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url: string) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: url.includes("/ds-data/") ? CHAINS : JUP_SEARCH,
      }),
    wsExchange: () => Promise.reject(new Error("not used by tokenPairs")),
  };
  const release = registerDexScreenerTransport(transport);
  try {
    const handler = DEXSCREENER_HANDLERS["dexscreener.tokenPairs"];
    if (handler === undefined) throw new Error("no tokenPairs handler");
    const result = await handler(
      { chain: "solana", tokenAddress: JUP, limit },
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
  expect(block, "the answer carried no priceDivergence block at all").toBeDefined();
  return block as DivergenceBlock;
}

describe("S10-31b: the divergence median is the provider's population, not the slice", () => {
  it("limit:5, an all-junk slice that agrees with itself, is STILL flagged from the full 30 rows", async () => {
    const data = await tokenPairs(5);
    const block = divergence(data);

    // THE POPULATION IS THE PROVIDER'S, and it is stated rather than implied.
    // Five rows are emitted; thirty were assessed.
    expect(data["returned"]).toBe(5);
    expect(block.populationRowCount).toBe(30);
    expect(block.populationBasis).toBe(
      "provider_rows_before_limit_and_client_filters"
    );

    // THE FLAGS SURVIVE THE SLICE. Post-limit, these five rows agree to within
    // 1.05x and the block was absent entirely.
    expect(block.rows).toHaveLength(9);
    expect(block.rows.map((row) => row.pairAddress)).toContain(JUNK_DEEPEST);

    // ...and the reader is told which of the FIVE rows in hand are flagged.
    // All five deepest pools are junk, so all five are named.
    expect(block.flaggedInReturnedRows).toHaveLength(5);
    expect(block.flaggedInReturnedRows).toContain(JUNK_DEEPEST);

    // THE MEDIAN IS THE HONEST CLUSTER'S, which is only true over 30 rows.
    // Over these 5 it would be 1092.30.
    expect(block.inconsistentTokens).toHaveLength(1);
    expect(block.inconsistentTokens[0]?.medianPriceUsd).toBe("0.215");
    expect(block.inconsistentTokens[0]?.divergingRowCount).toBe(9);
  });

  it("withholds deepestPair rather than publishing the fabricated 173.79M pool", async () => {
    const data = await tokenPairs(5);

    // THE SELECTION IS WITHHELD. Before the fix this named the junk pool, with
    // its inflated liquidity, as the deepest pool for JUP.
    expect(data["deepestPair"]).toBeNull();
    const reason = data["deepestPairWithheldReason"];
    expect(reason).toContain("price clusters disagree");
    expect(reason).toContain("neither cluster is declared correct");

    // THE SUMMARY DERIVES FROM THE SAME FACT. A summary still naming a deepest
    // pool beside a withheld `deepestPair` is the contradiction this asserts
    // against.
    const summary = String(data["summary"]);
    expect(summary).toContain("deepest WITHHELD");
    expect(summary).toContain("price clusters disagree");
    expect(summary).not.toContain("deepest meteora");
  });

  it("limit:10, where junk is the sliced majority, does NOT flag the honest pools", async () => {
    const data = await tokenPairs(10);
    const block = divergence(data);

    expect(data["returned"]).toBe(10);
    expect(block.populationRowCount).toBe(30);

    // THE INVERSION IS GONE. Post-limit the median landed at 1091.73 and these
    // two honest pools were the ones reported as diverging.
    const flagged = block.rows.map((row) => row.pairAddress);
    for (const honest of HONEST_ROWS) {
      expect(flagged, `honest pool ${honest} must not be flagged`).not.toContain(
        honest
      );
      expect(block.flaggedInReturnedRows).not.toContain(honest);
    }

    // ...and the junk group is still the marked one.
    expect(flagged).toContain(JUNK_DEEPEST);
    expect(block.inconsistentTokens[0]?.baseTokenAddress).toBe(JUP);
    expect(block.inconsistentTokens[0]?.medianPriceUsd).toBe("0.215");
  });

  it("gives the same verdict at every limit, because the population never changes", async () => {
    // Sequential, not concurrent: the transport registry is exclusive by
    // design, so two overlapping registrations are a test bug, not a finding.
    const five = await tokenPairs(5);
    const ten = await tokenPairs(10);
    const thirty = await tokenPairs(30);
    const verdict = (data: Record<string, unknown>): string =>
      JSON.stringify({
        rows: divergence(data).rows.map((row) => row.pairAddress).sort(),
        tokens: divergence(data).inconsistentTokens,
        deepestPair: data["deepestPair"],
      });

    // THE PROPERTY THE FIX BUYS, stated directly: `limit` is a display bound
    // and may change which rows are SHOWN, never what the answer concludes
    // about the provider's own price agreement.
    expect(verdict(five)).toBe(verdict(thirty));
    expect(verdict(ten)).toBe(verdict(thirty));
  });
});
