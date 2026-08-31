/**
 * Jupiter metadata honesty on the Solana wallet read.
 *
 * An unconfigured `JUPITER_API_KEY` used to reach this reader as a thrown
 * `VexError` caught into a per-lookup debug line, so every uncached mint kept
 * null labels and the only trace was a message that named a failure, not an
 * unavailable capability. These cases pin the three distinguishable outcomes:
 * the capability is not configured (named once, no request), the lookup ran and
 * failed (transient, still debug), and the lookup was never needed.
 *
 * Metadata is presentation: in EVERY case the holdings still come back with
 * their balances and prices. Nothing here retries, and nothing here changes
 * what is written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { SolanaBalanceRpc } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
vi.mock("@utils/logger.js", () => ({ default: mockLogger }));

const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
  readTokenPools: (...args: unknown[]) => mockReadTokenPools(...args),
}));

const mockKhalaniScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args),
}));

const mockJupiterTokensByMint = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: (...args: unknown[]) => mockJupiterTokensByMint(...args),
}));

// The real cache reads the user's config directory; a suite must not depend on
// the developer's machine.
const mockGetCachedSolanaToken = vi.fn();
const mockCacheSolanaTokens = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: (...args: unknown[]) => mockGetCachedSolanaToken(...args),
  cacheSolanaTokens: (...args: unknown[]) => mockCacheSolanaTokens(...args),
}));

const { readSolanaWalletBalances } = await import(
  "@tools/solana-ecosystem/balances/read-wallet-balances.js"
);

const WALLET = "BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg";
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Two uncached, non-well-known mints, so the Jupiter leg is the only answer. */
const MINT_A = "2dnH9aPEtnJ2PcGvCUqmGH8xq4PZzwZJrBf6aiDJJ5eC";
const MINT_B = "BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg";

function account(pubkey: string, mint: string, amount: string) {
  return {
    pubkey: new PublicKey(pubkey),
    account: {
      data: {
        parsed: {
          type: "account",
          info: {
            mint,
            owner: WALLET,
            state: "initialized",
            tokenAmount: { amount, decimals: 6 },
          },
        },
      },
    },
  };
}

const rpc: SolanaBalanceRpc = {
  getBalance: () => Promise.resolve(1_000_000),
  getParsedTokenAccountsByOwner: (_owner, filter) =>
    Promise.resolve({
      value:
        filter.programId.toBase58() === SPL_PROGRAM
          ? [account(WALLET, MINT_A, "1000"), account(SPL_PROGRAM, MINT_B, "2000")]
          : [],
    }),
};

const originalKey = process.env.JUPITER_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokensPairs.mockResolvedValue([]);
  mockReadTokenPools.mockResolvedValue([]);
  mockKhalaniScan.mockResolvedValue({ tokens: [] });
  mockGetCachedSolanaToken.mockReturnValue(undefined);
  mockJupiterTokensByMint.mockResolvedValue([]);
  process.env.JUPITER_API_KEY = "test-key";
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.JUPITER_API_KEY;
  else process.env.JUPITER_API_KEY = originalKey;
});

describe("Jupiter mint metadata as a named capability", () => {
  it("reports an unconfigured key ONCE, by name, and never requests", async () => {
    delete process.env.JUPITER_API_KEY;

    const read = await readSolanaWalletBalances(WALLET, { rpc });

    const warnings = mockLogger.warn.mock.calls.filter(
      (call) => call[0] === "solana.balances.metadata_capability_unavailable",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ capability: "jupiter_tokens_api", mints: 2 });
    // Not one line per mint, and not disguised as a lookup failure.
    expect(mockJupiterTokensByMint).not.toHaveBeenCalled();
    expect(
      mockLogger.debug.mock.calls.filter((call) => call[0] === "solana.balances.metadata_lookup_failed"),
    ).toHaveLength(0);

    // The holdings are unaffected: metadata is presentation.
    expect(read.tokens.map((token) => token.mint)).toEqual([MINT_A, MINT_B]);
    expect(read.tokens.every((token) => token.symbol === null)).toBe(true);
    expect(read.stats.metadataMissing).toBe(2);
  });

  it("an empty key is unconfigured too", async () => {
    process.env.JUPITER_API_KEY = "   ";
    await readSolanaWalletBalances(WALLET, { rpc });
    expect(
      mockLogger.warn.mock.calls.filter(
        (call) => call[0] === "solana.balances.metadata_capability_unavailable",
      ),
    ).toHaveLength(1);
    expect(mockJupiterTokensByMint).not.toHaveBeenCalled();
  });

  it("a FAILED lookup is not reported as an unavailable capability", async () => {
    mockJupiterTokensByMint.mockRejectedValue(new Error("provider down"));

    const read = await readSolanaWalletBalances(WALLET, { rpc });

    expect(
      mockLogger.warn.mock.calls.filter(
        (call) => call[0] === "solana.balances.metadata_capability_unavailable",
      ),
    ).toHaveLength(0);
    expect(
      mockLogger.debug.mock.calls.filter((call) => call[0] === "solana.balances.metadata_lookup_failed"),
    ).toHaveLength(1);
    // No retry was added: one attempt, one report.
    expect(mockJupiterTokensByMint).toHaveBeenCalledTimes(1);
    expect(read.stats.metadataMissing).toBe(2);
  });

  it("says nothing when the lookup answers", async () => {
    mockJupiterTokensByMint.mockResolvedValue([
      { id: MINT_A, symbol: "AAA", name: "Token A", decimals: 6 },
    ]);

    const read = await readSolanaWalletBalances(WALLET, { rpc });

    expect(
      mockLogger.warn.mock.calls.filter(
        (call) => call[0] === "solana.balances.metadata_capability_unavailable",
      ),
    ).toHaveLength(0);
    expect(read.tokens.find((token) => token.mint === MINT_A)?.symbol).toBe("AAA");
    expect(read.stats.metadataMissing).toBe(1);
  });
});
