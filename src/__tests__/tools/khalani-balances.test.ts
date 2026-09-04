import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAINS = [
  { id: 1, name: "Ethereum", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  { id: 8453, name: "Base", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  { id: 20011000000, name: "Solana", type: "solana" as const, nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 } },
];

const mockGetChains = vi.fn().mockResolvedValue(CHAINS);

// `KhalaniClient.getTokenBalances` returns the STRICT balances response
// (`{ tokens, rejectedEntries }`). Tests script the ENTRIES through
// `mockTokenEntries`; a plain array means "these tokens, nothing refused", and a
// full response object is passed through so a test can script rejections.
const mockTokenEntries = vi.fn().mockResolvedValue([]);
const mockGetTokenBalances = vi.fn(async (address: string, chainIds?: number[]) => {
  const scripted = await mockTokenEntries(address, chainIds);
  return Array.isArray(scripted) ? { tokens: scripted, rejectedEntries: [] } : scripted;
});

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getChains: mockGetChains,
    getTokenBalances: mockGetTokenBalances,
  }),
}));

// The EVM native top-up calls createDynamicPublicClient(...).getBalance().
// Mock the viem public client so these tests never touch a real RPC.
const mockGetBalance = vi.fn();

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: () => ({ getBalance: mockGetBalance }),
}));

const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const {
  getSelectedChainIdsForFamily,
  getTokenBalancesAcrossChains,
  parseBalanceChainSelection,
} = await import("../../tools/khalani/balances.js");
const { clearKhalaniChainsCache } = await import("../../tools/khalani/chains.js");

describe("Khalani balance scanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearKhalaniChainsCache();
    mockGetChains.mockResolvedValue(CHAINS);
    mockTokenEntries.mockReset();
    mockTokenEntries.mockResolvedValue([]);
    // Default: no native balance. Individual native-coverage tests override.
    mockGetBalance.mockReset();
    mockGetBalance.mockResolvedValue(0n);
  });

  it("resolves aliases into family-specific chain selections", async () => {
    const selection = await parseBalanceChainSelection("ethereum,base,solana");

    expect(getSelectedChainIdsForFamily(selection, "eip155")).toEqual([1, 8453]);
    expect(getSelectedChainIdsForFamily(selection, "solana")).toEqual([20011000000]);
  });

  it("scans explicit EVM chains as individual Khalani balance calls", async () => {
    mockTokenEntries.mockImplementation(async (_address: string, chainIds?: number[]) => {
      if (chainIds?.[0] === 1) {
        return [
          { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
        ];
      }
      if (chainIds?.[0] === 8453) {
        return [
          { chainId: 8453, address: "0xWETH", symbol: "WETH", name: "Wrapped Ether", decimals: 18, extensions: { balance: "1000000000000000000", price: { usd: "3000.0" } } },
        ];
      }
      return [];
    });

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1, 8453],
    });

    expect(mockGetTokenBalances).toHaveBeenCalledWith("0xWallet", [1]);
    expect(mockGetTokenBalances).toHaveBeenCalledWith("0xWallet", [8453]);
    expect(scan.scannedChainIds).toEqual([1, 8453]);
    expect(scan.tokens.map((token) => token.symbol)).toEqual(["WETH", "USDC"]);
    expect(scan.totalUsd).toBe(3001);
  });

  it("returns partial chain errors without dropping successful balances", async () => {
    mockTokenEntries.mockImplementation(async (_address: string, chainIds?: number[]) => {
      if (chainIds?.[0] === 8453) throw new Error("upstream timeout");
      return [
        { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
      ];
    });

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1, 8453],
    });

    expect(scan.tokens).toHaveLength(1);
    expect(scan.scannedChainIds).toEqual([1]);
    expect(scan.chainErrors).toEqual([
      { chainId: 8453, chainName: "Base", message: "upstream timeout" },
    ]);
  });

  // ── EVM native-balance coverage (Stage 4) ──────────────────────────

  it("adds a synthetic native entry for an EVM chain with a positive balance", async () => {
    mockTokenEntries.mockResolvedValue([]); // no ERC-20s
    mockGetBalance.mockResolvedValue(2_500000000000000000n); // 2.5 ETH

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(mockGetBalance).toHaveBeenCalledWith({ address: "0xWallet" });
    expect(scan.scannedChainIds).toEqual([1]);
    expect(scan.tokens).toHaveLength(1);
    const native = scan.tokens[0];
    expect(native.address).toBe(NATIVE_SENTINEL);
    expect(native.chainId).toBe(1);
    expect(native.symbol).toBe("ETH");
    expect(native.name).toBe("Ether");
    expect(native.decimals).toBe(18);
    expect(native.extensions?.balance).toBe("2500000000000000000");
    // USD is omitted (best-effort, no extra round-trip) → contributes 0 to total.
    expect(native.extensions?.price).toBeUndefined();
    expect(scan.totalUsd).toBe(0);
  });

  it("skips a native entry when the balance is zero", async () => {
    mockTokenEntries.mockResolvedValue([]);
    mockGetBalance.mockResolvedValue(0n);

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(scan.scannedChainIds).toEqual([1]);
    expect(scan.tokens).toHaveLength(0);
    expect(scan.chainErrors).toEqual([]);
  });

  it("does not double-add native when Khalani already returned a native entry", async () => {
    mockTokenEntries.mockResolvedValue([
      { chainId: 1, address: NATIVE_SENTINEL, symbol: "ETH", name: "Ether", decimals: 18, extensions: { balance: "1000000000000000000", price: { usd: "3000.0" } } },
    ]);
    mockGetBalance.mockResolvedValue(9_000000000000000000n); // would be added if not deduped

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    const ethEntries = scan.tokens.filter((token) => token.symbol === "ETH");
    expect(ethEntries).toHaveLength(1);
    expect(ethEntries[0]?.extensions?.balance).toBe("1000000000000000000");
  });

  it("native-RPC failure records a chainError and does NOT fail the read (token balances still returned)", async () => {
    mockTokenEntries.mockResolvedValue([
      { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
    ]);
    mockGetBalance.mockRejectedValue(new Error("HTTP 429 rate limited"));

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    // Token balances survive the native failure; chain still counts as scanned.
    expect(scan.scannedChainIds).toEqual([1]);
    expect(scan.tokens.map((token) => token.symbol)).toEqual(["USDC"]);
    expect(scan.chainErrors).toHaveLength(1);
    expect(scan.chainErrors[0]?.chainId).toBe(1);
    // Bounded, safe class — never the raw provider message.
    expect(scan.chainErrors[0]?.message).toBe("native balance: rate limited");
  });

  it("does not fetch native balances for the Solana family", async () => {
    mockTokenEntries.mockResolvedValue([
      { chainId: 20011000000, address: "So111", symbol: "SOL", name: "Solana", decimals: 9, extensions: { balance: "2000000000", price: { usd: "100.0" } } },
    ]);

    const scan = await getTokenBalancesAcrossChains({
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      family: "solana",
      chainIds: [20011000000],
      includeNative: true,
    });

    expect(mockGetBalance).not.toHaveBeenCalled();
    expect(scan.tokens.map((token) => token.symbol)).toEqual(["SOL"]);
  });

  // ── Sync-path regression: native top-up MUST be opt-in ─────────────
  //
  // syncWalletBalances() calls getTokenBalancesAcrossChains WITHOUT includeNative
  // and then full-replaces proj_balances per chain. If the native top-up ran on
  // that path, a transient RPC failure (or a fresh synthetic row) could add/lose
  // a native row from the replace set. Assert the default path returns ZERO
  // synthetic native rows even though the native RPC mock would return a positive
  // balance.
  it("does NOT add a synthetic native entry on the default (sync) path", async () => {
    mockTokenEntries.mockResolvedValue([
      { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
    ]);
    mockGetBalance.mockResolvedValue(5_000000000000000000n); // 5 ETH — would be added IF native ran

    // No includeNative → exactly how syncWalletBalances calls it.
    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
    });

    // Native RPC is never even consulted on the sync path.
    expect(mockGetBalance).not.toHaveBeenCalled();
    // Only the Khalani ERC-20 row survives; no synthetic native row, so a
    // proj_balances replace can neither gain nor lose a native row from the top-up.
    expect(scan.tokens.map((token) => token.symbol)).toEqual(["USDC"]);
    expect(scan.tokens.some((token) => token.address.toLowerCase() === NATIVE_SENTINEL.toLowerCase())).toBe(false);
    expect(scan.chainErrors).toEqual([]);
    expect(scan.scannedChainIds).toEqual([1]);
  });

  // ── Native error sanitization: no raw provider text leaks ──────────
  it("sanitizes native RPC errors to a bounded safe class (no raw HTML/URL/apiKey leak)", async () => {
    const RAW =
      '<!doctype html><html><body>Upstream 500 at https://rpc.secret-provider.io/v3/' +
      'mainnet?apiKey=sk_live_DEADBEEF1234567890&trace=abc viem@2.21.0</body></html>';
    mockTokenEntries.mockResolvedValue([]); // isolate the native error
    mockGetBalance.mockRejectedValue(new Error(RAW));

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(scan.chainErrors).toHaveLength(1);
    const message = scan.chainErrors[0]?.message ?? "";

    // Exactly one of the four safe classes.
    expect([
      "native balance: rate limited",
      "native balance: timeout",
      "native balance: missing RPC",
      "native balance: unavailable",
    ]).toContain(message);
    // This particular payload has no rate/timeout/rpc keyword → default class.
    expect(message).toBe("native balance: unavailable");

    // NONE of the raw provider text survives.
    expect(message).not.toContain("<!doctype");
    expect(message).not.toContain("html");
    expect(message).not.toContain("https://");
    expect(message).not.toContain("rpc.secret-provider.io");
    expect(message).not.toContain("apiKey");
    expect(message).not.toContain("sk_live");
    expect(message).not.toContain("viem");
    expect(message).not.toContain("500");
  });

  it("classifies a viem-style 429 (status field) as rate limited", async () => {
    mockTokenEntries.mockResolvedValue([]);
    // Mimic a viem HttpRequestError carrying a numeric status, no rate keyword in
    // the human message — classification must use the status, not substring luck.
    mockGetBalance.mockRejectedValue(
      Object.assign(new Error("request failed at https://rpc.example/v1?apiKey=secret"), {
        status: 429,
        name: "HttpRequestError",
      }),
    );

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(scan.chainErrors[0]?.message).toBe("native balance: rate limited");
    expect(scan.chainErrors[0]?.message).not.toContain("apiKey");
  });

  it("classifies a timeout error as timeout", async () => {
    mockTokenEntries.mockResolvedValue([]);
    mockGetBalance.mockRejectedValue(
      Object.assign(new Error("The request took too long to respond and timed out."), {
        name: "TimeoutError",
      }),
    );

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(scan.chainErrors[0]?.message).toBe("native balance: timeout");
  });

  it("classifies a missing-RPC VexError (KHALANI_UNSUPPORTED_CHAIN) as missing RPC", async () => {
    mockTokenEntries.mockResolvedValue([]);
    // getChainRpcUrl throws a VexError with this code when a chain has no RPC URL.
    // The classifier keys off the structured `code`, not the human message.
    mockGetBalance.mockRejectedValue(
      Object.assign(new Error("Chain 1 does not expose an RPC URL in Khalani metadata."), {
        name: "VexError",
        code: "KHALANI_UNSUPPORTED_CHAIN",
      }),
    );

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
      includeNative: true,
    });

    expect(scan.chainErrors[0]?.message).toBe("native balance: missing RPC");
  });
});
