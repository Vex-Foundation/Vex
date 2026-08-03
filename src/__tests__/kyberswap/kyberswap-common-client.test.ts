vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    services: { kyberswapCommonServiceUrl: "https://common-service.kyberswap.com" },
  }),
}));
vi.mock("@utils/logger.js", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KyberCommonClient } from "@tools/kyberswap/common/client.js";
import { clearDynamicChainsCache } from "@tools/kyberswap/chains.js";

const originalFetch = globalThis.fetch;

describe("KyberCommonClient", () => {
  let client: KyberCommonClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    clearDynamicChainsCache();
    client = new KyberCommonClient("https://common-service.kyberswap.com");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearDynamicChainsCache();
  });

  it("fetches and caches supported chains", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" },
        ],
      }),
    });

    const chains = await client.getSupportedChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].chainName).toBe("ethereum");

    // Second call should use cache (no additional fetch)
    const chains2 = await client.getSupportedChains();
    expect(chains2).toEqual(chains);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws on error response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: "Server error" }),
      // The error path reads the body as TEXT (W2a).
      text: async () => JSON.stringify({ message: "Server error" }),
    });

    await expect(client.getSupportedChains()).rejects.toThrow(/Common Service error/);
  });
});
