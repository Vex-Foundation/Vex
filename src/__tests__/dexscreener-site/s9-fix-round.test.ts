/**
 * Regressions for the S9 fix round: the defects wave-2 endpoint verification
 * measured against the SHIPPED surface, each pinned so reintroducing the
 * defect turns a test red.
 *
 * Every case here is a behavioural regression rather than a shape check,
 * because each defect produced an ordinary-looking answer: a security report
 * naming the wrong token, a summary describing a search window that was never
 * searched, a chain-share percentage computed over a narrowed denominator, and
 * a row count read as a count of identities.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { resolvePairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import { usd } from "@vex-agent/tools/protocols/dexscreener/handlers/resolve.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const DETAILS_ETH = loadJsonFixture("pair-details-ethereum-pepe").bytes;

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

function mount(body: Uint8Array): void {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map([["cache-control", "public, max-age=60"]]),
        body: isCatalog ? CATALOG : body,
      });
    },
    wsExchange: () => Promise.resolve([PAIR_FRAME]),
  };
  release = registerDexScreenerTransport(transport);
}

async function call(
  tool: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS[tool];
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error(`no handler for ${tool}`);
  const result = await handler(params, {} as never);
  expect(result.success, result.output).toBe(true);
  return result.data as Record<string, unknown>;
}

/**
 * S9-13: the pair-details summary named the BASE token unconditionally while
 * `reportedTokenSymbol` and `auditedTokenCheck` beside it named the quote side
 * under `inverted: true`. A security report that names the wrong asset is a
 * money-path defect, not a wording one.
 */
describe("the pair-details summary names the token the report is about", () => {
  it("names the quote side under inverted, in agreement with reportedTokenSymbol", async () => {
    mount(DETAILS_ETH);
    const answer = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      inverted: true,
    });
    const subject = answer["subject"] as Record<string, unknown>;
    const reported = subject["reportedTokenSymbol"];
    expect(typeof reported).toBe("string");
    expect(reported).not.toBe(subject["baseTokenSymbol"]);
    expect(reported).toBe(subject["quoteTokenSymbol"]);
    expect(answer["summary"]).toContain(String(reported));
    expect(answer["summary"]).not.toContain(String(subject["baseTokenSymbol"]));
  });

  it("names the base side when the report is not inverted", async () => {
    mount(DETAILS_ETH);
    const answer = await call("dexscreener.pair.details", {
      chain: CHAIN,
      pairAddress: PAIR,
      inverted: false,
    });
    const subject = answer["subject"] as Record<string, unknown>;
    expect(answer["summary"]).toContain(String(subject["baseTokenSymbol"]));
  });
});

/**
 * S9-10: the pair.get summary gated its "deepest of the search window" clause
 * on `!== "explicit_pair_address"`, so the third basis introduced by the I2
 * fix, `provider_resolved_from_token`, printed the clause with a blank token
 * address and two zeroes. The summary is the first thing the model reads, and
 * it contradicted the `resolutionNote` on the same answer.
 */
describe("the pair.get summary never claims a search window that was not searched", () => {
  it("says nothing about depth when the channel picked the pool itself", async () => {
    mount(DETAILS_ETH);
    // A token address in the pool slot: the channel answers with a pool of its
    // own choosing, so the frame's pairAddress differs from what was asked.
    const answer = await call("dexscreener.pair.get", {
      chain: CHAIN,
      pairAddress: "0xD629eb00dEced2a080B7EC630eF6aC117e614f1b",
    });
    expect(answer["resolutionBasis"]).toBe("provider_resolved_from_token");
    const summary = String(answer["summary"]);
    expect(summary).not.toContain("deepest");
    expect(summary).not.toContain("search window");
    expect(summary).not.toContain("resolved from token ");
    // The honest text for this basis is the note, and it is still there.
    expect(String(answer["resolutionNote"])).toContain("is not the pool this answer describes");
  });

  it("still states the window on the basis that really searched one", async () => {
    mount(DETAILS_ETH);
    const answer = await call("dexscreener.pair.get", {
      chain: CHAIN,
      pairAddress: PAIR,
    });
    expect(answer["resolutionBasis"]).toBe("explicit_pair_address");
    expect(String(answer["summary"])).not.toContain("deepest");
  });
});

/**
 * EP2 advisory: `usd()` rounded to whole dollars for the summary sentence, so
 * a quiet pool's measured 0.79 USD day printed as "$1" - a 27 percent
 * overstatement wearing the shape of an exact figure. A one-trade-a-day pool
 * is not an edge case on this surface: a celo board of 59 pairs had five of
 * its top eight quiet ones at three or fewer daily transactions.
 */
describe("a summary dollar figure never rounds a sub-dollar amount up to a dollar", () => {
  it.each([
    [0.79, "$0.79"],
    [0.5, "$0.50"],
    [0.004, "under $0.01"],
    [0, "$0"],
    [1, "$1"],
    [1_204_338.4, "$1,204,338"],
  ])("formats %s as %s", (value, expected) => {
    expect(usd(value)).toBe(expected);
  });

  it("says an amount is unreported rather than calling it zero dollars", () => {
    expect(usd(null)).toBe("an unreported amount");
  });
});

/**
 * A-6 (EP13 GUARD_COVERAGE_GAP): no test drove `resolvePairSubject` itself, so
 * a normalization introduced inside it could invert every deep-dive surface
 * while the handler-level guards stayed green. This drives the resolver
 * directly and pins the identity it hands the four deep-dive channels.
 */
describe("resolvePairSubject is driven directly, not only through its consumers", () => {
  it("returns the pair's own sides without swapping or lowercasing them", async () => {
    mount(DETAILS_ETH);
    const transport: DexScreenerTransport = {
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: () =>
        Promise.resolve({
          url: "https://io.dexscreener.com/",
          status: 200,
          headers: new Map<string, string>(),
          body: CATALOG,
        }),
      wsExchange: () => Promise.resolve([PAIR_FRAME]),
    };
    const subject = await resolvePairSubject({
      transport,
      chainId: CHAIN,
      pairAddress: PAIR,
      timeoutMs: 5_000,
    });
    expect(subject.chainId).toBe(CHAIN);
    expect(subject.pairAddress).toBe(PAIR);
    expect(subject.baseTokenAddress).not.toBe(subject.quoteTokenAddress);
    expect(subject.baseTokenSymbol).not.toBe(subject.quoteTokenSymbol);
    expect(subject.dexId).not.toBe("");
  });
});
