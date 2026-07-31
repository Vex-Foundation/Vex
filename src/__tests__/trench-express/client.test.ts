/**
 * Trench Express client behavior: stable-key-order URL building, the empty-body
 * not-found trap, the HTTP-500 leaked-text mapping, and page-walk dedupe.
 *
 * `global.fetch` is stubbed with a real `Response`, so the client's own
 * text-reading / empty-body / status branches are exercised without a network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";
import { TrenchExpressClient } from "@tools/trench-express/client.js";
import { captureResponse, CAPTURES } from "./_captures.js";

const BASE = "https://api.trench.express";

/** Records every requested URL and answers from a queue of `Response`s. */
function stubFetch(responses: Array<() => Response>): { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    const make = responses[Math.min(i, responses.length - 1)];
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

describe("buildUrl — params are ONE url-encoded JSON blob with stable key order", () => {
  it("serializes keys in a deterministic order regardless of call-site order", async () => {
    const { urls } = stubFetch([() => json([])]);
    const client = new TrenchExpressClient(BASE);
    await client.getTokens({ page: 0, limit: 30, status: "curve", sort: "time" });

    const url = new URL(urls[0]!);
    const params = url.searchParams.get("params")!;
    // keys sorted: launched, limit, page, sort
    expect(params).toBe('{"launched":false,"limit":30,"page":0,"sort":"time"}');
  });

  it("clamps limit above the server cap to 30", async () => {
    const { urls } = stubFetch([() => json([])]);
    const client = new TrenchExpressClient(BASE);
    await client.search({ search: "x", limit: 500 });

    const params = new URL(urls[0]!).searchParams.get("params")!;
    expect(params).toContain('"limit":30');
  });

  it("maps status=all by omitting the launched filter", async () => {
    const { urls } = stubFetch([() => json([])]);
    const client = new TrenchExpressClient(BASE);
    await client.getTokens({ page: 1, status: "all" });
    const params = new URL(urls[0]!).searchParams.get("params")!;
    expect(params).not.toContain("launched");
  });
});

describe("empty-body not-found trap", () => {
  it("getToken returns null on HTTP 200 empty body", async () => {
    stubFetch([() => new Response("", { status: 200 })]);
    const client = new TrenchExpressClient(BASE);
    expect(await client.getToken({ token: `0x${"0".repeat(40)}` })).toBeNull();
  });

  it("getTokens returns [] on an empty body", async () => {
    stubFetch([() => new Response("", { status: 200 })]);
    const client = new TrenchExpressClient(BASE);
    expect(await client.getTokens({ page: 0 })).toEqual([]);
  });

  it("getWalletStats returns null on an empty body", async () => {
    stubFetch([() => new Response("", { status: 200 })]);
    const client = new TrenchExpressClient(BASE);
    expect(await client.getWalletStats(`0x${"1".repeat(40)}`)).toBeNull();
  });
});

describe("HTTP 500 leaked text/plain input error", () => {
  it("maps to a safe VexError with a bounded, single-line snippet (no leaked stack)", async () => {
    const leaked = "SyntaxError: JSON Parse error: Unexpected identifier\n  at parse (native)\n  at api.ts:12";
    stubFetch([() => new Response(leaked, { status: 500 })]);
    const client = new TrenchExpressClient(BASE);

    await expect(client.getToken({ symbol: "x" })).rejects.toMatchObject({
      code: ErrorCodes.TRENCH_INVALID_REQUEST,
    });
    try {
      await client.getToken({ symbol: "x" });
    } catch (err) {
      const ve = err as VexError;
      expect(ve.hint).not.toContain("\n");
      expect((ve.hint ?? "").length).toBeLessThan(160);
    }
  });
});

describe("real captured bytes flow through the client", () => {
  it("getTokens returns validated graduated tokens from a capture", async () => {
    stubFetch([() => json(captureResponse(CAPTURES.tokensGraduated))]);
    const client = new TrenchExpressClient(BASE);
    const tokens = await client.getTokens({ page: 0, status: "launched" });
    expect(tokens.every((t) => t.graduated)).toBe(true);
  });
});

describe("walkTokens — page-walk with dedupe and short-page stop", () => {
  it("dedupes by token address and stops on a short page", async () => {
    const full = captureResponse(CAPTURES.tokensBonding) as unknown[];
    // Page 0 = a full page of `limit` rows (pad by repeating), page 1 = a short page.
    const row = full[0] as Record<string, unknown>;
    const page0 = Array.from({ length: 30 }, (_v, i) => ({ ...row, token: `0x${String(i).padStart(40, "0")}` }));
    // page1 repeats one page0 address (dedupe) plus is short → terminates the walk.
    const page1 = [page0[0], { ...row, token: `0x${"a".repeat(40)}` }];

    let call = 0;
    stubFetch([
      () => {
        call += 1;
        return json(call === 1 ? page0 : page1);
      },
    ]);
    const client = new TrenchExpressClient(BASE);
    const out = await client.walkTokens({ status: "curve", limit: 30 });

    // 30 unique from page0 + 1 new from page1 (the repeat is deduped) = 31.
    expect(out.length).toBe(31);
    const addrs = new Set(out.map((t) => t.token.toLowerCase()));
    expect(addrs.size).toBe(31);
  });
});
