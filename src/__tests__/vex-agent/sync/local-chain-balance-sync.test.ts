import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPublicClient, http, type Chain, type PublicClient, type Transport } from "viem";
import { mainnet } from "viem/chains";

type EvmClientModule = typeof import("@tools/evm-chains/evm-client.js");

// ── Mocks ───────────────────────────────────────────────────────
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// S11a: local-chain valuation reads through the `price-read` seam, not the old
// REST client. `readTokensPairs` keeps the same (chain, comma-separated
// addresses) call shape, so the fixtures below are unchanged.
const mockGetTokens = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...a: unknown[]) => mockGetTokens(...a),
}));

// A real viem public client with the two RPC-backed actions this suite drives
// replaced. `Object.assign` keeps the full `PublicClient` type, so the mock
// factory below satisfies `getLocalPublicClient`'s contract without a cast.
const baseClient: PublicClient<Transport, Chain> = createPublicClient({
  chain: mainnet,
  transport: http("http://127.0.0.1:1"),
});
const fakeClient = Object.assign(baseClient, {
  multicall: vi.fn(),
  getBalance: vi.fn(),
});
const mockGetLocalPublicClient = vi.fn<EvmClientModule["getLocalPublicClient"]>(() => fakeClient);
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: (...args: Parameters<EvmClientModule["getLocalPublicClient"]>) => mockGetLocalPublicClient(...args),
}));

const mockTracked = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  getTrackedTokenAddressesForChain: (...a: unknown[]) => mockTracked(...a),
}));

const mockReplace = vi.fn().mockResolvedValue(0);
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplace(...a),
}));

const { syncLocalChainForWallet, resetLocalChainMetadataCache } = await import(
  "../../../vex-agent/sync/local-chain-balance-sync.js"
);

// ── Fixtures ────────────────────────────────────────────────────
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".toLowerCase();
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const SEED = {
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  VEX: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
  VIRTUAL: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};
const NEW_TOKEN = "0x1111111111111111111111111111111111111111";

const DECIMALS: Record<string, number> = {
  [SEED.WETH.toLowerCase()]: 18,
  [SEED.VEX.toLowerCase()]: 18,
  [SEED.VIRTUAL.toLowerCase()]: 18,
  [SEED.USDG.toLowerCase()]: 6,
  [NEW_TOKEN.toLowerCase()]: 18,
};
const SYMBOLS: Record<string, string> = {
  [SEED.WETH.toLowerCase()]: "WETH",
  [SEED.VEX.toLowerCase()]: "VEX",
  [SEED.VIRTUAL.toLowerCase()]: "VIRTUAL",
  [SEED.USDG.toLowerCase()]: "USDG",
  [NEW_TOKEN.toLowerCase()]: "NEW",
};
// Non-zero: VEX (1e18), NEW (2e18). Zero: WETH/VIRTUAL/USDG.
const BALANCES: Record<string, bigint> = {
  [SEED.WETH.toLowerCase()]: 0n,
  [SEED.VEX.toLowerCase()]: 1_000000000000000000n,
  [SEED.VIRTUAL.toLowerCase()]: 0n,
  [SEED.USDG.toLowerCase()]: 0n,
  [NEW_TOKEN.toLowerCase()]: 2_000000000000000000n,
};

function defaultMulticall({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) {
  return Promise.resolve(
    contracts.map((c) => {
      const addr = c.address.toLowerCase();
      if (c.functionName === "decimals") return { status: "success", result: DECIMALS[addr] };
      if (c.functionName === "symbol") return { status: "success", result: SYMBOLS[addr] };
      if (c.functionName === "balanceOf") return { status: "success", result: BALANCES[addr] };
      return { status: "failure", error: new Error("unexpected") };
    }),
  );
}

function balanceOfMulticallContracts(): Array<{ address: string }> | undefined {
  const call = fakeClient.multicall.mock.calls
    .map((c) => (c[0] as { contracts: Array<{ address: string; functionName: string }> }).contracts)
    .find((cs) => cs.length > 0 && cs.every((c) => c.functionName === "balanceOf"));
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalChainMetadataCache();
  mockReplace.mockResolvedValue(3);
  fakeClient.multicall.mockImplementation(defaultMulticall as never);
  fakeClient.getBalance.mockResolvedValue(500000000000000000n); // 0.5 ETH
  // DexScreener — LIVE robinhood index shape (verified 2026-07-06): WETH
  // appears ONLY as a QUOTE token, so its USD price must derive as
  // priceUsd/priceNative (1.5 / 0.0005 = $3000). VEX is priced base-side.
  // NEW has no pair (priceless).
  mockGetTokens.mockResolvedValue([
    { chainId: "robinhood", baseToken: { address: SEED.VIRTUAL }, quoteToken: { address: SEED.WETH }, priceUsd: "1.5", priceNative: "0.0005", liquidity: { usd: 1_000_000 } },
    { chainId: "robinhood", baseToken: { address: SEED.VEX }, quoteToken: { address: SEED.VIRTUAL }, priceUsd: "0.5", priceNative: "0.3333", liquidity: { usd: 50_000 } },
  ]);
  mockTracked.mockResolvedValue([]);
});

describe("syncLocalChainForWallet", () => {
  it("scans seed ∪ pinned tokens, de-duping pins against the seed set", async () => {
    // Pins return VEX again (lowercase dup) plus a genuinely new token.
    mockTracked.mockResolvedValue([SEED.VEX.toLowerCase(), NEW_TOKEN]);

    await syncLocalChainForWallet("eip155", WALLET, 4663);

    // Wallet-scoped + chain-scoped pinned-token read (tracked_tokens table).
    expect(mockTracked).toHaveBeenCalledWith(WALLET, 4663);

    // Distinct balanceOf set = 4 seed + 1 new = 5 (VEX not duplicated).
    const balContracts = balanceOfMulticallContracts();
    expect(balContracts).toBeDefined();
    const queried = new Set(balContracts!.map((c) => c.address.toLowerCase()));
    expect(queried.size).toBe(5);
    expect(queried.has(NEW_TOKEN.toLowerCase())).toBe(true);
  });

  it("writes native + priced + priceless rows and drops zero balances", async () => {
    mockTracked.mockResolvedValue([NEW_TOKEN]);

    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);
    expect(res.skipped).toBe(false);

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [addr, chainId, rows] = mockReplace.mock.calls[0] as [string, number, Array<Record<string, unknown>>];
    expect(addr).toBe(WALLET);
    expect(chainId).toBe(4663);

    const byAddr = new Map(rows.map((r) => [String(r.tokenAddress).toLowerCase(), r]));
    // Native ETH priced off WETH (0.5 * 3000 = 1500).
    const nativeRow = byAddr.get(NATIVE)!;
    expect(nativeRow).toBeDefined();
    expect(nativeRow.tokenSymbol).toBe("ETH");
    expect(nativeRow.balanceUsd).toBeCloseTo(1500);
    // VEX priced (1 * 0.5).
    const vexRow = byAddr.get(SEED.VEX.toLowerCase())!;
    expect(vexRow.balanceUsd).toBeCloseTo(0.5);
    // NEW: priceless but RETAINED with null USD (never dropped).
    const newRow = byAddr.get(NEW_TOKEN.toLowerCase())!;
    expect(newRow.priceUsd).toBeNull();
    expect(newRow.balanceUsd).toBeNull();
    // Zero-balance seed tokens are NOT written.
    expect(byAddr.has(SEED.WETH.toLowerCase())).toBe(false);
    expect(byAddr.has(SEED.USDG.toLowerCase())).toBe(false);
    // native + VEX + NEW = 3 rows.
    expect(rows).toHaveLength(3);
  });

  it("drops malformed tracked addresses (untrusted DB rows)", async () => {
    mockTracked.mockResolvedValue(["USDC", NEW_TOKEN]); // "USDC" is not a hex address

    await syncLocalChainForWallet("eip155", WALLET, 4663);

    const queried = new Set(balanceOfMulticallContracts()!.map((c) => c.address.toLowerCase()));
    expect(queried.size).toBe(5); // 4 seed + NEW; the symbol string is dropped
  });

  it("is fail-soft: an RPC failure returns 0 and NEVER writes (no cache wipe)", async () => {
    fakeClient.multicall.mockRejectedValue(new Error("RPC down"));

    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);
    expect(res.skipped).toBe(true);
    expect(res.tokensUpdated).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ── DB failures PROPAGATE (Codex final-review required fix) ────
  // Fail-soft is for on-chain/RPC/transport faults only. DB faults must fail
  // the sync run visibly so the worker retries per existing semantics.
  it("PROPAGATES a tracked-tokens DB read failure (never masked as skipped)", async () => {
    mockTracked.mockRejectedValue(new Error("db read down"));

    await expect(syncLocalChainForWallet("eip155", WALLET, 4663)).rejects.toThrow("db read down");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("PROPAGATES a replaceBalancesForChain write failure (never masked as skipped)", async () => {
    mockReplace.mockRejectedValue(new Error("db write down"));

    await expect(syncLocalChainForWallet("eip155", WALLET, 4663)).rejects.toThrow("db write down");
    // The write was attempted — the RPC phase completed normally first.
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("prices wrapped-native from the QUOTE side, picking the deepest pool", async () => {
    // WETH as quote token in TWO pools — the deeper pool's derived price wins.
    mockGetTokens.mockResolvedValue([
      { chainId: "robinhood", baseToken: { address: SEED.VIRTUAL }, quoteToken: { address: SEED.WETH }, priceUsd: "1.5", priceNative: "0.0005", liquidity: { usd: 10_000 } }, // → $3000
      { chainId: "robinhood", baseToken: { address: SEED.USDG }, quoteToken: { address: SEED.WETH }, priceUsd: "1.0", priceNative: "0.00035", liquidity: { usd: 200_000 } }, // → ~$2857.14
    ]);

    await syncLocalChainForWallet("eip155", WALLET, 4663);
    const [, , rows] = mockReplace.mock.calls[0] as [string, number, Array<Record<string, unknown>>];
    const nativeRow = rows.find((r) => String(r.tokenAddress).toLowerCase() === NATIVE)!;
    expect(nativeRow.priceUsd).toBeCloseTo(1.0 / 0.00035, 2);
    expect(nativeRow.balanceUsd).toBeCloseTo(0.5 / 0.00035, 2);
  });

  it("keeps tokens when DexScreener has no data for the chain (all priceless, still written)", async () => {
    mockGetTokens.mockResolvedValue([]); // e.g. slug not indexed
    mockTracked.mockResolvedValue([NEW_TOKEN]);

    await syncLocalChainForWallet("eip155", WALLET, 4663);
    const [, , rows] = mockReplace.mock.calls[0] as [string, number, Array<Record<string, unknown>>];
    // Native (0.5 ETH) + VEX (1) + NEW (2) all present; all USD null.
    expect(rows.every((r) => r.balanceUsd === null)).toBe(true);
    expect(rows.length).toBe(3);
  });

  it("still writes even if DexScreener throws (fail-soft pricing)", async () => {
    mockGetTokens.mockRejectedValue(new Error("dex down"));
    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);
    expect(res.skipped).toBe(false);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  // ── A4: a partial read must never REPLACE a complete snapshot ──
  //
  // `multicall({ allowFailure: true })` answers per contract, so one token's
  // read can fail while the rest succeed. That partial set used to flow
  // straight into `replaceBalancesForChain`, which replaces the WHOLE chain:
  // a transient per-token RPC failure silently DELETED a previously valid
  // balance row, and the agent then read the deletion as "you hold none".
  it("SKIPS the whole-chain replacement when one token's balanceOf read failed", async () => {
    fakeClient.multicall.mockImplementation((args: { contracts: Array<{ address: string; functionName: string }> }) =>
      Promise.resolve(
        args.contracts.map((c) => {
          const addr = c.address.toLowerCase();
          if (c.functionName === "balanceOf") {
            return addr === SEED.VEX.toLowerCase()
              ? { status: "failure", error: new Error("execution reverted") }
              : { status: "success", result: BALANCES[addr] };
          }
          if (c.functionName === "decimals") return { status: "success", result: DECIMALS[addr] };
          return { status: "success", result: SYMBOLS[addr] };
        }),
      ),
    );

    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);

    expect(res.skipped).toBe(true);
    expect(res.tokensUpdated).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("SKIPS the replacement when a HELD token's metadata read failed", async () => {
    fakeClient.multicall.mockImplementation((args: { contracts: Array<{ address: string; functionName: string }> }) =>
      Promise.resolve(
        args.contracts.map((c) => {
          const addr = c.address.toLowerCase();
          if (c.functionName === "balanceOf") return { status: "success", result: BALANCES[addr] };
          // VEX has a non-zero balance, so losing its decimals loses a real row.
          if (addr === SEED.VEX.toLowerCase()) return { status: "failure", error: new Error("no decimals()") };
          if (c.functionName === "decimals") return { status: "success", result: DECIMALS[addr] };
          return { status: "success", result: SYMBOLS[addr] };
        }),
      ),
    );

    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);

    expect(res.skipped).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("still replaces normally when every required read succeeded", async () => {
    const res = await syncLocalChainForWallet("eip155", WALLET, 4663);

    expect(res.skipped).toBe(false);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("skips non-EVM families and unknown chains without any RPC call", async () => {
    const solResult = await syncLocalChainForWallet("solana", WALLET, 4663);
    expect(solResult.skipped).toBe(true);

    const unknownResult = await syncLocalChainForWallet("eip155", WALLET, 999999);
    expect(unknownResult.skipped).toBe(true);

    expect(mockGetLocalPublicClient).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
