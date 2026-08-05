vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    services: { kyberswapAggregatorUrl: "https://aggregator-api.kyberswap.com" },
  }),
}));
vi.mock("@utils/logger.js", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KyberAggregatorClient, getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { ErrorCodes } from "../../errors.js";

const originalFetch = globalThis.fetch;

function mockFetchOk(body: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  });
}

// The error path reads the body as TEXT (W2a): a non-JSON edge challenge page
// must survive to the agent sanitized, instead of being dropped by `readJson`.
function mockFetchError(status: number, body: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const VALID_ROUTE = {
  code: 0,
  data: {
    routeSummary: {
      tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      amountIn: "1000000000000000000", amountInUsd: "2000",
      tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amountOut: "2000000000", amountOutUsd: "2000",
      gas: "150000", gasPrice: "50000000000", gasUsd: "7.50",
      route: [], routeID: "route-1", checksum: "0x1", timestamp: "123",
    },
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  },
  requestId: "req-1",
};

describe("KyberAggregatorClient", () => {
  let client: KyberAggregatorClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    client = new KyberAggregatorClient("https://aggregator-api.kyberswap.com");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getRoute", () => {
    it("builds correct URL", async () => {
      mockFetchOk(VALID_ROUTE);
      await client.getRoute("ethereum", {
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`,
        tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        amountIn: "1000000000000000000",
      });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toContain("/ethereum/api/v1/routes");
      expect(url).toContain("tokenIn=");
      expect(url).toContain("amountIn=");
    });

    it("includes X-Client-Id header", async () => {
      mockFetchOk(VALID_ROUTE);
      await client.getRoute("ethereum", {
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`,
        tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        amountIn: "1000",
      });
      const options = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.headers["X-Client-Id"]).toBe("Vex");
    });

    it("parses valid response", async () => {
      mockFetchOk(VALID_ROUTE);
      const result = await client.getRoute("ethereum", {
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`,
        tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        amountIn: "1000",
      });
      expect(result.data.routeSummary.routeID).toBe("route-1");
      expect(result.data.routerAddress).toBe("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5");
    });

    it("maps error code 4008 to KYBER_ROUTE_NOT_FOUND", async () => {
      mockFetchError(400, { code: 4008, message: "Route not found", requestId: "req-1" });
      await expect(client.getRoute("ethereum", {
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`,
        tokenOut: "0x1" as `0x${string}`,
        amountIn: "1000",
      })).rejects.toMatchObject({ code: ErrorCodes.KYBER_ROUTE_NOT_FOUND });
    });

    it("maps 429 to KYBER_RATE_LIMITED", async () => {
      mockFetchError(429, { message: "Rate limited" });
      await expect(client.getRoute("ethereum", {
        tokenIn: "0x1" as `0x${string}`, tokenOut: "0x2" as `0x${string}`, amountIn: "1",
      })).rejects.toMatchObject({ code: ErrorCodes.KYBER_RATE_LIMITED });
    });
  });

  describe("buildRoute", () => {
    it("uses POST method with JSON body", async () => {
      mockFetchOk({
        code: 0,
        data: {
          amountIn: "1000", amountInUsd: "1", amountOut: "1000", amountOutUsd: "1",
          gas: "100", gasUsd: "0.01", data: "0xabc",
          routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
          transactionValue: "1000",
        },
      });
      await client.buildRoute("ethereum", {
        routeSummary: VALID_ROUTE.data.routeSummary as any,
        sender: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        recipient: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        slippageTolerance: 50,
      });
      const options = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
    });
  });
});

describe("getKyberAggregatorClient", () => {
  it("returns singleton for same URL", () => {
    const a = getKyberAggregatorClient();
    const b = getKyberAggregatorClient();
    expect(a).toBe(b);
  });
});
