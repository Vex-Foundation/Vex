import { describe, expect, it, vi } from "vitest";
import { classifyOrderStatusRecovery, HyperliquidExchangeClient, parseExchangeResponse } from "@tools/hyperliquid/exchange.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { HyperliquidMetaCache } from "@tools/hyperliquid/meta-cache.js";
import { HyperliquidSigner } from "@tools/hyperliquid/signer.js";
import { parseDecimalString } from "@tools/hyperliquid/validation.js";

const entry = {
  a: 0,
  b: true,
  p: parseDecimalString("100"),
  s: parseDecimalString("2"),
  r: false,
  t: { limit: { tif: "Gtc" as const } },
  c: "0x00000000000000000000000000000001" as const,
};

const stop = {
  a: 0,
  b: false,
  p: parseDecimalString("99"),
  s: parseDecimalString("2"),
  r: true,
  t: { trigger: { isMarket: true, triggerPx: parseDecimalString("95"), tpsl: "sl" as const } },
  c: "0x00000000000000000000000000000002" as const,
};

describe("Hyperliquid exchange response parser", () => {
  it("retains a partial batch where entry rests and the SL child is rejected", () => {
    const result = parseExchangeResponse({
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 10, cloid: entry.c } }, { error: "invalid trigger" }] } },
    }, [entry, stop]);
    expect(result.kind).toBe("orders");
    if (result.kind !== "orders") return;
    expect(result.statuses).toEqual([
      { kind: "accepted_resting", oid: 10, cloid: entry.c },
      { kind: "rejected", message: "invalid trigger", cloid: stop.c },
    ]);
  });

  it("retains a partial batch where entry filled and the SL child is rejected", () => {
    const result = parseExchangeResponse({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { oid: 10, totalSz: "2", avgPx: "100", cloid: entry.c } }, { error: "invalid trigger" }] } },
    }, [entry, stop]);
    expect(result.kind).toBe("orders");
    if (result.kind !== "orders") return;
    expect(result.statuses[0]).toMatchObject({ kind: "accepted_filled", oid: 10 });
    expect(result.statuses[1]).toEqual({ kind: "rejected", message: "invalid trigger", cloid: stop.c });
  });

  it("distinguishes a partial fill from a full fill", () => {
    const result = parseExchangeResponse({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { oid: 10, totalSz: "1", avgPx: "100" } }] } },
    }, [entry]);
    expect(result).toMatchObject({
      kind: "orders",
      statuses: [{ kind: "partially_filled", requestedSz: "2", totalSz: "1" }],
    });
  });

  it("returns a batch error for a top-level error response", () => {
    expect(parseExchangeResponse({ status: "err", response: "bad request" })).toMatchObject({
      kind: "batch_error",
      message: "bad request",
    });
  });
  it("rejects missing or short order status arrays", () => {
    expect(parseExchangeResponse({ status: "ok", response: {} }, [entry])).toMatchObject({ kind: "batch_error" });
    expect(parseExchangeResponse({ status: "ok", response: { data: { statuses: [] } } }, [entry])).toMatchObject({ kind: "batch_error" });
  });
  it.each([
    ["approveBuilderFee", { status: "ok", response: { type: "default" } }],
    ["usdClassTransfer", { status: "ok", response: { type: "default" } }],
    ["withdraw3", { status: "ok", response: { type: "default" } }],
  ])("accepts an acknowledged non-order %s response without statuses", (_action, response) => {
    expect(parseExchangeResponse(response)).toEqual({
      kind: "orders",
      statuses: [],
      raw: response,
    });
  });
  it("classifies CLOID recovery as confirmed, not-found, or unknown", () => {
    expect(classifyOrderStatusRecovery(entry.c, { status: "open", order: {} })).toEqual({ kind: "confirmed", cloid: entry.c });
    expect(classifyOrderStatusRecovery(entry.c, { status: "unknownOid" })).toEqual({ kind: "not_found", cloid: entry.c });
    expect(classifyOrderStatusRecovery(entry.c, {})).toEqual({ kind: "unknown", cloid: entry.c });
  });
});

describe("Hyperliquid plain position entry", () => {
  it("maps spot universe ids to base-token size precision", async () => {
    const info = {
      meta: async () => ({ universe: [] }),
      spotMeta: async () => ({
        tokens: [
          { name: "HYPE", index: 5, szDecimals: 2 },
          { name: "USDC", index: 0, szDecimals: 6 },
        ],
        universe: [{ name: "HYPE/USDC", index: 17, tokens: [5, 0] }],
      }),
    } as unknown as HyperliquidInfoClient;
    const metadata = await new HyperliquidMetaCache(info).get();
    expect(metadata.spotByName.get("HYPE/USDC")).toEqual({ name: "HYPE/USDC", asset: 10017, szDecimals: 2 });
  });

  it("uses the same metadata validation path and submits a plain na grouping", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { type?: string; action?: { type?: string; grouping?: string; builder?: unknown } };
      if (payload.type === "meta") return new Response(JSON.stringify({ universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 50 }] }));
      if (payload.type === "spotMeta") return new Response(JSON.stringify({ tokens: [], universe: [] }));
      expect(payload.action).toMatchObject({ type: "order", grouping: "na" });
      expect(payload.action?.builder).toBeUndefined();
      return new Response(JSON.stringify({ status: "ok", response: { data: { statuses: [{ resting: { oid: 7 } }] } } }));
    };
    const info = new HyperliquidInfoClient({ fetchFn });
    const signer = new HyperliquidSigner({
      network: "mainnet",
      fetchFn,
      resolveWallet: () => ({
        address: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
        privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
      }),
    });
    const client = new HyperliquidExchangeClient({ signer, metaCache: new HyperliquidMetaCache(info) });

    await expect(client.openPosition({ entry })).resolves.toMatchObject({
      kind: "orders",
      statuses: [{ kind: "accepted_resting", oid: 7 }],
    });
    await expect(client.openPosition({ entry: { ...entry, p: parseDecimalString("100.1234") } })).rejects.toThrow("at most 3 decimal places");
  });

  it("does not accept a reduce-only order as a plain entry", async () => {
    const client = Object.create(HyperliquidExchangeClient.prototype) as HyperliquidExchangeClient;
    expect(() => client.openPosition({ entry: { ...entry, r: true } })).toThrow("must not be reduce-only");
  });
});

describe("Hyperliquid builder attachment", () => {
  it("adds the confirmed builder field only to a derived order client", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { type?: string; action?: { builder?: { b: string; f: number } } };
      if (payload.type === "meta") return new Response(JSON.stringify({ universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 50 }] }));
      if (payload.type === "spotMeta") return new Response(JSON.stringify({ tokens: [], universe: [] }));
      expect(payload.action?.builder).toEqual({ b: "0x4cE6CD494E3586A8075A6fBBE4B214cb5B7Be020", f: 25 });
      return new Response(JSON.stringify({ status: "ok", response: { data: { statuses: [{ resting: { oid: 8 } }] } } }));
    };
    const info = new HyperliquidInfoClient({ fetchFn });
    const signer = new HyperliquidSigner({
      network: "mainnet", fetchFn,
      resolveWallet: () => ({ address: "0x5e9ee1089755c3435139848e47e6635505d5a13a", privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123" }),
    });
    const base = new HyperliquidExchangeClient({ signer, metaCache: new HyperliquidMetaCache(info) });
    await expect(base.withBuilder({ b: "0x4cE6CD494E3586A8075A6fBBE4B214cb5B7Be020", f: 25 }).openPosition({ entry })).resolves.toMatchObject({ kind: "orders" });
  });

  it("auto-generates CLOIDs and returns typed timeout recovery", async () => {
    const cloid = "0x11111111111111111111111111111111" as const;
    const fetchFn: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { type?: string };
      if (payload.type === "meta") return new Response(JSON.stringify({ universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 50 }] }));
      if (payload.type === "spotMeta") return new Response(JSON.stringify({ tokens: [], universe: [] }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
      });
    };
    const info = new HyperliquidInfoClient({ fetchFn });
    const signer = new HyperliquidSigner({
      network: "mainnet", fetchFn, timeoutMs: 1,
      resolveWallet: () => ({ address: "0x5e9ee1089755c3435139848e47e6635505d5a13a", privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123" }),
    });
    const client = new HyperliquidExchangeClient({
      signer,
      metaCache: new HyperliquidMetaCache(info),
      infoClient: { orderStatus: async () => ({ status: "unknownOid" }) },
      cloidFactory: () => cloid,
    });
    const result = await client.openPosition({ entry: { ...entry, c: undefined } });
    expect(result).toMatchObject({
      kind: "transport_timeout",
      cloids: [cloid],
      recovery: [{ kind: "not_found", cloid }],
    });
  });

  it("validates spot price, lot precision, and minimum notional before signing", async () => {
    const post = vi.fn(async () => ({ status: "ok", response: { data: { statuses: [{ resting: { oid: 9 } }] } } }));
    const signer = {
      address: "0x5e9ee1089755c3435139848e47e6635505d5a13a" as const,
      signL1: vi.fn(async (request) => ({ action: request.action, signature: { r: "0x", s: "0x", v: 27 }, nonce: 1 })),
      post,
    } as unknown as HyperliquidSigner;
    const meta = {
      get: async () => ({
        perpsByCoin: new Map(), perpsByAsset: new Map(),
        spotByName: new Map([["HYPE/USDC", { name: "HYPE/USDC", asset: 10000, szDecimals: 2 }]]),
      }),
    } as unknown as HyperliquidMetaCache;
    const client = new HyperliquidExchangeClient({ signer, metaCache: meta, cloidFactory: () => "0x22222222222222222222222222222222" });
    const order = { a: 10000, b: true, p: parseDecimalString("10"), s: parseDecimalString("1"), r: false, t: { limit: { tif: "Gtc" as const } } };
    await expect(client.spotOrder({ order })).resolves.toMatchObject({ kind: "orders" });
    await expect(client.spotOrder({ order: { ...order, s: parseDecimalString("1.001") } })).rejects.toThrow(/at most 2/i);
    await expect(client.spotOrder({ order: { ...order, p: parseDecimalString("1"), s: parseDecimalString("1") } })).rejects.toThrow(/at least \$10/i);
  });
});
