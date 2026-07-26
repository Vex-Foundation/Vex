import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
function callMock<T>(mock: unknown, args: unknown[]): T {
  return (mock as (...innerArgs: unknown[]) => T)(...args);
}
vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => callMock(mockFetchJson, args),
}));

const {
  jupiterTokenSearch,
  jupiterTokensByMint,
  jupiterTokensByTag,
  jupiterTokensByCategory,
  jupiterRecentTokens,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-tokens/client.js");

describe("jupiter tokens v2 client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("calls /tokens/v2/search with x-api-key", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterTokenSearch({ query: "JUP" });

    const [url, opts] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/tokens/v2/search?query=JUP");
    expect(opts.headers).toEqual({ "x-api-key": "test-jupiter-key" });
  });

  it("uses /tokens/v2/search with comma-separated mint addresses for batch mint lookup", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterTokensByMint([
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ]);

    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toContain("/tokens/v2/search?query=So11111111111111111111111111111111111111112%2CEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("calls /tokens/v2/tag for verified tokens", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterTokensByTag("verified");

    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/tokens/v2/tag?query=verified");
  });

  // W1-G: "stocks" (tokenized equities) is a documented Jupiter tag value
  // (recon-docs-tokens.md §2.2) that was previously unmodeled and rejected.
  it("calls /tokens/v2/tag for stocks (tokenized equities) tokens", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterTokensByTag("stocks");

    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/tokens/v2/tag?query=stocks");
  });

  it("calls /tokens/v2/{category}/{interval} with limit", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterTokensByCategory({
      category: "toptrending",
      interval: "1h",
      limit: 50,
    });

    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/tokens/v2/toptrending/1h?limit=50");
  });

  it("calls /tokens/v2/recent", async () => {
    mockFetchJson.mockResolvedValueOnce([]);

    await jupiterRecentTokens();

    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/tokens/v2/recent");
  });

  it("rejects when JUPITER_API_KEY is missing", async () => {
    delete process.env.JUPITER_API_KEY;

    await expect(
      jupiterTokenSearch({ query: "JUP" }),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("rejects invalid token tag before fetching", async () => {
    await expect(
      jupiterTokensByTag("community" as never),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("rejects mint batches larger than 100 before fetching", async () => {
    const mints = Array.from({ length: 101 }, () => "So11111111111111111111111111111111111111112");

    await expect(
      jupiterTokensByMint(mints),
    ).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });

    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
