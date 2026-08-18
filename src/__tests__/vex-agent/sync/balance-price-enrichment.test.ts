import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEvmPrices = vi.fn();
vi.mock("@tools/evm-chains/token-prices.js", () => ({
  fetchEvmTokenPricesByAddress: (...args: unknown[]) => mockEvmPrices(...args),
}));

const mockJupiterPrices = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prices/service.js", () => ({
  getJupiterPricesByMint: (...args: unknown[]) => mockJupiterPrices(...args),
}));

vi.mock("@utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { enrichKhalaniBalancePrices } = await import(
  "../../../vex-agent/sync/balance-price-enrichment.js"
);

const ETH_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_USDC = "0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48";
const SOL_MINT = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  vi.clearAllMocks();
  mockEvmPrices.mockResolvedValue(new Map());
  mockJupiterPrices.mockResolvedValue({});
});

describe("enrichKhalaniBalancePrices", () => {
  it("prices Ethereum native ETH through verified WETH and USDC by address", async () => {
    mockEvmPrices.mockResolvedValue(
      new Map([
        [ETH_WETH.toLowerCase(), 1_909],
        [ETH_USDC.toLowerCase(), 1],
      ]),
    );

    const result = await enrichKhalaniBalancePrices("eip155", [
      {
        chainId: 1,
        address: ETH_NATIVE,
        symbol: "ETH",
        name: "Ether",
        decimals: 18,
        extensions: { balance: "490600000000000" },
      },
      {
        chainId: 1,
        address: ETH_USDC,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        extensions: { balance: "2070000" },
      },
    ]);

    expect(mockEvmPrices).toHaveBeenCalledWith({
      chainSlug: "ethereum",
      tokenAddresses: [ETH_WETH, ETH_USDC],
    });
    expect(result[0]?.extensions?.price?.usd).toBe("1909");
    expect(result[1]?.extensions?.price?.usd).toBe("1");
    expect(result[0]?.extensions?.balance).toBe("490600000000000");
  });

  it("preserves a valid provider price and does not look it up again", async () => {
    const result = await enrichKhalaniBalancePrices("eip155", [
      {
        chainId: 1,
        address: ETH_USDC,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        extensions: { balance: "2070000", price: { usd: "0.998" } },
      },
    ]);

    expect(mockEvmPrices).not.toHaveBeenCalled();
    expect(result[0]?.extensions?.price?.usd).toBe("0.998");
  });

  it("uses Jupiter Price V3 for a Solana mint", async () => {
    mockJupiterPrices.mockResolvedValue({
      [SOL_MINT]: {
        createdAt: "2026-08-18T00:00:00Z",
        liquidity: 1,
        usdPrice: 185.5,
        blockId: null,
        decimals: 9,
        priceChange24h: null,
      },
    });

    const result = await enrichKhalaniBalancePrices("solana", [
      {
        chainId: 20_011_000_000,
        address: SOL_MINT,
        symbol: "SOL",
        name: "Wrapped SOL",
        decimals: 9,
        extensions: { balance: "1000000000" },
      },
    ]);

    expect(mockJupiterPrices).toHaveBeenCalledWith([SOL_MINT]);
    expect(result[0]?.extensions?.price?.usd).toBe("185.5");
  });

  it("keeps an unsupported or unpriced holding visible without fabricating a price", async () => {
    const result = await enrichKhalaniBalancePrices("eip155", [
      {
        chainId: 424_242,
        address: "0x1111111111111111111111111111111111111111",
        symbol: "UNKNOWN",
        name: "Unknown",
        decimals: 18,
        extensions: { balance: "1000000000000000000" },
      },
    ]);

    expect(mockEvmPrices).not.toHaveBeenCalled();
    expect(result[0]?.extensions?.price).toBeUndefined();
  });
});
