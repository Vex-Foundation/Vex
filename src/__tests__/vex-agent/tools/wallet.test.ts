/**
 * WalletBalances tests.
 *
 * Puzzle 5 phase 4: `WalletSendPrepare` / `WalletSendConfirm` are
 * covered by `src/__tests__/vex-agent/tools/internal/wallet/send.test.ts`
 * (orchestrator + ExecuteOutcome paths) +
 * `src/__tests__/vex-agent/db/repos/wallet-intents.test.ts` (repo CAS
 * shapes). Send tests cannot run from this file anymore because the
 * Map-based intent store was replaced by the DB-backed `wallet_intents`
 * table; the comprehensive coverage now mocks `walletIntentsRepo` +
 * executor modules directly.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@tools/wallet/multi-auth.js", () => ({
  requireEvmWallet: () => ({ family: "eip155", address: "0x1234567890abcdef1234567890abcdef12345678", privateKey: "0x" + "ab".repeat(32) }),
  requireSolanaWallet: () => ({ family: "solana", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", secretKey: new Uint8Array(64) }),
}));

// Phase 5B: WalletBalances resolves the address via the engine read resolver
// (resolveSelectedAddressForRead — a genuine READ; mission setup may read its own
// wallet). Mock it to return the test wallet addresses for the session's default
// resolution.
vi.mock("../../../vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: (_r: unknown, _p: unknown, family: string) =>
    family === "solana"
      ? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
      : "0x1234567890abcdef1234567890abcdef12345678",
}));

vi.mock("@tools/wallet/family.js", () => ({
  normalizeWalletChain: (input?: string) => {
    if (!input || input === "eip155" || input === "evm") return "eip155";
    if (input === "solana" || input === "sol") return "solana";
    throw new Error(`Unsupported wallet chain: ${input}`);
  },
}));

const MOCK_CHAIN = {
  id: 1, name: "Ethereum", type: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://ethereum.example.com"] } },
};
const MOCK_SOLANA_CHAIN = {
  id: 20011000000, name: "Solana", type: "solana" as const,
  nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["https://api.mainnet-beta.solana.com"] } },
};

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getTokenBalances: async (_address: string, chainIds?: number[]) => {
      const chainId = chainIds?.[0] ?? 1;
      if (chainId === 20011000000) {
        return [
          { address: "So11111111111111111111111111111111111111112", chainId, symbol: "SOL", name: "Solana", decimals: 9, extensions: { balance: "2000000000", price: { usd: "100.00" } } },
        ];
      }
      return [
        { address: "native", chainId, symbol: "ETH", name: "Ether", decimals: 18, extensions: { balance: "5000000000000000000", price: { usd: "3000.00" } } },
        { address: "0xUSDC", chainId, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
        // No `price` extension → projector omits priceUsd. Held-USD value of this
        // row is 0, so it must sort LAST in the concise top-N trim (null-safe).
        { address: "0xNOPRICE", chainId, symbol: "NOPX", name: "No Price Token", decimals: 18, extensions: { balance: "1000000000000000000" } },
      ];
    },
    getChains: async () => [MOCK_CHAIN, MOCK_SOLANA_CHAIN],
  }),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  resolveChainId: () => 1,
  getChain: () => MOCK_CHAIN,
  getCachedKhalaniChains: async () => [MOCK_CHAIN, MOCK_SOLANA_CHAIN],
}));

// The EVM native top-up calls createDynamicPublicClient(...).getBalance().
// The mocked Khalani response above already returns an ETH entry on chain 1, so
// the native top-up dedupes and never calls getBalance — but mock the public
// client anyway so this suite can never reach a real RPC.
const mockGetBalance = vi.fn().mockResolvedValue(0n);

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: () => ({ getBalance: mockGetBalance }),
}));

// The Solana family is read DIRECT FROM RPC, not through Khalani (the mocked
// Khalani client above answers a SOL row that this tool deliberately no longer
// consults for balances). The provider boundaries under that reader are
// scripted so this suite can never reach a real endpoint.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: async () => [
    {
      chainId: "solana",
      baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Solana" },
      quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
      priceUsd: "150",
      liquidity: { usd: 5_000_000 },
    },
  ],
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: async () => [],
}));
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: () => undefined,
  cacheSolanaTokens: () => undefined,
}));

const { handleWalletBalances: handleWalletBalancesRaw } = await import(
  "../../../vex-agent/tools/internal/wallet.js"
);
const { readSolanaWalletSnapshot } = await import(
  "@tools/solana-ecosystem/balances/wallet-snapshot.js"
);
import { makeTestContext } from "./_test-context.js";

/**
 * A wallet holding 3 SOL and nothing else, served through the reader's own RPC
 * seam. The REAL snapshot service and the REAL projector run over it.
 */
const SOLANA_DEPENDENCIES = {
  readSolanaSnapshot: (address: string, options?: { signal?: AbortSignal }) =>
    readSolanaWalletSnapshot(address, {
      signal: options?.signal,
      rpc: {
        getBalance: async () => 3_000_000_000,
        getParsedTokenAccountsByOwner: async () => ({ value: [] }),
      },
    }),
};

/** Every call in this suite goes through the same scripted Solana seam. */
function handleWalletBalances(
  params: Record<string, unknown>,
  context: ReturnType<typeof makeTestContext>,
) {
  return handleWalletBalancesRaw(params, context, SOLANA_DEPENDENCIES);
}

const baseContext = makeTestContext();

describe("WalletBalances", () => {
  // ── live snapshots ─────────────────────────────────────────────

  it("returns live snapshots for all configured wallets by default", async () => {
    const result = await handleWalletBalances({}, baseContext);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.walletFamily).toBe("all");
    expect(data.wallets).toHaveLength(2);
    expect(data.wallets.map((wallet: { wallet: string }) => wallet.wallet)).toEqual(["eip155", "solana"]);
    expect(data.totalUsd).toBeGreaterThan(0);
  });

  // Empty/whitespace `chainIds` is normalized to "scan all chains". Some
  // serializers and many LLM providers emit `""` for "no value" — the handler
  // must treat that as omission, not a validation error.
  it("treats empty chainIds string as omission (scans all chains)", async () => {
    const omitted = await handleWalletBalances({ walletFamily: "all" }, baseContext);
    const empty = await handleWalletBalances({ walletFamily: "all", chainIds: "" }, baseContext);
    expect(empty.success).toBe(true);
    expect(omitted.success).toBe(true);
    const omittedData = JSON.parse(omitted.output);
    const emptyData = JSON.parse(empty.output);
    expect(emptyData.wallets).toHaveLength(omittedData.wallets.length);
    expect(emptyData.wallets.map((w: { wallet: string }) => w.wallet)).toEqual(
      omittedData.wallets.map((w: { wallet: string }) => w.wallet),
    );
  });

  it("treats whitespace-only chainIds as omission", async () => {
    const result = await handleWalletBalances({ walletFamily: "all", chainIds: "   " }, baseContext);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.wallets).toHaveLength(2);
  });

  it("returns EVM snapshot when wallet=eip155", async () => {
    const result = await handleWalletBalances({ walletFamily: "eip155" }, baseContext);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.wallets).toHaveLength(1);
    expect(data.wallets[0].wallet).toBe("eip155");
    expect(data.wallets[0].address).toMatch(/^0x/);
    expect(data.wallets[0].tokens.length).toBeGreaterThan(0);
  });

  // CONTRACT CHANGE (2026-08-28): this arm used to assert only that a snapshot
  // came back with an address, which is exactly why it stayed green while the
  // tool answered `tokenCount: 0, totalUsd: 0` for a funded wallet. It now
  // asserts tokens and totals like its EVM siblings above.
  it("returns Solana snapshot with tokens and totals when wallet=solana", async () => {
    const result = await handleWalletBalances({ walletFamily: "solana" }, baseContext);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.wallets).toHaveLength(1);
    expect(data.wallets[0].wallet).toBe("solana");
    expect(data.wallets[0].address).toBeTruthy();
    expect(data.wallets[0].tokenCount).toBe(1);
    // 3 SOL at $150, read direct from RPC and priced by our own DexScreener read.
    expect(data.wallets[0].totalUsd).toBeCloseTo(450, 6);
    expect(data.wallets[0].tokens[0]).toMatchObject({
      symbol: "SOL",
      address: "So11111111111111111111111111111111111111112",
      decimals: 9,
      balanceRaw: "3000000000",
      // The human amount travels BESIDE the raw one so the model never divides.
      balance: "3",
      valueUsd: "450",
    });
    expect(data.wallets[0].scannedChainIds).toEqual([20011000000]);
  });

  it("snapshot includes token data with prices", async () => {
    const result = await handleWalletBalances({ walletFamily: "eip155" }, baseContext);
    const data = JSON.parse(result.output);
    const tokens = data.wallets[0].tokens;
    expect(tokens.map((token: { symbol: string }) => token.symbol)).toContain("ETH");
    const eth = tokens.find((token: {
      symbol: string;
      priceUsd?: string;
    }) => token.symbol === "ETH");
    expect(eth?.priceUsd).toBe("3000.00");
  });

  // ── concise + limit trim (P1-7) ────────────────────────────────
  // The EVM mock returns 3 tokens: ETH (~15000 held USD), USDC (~100),
  // NOPX (no price → 0 held USD). `trimTokens` only trims when
  // response_format is 'concise' AND a positive limit is supplied.
  //
  // NOPX holds a real balance with no price feed. Since 2026-08-11 the limit
  // applies to PRICED rows only and such a row is always retained (flagged
  // `priceUnavailable`), so "no price feed" can never read as "not held".

  it("concise + limit=1 trims priced rows to the highest held-USD token (ETH), keeping the unpriced holding", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise", limit: 1 },
      baseContext,
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    const tokens = data.wallets[0].tokens;
    expect(tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["ETH", "NOPX"]);
    expect(tokens[1].priceUnavailable).toBe(true);
    // tokenCount/totalUsd are computed off the FULL scan — a trim must not
    // distort the held totals.
    expect(data.wallets[0].tokenCount).toBe(3);
  });

  it("concise + limit greater than token count returns all tokens", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise", limit: 99 },
      baseContext,
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.wallets[0].tokens).toHaveLength(3);
  });

  it("concise + limit is null-safe for a token with no priceUsd (sinks to the bottom, retained, no throw)", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise", limit: 2 },
      baseContext,
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    const tokens = data.wallets[0].tokens;
    // Top 2 priced rows by held USD = ETH then USDC; the price-less NOPX row
    // sorts last and is kept outside the limit, marked, proving the sort never
    // threw on a missing price and that a holding is never silently hidden.
    expect(tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["ETH", "USDC", "NOPX"]);
    expect(tokens[2].priceUnavailable).toBe(true);
    expect(tokens[2].priceUsd).toBeNull();
    // Never a zero: zero as "I do not know" is a one-way door.
    expect(tokens[2].valueUsd).toBeNull();
  });

  it("default (no limit / detailed) returns all tokens unchanged", async () => {
    const detailedDefault = await handleWalletBalances({ walletFamily: "eip155" }, baseContext);
    const conciseNoLimit = await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise" },
      baseContext,
    );
    expect(detailedDefault.success).toBe(true);
    expect(conciseNoLimit.success).toBe(true);
    // Detailed default returns every projected row, in upstream order.
    const detailedTokens = JSON.parse(detailedDefault.output).wallets[0].tokens;
    expect(detailedTokens.map((t: { symbol: string }) => t.symbol)).toEqual(["ETH", "USDC", "NOPX"]);
    // Concise WITHOUT a limit is also untouched (trim needs both knobs).
    const conciseTokens = JSON.parse(conciseNoLimit.output).wallets[0].tokens;
    expect(conciseTokens).toHaveLength(3);
  });

  // ── errors ─────────────────────────────────────────────────────

  it("fails on invalid wallet parameter", async () => {
    const result = await handleWalletBalances({ walletFamily: "bitcoin" }, baseContext);
    expect(result.success).toBe(false);
    expect(result.output).toContain("WalletBalances");
  });
});
