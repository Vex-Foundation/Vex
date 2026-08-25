/**
 * The screener channel clients, driven by a scripted transport over REAL
 * captured frames.
 *
 * The behaviour under test is frame DISPATCH, and the reason it matters is
 * measured: the first binary frame on this channel was `latestBlock` in 72 of
 * 74 sessions, and was not in the other two. A client that took frame zero
 * would answer with a block number 97 percent of the time and with a page of
 * rows the rest, which is worse than always failing. So the scripts below put
 * the snapshot first, last, and never, and assert the client is right in each
 * case.
 *
 * The transport is a fake because a transport is exactly the boundary a fake
 * belongs at: the bytes it hands back are the provider's own, from the
 * fixtures.
 */

import { describe, expect, it } from "vitest";
import { fetchScreenerPage } from "../../tools/dexscreener/endpoints/screener.js";
import {
  fetchTokensPage,
  TOKENS_CHANNEL_HONESTY,
} from "../../tools/dexscreener/endpoints/tokens-screener.js";
import { buildScreenQuery } from "../../tools/dexscreener/screen-core/request.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import type {
  DexScreenerTransport,
  WsExchangeOptions,
} from "../../tools/dexscreener/transport.js";
import { VexError } from "../../errors.js";
import { loadFixture } from "./_fixtures.js";

/**
 * The real 18-byte `latestBlock` frame that OPENED the captured trending
 * session, and the 91 KB snapshot frame that followed it in the same session.
 */
const LATEST_BLOCK_FRAME = loadFixture("screener-latestblock-solana").bytes;
const PAIRS_FRAME = loadFixture("screener-pairs-solana-trending-h24").bytes;
const TOKENS_FRAME = loadFixture("screener-tokens-solana-volume-h24").bytes;

interface ExchangeCall {
  readonly url: string;
  readonly options: WsExchangeOptions;
}

/**
 * A transport that replays a scripted sequence of frame batches, one batch per
 * `wsExchange` call. It owns nothing beyond the script, and it records what it
 * was asked for so the attempt policy is observable.
 */
function scriptedTransport(script: readonly (readonly Uint8Array[])[]): {
  readonly transport: DexScreenerTransport;
  readonly calls: ExchangeCall[];
} {
  const calls: ExchangeCall[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: () => Promise.reject(new Error("not used by these tests")),
    wsExchange: (url, options) => {
      calls.push({ url, options });
      const batch = script[calls.length - 1];
      if (batch === undefined) {
        throw new Error(
          `the scripted transport was called ${calls.length} times but the script has ${script.length} batches`
        );
      }
      return Promise.resolve([...batch]);
    },
  };
  return { transport, calls };
}

const QUERY = buildScreenQuery({
  rankBy: { key: "trendingScoreH24", order: "desc" },
  window: "h24",
  chainIds: ["solana"],
});

describe("fetchScreenerPage", () => {
  it("builds the v7 pairs URL from the timeframe, page and query string", async () => {
    const { transport, calls } = scriptedTransport([
      [LATEST_BLOCK_FRAME, PAIRS_FRAME],
    ]);
    const result = await fetchScreenerPage(QUERY, {
      page: 3,
      transport,
      timeoutMs: 10_000,
    });
    expect(calls[0]?.url).toBe(
      "wss://io.dexscreener.com/dex/screener/v7/pairs/h24/3" +
        "?rankBy[key]=trendingScoreH24&rankBy[order]=desc&filters[chainIds][0]=solana"
    );
    expect(result.url).toBe(calls[0]?.url);
    expect(result.page).toBe(3);
  });

  it("takes the pairs frame even when latestBlock arrives first, and keeps the block", async () => {
    const { transport } = scriptedTransport([
      [LATEST_BLOCK_FRAME, PAIRS_FRAME],
    ]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.frame.rows).toHaveLength(100);
    expect(result.frame.pairsCount).toBe(52_479);
    expect(result.snapshotFrameIndex).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.latestBlock).toStrictEqual({
      blockNumber: "441366346",
      blockTimestampMs: Date.parse("2026-08-24T09:38:51Z"),
    });
  });

  it("takes the pairs frame when it arrives first and reports no block", async () => {
    const { transport } = scriptedTransport([[PAIRS_FRAME]]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.snapshotFrameIndex).toBe(0);
    expect(result.latestBlock).toBeNull();
    expect(result.frame.rows).toHaveLength(100);
  });

  it("keeps the NEWEST block when several arrive before the snapshot", async () => {
    const older = LATEST_BLOCK_FRAME;
    const { transport } = scriptedTransport([[older, older, PAIRS_FRAME]]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.latestBlock?.blockNumber).toBe("441366346");
    expect(result.snapshotFrameIndex).toBe(2);
  });

  it("skips zero-length keepalive frames without counting them as an answer", async () => {
    const { transport } = scriptedTransport([
      [new Uint8Array(0), LATEST_BLOCK_FRAME, new Uint8Array(0), PAIRS_FRAME],
    ]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.frame.rows).toHaveLength(100);
    expect(result.snapshotFrameIndex).toBe(3);
  });

  it("asks for six frames first, then retries once asking for ten", async () => {
    const { transport, calls } = scriptedTransport([
      [LATEST_BLOCK_FRAME, LATEST_BLOCK_FRAME],
      [LATEST_BLOCK_FRAME, PAIRS_FRAME],
    ]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(calls.map((call) => call.options.expect.binaryFrames)).toStrictEqual([
      6, 10,
    ]);
    expect(calls[0]?.options.expect.maxTotalBytes).toBe(4_000_000);
    expect(result.attempts).toBe(2);
    expect(result.framesReceived).toBe(4);
  });

  it("fails with a typed outcome naming what did arrive when no snapshot ever comes", async () => {
    const { transport } = scriptedTransport([
      [LATEST_BLOCK_FRAME, LATEST_BLOCK_FRAME],
      [LATEST_BLOCK_FRAME],
    ]);
    let thrown: unknown;
    try {
      await fetchScreenerPage(QUERY, {
        page: 1,
        transport,
        timeoutMs: 10_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(DexScreenerSiteErrorCodes.SCREEN_NO_RESULT_FRAME);
    expect(error.message).toContain("3 binary frames");
    expect(error.message).toContain("latestBlock, latestBlock, latestBlock");
    expect(error.hint).toContain("not an outage");
  });

  it("counts an undecodable frame without abandoning the search for the snapshot", async () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const { transport } = scriptedTransport([[junk, PAIRS_FRAME]]);
    const result = await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.frame.rows).toHaveLength(100);
  });

  it("refuses a page below one rather than opening a socket the provider refuses", async () => {
    const { transport, calls } = scriptedTransport([]);
    await expect(
      fetchScreenerPage(QUERY, { page: 0, transport, timeoutMs: 10_000 })
    ).rejects.toThrow(/pages from 1/);
    expect(calls).toHaveLength(0);
  });

  it("stops before the retry when the caller cancels", async () => {
    const controller = new AbortController();
    const calls: ExchangeCall[] = [];
    const transport: DexScreenerTransport = {
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: () => Promise.reject(new Error("not used by these tests")),
      wsExchange: (url, options) => {
        calls.push({ url, options });
        controller.abort();
        return Promise.resolve([LATEST_BLOCK_FRAME]);
      },
    };
    let thrown: unknown;
    try {
      await fetchScreenerPage(QUERY, {
        page: 1,
        transport,
        timeoutMs: 10_000,
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VexError).code).toBe(
      DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED
    );
    expect(calls).toHaveLength(1);
  });

  it("passes the caller's deadline and signal through to the transport", async () => {
    const controller = new AbortController();
    const { transport, calls } = scriptedTransport([[PAIRS_FRAME]]);
    await fetchScreenerPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 7_500,
      signal: controller.signal,
    });
    expect(calls[0]?.options.timeoutMs).toBe(7_500);
    expect(calls[0]?.options.signal).toBe(controller.signal);
  });
});

describe("fetchTokensPage", () => {
  it("builds the v2 tokens URL and decodes the token channel message", async () => {
    const { transport, calls } = scriptedTransport([
      [LATEST_BLOCK_FRAME, TOKENS_FRAME],
    ]);
    const result = await fetchTokensPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(calls[0]?.url).toContain("/dex/screener/v2/tokens/h24/1?");
    expect(result.frame.rows).toHaveLength(100);
  });

  it("carries the honesty facts the channel's count would otherwise hide", async () => {
    const { transport } = scriptedTransport([[TOKENS_FRAME]]);
    const result = await fetchTokensPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    // 100 rows and a count of 100: the count IS the page length, and a caller
    // that reads it as a total would report a market of 100 tokens.
    expect(result.frame.rows).toHaveLength(100);
    expect(result.frame.pairsCount).toBe(100);
    expect(result.honesty).toStrictEqual({
      totalUnavailable: true,
      pairsCountIsPageLength: true,
      pagesOverlap: true,
      orderIsProviderOpaque: true,
      metricsAreTokenAggregates: true,
      valuationIsRepresentativePool: true,
      universeIsProfileOnly: true,
      repeatsCountedBy: "baseTokenAddress",
      notes: TOKENS_CHANNEL_HONESTY.notes,
    });
  });

  it("states the three semantic hazards, not only the traversal ones", async () => {
    // The flags an agent will actually act on. Before S8 the block carried the
    // traversal facts alone, so a row whose volume is a SUM over pools and
    // whose market cap is one pool's mistake read as a plain token row: JUP
    // was served at 3.68 trillion USD of market cap with nothing saying the
    // number belonged to a single pool.
    const { transport } = scriptedTransport([[TOKENS_FRAME]]);
    const result = await fetchTokensPage(QUERY, {
      page: 1,
      transport,
      timeoutMs: 10_000,
    });
    expect(result.honesty.metricsAreTokenAggregates).toBe(true);
    expect(result.honesty.valuationIsRepresentativePool).toBe(true);
    expect(result.honesty.universeIsProfileOnly).toBe(true);
    // Repeats are a TOKEN fact here: the repeated rows carry different pair
    // addresses, so naming the identity is what stops a pair-keyed counter
    // reporting zero duplicates on a window that repeated a dozen tokens.
    expect(result.honesty.repeatsCountedBy).toBe("baseTokenAddress");
    // Every flag has a readable reason travelling with it.
    expect(result.honesty.notes).toHaveLength(4);
    for (const note of result.honesty.notes) {
      expect(note.length).toBeGreaterThan(80);
    }
  });
});
