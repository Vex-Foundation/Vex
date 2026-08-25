/**
 * The eight site-screening handlers, driven by a fake transport over the REAL
 * captured provider frames.
 *
 * The transport is the right place for the fake: it is the process and trust
 * boundary, the bytes it replays are the provider's own (verified against their
 * recorded hashes by `_fixtures.ts`), and everything above it - the query
 * grammar, the floors, the projection, the field groups, the envelope
 * accounting and the summary sentence - runs for real. A unit mock of the
 * client would have proven only that the handler called something.
 *
 * What these tests are here to catch, in order of how much it would cost to
 * ship the defect:
 *
 *  - A DEFAULT FLOOR THAT IS APPLIED BUT NOT ECHOED, or echoed but not applied.
 *    The gainers board is unusable without its floor and dishonest with a
 *    silent one, so both directions are asserted, including the explicit-null
 *    removal that must flip `qualityFloorApplied` to false.
 *  - AN UNKNOWN CHAIN ANSWERED WITH ZERO ROWS. The provider returns HTTP 200
 *    and an empty page for a typo, which an agent reports to a user as "nothing
 *    trades there". The refusal must name the value and offer candidates.
 *  - A SHAPING PARAMETER SILENTLY CLAMPED. `limit: 500` must be refused by
 *    name, not quietly served as 100, because a clamped limit makes `hasMore`
 *    mean something the agent did not ask for.
 *  - THE TOKEN CHANNEL'S HONESTY BLOCK GOING MISSING. That channel publishes no
 *    total and overlaps pages; an envelope that omits either fact invites an
 *    exhaustive-traversal claim that is false.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolHandler } from "../../../vex-agent/tools/protocols/types.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "../../../tools/dexscreener/transport.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
  type DexScreenerMessageName,
} from "../../../tools/dexscreener/codec/protobuf.js";
import { fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { TOKENS_CHANNEL_HONESTY } from "../../../tools/dexscreener/endpoints/tokens-screener.js";
import { loadFixture } from "../../dexscreener-site/_fixtures.js";
import { makeProtocolContext } from "./_test-context.js";

const CTX = makeProtocolContext();

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dexscreener-site",
  "fixtures"
);

/** The real frames the captured sessions carried, in the order they arrived. */
const LATEST_BLOCK_FRAME = loadFixture("screener-latestblock-solana").bytes;
const PAIRS_FRAME = loadFixture("screener-pairs-solana-trending-h24").bytes;
const BONDING_FRAME = loadFixture("screener-pairs-solana-bonding-pumpfun").bytes;
const TOKENS_FRAME = loadFixture("screener-tokens-solana-volume-h24").bytes;
const CATALOG_BYTES = new Uint8Array(
  readFileSync(path.join(FIXTURE_DIR, "chains-by-trending.json"))
);

interface Recorded {
  readonly wsUrls: string[];
  readonly httpUrls: string[];
}

/**
 * A transport that serves the catalog over HTTP and one scripted frame batch
 * per WebSocket exchange, and records what it was asked for so the query string
 * the tools actually sent is observable.
 */
function fakeTransport(frames: readonly Uint8Array[]): {
  readonly transport: DexScreenerTransport;
  readonly recorded: Recorded;
} {
  const recorded: Recorded = { wsUrls: [], httpUrls: [] };
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      recorded.httpUrls.push(url);
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: CATALOG_BYTES,
      });
    },
    wsExchange: (url) => {
      recorded.wsUrls.push(url);
      return Promise.resolve([...frames]);
    },
  };
  return { transport, recorded };
}

let release: (() => void) | null = null;

function mount(frames: readonly Uint8Array[]): Recorded {
  const { transport, recorded } = fakeTransport(frames);
  release = registerDexScreenerTransport(transport);
  return recorded;
}

/**
 * A transport that serves a DIFFERENT frame batch per WebSocket exchange, for
 * the stitched-window tests.
 *
 * `mount` replays one batch for every exchange, which cannot express the fact
 * these tests exist for: two provider pages of a live ranking are two
 * snapshots, and what repeats between them is a per-channel question. The last
 * batch is reused once the script runs out, so a test only has to script the
 * pages it is asserting about.
 */
function mountPages(pages: ReadonlyArray<readonly Uint8Array[]>): Recorded {
  const recorded: Recorded = { wsUrls: [], httpUrls: [] };
  let index = 0;
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      recorded.httpUrls.push(url);
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: CATALOG_BYTES,
      });
    },
    wsExchange: (url) => {
      recorded.wsUrls.push(url);
      const page = pages[Math.min(index, pages.length - 1)] ?? [];
      index += 1;
      return Promise.resolve([...page]);
    },
  };
  release = registerDexScreenerTransport(transport);
  return recorded;
}

/**
 * A synthetic SECOND page whose head re-serves the tail of the given page,
 * under different pair addresses and with nothing else touched.
 *
 * This is the provider's own measured difference between two pages of a token
 * board: the token comes back, the pool it is attached to does not (14 base
 * tokens repeated across pages 1 and 2 carrying zero repeated pair addresses,
 * 17 on the earlier capture). Building it by re-encoding the real decoded
 * message rather than by hand keeps every other field exactly as the provider
 * sent it, so the test still runs over captured bytes.
 */
function pageRepeatingTail(
  frame: Uint8Array,
  repeated: number,
  message: DexScreenerMessageName = "dex_screener.PairsChannelMessage"
): Uint8Array {
  const descriptor = getDexScreenerMessageDescriptor(message);
  /*
   * DECODED AS PROTOBUF-JSON, NOT AS A GENERATED MESSAGE.
   *
   * This helper walks a oneof by property name and hands the result back to
   * `toBinary`. A generated `Message` shares no members with the shape being
   * walked, so both ends previously needed an escape hatch - `as unknown as`
   * on the way in and `as never` on the way out - and the second of those
   * would have accepted literally any value. The JSON codec is the right
   * boundary for this: its output IS a plain JSON tree, `fromJson` validates
   * the mutated tree against the same descriptor before re-encoding, and a
   * wrong shape now fails there rather than being silently re-serialized.
   */
  const decoded = decodeDexScreenerMessageToJson(message, frame, {
    maxBytes: frame.byteLength,
  }) as Record<string, { pairs: { pairAddress: string }[] } | undefined>;
  /*
   * THE ONEOF IS A DIRECT FIELD IN PROTOBUF-JSON, measured rather than assumed:
   * `dex_screener.PairsChannelMessage` decodes to `{ pairs: { stats, pairs,
   * pairsCount } }`, not to the generated Message's `{ payload: { case, value } }`.
   * The old `as unknown as` shape asserted the latter and, because a double cast
   * silences the compiler completely, it type-checked while being wrong about
   * the data. The oneof member is keyed off the message name so the token
   * BOTH channels name that member `pairs`, measured: the token channel's
   * message decodes to `{ pairs: ... }` as well, so there is no per-message
   * branch to make here.
   */
  const wrapper = decoded["pairs"];
  if (wrapper === undefined) {
    throw new Error(
      `no pairs block in the decoded ${message}; keys: ${Object.keys(decoded).join(", ")}`
    );
  }
  const rows = wrapper.pairs;
  wrapper.pairs = [...rows.slice(rows.length - repeated), ...rows];
  for (const row of wrapper.pairs) {
    row.pairAddress = `${row.pairAddress}-page2`;
  }
  return toBinary(descriptor, fromJson(descriptor, decoded as JsonValue));
}

afterEach(() => {
  release?.();
  release = null;
});

function handlerFor(toolId: string): ProtocolHandler {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

async function call(
  toolId: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await handlerFor(toolId)(params, CTX);
  return JSON.parse(result.output) as Record<string, unknown>;
}

/** The tool's rejection text, for the paths that must fail closed. */
async function callRaw(toolId: string, params: Record<string, unknown>) {
  return handlerFor(toolId)(params, CTX);
}

const PAIR_FRAMES = [LATEST_BLOCK_FRAME, PAIRS_FRAME];

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

describe("the eight screening tools are wired", () => {
  const TOOL_IDS = [
    "dexscreener.pairs.trending",
    "dexscreener.pairs.top",
    "dexscreener.gainers",
    "dexscreener.losers",
    "dexscreener.pairs.new",
    "dexscreener.launchpad.pairs",
    "dexscreener.chains",
    "dexscreener.tokens.screen",
  ];

  for (const toolId of TOOL_IDS) {
    it(`${toolId} has a handler`, () => {
      expect(typeof DEXSCREENER_HANDLERS[toolId]).toBe("function");
    });
  }
});

/* ------------------------------------------------------------------ */
/* Shaping parameter boundaries                                        */
/* ------------------------------------------------------------------ */

describe("shaping parameter boundaries", () => {
  beforeEach(() => {
    mount(PAIR_FRAMES);
  });

  it("limit 0 is refused by name, not raised to the default", async () => {
    const result = await callRaw("dexscreener.pairs.trending", { limit: 0 });
    expect(result.output).toContain("limit");
    expect(result.output).toContain("1 to 100");
  });

  it("limit above the provider page size is refused, not clamped", async () => {
    const result = await callRaw("dexscreener.pairs.trending", { limit: 500 });
    // Clamping would make `hasMore` describe a window the agent never asked
    // for, so the refusal names the ceiling and the way past it.
    expect(result.output).toContain("100");
    expect(result.output).toContain("offset");
  });

  it("a fractional limit is refused", async () => {
    const result = await callRaw("dexscreener.pairs.trending", { limit: 2.5 });
    expect(result.output).toContain("whole number");
  });

  it("a negative offset is refused by name", async () => {
    const result = await callRaw("dexscreener.pairs.trending", { offset: -1 });
    expect(result.output).toContain("offset");
  });

  it("an unknown fields group is refused with the whole vocabulary", async () => {
    const result = await callRaw("dexscreener.pairs.trending", {
      fields: "core,socials",
    });
    expect(result.output).toContain("socials");
    expect(result.output).toContain("allWindows");
    expect(result.output).toContain("launchpad");
  });

  it("an unknown window value is refused with the accepted set", async () => {
    const result = await callRaw("dexscreener.pairs.trending", { window: "h12" });
    expect(result.output).toContain("h12");
    expect(result.output).toContain("m5, h1, h6, h24");
  });

  it("a non-numeric threshold is refused rather than sent as NaN", async () => {
    const result = await callRaw("dexscreener.pairs.trending", {
      minLiquidityUsd: "lots",
    });
    expect(result.output).toContain("minLiquidityUsd");
    expect(result.output).toContain("finite number");
  });
});

/* ------------------------------------------------------------------ */
/* Chain vocabulary                                                    */
/* ------------------------------------------------------------------ */

describe("chain scope", () => {
  it("accepts a comma-separated string and an array identically", async () => {
    const first = mount(PAIR_FRAMES);
    await call("dexscreener.pairs.trending", { chainIds: "solana,bsc" });
    release?.();
    release = null;

    const second = mount(PAIR_FRAMES);
    await call("dexscreener.pairs.trending", { chainIds: ["solana", "bsc"] });

    expect(second.wsUrls[0]).toBe(first.wsUrls[0]);
    expect(first.wsUrls[0]).toContain("filters[chainIds][0]=solana");
    expect(first.wsUrls[0]).toContain("filters[chainIds][1]=bsc");
  });

  it("refuses an unknown chain BY NAME with candidates instead of an empty board", async () => {
    mount(PAIR_FRAMES);
    const result = await callRaw("dexscreener.pairs.trending", {
      chainIds: "solanaa",
    });
    expect(result.output).toContain("solanaa");
    expect(result.output).toContain("solana");
    // The remedy names where the vocabulary lives.
    expect(result.output).toContain("dexscreener__chains_list");
  });

  it("omitting chainIds screens every chain and sends no chain filter", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {});
    expect(recorded.wsUrls[0]).not.toContain("chainIds");
    expect(data.summary).toContain("all indexed chains");
  });
});

/* ------------------------------------------------------------------ */
/* Default floors                                                      */
/* ------------------------------------------------------------------ */

describe("default quality floors", () => {
  it("gainers applies the frozen h24 floor and echoes every value", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.gainers", { chainIds: "solana" });

    const url = recorded.wsUrls[0] ?? "";
    // h24-anchored exactly as the site sends it, even though the ranking
    // window here is also h24: the anchor is the plan's frozen decision.
    expect(url).toContain("filters[txns][h24][min]=300");
    expect(url).toContain("filters[sells][h24][min]=30");
    expect(url).toContain("filters[volume][h24][min]=100000");
    expect(url).toContain("filters[liquidity][min]=250000");
    expect(url).toContain("filters[enhancedTokenInfo]=true");

    expect(data.qualityFloorApplied).toBe(true);
    const applied = data.defaultsApplied as { param: string }[];
    expect(applied.map((entry) => entry.param).sort()).toEqual([
      "minLiquidityUsd",
      "minSellCount",
      "minTxnCount",
      "minVolumeUsd",
      "requireProfile",
    ]);
  });

  it("null is refused by name and points at disableQualityFloor", async () => {
    mount(PAIR_FRAMES);
    const result = await callRaw("dexscreener.gainers", {
      chainIds: "solana",
      minLiquidityUsd: null,
    });
    // A tool schema cannot declare a nullable number, so the null spelling is
    // not a mechanism the model could have discovered; the refusal names the
    // one that is in the schema.
    expect(result.output).toContain("does not accept null");
    expect(result.output).toContain("disableQualityFloor");
  });

  it("disableQualityFloor drops every default floor, and the summary says so", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.gainers", {
      chainIds: "solana",
      disableQualityFloor: true,
    });

    const url = recorded.wsUrls[0] ?? "";
    for (const key of [
      "filters[liquidity][min]",
      "filters[volume]",
      "filters[txns]",
      "filters[sells]",
      "filters[enhancedTokenInfo]",
    ]) {
      expect(url).not.toContain(key);
    }
    expect(data.qualityFloorApplied).toBe(false);
    const summary = data.summary as string;
    expect(summary).toContain("no quality floor in force");
    expect(summary).toContain("removed at your request");
    // Nothing that did not run may be named as a floor that did.
    expect(summary).not.toContain("quality floor minTxnCount");
    expect(
      (data.defaultsDisabled as { param: string }[]).map((entry) => entry.param)
    ).toEqual([
      "minTxnCount",
      "minSellCount",
      "minVolumeUsd",
      "minLiquidityUsd",
      "requireProfile",
    ]);
  });

  it("requireProfile false removes the filter, and neither flag nor summary claims it", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.gainers", {
      chainIds: "solana",
      requireProfile: false,
    });

    // The provider has no not-profiled filter, so false sends NOTHING. The
    // measured defect was an envelope that still reported the floor as held.
    expect(recorded.wsUrls[0]).not.toContain("enhancedTokenInfo");
    expect(data.qualityFloorApplied).toBe(false);
    const summary = data.summary as string;
    expect(summary).toContain("removed at your request: requireProfile");
    expect(summary).not.toContain("quality floor requireProfile");
    expect(data.defaultsDisabled).toEqual([
      {
        param: "requireProfile",
        defaultValue: true,
        disposition: "removed",
        effectiveValue: null,
        effectiveKey: null,
      },
    ]);
    // The floors that DID run are still claimed, at their own values.
    expect(summary).toContain("quality floor minTxnCount 300 over h24");
  });

  it("a weakened floor is summarised at the value that ran, not at the default", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.gainers", {
      chainIds: "solana",
      minLiquidityUsd: 1_000,
    });

    // Measured: this weakening grew the screened population from 162 rows to
    // 545 while the summary still quoted the 250,000 default.
    expect(recorded.wsUrls[0]).toContain("filters[liquidity][min]=1000");
    expect(data.qualityFloorApplied).toBe(false);
    const summary = data.summary as string;
    expect(summary).toContain("loosened below the default: minLiquidityUsd 1,000 instead of minLiquidityUsd 250,000");
    expect(summary).not.toContain("quality floor minLiquidityUsd 250,000");
    expect(data.defaultsOverridden).toEqual([
      {
        param: "minLiquidityUsd",
        defaultValue: 250_000,
        disposition: "weakened",
        effectiveValue: 1_000,
        effectiveKey: "filters[liquidity][min]",
      },
    ]);
  });

  it("a tightened floor keeps the claim, at the tightened value", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.gainers", {
      chainIds: "solana",
      minLiquidityUsd: 1_000_000,
    });

    expect(recorded.wsUrls[0]).toContain("filters[liquidity][min]=1000000");
    expect(data.qualityFloorApplied).toBe(true);
    expect(data.summary).toContain("minLiquidityUsd 1,000,000");
  });

  it("losers carries the same floor as gainers, ranked the other way", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.losers", { chainIds: "solana" });

    expect(recorded.wsUrls[0]).toContain("rankBy[order]=asc");
    expect(recorded.wsUrls[0]).toContain("filters[txns][h24][min]=300");
    expect(data.qualityFloorApplied).toBe(true);
  });

  it("trending declares no floor, and says so instead of claiming one", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", { chainIds: "solana" });

    // No floors declared means no floor to claim: the flag is false and the
    // summary states it in words, so neither reads as "floor removed".
    expect(data.qualityFloorApplied).toBe(false);
    expect(data.defaultsApplied).toEqual([]);
    expect(data.summary).toContain("no default quality floor");
  });

  it("the new-pairs board applies the age and liquidity defaults", async () => {
    const recorded = mount(PAIR_FRAMES);
    await call("dexscreener.pairs.new", { chainIds: "solana" });

    expect(recorded.wsUrls[0]).toContain("rankBy[key]=pairAge");
    expect(recorded.wsUrls[0]).toContain("rankBy[order]=asc");
    // 86,400 seconds converted to the provider's fractional hours, once.
    expect(recorded.wsUrls[0]).toContain("filters[pairAge][max]=24");
    expect(recorded.wsUrls[0]).toContain("filters[liquidity][min]=1000");
  });
});

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

describe("pinned ranking", () => {
  it("trending pins the trending score of the selected window", async () => {
    const recorded = mount(PAIR_FRAMES);
    await call("dexscreener.pairs.trending", { window: "h1" });
    expect(recorded.wsUrls[0]).toContain("rankBy[key]=trendingScoreH1");
    expect(recorded.wsUrls[0]).toContain("/h1/1");
  });

  it("gainers and losers pin the price change of the selected window", async () => {
    const recorded = mount(PAIR_FRAMES);
    await call("dexscreener.gainers", { window: "m5" });
    expect(recorded.wsUrls[0]).toContain("rankBy[key]=priceChangeM5");
    expect(recorded.wsUrls[0]).toContain("rankBy[order]=desc");
  });

  it("top maps its sortBy onto the provider rank key and honours sortDir", async () => {
    const recorded = mount(PAIR_FRAMES);
    await call("dexscreener.pairs.top", { sortBy: "liquidity", sortDir: "asc" });
    expect(recorded.wsUrls[0]).toContain("rankBy[key]=liquidity");
    expect(recorded.wsUrls[0]).toContain("rankBy[order]=asc");
  });

  it("top ranks by the provider's active-boost key when asked", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.top", {
      chainIds: "solana",
      sortBy: "boosts",
    });

    expect(recorded.wsUrls[0]).toContain("rankBy[key]=activeBoosts");
    // An advertising ranking is not the volume board, so it inherits no floor.
    expect(data.qualityFloorApplied).toBe(false);
    expect(data.summary).toContain("no default quality floor");
  });

  it("maxBoostCount bounds the advertised end of the board", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.top", {
      chainIds: "solana",
      maxBoostCount: 10,
    });

    expect(recorded.wsUrls[0]).toContain("filters[activeBoosts][max]=10");
    expect(data.filtersApplied).toContainEqual({
      filter: "activeBoosts",
      key: "filters[activeBoosts][max]",
      value: "10",
    });
  });

  it("top defaults to volume with the volume floor preset", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.top", { chainIds: "solana" });
    expect(recorded.wsUrls[0]).toContain("rankBy[key]=volume");
    expect(recorded.wsUrls[0]).toContain("filters[txns][h24][min]=50");
    expect(data.qualityFloorApplied).toBe(true);
  });

  it("top sorted by liquidity applies no floor, matching the frozen matrix", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.top", { sortBy: "liquidity" });
    expect(recorded.wsUrls[0]).not.toContain("filters[txns]");
    expect(data.qualityFloorApplied).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Launchpad                                                           */
/* ------------------------------------------------------------------ */

describe("launchpad board", () => {
  const BONDING_FRAMES = [LATEST_BLOCK_FRAME, BONDING_FRAME];

  it("bonding lifts the hidden exclusion and caps progress below graduation", async () => {
    const recorded = mount(BONDING_FRAMES);
    // `dexIds`, not `launchpadIds`: on the bonding stage the provider has not
    // attached a launchpad id to the pair yet, so `launchpadIds` is refused by
    // name here (see the refusal test below). The subject of THIS test is the
    // exclusion lift and the progress cap, so it uses the filter that works.
    const data = await call("dexscreener.launchpad.pairs", {
      chainIds: "solana",
      dexIds: "pumpfun",
    });

    // The empty-item form is the SAFE lift; it still replaces the provider's
    // hidden default, and the envelope has to say so.
    expect(recorded.wsUrls[0]).toContain("filters[excludedDexIds][]=");
    expect(recorded.wsUrls[0]).toContain("filters[launchpadProgress][max]=99.99");
    expect(data.exclusionDefaultReplaced).toBe(true);
  });

  it("refuses launchpadIds on the bonding stage by name, naming the filter that works", async () => {
    // Measured 2026-08-24: `launchpad.meta` is `{}` on every bonding row and
    // carries an id only AFTER migration, so the provider's launchpadIds
    // filter matches graduated rows only. The manifest's own former example
    // (stage bonding + launchpadIds pumpfun) returned 0 rows and pairsCount 0
    // while dexIds pumpfun matched 53,478. An empty board reads to an agent as
    // "nothing is bonding right now", so this fails closed instead.
    mount(BONDING_FRAMES);
    const result = await callRaw("dexscreener.launchpad.pairs", {
      chainIds: "solana",
      stage: "bonding",
      launchpadIds: "pumpfun",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("launchpadIds");
    expect(result.output).toContain("dexIds");
  });

  it("refuses the same pairing when the bonding stage is the default rather than explicit", async () => {
    // `stage` defaults to bonding, so the trap is reachable without the caller
    // ever naming the stage. A guard that only fired on the explicit spelling
    // would miss the shorter call an agent is more likely to write.
    mount(BONDING_FRAMES);
    const result = await callRaw("dexscreener.launchpad.pairs", {
      chainIds: "solana",
      launchpadIds: "pumpfun",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("dexIds");
  });

  it("accepts launchpadIds on the graduated stage, where the provider does attach it", async () => {
    mount(BONDING_FRAMES);
    const result = await callRaw("dexscreener.launchpad.pairs", {
      chainIds: "solana",
      stage: "graduated",
      launchpadIds: "pumpfun",
    });
    expect(result.success).toBe(true);
  });

  it("ships the launchpad group at DEFAULT params, so the ranked column is visible", async () => {
    // The board ranks by bonding progress. With only the `core` group shipped
    // by default, every row came back with no progress, no creator and no
    // migration dex unless the caller guessed fields: "core,launchpad", which
    // no description mentioned: the board's whole reason to exist was
    // invisible in its own output.
    mount(BONDING_FRAMES);
    const data = await call("dexscreener.launchpad.pairs", {
      chainIds: "solana",
    });
    const rows = data["rows"] as readonly Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.hasOwn(row, "launchpad")).toBe(true);
    }
  });

  it("graduated pins the completed side of the curve", async () => {
    const recorded = mount(BONDING_FRAMES);
    await call("dexscreener.launchpad.pairs", {
      chainIds: "solana",
      stage: "graduated",
    });
    expect(recorded.wsUrls[0]).toContain("filters[launchpadProgress][min]=100");
    expect(recorded.wsUrls[0]).not.toContain("filters[launchpadProgress][max]");
  });

  it("bonding rows report null liquidity rather than zero", async () => {
    mount(BONDING_FRAMES);
    const data = await call("dexscreener.launchpad.pairs", {
      chainIds: "solana",
    });
    const rows = data.rows as {
      liquidityUsd: number | null;
      missingInputs: string[];
      // Declared on ShapedPairRow itself; the local type was simply missing it,
      // which is what the cast at the assertion below was working around.
      notApplicableInputs?: readonly string[];
    }[];
    const first = rows[0];
    expect(first).toBeDefined();
    // Measured: bonding rows carry no `liquidity` field at all. Reporting 0
    // would be a lie about a pair that is trading. A bonding-curve pair has
    // no liquidity POOL, so the input is not_applicable, not an unreported
    // measurement: it is absent from `missingInputs` and named in
    // `notApplicableInputs` instead.
    expect(first?.liquidityUsd).toBeNull();
    expect(first?.missingInputs).not.toContain("liquidityUsd");
    expect(first?.notApplicableInputs).toContain("liquidityUsd");
  });
});

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

describe("envelope accounting", () => {
  it("returned, offset and the continuation agree with the rows shipped", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 5,
    });

    const rows = data.rows as unknown[];
    expect(rows).toHaveLength(5);
    expect(data.returned).toBe(5);
    expect(data.offset).toBe(0);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(5);
    // Nothing was dropped by client filtering: rows beyond the requested
    // window were never candidates, and `offset`/`hasMore`/`nextOffset` already
    // account for them, so no `clientFiltering` block is emitted.
    expect(data.clientFiltering).toBeUndefined();
  });

  it("an offset inside the first provider page fetches one page and slices it", async () => {
    const recorded = mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      offset: 10,
      limit: 3,
    });

    expect(recorded.wsUrls).toHaveLength(1);
    expect(recorded.wsUrls[0]).toContain("/h24/1");
    expect(data.offset).toBe(10);
    expect(data.returned).toBe(3);
    expect(data.nextOffset).toBe(13);
  });

  it("the provider total travels with its measured instability warning", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", { chainIds: "solana" });
    const total = data.totalMatchedApprox as {
      isApproximate: boolean;
      warning: string;
      totalUnavailable: boolean;
    };

    expect(total.isApproximate).toBe(true);
    expect(total.totalUnavailable).toBe(false);
    expect(total.warning).toContain("not a stable total");
  });

  it("filtersApplied echoes what actually went on the wire", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      minLiquidityUsd: 25_000,
    });
    const applied = data.filtersApplied as { filter: string; key: string; value: string }[];

    expect(applied).toContainEqual({
      filter: "liquidity",
      key: "filters[liquidity][min]",
      value: "25000",
    });
    expect(applied).toContainEqual({
      filter: "chainIds",
      key: "filters[chainIds][0]",
      value: "solana",
    });
  });

  it("marketStats carries the frame's own per-window scale", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", { chainIds: "solana" });
    const stats = data.marketStats as Record<string, { volumeUsd: number | null }>;
    expect(stats.h24?.volumeUsd).toEqual(expect.any(Number));
  });

  it("the summary is quantitative: window, floor, count and the top row's number", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 3,
    });
    const summary = data.summary as string;

    expect(summary).toContain("solana");
    expect(summary).toContain("h24");
    expect(summary).toContain("Returned 3 rows from offset 0");
    expect(summary).toContain("Top row:");
  });
});

describe("the volume share is named after its denominator", () => {
  it("a single-chain query gets chainVolumeSharePct", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 3,
    });
    const derived = (data.rows as { derived: Record<string, unknown> }[])[0]
      ?.derived;

    expect(derived).toHaveProperty("chainVolumeSharePct");
    expect(derived).not.toHaveProperty("filteredSetVolumeSharePct");
  });

  it("a multi-chain query gets filteredSetVolumeSharePct instead", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana,base",
      limit: 3,
    });
    const derived = (data.rows as { derived: Record<string, unknown> }[])[0]
      ?.derived;

    // The denominator is the summed frame (measured 7.860 billion USD across a
    // solana plus base frame). Same number, honest name.
    expect(derived).toHaveProperty("filteredSetVolumeSharePct");
    expect(derived).not.toHaveProperty("chainVolumeSharePct");
  });

  it("an all-chain query never claims a chain share", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", { limit: 3 });
    const derived = (data.rows as { derived: Record<string, unknown> }[])[0]
      ?.derived;

    expect(derived).not.toHaveProperty("chainVolumeSharePct");
    expect(derived).toHaveProperty("filteredSetVolumeSharePct");
  });

  it("a single-chain query with a row-excluding filter still gets filteredSetVolumeSharePct", async () => {
    // Regression for FI16: `resolveShareBasis` only varied chain count in the
    // existing tests. A single-chain query that also carries a row-excluding
    // filter (here `minLiquidityUsd`) moves the stats denominator off the
    // whole chain's total, so the share must not be labelled a chain share.
    // Measured live 2026-08-24: solana plus a liquidity/pairAge filter
    // reported 70 percent of the unfiltered chain total. Fails if the
    // predicate drops the row-excluding-filter check and returns to varying
    // only on chain count.
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      minLiquidityUsd: 1_000,
      limit: 3,
    });
    const derived = (data.rows as { derived: Record<string, unknown> }[])[0]
      ?.derived;

    expect(derived).toHaveProperty("filteredSetVolumeSharePct");
    expect(derived).not.toHaveProperty("chainVolumeSharePct");
  });

  it("a real excludeDexIds LIST drops the chain-share name, while the empty lift keeps it", async () => {
    // S9-9. The exemption for `filters[excludedDexIds]` was written for the
    // LIFT form, which excludes no row, and then applied to the filter NAME,
    // which both forms share. Measured on solana, h24: naming one venue moved
    // the stats denominator by -75.17 percent while the share kept the word
    // "chain" in it. The two calls below differ only in that form.
    mount(PAIR_FRAMES);
    const lifted = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      includeLaunchpadPairs: true,
      limit: 1,
    });
    const narrowed = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      excludeDexIds: "pumpswap",
      limit: 1,
    });
    const liftedDerived = (lifted.rows as { derived: Record<string, unknown> }[])[0]?.derived;
    const narrowedDerived = (narrowed.rows as { derived: Record<string, unknown> }[])[0]?.derived;

    expect(liftedDerived).toHaveProperty("chainVolumeSharePct");
    expect(narrowedDerived).not.toHaveProperty("chainVolumeSharePct");
    expect(narrowedDerived).toHaveProperty("filteredSetVolumeSharePct");
    // Both forms still report that the provider's hidden default was replaced;
    // that flag was never the thing that could tell them apart.
    expect(lifted.exclusionDefaultReplaced).toBe(true);
    expect(narrowed.exclusionDefaultReplaced).toBe(true);
  });

  it("the two names carry the same measurement, so only the label moved", async () => {
    mount(PAIR_FRAMES);
    const single = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 1,
    });
    const multi = await call("dexscreener.pairs.trending", {
      chainIds: "solana,base",
      limit: 1,
    });
    const one = (single.rows as { derived: Record<string, number | null> }[])[0];
    const many = (multi.rows as { derived: Record<string, number | null> }[])[0];

    expect(one?.derived.chainVolumeSharePct).toBe(
      many?.derived.filteredSetVolumeSharePct
    );
  });
});

/* ------------------------------------------------------------------ */
/* Field groups over real rows                                         */
/* ------------------------------------------------------------------ */

describe("field groups over real provider rows", () => {
  it("the default projection omits profile, launchpad, identity and allWindows", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 1,
    });
    const row = (data.rows as Record<string, unknown>[])[0] ?? {};

    expect("profile" in row).toBe(false);
    expect("windows" in row).toBe(false);
    expect("ammId" in row).toBe(false);
    // Core still carries the derived metrics, which are the point of the surface.
    expect(row).toHaveProperty("derived");
  });

  it("requesting profile ships the block and labels it as issuer-authored", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 5,
      fields: "profile",
    });
    const rows = data.rows as Record<string, unknown>[];

    for (const row of rows) expect("profile" in row).toBe(true);
    expect(data.externalContentFields).toContain("profile.description");
    expect(data.externalContentWarning).toContain("untrusted data");
    // Nothing was stripped from these captured rows, and the tool says so with
    // an empty list rather than by omitting the key.
    expect(data.sanitizedFields).toEqual([]);
  });

  it("requesting allWindows ships all four windows beside the selected one", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 1,
      fields: "allWindows",
    });
    const row = (data.rows as Record<string, unknown>[])[0] ?? {};
    const windows = row.windows as Record<string, unknown>;

    expect(Object.keys(windows).sort()).toEqual(["h1", "h24", "h6", "m5"]);
  });

  it("computes each window's share against ITS OWN frame volume, not the selected window's", async () => {
    // Regression for FI2: every window used to divide by the SELECTED
    // window's frame total. Measured live: an h24 share of a solana m5-board
    // row came out 3.53 percent against a true 0.0395 percent, an 89x
    // overstatement. Recompute each window's share independently from the
    // fixture's own marketStats and row volumes; it must fail if all four
    // windows share one denominator.
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 1,
      fields: "allWindows",
    });
    const row = (data.rows as Record<string, unknown>[])[0] ?? {};
    const windows = row.windows as Record<
      string,
      { volumeUsd: number; derived: Record<string, number | null> }
    >;
    const marketStats = data.marketStats as Record<
      string,
      { volumeUsd: number | null }
    >;

    for (const window of ["m5", "h1", "h6", "h24"] as const) {
      const rowVolume = windows[window]?.volumeUsd;
      const frameVolume = marketStats[window]?.volumeUsd;
      expect(rowVolume).not.toBeNull();
      expect(frameVolume).not.toBeNull();
      const expectedSharePct =
        ((rowVolume as number) / (frameVolume as number)) * 100;
      const actualSharePct = windows[window]?.derived.chainVolumeSharePct;
      expect(actualSharePct).not.toBeNull();
      expect(
        Math.abs((actualSharePct as number) - expectedSharePct) /
          expectedSharePct
      ).toBeLessThan(1e-4);
    }

    // The four windows are genuinely different measurements, not four copies
    // of the same ratio: if they were all divided by one shared denominator
    // this would trivially hold too, so this alone would not catch the
    // regression, but combined with the per-window recomputation above it
    // proves the denominators actually differ.
    const shares = (["m5", "h1", "h6", "h24"] as const).map(
      (window) => windows[window]?.derived.chainVolumeSharePct
    );
    expect(new Set(shares).size).toBeGreaterThan(1);
  });

  it("requesting identity ships the inputs the deeper tools need", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      limit: 1,
      fields: "identity",
    });
    const row = (data.rows as Record<string, unknown>[])[0] ?? {};

    expect(row).toHaveProperty("ammId");
    expect(row).toHaveProperty("quoteTokenAddress");
  });
});

/* ------------------------------------------------------------------ */
/* Token channel                                                       */
/* ------------------------------------------------------------------ */

describe("the token channel's honesty contract", () => {
  const TOKEN_FRAMES = [LATEST_BLOCK_FRAME, TOKENS_FRAME];

  it("reports no total at all, rather than the page length as one", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", { chainIds: "solana" });
    const total = data.totalMatchedApprox as {
      value: number | null;
      totalUnavailable: boolean;
      warning: string;
    };

    // The provider sends `pairsCount` on this channel and it is the PAGE
    // LENGTH. Publishing it as a total would be a number that does not exist.
    expect(total.totalUnavailable).toBe(true);
    expect(total.value).toBeNull();
    expect(total.warning).toContain("no total");
  });

  it("declares that adjacent pages overlap", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", { chainIds: "solana" });
    const window = data.providerWindow as { pagesMayOverlap: boolean; endpoint: string };

    expect(window.pagesMayOverlap).toBe(true);
    expect(window.endpoint).toBe("/dex/screener/v2/tokens");
  });

  it("carries the measured honesty block verbatim from the client", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", { chainIds: "solana" });
    expect(data.honesty).toEqual(TOKENS_CHANNEL_HONESTY);
  });

  it("says in words that traversal is not exhaustive", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", { chainIds: "solana" });
    expect(data.summary).toContain("not exhaustive");
  });

  it("says in the summary that the metrics are sums and the valuation is one pool's", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", { chainIds: "solana" });
    const summary = data.summary as string;
    // The row is a hybrid, and the summary is the sentence a model quotes.
    // Measured: the same pool carried 2.20x the liquidity here that it carried
    // on the pair channel at the same instant, and JUP's representative-pool
    // market cap was served at 3.68 trillion USD.
    expect(summary).toContain("SUMS across each token's pools");
    expect(summary).toContain("representative pool");
    expect(summary).toContain("orders of magnitude");
    // A short board here is a coverage fact, not a market fact.
    expect(summary).toContain("profile-carrying tokens only");
  });

  it("ranks by pairAge ascending by default, and an explicit sortDir still wins", async () => {
    const recorded = mount(TOKEN_FRAMES);
    // "Newest tokens" is what pairAge is asked for, and that is ascending age;
    // a desc default would answer the opposite question. Measured live
    // 2026-08-25: desc served tokens created in 2022 and 2023, asc served
    // tokens created that day.
    const ascending = await call("dexscreener.tokens.screen", {
      chainIds: "solana",
      sortBy: "pairAge",
    });
    expect(ascending.rankApplied).toEqual({ key: "pairAge", order: "asc" });
    expect(recorded.wsUrls[0]).toContain("rankBy[order]=asc");

    const descending = await call("dexscreener.tokens.screen", {
      chainIds: "solana",
      sortBy: "pairAge",
      sortDir: "desc",
    });
    expect(descending.rankApplied).toEqual({ key: "pairAge", order: "desc" });
  });

  it("passes sortDir through on the metric keys, where desc is the default", async () => {
    mount(TOKEN_FRAMES);
    expect(
      (await call("dexscreener.tokens.screen", { chainIds: "solana", sortBy: "volume" }))
        .rankApplied
    ).toEqual({ key: "volume", order: "desc" });
    expect(
      (await call("dexscreener.tokens.screen", {
        chainIds: "solana",
        sortBy: "volume",
        sortDir: "asc",
      })).rankApplied
    ).toEqual({ key: "volume", order: "asc" });
  });

  it("counts repeats across pages BY TOKEN, because the repeated rows carry different pairs", async () => {
    // The measured shape, reproduced: pages 1 and 2 of one token board
    // repeated 14 base tokens carrying ZERO repeated pair addresses (17 on the
    // earlier capture, likewise zero). A duplicate counter keyed on the pair
    // address therefore reported 0 duplicates on a window that had just
    // re-served a dozen tokens. Page 2 here is page 1's real bytes with every
    // pair address renamed and nothing else touched, which is exactly the
    // difference the provider itself serves.
    mountPages([
      [LATEST_BLOCK_FRAME, TOKENS_FRAME],
      [LATEST_BLOCK_FRAME, pageRepeatingTail(TOKENS_FRAME, 5, "dex_screener.TokensChannelMessage")],
    ]);
    const data = await call("dexscreener.tokens.screen", {
      chainIds: "solana",
      offset: 95,
      limit: 10,
    });
    const window = data.providerWindow as {
      distinctRowsReturned: number;
      duplicateRowsAcrossPages: number;
    };
    expect(data.returned).toBe(10);
    // Five rows from the tail of page 1 and the same five tokens back at the
    // head of page 2, under different pair addresses.
    expect(window.duplicateRowsAcrossPages).toBe(5);
    expect(window.distinctRowsReturned).toBe(5);
  });

  it("the pair boards still key their repeats on the pair address", async () => {
    mountPages([
      [LATEST_BLOCK_FRAME, PAIRS_FRAME],
      [LATEST_BLOCK_FRAME, pageRepeatingTail(PAIRS_FRAME, 5)],
    ]);
    const data = await call("dexscreener.pairs.trending", {
      chainIds: "solana",
      offset: 95,
      limit: 10,
    });
    const window = data.providerWindow as {
      distinctRowsReturned: number;
      duplicateRowsAcrossPages: number;
    };
    // A pair row IS its pair address, so renaming it makes ten distinct rows.
    // This is the assertion that stops the token fix from being applied to a
    // channel whose identity it would be wrong on.
    expect(window.duplicateRowsAcrossPages).toBe(0);
    expect(window.distinctRowsReturned).toBe(10);
  });

  it("carries the provider's own ordinal per row, because the order is opaque", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", {
      chainIds: "solana",
      limit: 3,
    });
    const ranks = (data.rows as { providerRank: number }[]).map(
      (row) => row.providerRank
    );
    // 1-based over the order the provider served: the score behind it does not
    // reproduce from any visible metric, so the position is the only citable
    // fact about the ordering.
    expect(ranks).toEqual([1, 2, 3]);
  });

  it("the ordinal counts from the offset, not from the page", async () => {
    mount(TOKEN_FRAMES);
    const data = await call("dexscreener.tokens.screen", {
      chainIds: "solana",
      offset: 10,
      limit: 2,
    });
    expect(
      (data.rows as { providerRank: number }[]).map((row) => row.providerRank)
    ).toEqual([11, 12]);
  });

  it("the pair boards emit no ordinal, because their ranking is a stated metric", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.pairs.top", {
      chainIds: "solana",
      limit: 2,
    });
    for (const row of data.rows as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("providerRank");
    }
  });

  it("uses the v2 tokens path", async () => {
    const recorded = mount(TOKEN_FRAMES);
    await call("dexscreener.tokens.screen", { chainIds: "solana" });
    expect(recorded.wsUrls[0]).toContain("/dex/screener/v2/tokens/h24/1");
  });
});

/* ------------------------------------------------------------------ */
/* Chain catalog                                                       */
/* ------------------------------------------------------------------ */

describe("the chain catalog tool", () => {
  it("lists every indexed chain with its dexes and explorer templates", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.chains", {});
    const chains = data.chains as Record<string, unknown>[];

    expect(chains.length).toBeGreaterThan(50);
    expect(data.returned).toBe(chains.length);
    expect(data.totalChains).toBe(chains.length);
    // A complete document, not a page: there is nothing to continue to, and
    // saying so is different from staying silent.
    expect(data.hasMore).toBe(false);

    const solana = chains.find((chain) => chain.slug === "solana");
    expect(solana).toBeDefined();
    expect(solana?.dexIds).toEqual(expect.any(Array));
    expect(solana?.blockExplorer).toBeDefined();
  });

  it("narrowing to one chain expands only that chain", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.chains", { chain: "solana" });
    const chains = data.chains as Record<string, unknown>[];

    expect(chains).toHaveLength(1);
    expect(chains[0]?.slug).toBe("solana");
    expect(data.totalChains).toBeGreaterThan(50);
  });

  it("refuses an unknown chain with candidates rather than an empty list", async () => {
    mount(PAIR_FRAMES);
    const result = await callRaw("dexscreener.chains", { chain: "solanaa" });
    expect(result.output).toContain("solanaa");
    expect(result.output).toContain("solana");
  });

  it("resolves a numeric chain id end to end, not the raw string against the slug", async () => {
    // Regression for FI13: filtering matched the caller's raw string against
    // `chain.slug` instead of the resolved canonical slug. Measured live:
    // `{chain:"1"}` returned `success:true, returned:0, chains:[]` with the
    // confident summary "1 (1) with its 0 DEX identifiers". It must fail if
    // the filter reverts to comparing against the raw string.
    mount(PAIR_FRAMES);
    const ethereum = await call("dexscreener.chains", { chain: "1" });
    const ethereumChains = ethereum.chains as Record<string, unknown>[];
    expect(ethereumChains).toHaveLength(1);
    expect(ethereumChains[0]?.slug).toBe("ethereum");
    expect(ethereum.summary).toContain("ethereum");
    expect(ethereum.summary).not.toContain("with its 0 DEX identifiers");

    const bsc = await call("dexscreener.chains", { chain: "56" });
    const bscChains = bsc.chains as Record<string, unknown>[];
    expect(bscChains).toHaveLength(1);
    expect(bscChains[0]?.slug).toBe("bsc");
    expect(bsc.summary).toContain("bsc");
  });

  it("reports only the audit integrations that are actually enabled", async () => {
    mount(PAIR_FRAMES);
    const data = await call("dexscreener.chains", { chain: "solana" });
    const solana = (data.chains as Record<string, unknown>[])[0] ?? {};
    // Presence is CATALOG metadata: it says the provider can ask that auditor
    // about this chain, never that an audit exists for a given token.
    expect(solana.auditIntegrations).toEqual(expect.any(Array));
  });
});
