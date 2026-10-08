/**
 * `deadlineMs` on `dexscreener__trades_list` bounds each PAGE, not only the
 * gap between pages.
 *
 * THE DEFECT THIS CLOSES, measured in a live verification (2026-10-07)
 *
 * The walk checked its deadline only BETWEEN pages while every page waited up
 * to the channel's own 25 s timeout, so `deadlineMs: 5000` against a slow
 * channel answered after about 25 s. Each page's transport timeout is now the
 * smaller of the channel timeout and what the deadline has left.
 *
 * The fake transport below honours the `timeoutMs` it is handed exactly the
 * way the real one does (it rejects with `TRANSPORT_TIMEOUT` when the budget
 * runs out) and never answers on its own, so a page that is not capped by the
 * deadline would hold the test for 25 s and fail it on vitest's own timeout.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const CONNECT_TRADES = loadFixture("connect-gettransactions-uniswap").bytes;

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

/** A request that never answers and times out exactly when its budget says. */
function silentUntilTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    setTimeout(() => {
      reject(
        siteError(
          DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
          `The request to ${url} did not complete within ${timeoutMs} ms`,
          "Retry with a longer timeoutMs, or narrow the request."
        )
      );
    }, timeoutMs);
  });
}

interface Script {
  /** Delay before the Connect trades read answers, or null for a silent channel. */
  readonly connectDelayMs: number | null;
}

/** Every timeout the trade channels were handed, in call order. */
function mount(script: Script): number[] {
  const tradeTimeouts: number[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url, options) => {
      if (url.includes("/ds-data/") || url.includes("chains")) {
        return Promise.resolve({ url, status: 200, headers: new Map(), body: CATALOG });
      }
      tradeTimeouts.push(options.timeoutMs);
      const delay = script.connectDelayMs;
      if (delay === null) return silentUntilTimeout(url, options.timeoutMs);
      return new Promise((resolve) => {
        setTimeout(
          () => resolve({ url, status: 200, headers: new Map(), body: CONNECT_TRADES }),
          delay
        );
      });
    },
    wsExchange: (url, options) => {
      // The continued page goes to the feed socket; the pair subject read goes
      // to the pair channel and answers at once.
      if (url.includes("/feed/ws")) {
        tradeTimeouts.push(options.timeoutMs);
        return silentUntilTimeout(url, options.timeoutMs);
      }
      return Promise.resolve([PAIR_FRAME]);
    },
  };
  release = registerDexScreenerTransport(transport);
  return tradeTimeouts;
}

async function run(params: Record<string, unknown>) {
  const handler = DEXSCREENER_HANDLERS["dexscreener.trades"];
  if (handler === undefined) throw new Error("no dexscreener.trades handler");
  return handler({ chain: CHAIN, pairAddress: PAIR, ...params }, makeProtocolContext());
}

describe("dexscreener__trades_list deadlineMs caps every page", () => {
  it("fails a silent FIRST page at the deadline with a typed timeout naming deadlineMs", async () => {
    const timeouts = mount({ connectDelayMs: null });
    const startedAt = Date.now();
    const result = await run({ deadlineMs: 1000 });
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(result.output).toContain("deadlineMs 1000 was reached before the first trade page answered");
    expect(result.output).toContain("Raise deadlineMs");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(1000);
    // About the deadline, nowhere near the channel's own 25 s.
    expect(elapsed).toBeLessThan(3000);
  });

  it("ends a walk whose LATER page the deadline cut off as a reported deadline bound", async () => {
    const timeouts = mount({ connectDelayMs: 300 });
    const startedAt = Date.now();
    const result = await run({
      mode: "aggregate",
      startAtMs: 1,
      maxPages: 5,
      deadlineMs: 1000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.success, result.output).toBe(true);
    const data = result.data as Record<string, unknown>;
    const window = data["providerWindow"] as Record<string, unknown>;
    expect(window["deadlineHit"]).toBe(true);
    expect(window["pageBudgetHit"]).toBe(false);
    expect(window["pagesFetched"]).toBe(1);
    expect(String(data["summary"])).toContain("the deadline stopped the walk");
    expect(String(data["summary"])).not.toContain("the page budget stopped the walk");
    // The first page's rows are kept, and the summary says it did not cover
    // the range rather than presenting one page as the range.
    expect(data).not.toHaveProperty("aggregate");
    expect((data["pageAggregate"] as Record<string, unknown>)["rangeFullyCovered"]).toBe(false);
    expect((data["pagination"] as Record<string, unknown>)["nextCursor"]).not.toBeNull();
    // The second page was handed only what the deadline had left.
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThan(1000);
    expect(elapsed).toBeLessThan(3000);
  });

  it("keeps the channel's own timeout when the deadline leaves more than it", async () => {
    const timeouts = mount({ connectDelayMs: 0 });
    const result = await run({ limit: 5, deadlineMs: 60_000 });
    expect(result.success, result.output).toBe(true);
    // 25 s is the channel's own bound; a 60 s deadline must not widen it.
    expect(timeouts[0]).toBe(25_000);
  });
});
