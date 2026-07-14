import { describe, expect, it, vi } from "vitest";
import { canonicalize, createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { OrderRequest, TwapOrderRequest, UpdateLeverageRequest } from "@nktkas/hyperliquid/api/exchange";

import { HyperliquidExchangeClient } from "@tools/hyperliquid/exchange.js";
import type { HyperliquidMetaCache } from "@tools/hyperliquid/meta-cache.js";
import type { HyperliquidSigner } from "@tools/hyperliquid/signer.js";
import { assertValidPerpPrice, parseDecimalString } from "@tools/hyperliquid/validation.js";

const nonce = 1_700_000_000_000;
const meta = {
  get: async () => ({
    perpsByCoin: new Map(),
    perpsByAsset: new Map([[0, { coin: "BTC", asset: 0, szDecimals: 3, maxLeverage: 50 }]]),
    spotByName: new Map(),
  }),
} as unknown as HyperliquidMetaCache;

function clientWithCapturedAction() {
  const signL1 = vi.fn(async (request) => ({ action: request.action, signature: { r: "0x", s: "0x", v: 27 }, nonce }));
  const signer = { signL1, post: vi.fn(async () => ({ status: "ok", response: { data: { statuses: [] } } })) } as unknown as HyperliquidSigner;
  return { client: new HyperliquidExchangeClient({ signer, metaCache: meta, cloidFactory: () => "0x11111111111111111111111111111111" }), signL1 };
}

function expectCanonicalHash(schema: Parameters<typeof canonicalize>[0], actual: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(createL1ActionHash({ action: actual, nonce })).toBe(createL1ActionHash({
    action: canonicalize(schema, expected),
    nonce,
  }));
}

describe("Hyperliquid L1 canonical wire actions", () => {
  it("signs updateLeverage in SDK schema order", async () => {
    const { client, signL1 } = clientWithCapturedAction();
    await client.updateLeverage({ asset: 0, leverage: 3, isCross: false });
    const action = signL1.mock.calls[0]![0].action;
    expect(action).toEqual({ type: "updateLeverage", asset: 0, isCross: false, leverage: 3 });
    expectCanonicalHash(UpdateLeverageRequest.entries.action, action, { type: "updateLeverage", asset: 0, isCross: false, leverage: 3 });
  });

  it("signs order actions in SDK schema order", async () => {
    const { client, signL1 } = clientWithCapturedAction();
    await client.openPosition({ entry: { a: 0, b: true, p: parseDecimalString("100"), s: parseDecimalString("1"), r: false, t: { limit: { tif: "Gtc" } } } });
    const action = signL1.mock.calls[0]![0].action;
    expectCanonicalHash(OrderRequest.entries.action, action, action);
  });

  it("uses required TWAP reduce-only and randomization fields in SDK order", async () => {
    const { client, signL1 } = clientWithCapturedAction();
    await client.twapOrder({ twap: { a: 0, b: true, s: parseDecimalString("1"), r: false, m: 30, t: true } });
    const action = signL1.mock.calls[0]![0].action;
    expect(action).toEqual({ type: "twapOrder", twap: { a: 0, b: true, s: "1", r: false, m: 30, t: true } });
    expectCanonicalHash(TwapOrderRequest.entries.action, action, action);
  });

  it("includes a concrete size in a signed positionTpsl order", async () => {
    const { client, signL1 } = clientWithCapturedAction();
    await client.setPositionTpsl({
      a: 0, b: false, p: parseDecimalString("90"), s: parseDecimalString("1"), r: true,
      t: { trigger: { isMarket: true, triggerPx: parseDecimalString("90"), tpsl: "sl" } },
    });
    expect(signL1.mock.calls[0]![0].action).toMatchObject({
      type: "order",
      grouping: "positionTpsl",
      orders: [{ s: "1" }],
    });
  });

  it("formats a reduce-only IOC close cap with the live asset tick before signing", async () => {
    const { client, signL1 } = clientWithCapturedAction();
    await client.closePosition({
      asset: 0, side: "sell", size: parseDecimalString("1"), markPrice: parseDecimalString("123.4567"), slippageBps: 37,
    });
    const action = signL1.mock.calls[0]![0].action;
    const orders = action["orders"];
    expect(Array.isArray(orders)).toBe(true);
    const price = Array.isArray(orders) && typeof orders[0] === "object" && orders[0] !== null && typeof orders[0]["p"] === "string"
      ? orders[0]["p"]
      : undefined;
    expect(price).toBeDefined();
    expect(() => assertValidPerpPrice(parseDecimalString(price ?? ""), 3)).not.toThrow();
  });

  it.each([
    [{ a: 0, b: true, s: parseDecimalString("1"), r: false, m: 4, t: false }, /minutes/i],
    [{ a: 0, b: true, s: parseDecimalString("1"), r: false, m: 1441, t: false }, /minutes/i],
  ])("rejects an invalid TWAP duration before signing", async (twap, message) => {
    const { client, signL1 } = clientWithCapturedAction();
    expect(() => client.twapOrder({ twap })).toThrow(message);
    expect(signL1).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])("rejects unsafe isolated-margin ntli %p before signing", async (ntli) => {
    const { client, signL1 } = clientWithCapturedAction();
    expect(() => client.updateIsolatedMargin({ asset: 0, isBuy: true, ntli })).toThrow(/safe integer/i);
    expect(signL1).not.toHaveBeenCalled();
  });
});
