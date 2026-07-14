/**
 * FIX 3 — the Limit Order maker + taker clients must send the X-Client-Id
 * header on every request, matching the aggregator / ZaaS / token-api clients
 * (KYBER_CLIENT_ID = "Vex"). Without it, KyberSwap cannot attribute requests to
 * the Vex integrator and rate-limits/identifies the traffic incorrectly.
 *
 * Mirrors `kyberswap-aggregator-client.test.ts`: global fetch is mocked and the
 * forwarded request options' headers are asserted (fetchWithTimeout forwards
 * headers to fetch unchanged).
 */

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    services: { kyberswapLimitOrderUrl: "https://limit-order.kyberswap.com" },
  }),
}));
vi.mock("@utils/logger.js", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KyberLimitOrderClient } from "@tools/kyberswap/limit-order/client.js";
import { KyberLimitOrderTakerClient } from "@tools/kyberswap/limit-order/taker-client.js";

const originalFetch = globalThis.fetch;

function mockFetchOk(body: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  });
}

function lastHeaders() {
  const options = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
  return options.headers as Record<string, string>;
}

const BASE = "https://limit-order.kyberswap.com";

describe("KyberLimitOrderClient (maker) — X-Client-Id header", () => {
  let client: KyberLimitOrderClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    client = new KyberLimitOrderClient(BASE);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends X-Client-Id on a GET request", async () => {
    mockFetchOk([]);
    await client.getOrders({ chainId: "1", maker: "0xabc" });
    expect(lastHeaders()["X-Client-Id"]).toBe("Vex");
  });

  it("sends X-Client-Id on a POST request (alongside Content-Type)", async () => {
    mockFetchOk({ id: 42 });
    await client.createOrder({
      chainId: "1",
      makerAsset: "0x1111111111111111111111111111111111111111",
      takerAsset: "0x2222222222222222222222222222222222222222",
      maker: "0x3333333333333333333333333333333333333333",
      makingAmount: "100",
      takingAmount: "200",
      expiredAt: 9999999999,
      salt: "1",
      signature: "0xsig",
    });
    const headers = lastHeaders();
    expect(headers["X-Client-Id"]).toBe("Vex");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("KyberLimitOrderTakerClient — X-Client-Id header", () => {
  let taker: KyberLimitOrderTakerClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    taker = new KyberLimitOrderTakerClient(BASE);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends X-Client-Id on a GET request", async () => {
    mockFetchOk([]);
    await taker.getTradingPairs("1");
    expect(lastHeaders()["X-Client-Id"]).toBe("Vex");
  });

  it("sends X-Client-Id on a POST request", async () => {
    mockFetchOk({ encodedData: "0xdeadbeef" });
    await taker.encodeFillOrder({
      orderId: 1,
      takingAmount: "100",
      thresholdAmount: "90",
      target: "0x4444444444444444444444444444444444444444",
      operatorSignature: "0xop",
    });
    const headers = lastHeaders();
    expect(headers["X-Client-Id"]).toBe("Vex");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
