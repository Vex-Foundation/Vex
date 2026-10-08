/**
 * The `feed/ws` envelope protocol (`util_envelope`), proven on captured bytes.
 *
 * The site retired `dex_feed.WSCommand` / `WSMessage` in its 2026-10 deploy;
 * the old commands are no longer answered, which silently took out daily and
 * 5 s candles, every socket-served trades page and the token insight. Every
 * fixture here is a real exchange captured live on
 * 2026-10-07 (`feed-envelope-*`, provenance beside each), so these tests pin
 * three things a reviewer cannot see in a diff:
 *
 *  1. THE REQUEST BYTES. Re-encoding a captured request's parameters under its
 *     captured id reproduces the frame the provider answered, byte for byte.
 *  2. THE ANSWER SHAPES. Each status the provider was measured sending decodes
 *     to the outcome it means, and an OK payload decodes as the method's own
 *     response message.
 *  3. THE DISPATCH. An answer belongs to a request by envelope id and by the
 *     `response` arm only; stream arms, keepalives and noise are skipped.
 */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  DEXSCREENER_FEED_WS_URL,
  FEED_WS_METHODS,
  encodeFeedRequest,
  feedMethodPath,
  isTransientFeedStatus,
  nextFeedRequestId,
  readFeedRequest,
  readFeedResponse,
  type FeedFrameCensus,
  type FeedWsMethod,
} from "@tools/dexscreener/codec/feed-envelope.js";
import {
  getDexScreenerMessageDescriptor,
  getDexScreenerProtoRegistry,
  type DexScreenerMessageName,
} from "@tools/dexscreener/codec/protobuf.js";
import {
  DEXSCREENER_COMMAND_MESSAGES,
  encodeDexScreenerCommand,
  type DexScreenerCommandName,
} from "@tools/dexscreener/codec/encode.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { loadFixture, type FixtureProvenance } from "./_fixtures.js";
import { feedResponseFrame, feedStreamFrame } from "./_feed-envelope.js";

const MAX = 2_000_000;

interface Exchange {
  readonly name: string;
  readonly method: FeedWsMethod;
  readonly id: number;
  readonly request: JsonValue;
}

/** The captured request parameters, read from the provenance the capture wrote. */
function exchange(name: string): Exchange {
  const { provenance } = loadFixture(`${name}.response`);
  const params = (provenance as FixtureProvenance).requestParams as {
    envelopeId: number;
    method: string;
    request: JsonValue;
  };
  const method = params.method.split("/").pop() as FeedWsMethod;
  return { name, method, id: params.envelopeId, request: params.request };
}

describe("the method paths come from the checked-in service descriptor", () => {
  it("names every unary RPC this build calls as /dex_feed.PublicWSService/<Method>", () => {
    expect(feedMethodPath("GetHistoricalBars")).toBe("/dex_feed.PublicWSService/GetHistoricalBars");
    expect(feedMethodPath("GetHistoricalTransactions")).toBe(
      "/dex_feed.PublicWSService/GetHistoricalTransactions"
    );
    expect(feedMethodPath("GetTokenInsight")).toBe("/dex_feed.PublicWSService/GetTokenInsight");
  });

  it("matches each method's declared input and output to what this build encodes and decodes", () => {
    const service = getDexScreenerProtoRegistry().getService("dex_feed.PublicWSService");
    expect(service).toBeDefined();
    for (const [name, spec] of Object.entries(FEED_WS_METHODS)) {
      const method = service?.methods.find((m) => m.name === name);
      expect(method?.methodKind).toBe("unary");
      expect(method?.input.typeName).toBe(spec.request);
      expect(method?.output.typeName).toBe(spec.response);
    }
  });

  it("no longer carries the retired WSCommand / WSMessage pair at all", () => {
    const registry = getDexScreenerProtoRegistry();
    expect(registry.getMessage("dex_feed.WSCommand")).toBeUndefined();
    expect(registry.getMessage("dex_feed.WSMessage")).toBeUndefined();
    expect(() =>
      getDexScreenerMessageDescriptor("dex_feed.WSMessage" as DexScreenerMessageName)
    ).toThrow(expect.objectContaining({ code: DexScreenerSiteErrorCodes.DECODE_MESSAGE_NOT_ALLOWED }));
    expect(() =>
      encodeDexScreenerCommand("dex_feed.WSCommand" as DexScreenerCommandName, {})
    ).toThrow(expect.objectContaining({ code: DexScreenerSiteErrorCodes.ENCODE_MESSAGE_NOT_ALLOWED }));
  });

  it("allows encoding exactly the envelope and the three request payloads on the feed socket", () => {
    for (const name of [
      "util_envelope.ClientEnvelope",
      "dex_feed.GetHistoricalBarsRequest",
      "dex_feed.GetHistoricalTransactionsRequest",
      "dex_feed.GetTokenInsightRequest",
    ]) {
      expect(DEXSCREENER_COMMAND_MESSAGES).toContain(name);
    }
    // The server frame is decode-only: nothing in production writes one.
    expect(DEXSCREENER_COMMAND_MESSAGES).not.toContain("util_envelope.ServerEnvelope");
  });

  it("targets the socket the site itself opens", () => {
    expect(DEXSCREENER_FEED_WS_URL).toBe("wss://io.dexscreener.com/feed/ws");
  });
});

describe("request frames are the bytes the provider answered", () => {
  for (const name of [
    "feed-envelope-bars-d1-uniswap-ethereum",
    "feed-envelope-trades-swap-uniswap",
    "feed-envelope-trades-cursor-page2-uniswap",
    "feed-envelope-insight-ok-solana",
  ]) {
    it(`re-encodes ${name} byte for byte`, () => {
      const captured = loadFixture(`${name}.request`).bytes;
      const { method, id, request } = exchange(name);
      const built = encodeFeedRequest(method, request, id);
      expect(Buffer.from(built).toString("hex")).toBe(Buffer.from(captured).toString("hex"));
    });

    it(`reads ${name} back into its id, method and request`, () => {
      const captured = loadFixture(`${name}.request`).bytes;
      const { method, id, request } = exchange(name);
      const read = readFeedRequest(captured, 4096);
      expect(read?.id).toBe(id);
      expect(read?.knownMethod).toBe(method);
      expect(read?.method).toBe(feedMethodPath(method));
      expect(read?.request).toStrictEqual(request);
    });
  }

  it("refuses an envelope id the protocol cannot carry, before anything is sent", () => {
    for (const bad of [0, -1, 1.5, 2_147_483_648]) {
      expect(() => encodeFeedRequest("GetTokenInsight", { chainId: "solana", tokenId: "x" }, bad)).toThrow(
        expect.objectContaining({ code: DexScreenerSiteErrorCodes.ENCODE_FAILED })
      );
    }
  });

  it("refuses a misspelled request field instead of silently dropping it", () => {
    expect(() =>
      encodeFeedRequest("GetHistoricalBars", { limit: 5, chainID: "ethereum" }, 1)
    ).toThrow(expect.objectContaining({ code: DexScreenerSiteErrorCodes.ENCODE_FAILED }));
  });

  it("issues ids that are never zero and never repeat back to back", () => {
    const first = nextFeedRequestId();
    const second = nextFeedRequestId();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
  });
});

describe("response frames decode to the outcome each measured status means", () => {
  it("bars: STATUS_OK with a 60-bar D1 page", () => {
    const { bytes } = loadFixture("feed-envelope-bars-d1-uniswap-ethereum.response");
    const answer = readFeedResponse([bytes], 41, "GetHistoricalBars", MAX);
    expect(answer?.status).toBe("STATUS_OK");
    const bars = (answer?.payload as { bars?: { timestamp?: string; closeUSD?: string }[] }).bars ?? [];
    expect(bars).toHaveLength(60);
    // Oldest first, a day apart, prices as decimal strings.
    expect(Date.parse(bars[1]?.timestamp ?? "") - Date.parse(bars[0]?.timestamp ?? "")).toBe(86_400_000);
    expect(typeof bars[0]?.closeUSD).toBe("string");
  });

  it("bars: an unindexed pair is STATUS_OK with an EMPTY payload, not NOT_FOUND", () => {
    const { bytes } = loadFixture("feed-envelope-bars-unindexed-pair.response");
    expect(bytes.byteLength).toBe(8);
    expect(readFeedResponse([bytes], 43, "GetHistoricalBars", MAX)).toStrictEqual({
      status: "STATUS_OK",
      payload: {},
    });
  });

  it("trades: STATUS_OK with a full 100-row page of swaps only", () => {
    const { bytes } = loadFixture("feed-envelope-trades-swap-uniswap.response");
    const answer = readFeedResponse([bytes], 11, "GetHistoricalTransactions", MAX);
    const rows = (answer?.payload as { transactions?: { swap?: { type?: string }; joinExit?: unknown }[] })
      .transactions ?? [];
    expect(rows).toHaveLength(100);
    // TYPE_BUY_OR_SELL is honoured: every row is a swap arm, none a liquidity event.
    expect(rows.every((row) => row.swap !== undefined && row.joinExit === undefined)).toBe(true);
    expect(new Set(rows.map((row) => row.swap?.type))).toStrictEqual(new Set(["TYPE_BUY", "TYPE_SELL"]));
  });

  it("insight: STATUS_OK carries a dex_feed.TokenInsight for the token asked about", () => {
    const { bytes } = loadFixture("feed-envelope-insight-ok-solana.response");
    const { request } = exchange("feed-envelope-insight-ok-solana");
    const answer = readFeedResponse([bytes], 32, "GetTokenInsight", MAX);
    const insight = (answer?.payload as { tokenInsight?: Record<string, unknown> }).tokenInsight;
    expect(answer?.status).toBe("STATUS_OK");
    expect(insight?.["chainId"]).toBe("solana");
    expect(insight?.["tokenId"]).toBe((request as Record<string, unknown>)["tokenId"]);
    expect(typeof insight?.["content"]).toBe("string");
  });

  it("insight: STATUS_NOT_FOUND and STATUS_INVALID_ARGUMENT arrive with no payload", () => {
    const notFound = loadFixture("feed-envelope-insight-not-found-ethereum-pepe.response").bytes;
    const invalid = loadFixture("feed-envelope-insight-invalid-argument.response").bytes;
    expect(readFeedResponse([notFound], 30, "GetTokenInsight", MAX)).toStrictEqual({
      status: "STATUS_NOT_FOUND",
      payload: null,
    });
    expect(readFeedResponse([invalid], 31, "GetTokenInsight", MAX)).toStrictEqual({
      status: "STATUS_INVALID_ARGUMENT",
      payload: null,
    });
  });

  it("classifies only TIMEOUT and INTERNAL as worth a retry", () => {
    expect(isTransientFeedStatus("STATUS_TIMEOUT")).toBe(true);
    expect(isTransientFeedStatus("STATUS_INTERNAL")).toBe(true);
    for (const status of ["STATUS_OK", "STATUS_NOT_FOUND", "STATUS_INVALID_ARGUMENT", "STATUS_UNAUTHORIZED", "STATUS_UNSPECIFIED"] as const) {
      expect(isTransientFeedStatus(status)).toBe(false);
    }
  });
});

describe("an answer belongs to its request by envelope id and response arm only", () => {
  const answer = (): Uint8Array => loadFixture("feed-envelope-insight-not-found-ethereum-pepe.response").bytes;

  it("skips keepalives, undecodable frames and a stream message carrying the same id", () => {
    const census: FeedFrameCensus = { arms: [], byteSizes: [] };
    const stream = feedStreamFrame(30, new Uint8Array([0x0a, 0x00]));
    const result = readFeedResponse(
      [new Uint8Array(0), new Uint8Array([0xff, 0xff]), stream, answer()],
      30,
      "GetTokenInsight",
      MAX,
      census
    );
    expect(result?.status).toBe("STATUS_NOT_FOUND");
    expect(census.arms).toStrictEqual(["undecodable", "streamMessage#30", "response#30"]);
  });

  it("returns null when no response carries this id", () => {
    expect(readFeedResponse([answer()], 31, "GetTokenInsight", MAX)).toBeNull();
    expect(readFeedResponse([], 30, "GetTokenInsight", MAX)).toBeNull();
  });

  it("rejects an over-cap frame by name instead of decoding part of it", () => {
    const bars = loadFixture("feed-envelope-bars-d1-uniswap-ethereum.response").bytes;
    expect(() => readFeedResponse([bars], 41, "GetHistoricalBars", 1_000)).toThrow(
      expect.objectContaining({ code: DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP })
    );
  });

  it("refuses an OK payload that is not the method's response message", () => {
    // The answer frame arrived, says STATUS_OK, and its payload is not a
    // GetHistoricalBarsResponse: a typed decode failure, never an empty page.
    const corrupt = feedResponseFrame(9, "GetHistoricalBars", Uint8Array.from([0xff, 0xff]));
    expect(() => readFeedResponse([corrupt], 9, "GetHistoricalBars", MAX)).toThrow(
      expect.objectContaining({ code: DexScreenerSiteErrorCodes.DECODE_FAILED })
    );
  });
});
