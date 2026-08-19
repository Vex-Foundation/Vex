/**
 * pools.fun client behaviour: the two parameters that must never be missing,
 * stable query order, limit clamping, and the error paths.
 *
 * `global.fetch` is stubbed with a real `Response`, so the client's own
 * status/parse branches run without a network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes } from "../../errors.js";
import { PoolsFunClient } from "@tools/pools-fun/client.js";
import { captureResponse, errorCapture, htmlCapture, CAPTURES } from "./_captures.js";

const BASE = "https://api.bankr.bot";

function stubFetch(responses: Array<() => Response>): { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    const make = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return Promise.resolve(make());
  });
  return { urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the two parameters the provider must never be asked without", () => {
  it("injects chain=robinhood on discover - omitting it silently answers for BASE", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.discoverPoolsFun))]);
    await new PoolsFunClient(BASE).discover({ platform: "poolsfun" });
    expect(new URL(urls[0]!).searchParams.get("chain")).toBe("robinhood");
  });

  it("injects chain=robinhood on the candles route too", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.ohlcvHour))]);
    await new PoolsFunClient(BASE).candles({ tokenAddress: `0x${"a".repeat(40)}`, timeframe: "hour" });
    expect(new URL(urls[0]!).searchParams.get("chain")).toBe("robinhood");
  });

  it("always sends the platform the caller named", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.discoverSushiStockPaired))]);
    await new PoolsFunClient(BASE).discover({ platform: "sushi" });
    expect(new URL(urls[0]!).searchParams.get("platform")).toBe("sushi");
  });
});

describe("URL building", () => {
  it("appends keys in a stable order regardless of call-site order", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.discoverEmpty))]);
    await new PoolsFunClient(BASE).discover({
      maxAgeHours: 6,
      limit: 20,
      platform: "poolsfun",
      order: "asc",
      sortBy: "deployedAt",
    });
    expect(new URL(urls[0]!).search).toBe(
      "?chain=robinhood&platform=poolsfun&sortBy=deployedAt&order=asc&limit=20&maxAgeHours=6",
    );
  });

  it("omits every filter the caller did not supply", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.discoverEmpty))]);
    await new PoolsFunClient(BASE).discover({ platform: "all" });
    expect(new URL(urls[0]!).search).toBe("?chain=robinhood&platform=all");
  });

  it("clamps limit to the provider's own caps rather than sending a value it ignores", async () => {
    const { urls } = stubFetch([
      () => json(captureResponse(CAPTURES.discoverEmpty)),
      () => json(captureResponse(CAPTURES.ohlcvHour)),
    ]);
    const client = new PoolsFunClient(BASE);
    await client.discover({ platform: "poolsfun", limit: 5000 });
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("100");
    await client.candles({ tokenAddress: `0x${"a".repeat(40)}`, timeframe: "minute", limit: 9999 });
    expect(new URL(urls[1]!).searchParams.get("limit")).toBe("1000");
  });

  it("puts the token in the candles PATH, not the query", async () => {
    const { urls } = stubFetch([() => json(captureResponse(CAPTURES.ohlcvHour))]);
    const token = `0x${"b".repeat(40)}`;
    await new PoolsFunClient(BASE).candles({ tokenAddress: token, timeframe: "day" });
    expect(new URL(urls[0]!).pathname).toBe(`/discover/${token}/ohlcv`);
  });
});

describe("real captured bytes flow through the client", () => {
  it("discover returns validated rows and the page cursor", async () => {
    stubFetch([() => json(captureResponse(CAPTURES.discoverPoolsFun))]);
    const page = await new PoolsFunClient(BASE).discover({ platform: "poolsfun" });
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.every((r) => r.platform === "poolsfun")).toBe(true);
  });

  it("an empty market comes back as an empty page, not an error", async () => {
    stubFetch([() => json(captureResponse(CAPTURES.discoverEmpty))]);
    const page = await new PoolsFunClient(BASE).discover({ platform: "poolsfun", minMarketCapUsd: 1e12 });
    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("error paths", () => {
  it("a 400 becomes POOLS_INVALID_REQUEST carrying the provider's detail", async () => {
    const capture = errorCapture(CAPTURES.discoverInvalidSortBy);
    stubFetch([() => json(capture.response, capture.httpStatus)]);
    await expect(new PoolsFunClient(BASE).discover({ platform: "poolsfun", sortBy: "trending" }))
      .rejects.toMatchObject({ code: ErrorCodes.POOLS_INVALID_REQUEST });
  });

  it("the 502 upstream-pool body becomes a named POOLS_NOT_FOUND", async () => {
    const capture = errorCapture(CAPTURES.ohlcvUnknownToken);
    stubFetch([() => json(capture.response, capture.httpStatus)]);
    await expect(
      new PoolsFunClient(BASE).candles({ tokenAddress: `0x${"0".repeat(39)}1`, timeframe: "hour" }),
    ).rejects.toMatchObject({ code: ErrorCodes.POOLS_NOT_FOUND });
  });

  it("an HTML 404 route becomes POOLS_API_ERROR, never a JSON parse crash", async () => {
    const capture = htmlCapture();
    stubFetch([() => new Response(capture.bodyText, { status: capture.httpStatus })]);
    await expect(new PoolsFunClient(BASE).discover({ platform: "poolsfun" }))
      .rejects.toMatchObject({ code: ErrorCodes.POOLS_API_ERROR });
  });

  it("a 200 with a non-JSON body becomes POOLS_INVALID_RESPONSE", async () => {
    stubFetch([() => new Response("<html>maintenance</html>", { status: 200 })]);
    await expect(new PoolsFunClient(BASE).discover({ platform: "poolsfun" }))
      .rejects.toMatchObject({ code: ErrorCodes.POOLS_INVALID_RESPONSE });
  });
});
