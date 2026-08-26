/**
 * `coalesceScope` on the trades channel: an ADDITIVE partition of the
 * transport's single-flight table.
 *
 * WHY THIS EXISTS. The site bridge joins identical concurrent exchanges onto
 * the FIRST caller's promise, so the leader's signal and deadline own the
 * socket. The board's spotlight tape polls this channel for as long as a reader
 * looks at a token, and an agent tool can ask for the same page at the same
 * moment. Without a partition, one of two things happens and both are wrong:
 * the tape's teardown aborts a socket an agent call is still waiting on, or the
 * tape joins the agent's exchange and can no longer be aborted when the reader
 * leaves the spotlight.
 *
 * `pairs-batch` already carries exactly this option for exactly this reason.
 * These cases pin the two halves of "additive": the option reaches the
 * transport verbatim when it is given, and OMITTING it produces a call
 * byte-identical to the one that existed before the option, which is what
 * leaves every current caller's wire behaviour unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  fetchTradesPage,
  type TradesPageOptions,
} from "../../tools/dexscreener/endpoints/trades.js";
import type {
  DexScreenerTransport,
  HttpGetOptions,
  WsExchangeOptions,
} from "../../tools/dexscreener/transport.js";

const CHAIN = "solana";
const PAIR = "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU";
const AMM = "pumpfundex";
const QUOTE = "So11111111111111111111111111111111111111112";

/** Records the options each transport method was handed. */
function recording(): {
  readonly transport: DexScreenerTransport;
  readonly wsCalls: WsExchangeOptions[];
  readonly httpCalls: HttpGetOptions[];
} {
  const wsCalls: WsExchangeOptions[] = [];
  const httpCalls: HttpGetOptions[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url: string, options: HttpGetOptions) => {
      httpCalls.push(options);
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        // An empty body decodes to no rows, which is enough: these cases are
        // about what the transport was ASKED, not about what came back.
        body: new Uint8Array(0),
      });
    },
    wsExchange: (_url: string, options: WsExchangeOptions) => {
      wsCalls.push(options);
      return Promise.resolve([]);
    },
  };
  return { transport, wsCalls, httpCalls };
}

function options(
  transport: DexScreenerTransport,
  overrides: Partial<TradesPageOptions> = {},
): TradesPageOptions {
  return {
    transport,
    chainId: CHAIN,
    pairAddress: PAIR,
    ammId: AMM,
    quoteTokenAddress: QUOTE,
    inverted: false,
    filters: { eventType: "all" },
    timeoutMs: 6_000,
    ...overrides,
  };
}

/** A cursor forces the SOCKET route, which is the one that can coalesce. */
const CURSOR = { blockNumber: 441_850_042, transactionIndex: 3, eventIndex: 7 };

describe("coalesceScope reaches the socket verbatim", () => {
  it("forwards the scope the caller gave", async () => {
    const { transport, wsCalls } = recording();
    await fetchTradesPage(
      options(transport, { cursor: CURSOR, coalesceScope: "board-tape:solana:22cf" }),
    ).catch(() => undefined);
    expect(wsCalls).toHaveLength(1);
    expect(wsCalls[0]?.coalesceScope).toBe("board-tape:solana:22cf");
  });

  it("omits the key entirely when no scope was given", async () => {
    // ADDITIVE means the previous behaviour is byte-identical, not merely
    // similar: an explicit `undefined` would still be a key the transport sees.
    const { transport, wsCalls } = recording();
    await fetchTradesPage(options(transport, { cursor: CURSOR })).catch(() => undefined);
    expect(wsCalls).toHaveLength(1);
    expect("coalesceScope" in (wsCalls[0] ?? {})).toBe(false);
  });

  it("keeps the signal and the deadline the caller owns", async () => {
    const controller = new AbortController();
    const { transport, wsCalls } = recording();
    await fetchTradesPage(
      options(transport, {
        cursor: CURSOR,
        coalesceScope: "board-tape:x",
        signal: controller.signal,
        timeoutMs: 6_000,
      }),
    ).catch(() => undefined);
    // The scope is what makes this signal MEAN something: a joined exchange
    // would be governed by the leader's signal instead of this one.
    expect(wsCalls[0]?.signal).toBe(controller.signal);
    expect(wsCalls[0]?.timeoutMs).toBe(6_000);
  });
});

describe("the HTTP route is unaffected", () => {
  it("does not pass a coalescence scope to a Connect read", async () => {
    // Connect is a plain HTTP read and the transport single-flights nothing
    // there, so there is no table to partition.
    const { transport, httpCalls, wsCalls } = recording();
    await fetchTradesPage(
      options(transport, { coalesceScope: "board-tape:solana:22cf" }),
    ).catch(() => undefined);
    expect(wsCalls).toHaveLength(0);
    expect(httpCalls).toHaveLength(1);
    expect("coalesceScope" in (httpCalls[0] ?? {})).toBe(false);
  });
});
