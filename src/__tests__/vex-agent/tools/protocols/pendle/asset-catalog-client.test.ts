/**
 * H-1: the Pendle asset catalogue is read from the PER-CHAIN endpoint, and a
 * shape we cannot read RAISES instead of degrading to an empty list.
 *
 * The defect this locks down: the client requested the GLOBAL `/v1/assets/all`,
 * whose root is an object, through an array-shaped validator that answered `[]`.
 * Nothing threw and nothing logged, so every token was treated as 18-decimal,
 * every cost basis was $0, and no PT was ever classified.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
const mockReadJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
  readJson: (...a: unknown[]) => mockReadJson(...a),
}));

const { PendleClient } = await import("@tools/pendle/client.js");
const {
  PENDLE_CHAIN1_ASSETS,
  PENDLE_CHAIN143_ASSETS,
  PENDLE_GLOBAL_ASSETS_ENVELOPE,
} = await import("./asset-catalog-fixtures.js");
const { requireAsset } = await import("./validated-fixtures.js");

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  __json: unknown;
}
function res(json: unknown): FakeResponse {
  return { ok: true, status: 200, headers: { get: () => null }, __json: json };
}

/** Serve `byChainId[chainId]` for whichever `/v1/{chainId}/assets/all` is requested. */
function install(byChainId: Record<number, unknown>): void {
  mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
  mockFetch.mockImplementation((url: string) => {
    const match = /\/v1\/(\d+)\/assets\/all$/.exec(String(url));
    if (!match) throw new Error(`unexpected URL: ${String(url)}`);
    return Promise.resolve(res(byChainId[Number(match[1])]));
  });
}

beforeEach(() => vi.clearAllMocks());

describe("PendleClient.getAssetsForChain", () => {
  it("requests the PER-CHAIN endpoint, never the global one", async () => {
    install({ 1: PENDLE_CHAIN1_ASSETS });
    const client = new PendleClient("https://api.example/");

    await client.getAssetsForChain(1);

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["https://api.example/v1/1/assets/all"]);
    expect(urls.some((u) => u.endsWith("/v1/assets/all"))).toBe(false);
  });

  it("returns priced PT assets with real decimals and baseType", async () => {
    install({ 1: PENDLE_CHAIN1_ASSETS });
    const client = new PendleClient("https://api.example/");

    const assets = await client.getAssetsForChain(1);

    const pts = assets.filter((a) => a.baseType === "PT" && a.priceUsd !== null);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((a) => a.decimals !== null)).toBe(true);
    expect(assets.every((a) => a.chainId === 1)).toBe(true);
    // The 6-decimal SIERRA PT — proof the `?? 18` fallback is no longer reached.
    const sierraPt = requireAsset(assets, "PT-SIERRA-6AUG2026", (a) => a.symbol === "PT-SIERRA-6AUG2026");
    expect(sierraPt.decimals).toBe(6);
  });

  it("keeps chains apart: chain 143 is fetched from its own URL and cached separately", async () => {
    install({ 1: PENDLE_CHAIN1_ASSETS, 143: PENDLE_CHAIN143_ASSETS });
    const client = new PendleClient("https://api.example/");

    const [one, monad] = await Promise.all([client.getAssetsForChain(1), client.getAssetsForChain(143)]);

    expect(one.every((a) => a.chainId === 1)).toBe(true);
    expect(monad.every((a) => a.chainId === 143)).toBe(true);
    expect(monad.some((a) => a.baseType === "PT")).toBe(true);

    // A second read of the same chain is served from the per-URL TTL cache.
    await client.getAssetsForChain(1);
    const chain1Gets = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/v1/1/assets/all"));
    expect(chain1Gets).toHaveLength(1);
  });

  it("RAISES PENDLE_INVALID_RESPONSE when the body is the global object envelope", async () => {
    install({ 1: PENDLE_GLOBAL_ASSETS_ENVELOPE });
    const client = new PendleClient("https://api.example/");

    await expect(client.getAssetsForChain(1)).rejects.toThrow(VexError);
    await expect(client.getAssetsForChain(1)).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_INVALID_RESPONSE,
    });
  });

  it("does NOT cache a shape failure — the next call retries the provider", async () => {
    install({ 1: PENDLE_GLOBAL_ASSETS_ENVELOPE });
    const client = new PendleClient("https://api.example/");

    await expect(client.getAssetsForChain(1)).rejects.toThrow(VexError);
    await expect(client.getAssetsForChain(1)).rejects.toThrow(VexError);
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it("returns a determined EMPTY list without throwing when the chain has no assets", async () => {
    install({ 80094: [] });
    const client = new PendleClient("https://api.example/");
    await expect(client.getAssetsForChain(80094)).resolves.toEqual([]);
  });
});
