/**
 * Solana direct-RPC balance sync: what reaches `proj_balances`, and what must
 * NOT reach it when the read is incomplete.
 *
 * The RPC is a scripted object injected through the reader's own seam, serving
 * the SANITIZED live probe responses of 2026-08-26; the provider boundaries
 * (DexScreener, Jupiter metadata, the Khalani price map, the token-file cache)
 * are the only modules mocked. Everything between the RPC bytes and the row
 * handed to `replaceBalancesForChain` is the real code path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { SolanaBalanceRpc } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";

import splResponse from "../../fixtures/solana/spl-response.json" with { type: "json" };
import token2022Response from "../../fixtures/solana/t22-response.json" with { type: "json" };
import dexscreenerPairs from "../../fixtures/solana/dexscreener-tokens-v1.json" with { type: "json" };
import malformedFixture from "../../fixtures/solana/malformed-amount-account.json" with { type: "json" };

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockReadTokensPairs = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
}));

const mockKhalaniScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args),
}));

const mockJupiterTokensByMint = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: (...args: unknown[]) => mockJupiterTokensByMint(...args),
}));

// The real cache reads a file in the user's config directory; a suite must not
// depend on the developer's machine.
const mockGetCachedSolanaToken = vi.fn();
const mockCacheSolanaTokens = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: (...args: unknown[]) => mockGetCachedSolanaToken(...args),
  cacheSolanaTokens: (...args: unknown[]) => mockCacheSolanaTokens(...args),
}));

const mockReplaceBalancesForChain = vi.fn();
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...args: unknown[]) => mockReplaceBalancesForChain(...args),
}));

const { syncSolanaWalletBalances } = await import("../../../vex-agent/sync/solana-balance-sync.js");
const { SOLANA_SYNTHETIC_CHAIN_ID } = await import("../../../constants/solana-chain.js");

const WALLET = "BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg";
const LAMPORTS = 96_740_111;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JLP = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JUPUSD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const UNPRICED_MINT = "2dnH9aPEtnJ2PcGvCUqmGH8xq4PZzwZJrBf6aiDJJ5eC";
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Fixtures are read through a schema, never asserted through a cast. */
const probeAccountSchema = z.object({
  pubkey: z.string(),
  account: z.object({ data: z.unknown() }),
});
type ProbeAccount = z.infer<typeof probeAccountSchema>;
const probeResponseSchema = z.object({ result: z.object({ value: z.array(probeAccountSchema) }) });
const singleAccountFixtureSchema = z.object({ account: probeAccountSchema });

function accountsOf(response: unknown): ProbeAccount[] {
  return probeResponseSchema.parse(response).result.value;
}

function rpcValue(accounts: readonly ProbeAccount[]): {
  value: ReadonlyArray<{ pubkey: PublicKey; account: { data: unknown } }>;
} {
  return {
    value: accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      account: { data: account.account.data },
    })),
  };
}

interface RpcScript {
  lamports?: () => Promise<number>;
  spl?: () => Promise<ReadonlyArray<ProbeAccount>>;
  token2022?: () => Promise<ReadonlyArray<ProbeAccount>>;
}

function scriptedRpc(script: RpcScript = {}): SolanaBalanceRpc {
  return {
    getBalance: script.lamports ?? (() => Promise.resolve(LAMPORTS)),
    async getParsedTokenAccountsByOwner(_owner, filter) {
      const program = filter.programId.toBase58();
      if (program === SPL_PROGRAM) {
        return rpcValue(await (script.spl ?? (() => Promise.resolve(accountsOf(splResponse))))());
      }
      if (program === TOKEN_2022_PROGRAM) {
        return rpcValue(
          await (script.token2022 ?? (() => Promise.resolve(accountsOf(token2022Response))))(),
        );
      }
      throw new Error(`unexpected program filter ${program}`);
    },
  };
}

function writtenRows(): BalanceRow[] {
  const call = mockReplaceBalancesForChain.mock.calls[0];
  if (!call) throw new Error("replaceBalancesForChain was not called");
  return call[2] as BalanceRow[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReplaceBalancesForChain.mockImplementation((_address: string, _chainId: number, rows: BalanceRow[]) =>
    Promise.resolve(rows.length),
  );
  mockReadTokensPairs.mockResolvedValue(dexscreenerPairs);
  mockJupiterTokensByMint.mockResolvedValue([]);
  mockGetCachedSolanaToken.mockReturnValue(undefined);
  mockKhalaniScan.mockResolvedValue({ tokens: [] });
});

describe("syncSolanaWalletBalances", () => {
  it("writes the native row plus one row per non-zero mint, priced by our own DexScreener read", async () => {
    const result = await syncSolanaWalletBalances(WALLET, { rpc: scriptedRpc() });

    expect(result).toEqual({ chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 9, skipped: false });
    const rows = writtenRows();
    expect(mockReplaceBalancesForChain).toHaveBeenCalledWith(WALLET, SOLANA_SYNTHETIC_CHAIN_ID, rows);
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.walletFamily === "solana")).toBe(true);
    expect(rows.every((row) => row.chainId === SOLANA_SYNTHETIC_CHAIN_ID)).toBe(true);

    const byAddress = new Map(rows.map((row) => [row.tokenAddress, row]));
    expect(byAddress.get(SOL_MINT)).toMatchObject({
      balanceRaw: "96740111",
      decimals: 9,
      tokenSymbol: "SOL",
      priceUsd: 96.076,
    });
    expect(byAddress.get(JLP)).toMatchObject({ balanceRaw: "1110870", decimals: 6, priceUsd: 4.28 });
    expect(byAddress.get(JUPUSD)?.priceUsd).toBe(0.9997);
    // USDC is priced from the QUOTE side of the 25.2M SOL/USDC pool
    // (96.076 / 96.0766), which is deeper than its own 1.1M base-side pool -
    // the deepest venue wins regardless of which side matched.
    expect(byAddress.get(USDC)?.priceUsd).toBeCloseTo(0.99999, 5);

    // Every mint is stored with base58 case intact - the DB predicate has no LOWER().
    expect([...byAddress.keys()].every((address) => address === address.trim())).toBe(true);
    expect(byAddress.has(USDC.toLowerCase())).toBe(false);

    const totalUsd = rows.reduce((sum, row) => sum + (row.balanceUsd ?? 0), 0);
    expect(totalUsd).toBeCloseTo(15.93, 2);
    expect(rows.filter((row) => row.balanceUsd === null)).toHaveLength(5);
  });

  it("keeps an unpriced non-zero holding as a row instead of dropping it", async () => {
    await syncSolanaWalletBalances(WALLET, { rpc: scriptedRpc() });
    const row = writtenRows().find((candidate) => candidate.tokenAddress === UNPRICED_MINT);
    expect(row).toMatchObject({ balanceRaw: "478930624197716", decimals: 9, priceUsd: null, balanceUsd: null });
  });

  it("writes rows with null prices when DexScreener throws, and never drops a holding", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    const result = await syncSolanaWalletBalances(WALLET, { rpc: scriptedRpc() });
    expect(result.skipped).toBe(false);
    const rows = writtenRows();
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.priceUsd === null && row.balanceUsd === null)).toBe(true);
  });

  it("falls back to the Khalani price map for a mint DexScreener did not price", async () => {
    mockKhalaniScan.mockResolvedValue({
      tokens: [
        { address: UNPRICED_MINT, chainId: SOLANA_SYNTHETIC_CHAIN_ID, name: "n", symbol: "s", decimals: 9, extensions: { price: { usd: "0.00002" }, balance: "999" } },
      ],
    });
    await syncSolanaWalletBalances(WALLET, { rpc: scriptedRpc() });
    const rows = writtenRows();
    const row = rows.find((candidate) => candidate.tokenAddress === UNPRICED_MINT);
    expect(row?.priceUsd).toBe(0.00002);
    // The Khalani leg is a PRICE map only: its own balance never becomes a row.
    expect(row?.balanceRaw).toBe("478930624197716");
    expect(rows).toHaveLength(9);
  });

  it("writes NOTHING when getBalance fails (last-good rows survive)", async () => {
    const result = await syncSolanaWalletBalances(WALLET, {
      rpc: scriptedRpc({ lamports: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8899")) }),
    });
    expect(result).toEqual({ chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true });
    expect(mockReplaceBalancesForChain).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the Token-2022 read fails while the classic read succeeded", async () => {
    const result = await syncSolanaWalletBalances(WALLET, {
      rpc: scriptedRpc({ token2022: () => Promise.reject(new Error("upstream 503")) }),
    });
    expect(result).toEqual({ chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true });
    // Writing the survivors would DELETE every Token-2022 holding.
    expect(mockReplaceBalancesForChain).not.toHaveBeenCalled();
  });

  it("writes NOTHING when a single account fails to parse", async () => {
    const malformed = singleAccountFixtureSchema.parse(malformedFixture).account;
    const result = await syncSolanaWalletBalances(WALLET, {
      rpc: scriptedRpc({ spl: () => Promise.resolve([...accountsOf(splResponse), malformed]) }),
    });
    expect(result).toEqual({ chainId: SOLANA_SYNTHETIC_CHAIN_ID, tokensUpdated: 0, skipped: true });
    expect(mockReplaceBalancesForChain).not.toHaveBeenCalled();
  });

  it("folds a wSOL token account into the native row instead of colliding on the primary key", async () => {
    const wsolAccount: ProbeAccount = {
      pubkey: "9WSo1TokenAccountFixturePubkey1111111111111",
      account: {
        data: {
          parsed: {
            type: "account",
            info: {
              mint: SOL_MINT,
              owner: WALLET,
              state: "initialized",
              tokenAmount: { amount: "1000000000", decimals: 9 },
            },
          },
        },
      },
    };
    await syncSolanaWalletBalances(WALLET, {
      rpc: scriptedRpc({ spl: () => Promise.resolve([...accountsOf(splResponse), wsolAccount]) }),
    });
    const rows = writtenRows();
    const solRows = rows.filter((row) => row.tokenAddress === SOL_MINT);
    expect(solRows).toHaveLength(1);
    expect(solRows[0]).toMatchObject({ balanceRaw: "1096740111" });
    expect(new Set(rows.map((row) => row.tokenAddress)).size).toBe(rows.length);
  });

  it("propagates a DB write failure instead of reporting a skipped chain", async () => {
    mockReplaceBalancesForChain.mockRejectedValue(new Error("relation proj_balances does not exist"));
    await expect(syncSolanaWalletBalances(WALLET, { rpc: scriptedRpc() })).rejects.toThrow(
      "relation proj_balances does not exist",
    );
  });
});
