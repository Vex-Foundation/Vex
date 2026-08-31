/**
 * `khalani__token_balances_get` reads the SOLANA family direct from RPC.
 *
 * WHY THIS TOOL AND NOT JUST `WalletBalances`. C2 owns the documented
 * other-wallet read path: its `walletAddress` param reads an address that is
 * not the session's, and `WalletBalances` has no such parameter. Its own
 * description tells the model to use it to find a funded source asset before
 * quoting a bridge or a swap, so a blind Solana lane here is a wrong MONEY
 * decision, not just a wrong display. Khalani's Solana scan answers ZERO
 * tokens, so the tool would report "no funds on Solana" for a funded wallet.
 *
 * What must NOT move: the wallet contract (explicit `walletAddress`, the
 * session-scope mismatch), the chainIds filter behavior, and the eip155 family,
 * which stays Khalani-backed. This suite pins all of it.
 *
 * The handler under test is the REAL one; only the provider boundaries are
 * scripted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { SolanaBalanceRpc } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import { makeProtocolContext } from "../_test-context.js";

const SOLANA_CHAIN_ID = 20_011_000_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const UNLABELLED_MINT = "2dnH9aPEtnJ2PcGvCUqmGH8xq4PZzwZJrBf6aiDJJ5eC";
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SESSION_SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_SOLANA = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
const ACCOUNT_A = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const CHAINS = [
  { id: 1, name: "Ethereum", type: "eip155" as const },
  { id: SOLANA_CHAIN_ID, name: "Solana", type: "solana" as const },
];

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@tools/khalani/chains.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/khalani/chains.js")>();
  return { ...actual, getCachedKhalaniChains: async () => CHAINS };
});

/** The Khalani scan, watched: it must never answer a Solana BALANCE request. */
const mockKhalaniScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return { ...original, getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args) };
});

vi.mock("../../../../vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../vex-agent/tools/internal/wallet/resolve.js")
  >();
  return {
    ...actual,
    resolveSelectedAddress: (_r: unknown, _p: unknown, family: string) =>
      family === "solana" ? SESSION_SOLANA : "0x1234567890abcdef1234567890abcdef12345678",
  };
});

// Provider boundaries under the Solana reader.
const mockReadTokensPairs = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: async () => [],
}));
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: () => undefined,
  cacheSolanaTokens: () => undefined,
}));

const { handleTokenBalances } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);
const { readSolanaWalletSnapshot } = await import(
  "@tools/solana-ecosystem/balances/wallet-snapshot.js"
);
const { VexError, ErrorCodes } = await import("../../../../errors.js");

// ── Scripted RPC ────────────────────────────────────────────────

interface AccountScript {
  pubkey: string;
  mint: string;
  amount: string;
  decimals: number;
  malformed?: boolean;
}

function parsedAccount(owner: string, script: AccountScript) {
  return {
    pubkey: new PublicKey(script.pubkey),
    account: {
      data: script.malformed === true
        ? { parsed: { type: "account", info: { mint: script.mint } } }
        : {
            parsed: {
              type: "account",
              info: {
                mint: script.mint,
                owner,
                state: "initialized",
                tokenAmount: { amount: script.amount, decimals: script.decimals },
              },
            },
          },
    },
  };
}

function scriptedRpc(input: { lamports?: number; spl?: AccountScript[] } = {}): SolanaBalanceRpc {
  return {
    getBalance: async () => input.lamports ?? 4_000_000_000,
    async getParsedTokenAccountsByOwner(owner, filter) {
      const accounts = filter.programId.toBase58() === SPL_PROGRAM ? (input.spl ?? []) : [];
      return { value: accounts.map((script) => parsedAccount(owner.toBase58(), script)) };
    },
  };
}

/** The REAL snapshot service over a scripted RPC, recording the address asked for. */
function withRpc(rpc: SolanaBalanceRpc, seen?: string[]) {
  return {
    readSolanaSnapshot: (address: string, options?: { signal?: AbortSignal }) => {
      seen?.push(address);
      return readSolanaWalletSnapshot(address, { rpc, signal: options?.signal });
    },
  };
}

function pair(mint: string, priceUsd: string) {
  return {
    chainId: "solana",
    baseToken: { address: mint, symbol: "X", name: "X" },
    quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
    priceUsd,
    liquidity: { usd: 5_000_000 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "150")]);
  mockKhalaniScan.mockResolvedValue({
    address: "0x1234567890abcdef1234567890abcdef12345678",
    family: "eip155",
    tokens: [],
    scannedChainIds: [1],
    chainErrors: [],
    totalUsd: 0,
  });
});

/**
 * 32 deterministic bytes per index: any 32 bytes are a valid `PublicKey`, so
 * this mints as many distinct account addresses as a bound test needs without
 * hand-writing base58.
 */
function accountAt(index: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, byte) => (byte === 0 ? index + 1 : 9))).toBase58();
}

describe("khalani__token_balances_get - the solana family", () => {
  it("answers a funded Solana wallet from RPC instead of Khalani's zero-token scan", async () => {
    const result = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc({
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "500000", decimals: 5 }],
      })),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.address).toBe(SESSION_SOLANA);
    expect(data.wallet).toBe("solana");
    expect(data.count).toBe(2);
    // 4 SOL at $150.
    expect(data.totalUsd).toBeCloseTo(600, 6);
    expect(data.scannedChainIds).toEqual([SOLANA_CHAIN_ID]);
    expect(data.tokens[0]).toMatchObject({
      symbol: "SOL",
      name: "Solana",
      address: SOL_MINT,
      chainId: SOLANA_CHAIN_ID,
      decimals: 9,
      balance: "4000000000",
      priceUsd: "150",
    });
  });

  it("never asks Khalani for Solana BALANCES", async () => {
    await handleTokenBalances({ walletFamily: "solana" }, makeProtocolContext(), withRpc(scriptedRpc()));

    const solanaScans = mockKhalaniScan.mock.calls.filter(
      ([input]) => (input as { family?: string })?.family === "solana",
    );
    expect(solanaScans).toEqual([]);
  });

  it("keeps an unlabelled non-zero SPL holding with symbol and name honestly null", async () => {
    // The surviving row must come back PRICED, so enrichment is proven to run
    // on a partial read rather than being skipped along with the lost rows.
    mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "150"), pair(BONK_MINT, "0.5")]);
    const result = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc({
        lamports: 0,
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "42", decimals: 0 }],
      })),
    );

    const data = JSON.parse(result.output);
    expect(data.tokens).toHaveLength(1);
    expect(data.tokens[0].symbol).toBeNull();
    expect(data.tokens[0].name).toBeNull();
    expect(data.tokens[0].address).toBe(UNLABELLED_MINT);
    expect(data.tokens[0].balance).toBe("42");
  });

  it("surfaces an untrusted token account as an accountError and still returns the readable rows", async () => {
    const result = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc({
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1", decimals: 5, malformed: true }],
      })),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.tokens.length).toBeGreaterThanOrEqual(1);
    expect(data.accountErrors).toEqual([
      { chainId: SOLANA_CHAIN_ID, accountAddress: ACCOUNT_A, reason: "schema-parse-failed" },
    ]);
  });

  // ── the wallet contract, unchanged ──────────────────────────────

  it("reads an EXPLICIT non-session wallet under default resolution", async () => {
    const seen: string[] = [];
    const result = await handleTokenBalances(
      { walletFamily: "solana", walletAddress: OTHER_SOLANA },
      makeProtocolContext({ walletResolution: { source: "default" } }),
      withRpc(scriptedRpc(), seen),
    );

    expect(result.success).toBe(true);
    expect(seen).toEqual([OTHER_SOLANA]);
    expect(JSON.parse(result.output).address).toBe(OTHER_SOLANA);
  });

  it("still refuses an explicit address that is not the SESSION's selected wallet", async () => {
    let thrown: unknown;
    try {
      await handleTokenBalances(
        { walletFamily: "solana", walletAddress: OTHER_SOLANA },
        makeProtocolContext({
          walletResolution: {
            source: "session",
            evm: null,
            solana: { id: "sol-1", address: SESSION_SOLANA },
          },
        }),
        withRpc(scriptedRpc()),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VexError);
    if (thrown instanceof VexError) expect(thrown.code).toBe(ErrorCodes.WALLET_SCOPE_MISMATCH);
  });

  // ── the chainIds filter, unchanged ──────────────────────────────

  it("fails when an explicit chainIds filter keeps no solana chain", async () => {
    const result = await handleTokenBalances(
      { walletFamily: "solana", chainIds: "ethereum" },
      makeProtocolContext(),
      withRpc(scriptedRpc()),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("No solana chains matched");
  });

  it("scans when chainIds names solana explicitly, and when it is omitted", async () => {
    const explicit = await handleTokenBalances(
      { walletFamily: "solana", chainIds: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc()),
    );
    const omitted = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc()),
    );

    expect(explicit.success).toBe(true);
    expect(omitted.success).toBe(true);
    expect(JSON.parse(explicit.output).scannedChainIds).toEqual([SOLANA_CHAIN_ID]);
    expect(JSON.parse(omitted.output).scannedChainIds).toEqual([SOLANA_CHAIN_ID]);
  });

  // ── the eip155 family stays Khalani-backed ──────────────────────

  it("still answers the eip155 family from Khalani", async () => {
    mockKhalaniScan.mockResolvedValue({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      family: "eip155",
      tokens: [
        { address: "0xUSDC", chainId: 1, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
      ],
      scannedChainIds: [1],
      chainErrors: [],
      totalUsd: 100,
    });

    const result = await handleTokenBalances({ walletFamily: "eip155" }, makeProtocolContext());

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(mockKhalaniScan).toHaveBeenCalledTimes(1);
    expect(data.tokens).toEqual([
      { symbol: "USDC", name: "USD Coin", address: "0xUSDC", chainId: 1, decimals: 6, priceUsd: "1.00", balance: "100000000" },
    ]);
    // Present and empty, never absent: an absent field reads as "no answer".
    expect(data.accountErrors).toEqual([]);
  });

  it("an operator abort stays a cancellation and is not relabelled a provider failure", async () => {
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      await handleTokenBalances(
        { walletFamily: "solana" },
        makeProtocolContext({ abortSignal: controller.signal }),
        withRpc(scriptedRpc()),
      );
    } catch (error) {
      thrown = error;
    }

    // The signal's OWN reason escapes the handler; it is never turned into a
    // "Khalani read failed" result, and never into the reader's deadline error.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AbortError");
  });

  it("a PARTIAL read keeps the valid SPL row: a zero-lamport wallet does not lose it to a broken sibling account", async () => {
    // THE DECISIVE CASE, mirrored for this tool. See the same test in the
    // WalletBalances suite: with zero lamports there is no native row to mask
    // a discarded holding, so a dropped SPL row shows up as "you hold nothing"
    // on the very lane the model uses to find a funded source asset.
    //
    // The surviving row must also come back PRICED, which proves enrichment
    // still runs on a partial read instead of being skipped along with the
    // rows that were lost.
    mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "150"), pair(BONK_MINT, "0.5")]);
    const result = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc({
        lamports: 0,
        spl: [
          { pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1", decimals: 5, malformed: true },
          { pubkey: accountAt(1), mint: BONK_MINT, amount: "4000000", decimals: 5 },
        ],
      })),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    const bonk = data.tokens.find((row: { address: string }) => row.address === BONK_MINT);
    expect(bonk).toBeDefined();
    expect(bonk.balance).toBe("4000000");
    expect(data.accountErrors).toEqual([
      { chainId: SOLANA_CHAIN_ID, accountAddress: ACCOUNT_A, reason: "schema-parse-failed" },
    ]);
    expect(data.totalUsd).toBeGreaterThan(0);
  });

  it("bounds accountErrors at 20 and counts the rest in accountErrorsOmitted", async () => {
    const broken = Array.from({ length: 26 }, (_, index) => ({
      pubkey: accountAt(index),
      mint: UNLABELLED_MINT,
      amount: "1",
      decimals: 5,
      malformed: true,
    }));

    const result = await handleTokenBalances(
      { walletFamily: "solana" },
      makeProtocolContext(),
      withRpc(scriptedRpc({ spl: broken })),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.accountErrors).toHaveLength(20);
    expect(data.accountErrorsOmitted).toBe(6);
  });
});
