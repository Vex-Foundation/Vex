/**
 * The three Solana shaping rules, pinned ONCE.
 *
 * They used to live only inside `vex-agent/sync/solana-balance-sync.ts`, which
 * is why the agent tools (`WalletBalances`, `khalani__token_balances_get`) read
 * Solana through Khalani's zero-token scan and reported `$0` for a funded
 * wallet the sidebar showed correctly. This suite is the contract every lane
 * now maps from, so a change to any of the three rules is visible here first.
 */

import { describe, it, expect, vi } from "vitest";

import type { SolanaWalletBalancesRead } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
// The provider boundaries are the ONLY modules mocked; everything between the
// scripted RPC bytes and the canonical rows is the real code path.
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokensPairs: async () => [] }));
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: async () => ({ tokens: [] }),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: async () => [],
}));
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: () => undefined,
  cacheSolanaTokens: () => undefined,
}));

const { projectSolanaBalanceRows, readSolanaWalletSnapshot } = await import(
  "@tools/solana-ecosystem/balances/wallet-snapshot.js"
);

const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function makeRead(overrides: Partial<SolanaWalletBalancesRead> = {}): SolanaWalletBalancesRead {
  return {
    lamports: "0",
    solPriceUsd: null,
    tokens: [],
    accountFailures: [],
    stats: {
      accountsScanned: 0,
      zeroSkipped: 0,
      frozenAccounts: 0,
      metadataMissing: 0,
      unpriced: 0,
      priceTiers: { tier0: 0, tier1: 0, unpriced: 0 },
    },
    ...overrides,
  };
}

function makeHolding(overrides: Partial<SolanaWalletBalancesRead["tokens"][number]> = {}) {
  return {
    mint: BONK_MINT,
    amountRaw: "1000000",
    decimals: 5,
    frozen: false,
    accountCount: 1,
    symbol: "BONK",
    name: "Bonk",
    priceUsd: 2,
    ...overrides,
  };
}

describe("projectSolanaBalanceRows - the three shaping rules", () => {
  it("rule 1: native SOL is emitted under the wSOL mint, first, with 9 decimals", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({ lamports: "2500000000", solPriceUsd: 200, tokens: [makeHolding()] }),
    );

    expect(rows[0]).toEqual({
      mint: SOL_MINT,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      amountRaw: "2500000000",
      priceUsd: 200,
      usdValue: 500,
      isNative: true,
    });
    expect(rows[1]?.mint).toBe(BONK_MINT);
    expect(rows[1]?.isNative).toBe(false);
    expect(rows[1]?.usdValue).toBe(20);
  });

  it("rule 2: zero lamports produce NO native row", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({ lamports: "0", solPriceUsd: 200, tokens: [makeHolding()] }),
    );

    expect(rows.map((row) => row.mint)).toEqual([BONK_MINT]);
  });

  it("rule 2 covers SPL rows too: a zero-amount holding produces NO row", () => {
    // Rule 2 says ZERO is skipped, without qualification. The reader drops zero
    // accounts upstream, but this projector OWNS the rule, so a zero holding
    // handed to it directly must not become a row that would read to an agent
    // as a position the wallet does not hold.
    const rows = projectSolanaBalanceRows(
      makeRead({
        lamports: "2500000000",
        solPriceUsd: 200,
        tokens: [makeHolding({ amountRaw: "0" })],
      }),
    );

    expect(rows.map((row) => row.mint)).toEqual([SOL_MINT]);
    expect(rows.every((row) => BigInt(row.amountRaw) > 0n)).toBe(true);
  });

  it("rule 3: a wSOL token account is FOLDED into the native row, not emitted beside it", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({
        lamports: "1000000000",
        solPriceUsd: 100,
        tokens: [
          makeHolding({ mint: SOL_MINT, amountRaw: "500000000", decimals: 9, symbol: "wSOL", name: "Wrapped SOL", priceUsd: 100 }),
          makeHolding(),
        ],
      }),
    );

    // ONE SOL_MINT row: 1.0 native + 0.5 wrapped, valued as 1.5 SOL.
    expect(rows.filter((row) => row.mint === SOL_MINT)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mint: SOL_MINT,
      symbol: "SOL",
      amountRaw: "1500000000",
      usdValue: 150,
      isNative: true,
    });
    expect(rows.map((row) => row.mint)).toEqual([SOL_MINT, BONK_MINT]);
  });

  it("rule 3, the wSOL-ONLY case: with zero lamports the wSOL account keeps its own ordinary row", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({
        lamports: "0",
        solPriceUsd: 100,
        tokens: [
          makeHolding({ mint: SOL_MINT, amountRaw: "500000000", decimals: 9, symbol: "wSOL", name: "Wrapped SOL", priceUsd: 100 }),
        ],
      }),
    );

    expect(rows).toEqual([
      {
        mint: SOL_MINT,
        symbol: "wSOL",
        name: "Wrapped SOL",
        decimals: 9,
        amountRaw: "500000000",
        priceUsd: 100,
        usdValue: 50,
        isNative: false,
      },
    ]);
  });

  it("keeps an unlabelled, unpriced holding rather than inventing a symbol or dropping it", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({
        lamports: "0",
        tokens: [makeHolding({ symbol: null, name: null, priceUsd: null })],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBeNull();
    expect(rows[0]?.name).toBeNull();
    // The mint is NEVER substituted as a label.
    expect(rows[0]?.mint).toBe(BONK_MINT);
    expect(rows[0]?.usdValue).toBeNull();
  });

  it("an INCOMPLETE read still yields the native row: an empty snapshot would read as 'you hold nothing'", () => {
    const rows = projectSolanaBalanceRows(
      makeRead({
        lamports: "1000000000",
        solPriceUsd: null,
        tokens: [],
        accountFailures: [{ pubkey: "AccountPubkey1111111111111111111111111111111", reason: "schema-parse-failed" }],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.isNative).toBe(true);
    expect(rows[0]?.usdValue).toBeNull();
  });
});

describe("readSolanaWalletSnapshot", () => {
  it("sums totalUsd over priced rows and treats an unpriced holding as 0, never null", async () => {
    const snapshot = await readSolanaWalletSnapshot(
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      {
        rpc: {
          getBalance: async () => 1_000_000_000,
          getParsedTokenAccountsByOwner: async () => ({ value: [] }),
        },
      },
    );

    expect(snapshot.rows.map((row) => row.mint)).toEqual([SOL_MINT]);
    expect(snapshot.totalUsd).toBe(0);
    expect(snapshot.accountFailures).toEqual([]);
  });
});
