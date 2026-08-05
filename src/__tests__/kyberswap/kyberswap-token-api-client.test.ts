vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    services: { kyberswapTokenApiUrl: "https://token-api.kyberswap.com" },
  }),
}));
vi.mock("@utils/logger.js", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { ErrorCodes } from "../../errors.js";

const originalFetch = globalThis.fetch;

describe("KyberTokenApiClient", () => {
  let client: KyberTokenApiClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    client = new KyberTokenApiClient("https://token-api.kyberswap.com");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("searchTokens", () => {
    it("builds URL with chainIds and name", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { tokens: [], pagination: { totalItems: 0 } } }),
      });
      await client.searchTokens("1,56", { name: "USDC", isWhitelisted: true, pageSize: 5 });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toContain("chainIds=1%2C56");
      expect(url).toContain("name=USDC");
      expect(url).toContain("isWhitelisted=true");
      expect(url).toContain("pageSize=5");
    });

    it("includes X-Client-Id header", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { tokens: [], pagination: {} } }),
      });
      await client.searchTokens("1");
      const options = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.headers["X-Client-Id"]).toBe("Vex");
    });

    it("returns parsed tokens", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tokens: [{ address: "0x1", symbol: "USDC", name: "USD Coin", decimals: 6 }],
            pagination: { totalItems: 1 },
          },
        }),
      });
      const tokens = await client.searchTokens("1", { name: "USDC" });
      expect(tokens).toHaveLength(1);
      expect(tokens[0].symbol).toBe("USDC");
    });

    it("throws KYBER_TOKEN_SEARCH_FAILED on error", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ message: "Bad request" }),
        // The error path reads the body as TEXT (W2a).
        text: async () => JSON.stringify({ message: "Bad request" }),
      });
      await expect(client.searchTokens("1")).rejects.toMatchObject({
        code: ErrorCodes.KYBER_TOKEN_SEARCH_FAILED,
      });
    });
  });

  describe("getHoneypotFotInfo", () => {
    it("returns honeypot info", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ isHoneypot: false, isFOT: true, tax: 3 }),
      });
      const result = await client.getHoneypotFotInfo(1, "0xdAC17F958D2ee523a2206206994597C13D831ec7");
      expect(result.isHoneypot).toBe(false);
      expect(result.isFOT).toBe(true);
      expect(result.tax).toBe(3);
    });

    it("throws KYBER_HONEYPOT_CHECK_FAILED on error", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: "Server error" }),
        text: async () => JSON.stringify({ message: "Server error" }),
      });
      await expect(client.getHoneypotFotInfo(1, "0x1")).rejects.toMatchObject({
        code: ErrorCodes.KYBER_HONEYPOT_CHECK_FAILED,
      });
    });
  });
});
