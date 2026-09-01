/**
 * wallet_balances — inclusive chain scope (Khalani-first, local fallback).
 *
 * Pins the Robinhood-launch behavior:
 *   - a local-only filter ("robinhood"/"4663") scans direct-RPC and NEVER
 *     widens into an unfiltered all-Khalani scan,
 *   - an omitted filter scans all Khalani chains AND every local chain,
 *   - a Khalani-only filter never touches the local reader,
 *   - a local RPC failure degrades to a bounded per-chain error (snapshot
 *     survives; no raw provider text),
 *   - unsupported chains still fail with `Unsupported chain: X`,
 *   - a local-chain filter for the solana family fails (local chains are EVM).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";

// ── Mocks ───────────────────────────────────────────────────────

const mockScan = vi.fn();
// The shared Khalani price enrichment now runs on this path too, so its ONE
// provider boundary is scripted to answer nothing: rows Khalani left unpriced
// stay unpriced, and no test in this suite reaches the network.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: () => Promise.resolve([]),
  readTokenPools: () => Promise.resolve([]),
}));

vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    // Real selection helpers are trivially pure EXCEPT the parse (registry
    // fetch) — replace parse with a static two-chain registry (base + solana).
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    calculateTokensTotalUsd: original.calculateTokensTotalUsd,
    parseBalanceChainSelection: async (raw: string | undefined) => {
      if (!raw) return { rawProvided: false, byFamily: new Map() };
      const byFamily = new Map<ChainFamily, number[]>();
      for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
        if (part === "base" || part === "8453") {
          byFamily.set("eip155", [...(byFamily.get("eip155") ?? []), 8453]);
        } else if (part === "solana") {
          byFamily.set("solana", [...(byFamily.get("solana") ?? []), 101]);
        } else {
          throw new Error(`Chain ${part} is not in the current Khalani registry.`);
        }
      }
      return { rawProvided: true, byFamily };
    },
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async (input: string) => {
    const normalized = input.trim().toLowerCase();
    if (normalized === "base" || normalized === "8453") {
      return { source: "khalani", chainId: 8453, family: "eip155" };
    }
    if (normalized === "solana") {
      return { source: "khalani", chainId: 101, family: "solana" };
    }
    if (normalized === "robinhood" || normalized === "4663") {
      return { source: "local", chainId: 4663, family: "eip155" };
    }
    throw new Error(`Unsupported chain: ${input}`);
  },
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

const mockScanSet = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildLocalChainInventory: (...a: unknown[]) => mockScanSet(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0xWALLET",
}));

import { buildLocalChainScanSet } from "@vex-agent/wallet-inventory/local-chain.js";

/**
 * The enumeration the mocked sync lane answers with: a seeds-and-pins scan set,
 * built by the REAL union owner so the shape under test is never a hand-written
 * imitation of it. No indexer, which is exactly the state a local chain reports
 * when Blockscout answered nothing.
 */
function scanSetOf(addresses: readonly string[], chainId = 4663) {
  return buildLocalChainScanSet({
    chainId,
    seedAddresses: addresses,
    pinnedAddresses: [],
    indexer: null,
  });
}

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

// ── Fixtures ────────────────────────────────────────────────────

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

const CONTEXT = {
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as never;

function khalaniScan(family: ChainFamily, overrides: Record<string, unknown> = {}) {
  return {
    address: "0xWALLET",
    family,
    tokens: [],
    scannedChainIds: [],
    chainErrors: [],
    totalUsd: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockImplementation(async ({ family }: { family: ChainFamily }) => khalaniScan(family));
  mockScanSet.mockResolvedValue(scanSetOf([VEX]));
  // 0.005 ETH priced $2000 + 2 VEX priced $0.5.
  mockReadLocal.mockResolvedValue({
    nativeWei: 5_000000000000000n,
    nativePriceUsd: 2000,
    tokens: [
      { address: VEX, symbol: "VEX", decimals: 18, balanceWei: 2_000000000000000000n, priceUsd: 0.5 },
    ],
    // A4: every scanned token answered; per-token read failures are reported
    // separately from the tokens themselves.
    tokenFailures: [],
  });
});

// ── Tests ───────────────────────────────────────────────────────

describe("handleWalletBalances — inclusive chain scope", () => {
  it("scans a local-only filter ('robinhood') direct-RPC and never calls the Khalani scan", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "robinhood" }, CONTEXT);
    expect(res.success).toBe(true);
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockReadLocal).toHaveBeenCalledTimes(1);

    const data = res.data as { wallets: Array<Record<string, unknown>>; totalUsd: number };
    const snap = data.wallets[0]!;
    expect(snap.scannedChainIds).toEqual([4663]);
    const tokens = snap.tokens as Array<Record<string, unknown>>;
    const native = tokens.find((t) => t.address === NATIVE)!;
    expect(native.symbol).toBe("ETH");
    expect(native.balanceRaw).toBe("5000000000000000");
    expect(native.balance).toBe("0.005");
    expect(native.priceUsd).toBe("2000");
    // 0.005 * 2000 + 2 * 0.5 = 11.
    expect(data.totalUsd).toBeCloseTo(11);
  });

  it("accepts the numeric local chain id ('4663')", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "4663" }, CONTEXT);
    expect(res.success).toBe(true);
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockReadLocal).toHaveBeenCalledTimes(1);
  });

  it("an omitted filter scans all Khalani chains AND every local chain", async () => {
    mockScan.mockImplementation(async ({ family, chainIds }: { family: ChainFamily; chainIds?: number[] }) => {
      expect(chainIds).toBeUndefined(); // unfiltered Khalani scan
      // The Khalani $7 is carried by a real ROW, not by a bare `totalUsd`
      // field: the handler now re-derives that number from the rows AFTER the
      // shared price enrichment has filled whatever nulls it could, so a
      // scripted total that no row backs would be a fiction no production scan
      // can produce (the scan owner reduces the same rows).
      return khalaniScan(
        family,
        family === "eip155"
          ? {
              tokens: [
                {
                  symbol: "KHL",
                  name: "Khalani Token",
                  address: "0xk",
                  chainId: 8453,
                  decimals: 18,
                  extensions: { balance: "7000000000000000000", price: { usd: "1" } },
                },
              ],
              totalUsd: 7,
              scannedChainIds: [8453],
            }
          : {},
      );
    });
    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);
    expect(res.success).toBe(true);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockReadLocal).toHaveBeenCalledTimes(1);
    const data = res.data as { wallets: Array<Record<string, unknown>>; totalUsd: number };
    expect(data.wallets[0]!.scannedChainIds).toEqual([8453, 4663]);
    expect(data.totalUsd).toBeCloseTo(7 + 11);
  });

  it("a Khalani-only filter ('base') never touches the local reader", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "base" }, CONTEXT);
    expect(res.success).toBe(true);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockScan.mock.calls[0]![0]).toMatchObject({ chainIds: [8453] });
    expect(mockReadLocal).not.toHaveBeenCalled();
  });

  it("mixed filter ('base,robinhood') routes each side to its own scanner", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "base,robinhood" }, CONTEXT);
    expect(res.success).toBe(true);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockScan.mock.calls[0]![0]).toMatchObject({ chainIds: [8453] });
    expect(mockReadLocal).toHaveBeenCalledTimes(1);
  });

  it("degrades a local RPC failure to a bounded per-chain error (no raw provider text)", async () => {
    mockReadLocal.mockRejectedValue(new Error("connect ECONNREFUSED https://rpc.secret"));
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "robinhood" }, CONTEXT);
    expect(res.success).toBe(true);
    const snap = (res.data as { wallets: Array<Record<string, unknown>> }).wallets[0]!;
    expect(snap.scannedChainIds).toEqual([]);
    const errors = snap.chainErrors as Array<Record<string, unknown>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.chainId).toBe(4663);
    expect(String(errors[0]!.message)).not.toContain("rpc.secret");
  });

  it("fails a solana-family request filtered to a local EVM chain", async () => {
    const res = await handleWalletBalances({ walletFamily: "solana", chainIds: "robinhood" }, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.output).toContain("no solana chains matched");
  });

  it("still fails on a chain neither registry knows", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "foochain" }, CONTEXT);
    expect(res.success).toBe(false);
    expect(res.output).toContain("Unsupported chain: foochain");
  });
});
