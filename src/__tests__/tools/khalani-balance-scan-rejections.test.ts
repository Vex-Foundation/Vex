/**
 * `getTokenBalancesAcrossChains` over the STRICT wallet-balances boundary.
 *
 * The scan is where a per-entry rejection either keeps its per-chain
 * attribution or gets lost in the aggregate, so the contract here is:
 *
 * - a refused entry costs its own row and NOTHING else on that chain;
 * - the refusal travels with the chain it came from;
 * - a structural provider defect is still a CHAIN failure, recorded in
 *   `chainErrors` with the chain left out of `scannedChainIds`.
 *
 * The client is faked at its public method (`getTokenBalances`) but the REAL
 * validator runs behind it, so these tests drive the same parse the live client
 * performs on provider bytes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAINS = [
  { id: 1, name: "Ethereum", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  { id: 8453, name: "Base", type: "eip155" as const, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
];

const mockGetChains = vi.fn().mockResolvedValue(CHAINS);
/** Raw provider entries per chain id - the real validator parses them. */
const mockRawEntries = vi.fn<(chainId: number) => unknown[]>();

vi.mock("@tools/khalani/client.js", async () => {
  const { validateTokenBalancesResponse } = await import("@tools/khalani/validation.js");
  return {
    getKhalaniClient: () => ({
      getChains: mockGetChains,
      getTokenBalances: async (_address: string, chainIds?: number[]) =>
        validateTokenBalancesResponse(mockRawEntries(chainIds?.[0] ?? 1)),
    }),
  };
});

const { getTokenBalancesAcrossChains } = await import("@tools/khalani/balances.js");
const { clearKhalaniChainsCache } = await import("@tools/khalani/chains.js");

function token(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    address: "0xUSDC",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    extensions: { balance: "100000000", price: { usd: "1.00" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearKhalaniChainsCache();
  mockGetChains.mockResolvedValue(CHAINS);
  mockRawEntries.mockReturnValue([]);
});

describe("khalani balance scan: one hostile token does not blank a chain", () => {
  it("keeps the chain's valid rows and reports the refused entry with its amount", async () => {
    mockRawEntries.mockImplementation((chainId) =>
      chainId === 1
        ? [
            token({ address: "0xUSDC", symbol: "USDC", decimals: 6 }),
            token({
              address: "0xGIFT",
              symbol: "GIFT",
              name: "Airdropped Gift",
              // The airdrop payload: a scale nothing can convert from.
              decimals: 1e21,
              extensions: { balance: "424242" },
            }),
            token({
              address: "0xWETH",
              symbol: "WETH",
              name: "Wrapped Ether",
              decimals: 18,
              extensions: { balance: "1000000000000000000", price: { usd: "2.00" } },
            }),
          ]
        : [],
    );

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
    });

    expect(scan.tokens.map((entry) => entry.symbol)).toEqual(["USDC", "WETH"]);
    expect(scan.scannedChainIds).toEqual([1]);
    expect(scan.chainErrors).toEqual([]);
    expect(scan.rejectedEntries).toEqual([
      {
        entryIndex: 1,
        chainId: 1,
        address: "0xGIFT",
        name: "Airdropped Gift",
        symbol: "GIFT",
        balanceRaw: "424242",
        reason: "token_decimals_invalid",
      },
    ]);
  });

  it("keeps per-chain attribution when several chains refuse entries", async () => {
    mockRawEntries.mockImplementation((chainId) => [
      token({ chainId, address: "0xOK", symbol: "OK", decimals: 6 }),
      token({
        chainId,
        address: chainId === 1 ? "0xBAD1" : "0xBAD8453",
        symbol: "BAD",
        decimals: "18",
        extensions: { balance: String(chainId) },
      }),
    ]);

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1, 8453],
    });

    expect(scan.tokens).toHaveLength(2);
    expect(
      (scan.rejectedEntries ?? []).map((entry) => [entry.chainId, entry.address, entry.balanceRaw]),
    ).toEqual([
      [1, "0xBAD1", "1"],
      [8453, "0xBAD8453", "8453"],
    ]);
  });

  it("reports an empty rejection list when the provider is clean", async () => {
    mockRawEntries.mockReturnValue([token({})]);

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1],
    });

    expect(scan.rejectedEntries).toEqual([]);
  });

  it("reports an empty rejection list when no chain matches the selection", async () => {
    mockGetChains.mockResolvedValue([]);

    const scan = await getTokenBalancesAcrossChains({ address: "0xWallet", family: "solana" });

    expect(scan.rejectedEntries).toEqual([]);
    expect(scan.tokens).toEqual([]);
  });
});

describe("khalani balance scan: a structural defect is still a chain failure", () => {
  it("records the chain error, leaves the chain unscanned, and keeps the sibling chain", async () => {
    mockRawEntries.mockImplementation((chainId) =>
      chainId === 1
        ? // No readable address: identity is gone, so there is nothing to attach
          // an amount to and the chain's answer cannot be trusted at all.
          [token({ address: 42, symbol: "MALFORMED" })]
        : [token({ chainId: 8453, address: "0xBASEOK", symbol: "OK", decimals: 6 })],
    );

    const scan = await getTokenBalancesAcrossChains({
      address: "0xWallet",
      family: "eip155",
      chainIds: [1, 8453],
    });

    expect(scan.scannedChainIds).toEqual([8453]);
    expect(scan.tokens.map((entry) => entry.symbol)).toEqual(["OK"]);
    expect(scan.rejectedEntries).toEqual([]);
    expect(scan.chainErrors).toEqual([
      {
        chainId: 1,
        chainName: "Ethereum",
        message: "Invalid Khalani response: missing token.address",
      },
    ]);
  });
});
