/**
 * Pendle enrichment (harness P2, hardened by H-1):
 *   - mergePendleRows dedup-by-address precedence,
 *   - enrichPendleBalances / seedPendleChainBalances driving the REAL
 *     PendleClient against a CAPTURED live asset catalogue,
 *   - seedPendleChainBalances standalone seeding + ghost cleanup,
 *   - DETERMINED-EMPTY vs UNKNOWN: only a determined empty result may clear rows,
 *   - fail-soft (RPC/API failure never destroys balances) vs DB-read propagation.
 *
 * H-1 note on why this file stubs `fetch` rather than `getPendleClient`: it used
 * to mock `getAllAssets` with an invented helper, so it stayed green for months
 * while the production read returned `[]` on every single call. The client is now
 * exercised for real — validator, per-chain URL and all — and only the network is
 * faked, with bodies captured verbatim from the live API.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import {
  PENDLE_CHAIN1_ASSETS,
  PENDLE_CHAIN143_ASSETS,
  PENDLE_GLOBAL_ASSETS_ENVELOPE,
} from "../tools/protocols/pendle/asset-catalog-fixtures.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Only the NETWORK is faked. `getPendleClient()` and its validators run for real.
const mockFetch = vi.fn();
const mockReadJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
  readJson: (...a: unknown[]) => mockReadJson(...a),
}));

/**
 * `getPendleClient()` memoizes one client per base URL, and that client holds a
 * 5-minute TTL cache. Handing each test its OWN base URL rebuilds the singleton,
 * so no fixture cached in one test can answer the next one.
 */
let apiBase = "https://api0.example/";
vi.mock("@config/store.js", () => ({
  loadConfig: () => ({ services: { pendleApiUrl: apiBase } }),
}));

const mockMulticall = vi.fn();
vi.mock("@tools/pendle/evm-client.js", () => ({
  getPendlePublicClient: () => ({ multicall: mockMulticall }),
}));

const mockGetTracked = vi.fn();
vi.mock("@vex-agent/db/repos/activity.js", () => ({
  getTrackedEvmTokensForChain: (...a: unknown[]) => mockGetTracked(...a),
}));

const mockReplace = vi.fn();
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplace(...a),
}));

const { mergePendleRows, enrichPendleBalances, seedPendleChainBalances } = await import(
  "../../../vex-agent/sync/pendle-enrichment.js"
);
const { getPendleClient } = await import("@tools/pendle/client.js");

const WALLET = "0x1111111111111111111111111111111111111111";
/** PT-SIERRA-6AUG2026 on Ethereum — 6 decimals, priced, from the captured body. */
const PT_CHAIN1 = "0x0ee083964c815baed1a2d7f5e3cec851ec394e7d";
/** SY-SIERRA on Ethereum — present in the catalogue but NOT a PT. */
const SY_CHAIN1 = "0x399e426e6812943ac22976333698e16eaa80a209";
/** PT-AUSD-8OCT2026 on Monad — 6 decimals, priced, from the captured body. */
const PT_CHAIN143 = "0x9fc74f8ed616b5baf52a170caa97d6d3898602d1";

function fixtureAsset(rows: readonly unknown[], address: string): Record<string, unknown> {
  const row = rows.find(
    (r) => (r as { address?: string }).address?.toLowerCase() === address.toLowerCase(),
  );
  if (!row) throw new Error(`fixture has no asset ${address}`);
  return row as Record<string, unknown>;
}

function price(rows: readonly unknown[], address: string): number {
  const usd = (fixtureAsset(rows, address).price as { usd?: number } | undefined)?.usd;
  if (typeof usd !== "number") throw new Error(`fixture asset ${address} has no price`);
  return usd;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  __json: unknown;
}

/** Serve a captured `/v1/{chainId}/assets/all` body per chain. */
function installCatalog(byChainId: Record<number, unknown>): void {
  mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
  mockFetch.mockImplementation((url: string) => {
    const match = /\/v1\/(\d+)\/assets\/all$/.exec(String(url));
    if (!match) throw new Error(`unexpected URL: ${String(url)}`);
    const body = byChainId[Number(match[1])];
    if (body === undefined) throw new Error("network down");
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, __json: body });
  });
}

function row(address: string, priceUsd: number | null): BalanceRow {
  return {
    walletFamily: "eip155",
    walletAddress: "0xwallet",
    chainId: 1,
    tokenAddress: address,
    tokenSymbol: "PT-X",
    tokenName: null,
    balanceRaw: "1000000000000000000",
    balanceUsd: priceUsd,
    priceUsd,
    decimals: 18,
  };
}

let testIndex = 0;
beforeEach(() => {
  vi.clearAllMocks();
  apiBase = `https://api${++testIndex}.example/`;
});

describe("mergePendleRows", () => {
  it("Pendle-priced row replaces an unpriced Khalani row for the same token", () => {
    const merged = mergePendleRows([row(PT_CHAIN1, null)], [row(PT_CHAIN1, 0.99)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.priceUsd).toBe(0.99);
  });

  it("a Khalani row that already has a price is authoritative", () => {
    const merged = mergePendleRows([row(PT_CHAIN1, 1.0)], [row(PT_CHAIN1, 0.5)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.priceUsd).toBe(1.0);
  });

  it("adds a Pendle PT that Khalani did not report at all", () => {
    const merged = mergePendleRows([row("0xother", 1)], [row(PT_CHAIN1, 0.99)]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.tokenAddress.toLowerCase())).toContain(PT_CHAIN1);
  });

  it("dedupes case-insensitively on the token address", () => {
    const merged = mergePendleRows([row(PT_CHAIN1.toUpperCase(), null)], [row(PT_CHAIN1, 0.99)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.priceUsd).toBe(0.99);
  });
});

describe("enrichPendleBalances — real client against the captured catalogue", () => {
  it("prices a tracked PT with its REAL decimals from the live capture", async () => {
    installCatalog({ 1: PENDLE_CHAIN1_ASSETS });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);
    // 12.5 PT at the fixture's 6 decimals.
    mockMulticall.mockResolvedValue([{ status: "success", result: 12_500_000n }]);

    const merged = await enrichPendleBalances("eip155", WALLET, 1, []);

    expect(merged).toHaveLength(1);
    const [only] = merged;
    // 6, not the 18 the old `?? 18` fallback assumed — the whole point of H-1.
    expect(only).toMatchObject({
      decimals: 6,
      priceUsd: price(PENDLE_CHAIN1_ASSETS, PT_CHAIN1),
      tokenSymbol: "PT-SIERRA-6AUG2026",
    });
    expect(only?.balanceUsd).toBeCloseTo(12.5 * price(PENDLE_CHAIN1_ASSETS, PT_CHAIN1), 10);
    expect(mockGetTracked).toHaveBeenCalledWith({ walletAddress: WALLET, chainKeys: ["ethereum"] });
  });

  it("reads the PER-CHAIN URL for the chain it was asked about", async () => {
    installCatalog({ 143: PENDLE_CHAIN143_ASSETS });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);

    await enrichPendleBalances("eip155", WALLET, 143, []);

    expect(mockFetch.mock.calls.map((c) => String(c[0]))).toEqual([`${apiBase}v1/143/assets/all`]);
  });

  it("ignores a tracked token the catalogue does not classify as PT", async () => {
    installCatalog({ 1: PENDLE_CHAIN1_ASSETS });
    mockGetTracked.mockResolvedValue([SY_CHAIN1]);

    const merged = await enrichPendleBalances("eip155", WALLET, 1, []);

    expect(merged).toEqual([]);
    expect(mockMulticall).not.toHaveBeenCalled();
  });

  it("keeps the base rows (same reference) when the catalogue read fails", async () => {
    installCatalog({});
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);
    const base = [row("0xother", 1)];

    const merged = await enrichPendleBalances("eip155", WALLET, 1, base);

    expect(merged).toBe(base);
  });
});

describe("seedPendleChainBalances — determined-empty vs unknown", () => {
  it("writes tracked PT rows for a Pendle chain Khalani cannot scan (monad 143)", async () => {
    installCatalog({ 143: PENDLE_CHAIN143_ASSETS });
    mockGetTracked.mockResolvedValue([PT_CHAIN143]);
    // 2 PT at the fixture's 6 decimals.
    mockMulticall.mockResolvedValue([{ status: "success", result: 2_000_000n }]);
    mockReplace.mockResolvedValue(1);

    const result = await seedPendleChainBalances("eip155", WALLET, 143);

    expect(result.skipped).toBe(false);
    expect(result.tokensUpdated).toBe(1);
    const [addr, chainId, rows] = mockReplace.mock.calls[0]! as [string, number, BalanceRow[]];
    expect(addr).toBe(WALLET);
    expect(chainId).toBe(143);
    const [seeded] = rows;
    expect(seeded).toMatchObject({ chainId: 143, decimals: 6 });
    expect(seeded?.balanceUsd).toBeCloseTo(2 * price(PENDLE_CHAIN143_ASSETS, PT_CHAIN143), 10);
  });

  it("replaces with EMPTY only when the balance is DETERMINED zero (post-sell)", async () => {
    installCatalog({ 1: PENDLE_CHAIN1_ASSETS });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);
    mockMulticall.mockResolvedValue([{ status: "success", result: 0n }]);
    mockReplace.mockResolvedValue(0);

    const result = await seedPendleChainBalances("eip155", WALLET, 1);

    expect(result.skipped).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith(WALLET, 1, []);
  });

  it("NEVER replaces with empty when the catalogue is UNREADABLE (the global envelope)", async () => {
    // The exact production failure: the response parsed as "no assets", nothing
    // classified as PT, and the seed deleted the wallet's real PT balances.
    installCatalog({ 1: PENDLE_GLOBAL_ASSETS_ENVELOPE });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);

    const result = await seedPendleChainBalances("eip155", WALLET, 1);

    expect(result.skipped).toBe(true);
    expect(result.tokensUpdated).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("NEVER replaces with empty when the chain's catalogue comes back empty", async () => {
    installCatalog({ 1: [] });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);

    const result = await seedPendleChainBalances("eip155", WALLET, 1);

    expect(result.skipped).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skips (no write) when the wallet has never traded PT on this chain", async () => {
    mockGetTracked.mockResolvedValue([]);
    const result = await seedPendleChainBalances("eip155", WALLET, 143);
    expect(result.skipped).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("skips a non-Pendle chain without any DB or RPC work", async () => {
    const result = await seedPendleChainBalances("eip155", WALLET, 137); // polygon
    expect(result.skipped).toBe(true);
    expect(mockGetTracked).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("fail-soft vs propagation", () => {
  it("SEED skips its write (keeps last-good rows) when the multicall RPC fails", async () => {
    installCatalog({ 1: PENDLE_CHAIN1_ASSETS });
    mockGetTracked.mockResolvedValue([PT_CHAIN1]);
    mockMulticall.mockRejectedValue(new Error("rpc down"));

    const result = await seedPendleChainBalances("eip155", WALLET, 1);

    expect(result.skipped).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("PROPAGATES a DB fault from the tracked-token read (never silently swallowed)", async () => {
    mockGetTracked.mockRejectedValue(new Error("db down"));
    await expect(seedPendleChainBalances("eip155", WALLET, 143)).rejects.toThrow("db down");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("the client surfaces the unreadable catalogue as PENDLE_INVALID_RESPONSE", async () => {
    installCatalog({ 1: PENDLE_GLOBAL_ASSETS_ENVELOPE });
    await expect(getPendleClient().getAssetsForChain(1)).rejects.toMatchObject({
      code: ErrorCodes.PENDLE_INVALID_RESPONSE,
    });
    await expect(getPendleClient().getAssetsForChain(1)).rejects.toThrow(VexError);
  });
});
