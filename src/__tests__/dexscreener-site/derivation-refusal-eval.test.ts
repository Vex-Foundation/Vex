/**
 * THE REPLAY EVAL FOR THE TWO DERIVATIONS OF SESSION 2026-08-30.
 *
 * A behavior change to a model-visible tool contract needs a targeted
 * evaluation rather than an argument (rule 09). This is that evaluation, and
 * it is the mechanism the prose was not.
 *
 * It replays the two payloads the agent actually read - a top-traders
 * leaderboard and a single-pair live state - through the REAL handler chain
 * over committed provider bytes, and runs the four candidate derivations of
 * `./derivation-audit.js` against what comes back. Three of them are the
 * claims that reached the user and must be `refused` BY THE SHAPE of the
 * payload; the fourth is the legitimate read off the same number and must stay
 * `supported`, so the mechanism is a refusal of one derivation and not a
 * refusal to answer.
 *
 * DETERMINISTIC AND OFFLINE. Every byte comes from `./fixtures`, whose loader
 * re-hashes each capture against its provenance on read, and the transport is
 * a fake because a transport is the boundary a fake belongs at. Nothing here
 * contacts a provider, so it runs in CI with the default suite.
 *
 * This test goes red if: a refusal field is deleted, the retained amount is
 * renamed back to a balance-shaped name, `liquidityInterpretation` stops
 * covering a `liquidityUsd` the payload emits, or the derived holding value
 * loses the basis that makes it checkable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import {
  auditDerivation,
  findSites,
  FORBIDDEN_MODEL_VISIBLE_KEYS,
  type CandidateDerivation,
} from "./derivation-audit.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const TOP_MAKERS = loadFixture("topmakers-uniswap-ethereum").bytes;
const CONNECT_TRADES = loadFixture("connect-gettransactions-uniswap").bytes;
const SEARCH_BODY = loadFixture("search-cat-plain").bytes;
const METAS_TRENDING = loadFixture("metas-trending").bytes;
const SCREENER_LATEST_BLOCK = loadFixture("screener-latestblock-solana").bytes;
const SCREENER_TRENDING = loadFixture("screener-pairs-solana-trending-h24").bytes;

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

function mount(body: Uint8Array, ws: readonly Uint8Array[] = [PAIR_FRAME]): void {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: isCatalog ? CATALOG : body,
      });
    },
    wsExchange: () => Promise.resolve([...ws]),
  };
  release = registerDexScreenerTransport(transport);
}

/**
 * The many-row surfaces that also publish `liquidityUsd` to the model.
 *
 * One per channel class: a screener WebSocket board, an HTTP search window,
 * and the Avro narratives document. Driving them is what makes the sweep below
 * evidence rather than my reading of which handlers emit the field.
 */
const MANY_ROW_CALLS: readonly [
  string,
  Record<string, unknown>,
  Uint8Array,
  readonly Uint8Array[],
][] = [
  [
    "dexscreener.pairs.trending",
    { chainIds: "solana", window: "h24", limit: 30, disableQualityFloor: true },
    CATALOG,
    [SCREENER_LATEST_BLOCK, SCREENER_TRENDING],
  ],
  ["dexscreener.search", { query: "cat", limit: 10 }, SEARCH_BODY, []],
  ["dexscreener.trending", {}, METAS_TRENDING, []],
];

async function call(
  toolId: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, makeProtocolContext());
  expect(result.success, result.output).toBe(true);
  return result.data as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* The candidate derivations                                           */
/* ------------------------------------------------------------------ */

const SUPPLY_SHARE: CandidateDerivation = {
  id: "top-traders/supply-share",
  tool: "dexscreener__top_traders_list",
  kind: "supply_share",
  readsField: "pairObservedRetainedAmount",
  refusalField: "pairObservedRetainedSupplyShare",
  claim: "the top wallet holds about 90 percent of total supply",
  measuredFailure: true,
};

const ENTITY_CONTROL: CandidateDerivation = {
  id: "top-traders/entity-control",
  tool: "dexscreener__top_traders_list",
  kind: "entity_control",
  readsField: "pairObservedRetainedAmount",
  refusalField: "pairObservedRetainedEntityRelationship",
  claim: "a 19-wallet sybil cluster holds roughly 20 percent more of the supply",
  measuredFailure: true,
};

const LIQUIDITY_FLOW: CandidateDerivation = {
  id: "pair-get/liquidity-flow",
  tool: "dexscreener__pair_get",
  kind: "liquidity_flow",
  readsField: "liquidityUsd",
  claim: "liquidity grew 210K to 223K, meaning someone added to the pool, which is mildly constructive",
  measuredFailure: true,
};

/** The legitimate read off the same number. It must NOT be refused. */
const POSITION_VALUE: CandidateDerivation = {
  id: "top-traders/position-value",
  tool: "dexscreener__top_traders_list",
  kind: "position_value",
  readsField: "pairObservedRetainedAmount",
  claim: "this wallet's remaining position on this pool is worth N dollars at the pair price now",
  measuredFailure: false,
};

/* ------------------------------------------------------------------ */
/* Defect A: the supply share and the entity                           */
/* ------------------------------------------------------------------ */

describe("top_traders_list refuses a supply-share derivation in its shape", () => {
  it("carries no balance-shaped key for the model to divide by supply", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "currentHoldingValueUsd",
      limit: 100,
    });
    /*
     * The rename IS the remediation. `balanceAmount` remains the provider's
     * wire spelling inside the endpoint codec, where it is a measured fact;
     * what is forbidden is handing that name to the model, because the name is
     * what invited the division past two paragraphs that forbade it.
     */
    for (const forbidden of FORBIDDEN_MODEL_VISIBLE_KEYS) {
      expect(findSites(data, forbidden)).toStrictEqual([]);
    }
    const traders = data["traders"] as Record<string, unknown>[];
    expect(traders.length).toBeGreaterThan(0);
    expect(findSites(data, "pairObservedRetainedAmount").length).toBe(
      traders.length + traders.length
    );
  });

  it("refuses the supply share and the entity link on EVERY row, as fields", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "currentHoldingValueUsd",
      limit: 100,
    });
    expect(auditDerivation(data, SUPPLY_SHARE).verdict).toBe("refused");
    expect(auditDerivation(data, ENTITY_CONTROL).verdict).toBe("refused");

    // The envelope repeats both, so a reader that never reaches a row still
    // has them. The row-level refusal is what the audit requires; this is the
    // second copy, and it is a structured status rather than a sentence.
    const unknowns = data["unknowns"] as Record<string, unknown>;
    expect((unknowns["supplyShare"] as Record<string, unknown>)["status"]).toBe(
      "not_determinable"
    );
    expect(
      (unknowns["entityRelationship"] as Record<string, unknown>)["status"]
    ).toBe("unknown");
  });

  it("still supports the derivation the retained amount CAN carry", async () => {
    mount(TOP_MAKERS);
    const data = await call("dexscreener.top.traders", {
      chain: CHAIN,
      pairAddress: PAIR,
      sortBy: "currentHoldingValueUsd",
      limit: 100,
    });
    // A payload that refused everything would be safe and useless. The present
    // value of the position is derivable from this same number, shows its two
    // factors, and must stay derivable.
    expect(auditDerivation(data, POSITION_VALUE).verdict).toBe("supported");
  });

  it("refuses on the trades surface too, where the same amount is served at full depth", async () => {
    mount(CONNECT_TRADES);
    const data = await call("dexscreener.trades", {
      chain: CHAIN,
      pairAddress: PAIR,
      traderProfile: "full",
      limit: 25,
    });
    for (const forbidden of FORBIDDEN_MODEL_VISIBLE_KEYS) {
      expect(findSites(data, forbidden)).toStrictEqual([]);
    }
    // The field is optional on this surface (depth `full` only), so an absent
    // field is a legitimate verdict; an unrefused one never is.
    expect(auditDerivation(data, { ...SUPPLY_SHARE, tool: "dexscreener__trades_list" }).verdict)
      .not.toBe("unrefused");
    expect(auditDerivation(data, { ...ENTITY_CONTROL, tool: "dexscreener__trades_list" }).verdict)
      .not.toBe("unrefused");
  });
});

/* ------------------------------------------------------------------ */
/* Defect B: the liquidity causation                                   */
/* ------------------------------------------------------------------ */

describe("pair_get refuses an add-or-remove derivation from USD liquidity", () => {
  it("covers every liquidityUsd it emits with the mark-to-market block", async () => {
    mount(CATALOG);
    const data = await call("dexscreener.pair.get", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    expect(auditDerivation(data, LIQUIDITY_FLOW).verdict).toBe("refused");
    const block = data["liquidityInterpretation"] as Record<string, unknown>;
    expect(block["establishesLiquidityAddedOrRemoved"]).toBe(false);
    expect(block["movesWithPriceAlone"]).toBe(true);
    // The tool that CAN answer it is named, with the parameter that does so.
    const answeredBy = block["answeredBy"] as Record<string, unknown>;
    expect(answeredBy["tool"]).toBe("dexscreener__trades_list");
    expect((answeredBy["params"] as Record<string, unknown>)["eventType"]).toBe(
      "liquidity"
    );
  });

  it("says the per-side reserves were not read, and reports them when they are", async () => {
    mount(CATALOG);
    const withoutReserves = await call("dexscreener.pair.get", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    const absent = (
      withoutReserves["liquidityInterpretation"] as Record<string, unknown>
    )["reserveAmounts"] as Record<string, unknown>;
    // "You did not ask" is a different fact from "the pool has none", and the
    // whole surface is built on not collapsing those two.
    expect(absent["status"]).toBe("not_requested");

    release?.();
    release = null;
    mount(CATALOG);
    const withReserves = await call("dexscreener.pair.get", {
      chain: CHAIN,
      pairAddress: PAIR,
      fields: "reserves",
    });
    const present = (
      withReserves["liquidityInterpretation"] as Record<string, unknown>
    )["reserveAmounts"] as Record<string, unknown>;
    expect(present["status"]).not.toBe("not_requested");
    const pair = withReserves["pair"] as Record<string, unknown>;
    // The block echoes the row rather than holding a second copy of the truth.
    expect(present["baseTokens"]).toBe(pair["liquidityBaseTokens"] ?? null);
    expect(present["quoteTokens"]).toBe(pair["liquidityQuoteTokens"] ?? null);
  });

  it("covers the many-row rankings at the envelope, once, not per row", async () => {
    /*
     * THE SWEEP. Reading the handlers to decide which ones emit `liquidityUsd`
     * is exactly the kind of evidence that goes stale the next time a handler
     * is added, so this drives them and looks at what came back instead.
     * Every payload that carries the field must carry a block that covers it.
     */
    let covered = 0;
    for (const [toolId, params, body, ws] of MANY_ROW_CALLS) {
      release?.();
      release = null;
      mount(body, ws);
      const data = await call(toolId, params);
      const sites = findSites(data, "liquidityUsd");
      // A surface that publishes none of the field needs no block; a sweep in
      // which NOTHING published it would be a green test proving nothing, so
      // the count is asserted below.
      if (sites.length === 0) continue;
      covered += 1;
      const verdict = auditDerivation(data, LIQUIDITY_FLOW);
      expect(verdict.verdict, `${toolId}: ${JSON.stringify(verdict)}`).toBe(
        "refused"
      );
      const block = data["liquidityInterpretation"] as Record<string, unknown>;
      expect(block["appliesTo"]).toBe("every_row_in_this_answer");
      // Once at the envelope, never copied onto the rows it describes.
      expect(findSites(data, "liquidityInterpretation").length).toBe(1);
    }
    expect(covered).toBe(MANY_ROW_CALLS.length);
  });

  it("the recorded reading is arithmetic the price move alone accounts for", () => {
    /*
     * The session's own two reads, kept as numbers so the reasoning is
     * checkable rather than asserted. Price rose about 10.7 percent while the
     * reported USD liquidity rose about 6.1 percent.
     *
     * Under the constant-product model, an UNTOUCHED two-sided position marks
     * to sqrt of the price ratio, which is +5.2 percent here: within a whisker
     * of the +6.1 percent that was read as a deposit, and the pool in question
     * was a concentrated-liquidity V3 pool whose mark can diverge further than
     * that from either model without anyone depositing anything. So the
     * observation is consistent with no deposit at all. That is exactly why
     * the payload states the claim is not derivable INSTEAD of publishing a
     * threshold: there is no arithmetic on this field that separates the two.
     */
    const before = 210_000;
    const after = 222_913;
    const priceRatio = 1.107;
    const observed = after / before - 1;
    const markOnly = Math.sqrt(priceRatio) - 1;
    expect(observed).toBeCloseTo(0.0615, 3);
    expect(markOnly).toBeCloseTo(0.0521, 3);
    // The residual is far below the resolution of any inference from this
    // field, which is the whole content of `establishesLiquidityAddedOrRemoved`.
    expect(Math.abs(observed - markOnly)).toBeLessThan(0.02);
  });
});
