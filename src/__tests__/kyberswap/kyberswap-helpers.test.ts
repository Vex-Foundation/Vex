import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveChain, resolveChainWithId, requireFeature } from "@tools/kyberswap/helpers.js";
import { VexError, ErrorCodes } from "../../errors.js";

// Mock on-chain reads for resolveTokenMetadata address path
vi.mock("../../tools/kyberswap/evm-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../tools/kyberswap/evm-utils.js")>();
  return {
    ...original,
    readErc20Metadata: vi.fn().mockResolvedValue({
      address: "0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed",
      symbol: "axlUSDC",
      name: "Axelar Wrapped USDC",
      decimals: 6,
      isNative: false,
    }),
  };
});

// Mock Token API for symbol path
vi.mock("../../tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn()
      .mockImplementation((_chainIds: string, opts?: { name?: string; isWhitelisted?: boolean }) => {
        const name = opts?.name?.toLowerCase() ?? "";
        // Whitelisted search: USDC found, axlUSDC not found
        if (opts?.isWhitelisted === true) {
          if (name === "usdc") return Promise.resolve([{ address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "USD Coin", decimals: 6 }]);
          return Promise.resolve([]);
        }
        // Broader search: axlUSDC found
        if (name === "axlusdc") return Promise.resolve([{ address: "0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed", symbol: "axlUSDC", name: "Axelar Wrapped USDC", decimals: 6 }]);
        if (name === "usdc") return Promise.resolve([{ address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "USD Coin", decimals: 6 }]);
        return Promise.resolve([]);
      }),
  }),
}));

describe("resolveChain", () => {
  it("resolves slug", () => {
    expect(resolveChain("ethereum")).toBe("ethereum");
    expect(resolveChain("eth")).toBe("ethereum");
  });
});

describe("resolveChainWithId", () => {
  it("returns slug and chainId", () => {
    const result = resolveChainWithId("eth");
    expect(result.slug).toBe("ethereum");
    expect(result.chainId).toBe(1);
  });
});

describe("requireFeature", () => {
  it("does not throw for supported feature", () => {
    expect(() => requireFeature("ethereum", "aggregator")).not.toThrow();
    expect(() => requireFeature("ethereum", "zaas")).not.toThrow();
  });

  it("throws KYBER_UNSUPPORTED_CHAIN for unsupported feature", () => {
    expect(() => requireFeature("mantle", "zaas")).toThrow(VexError);
    expect(() => requireFeature("megaeth", "zaas")).toThrow(VexError);
  });

  it("gates Robinhood to aggregator only — limit order + zap are rejected", () => {
    expect(() => requireFeature("robinhood", "aggregator")).not.toThrow();
    expect(() => requireFeature("robinhood", "limitOrder")).toThrow(VexError);
    expect(() => requireFeature("robinhood", "zaas")).toThrow(VexError);
  });
});

// ── Token resolution (address path + symbol fallback) ──────────────

describe("resolveTokenMetadata — address path", () => {
  it("reads ERC-20 metadata on-chain for address input", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadata("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed", 137);
    expect(result.address).toBe("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed");
    expect(result.symbol).toBe("axlUSDC");
    expect(result.decimals).toBe(6);
    expect(result.isNative).toBe(false);
  });

  it("returns native metadata for 'native' input", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadata("native", 137);
    expect(result.isNative).toBe(true);
    expect(result.decimals).toBe(18);
  });

  it("returns native metadata for the native SENTINEL ADDRESS (not an ERC-20 read)", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    const { NATIVE_TOKEN_ADDRESS } = await import("@tools/kyberswap/constants.js");
    const { readErc20Metadata } = await import("../../tools/kyberswap/evm-utils.js");
    const mockRead = vi.mocked(readErc20Metadata);
    mockRead.mockClear();

    // Lowercased sentinel proves case-insensitive matching.
    const result = await resolveTokenMetadata(NATIVE_TOKEN_ADDRESS.toLowerCase(), 137);
    expect(result.isNative).toBe(true);
    expect(result.address).toBe(NATIVE_TOKEN_ADDRESS);
    expect(result.decimals).toBe(18);
    // Sentinel short-circuited BEFORE the ERC-20 metadata read.
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("resolveTokenMetadata — symbol path with fallback", () => {
  it("resolves USDC via whitelisted search (no fallback needed)", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadata("USDC", 137);
    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
  });

  it("resolves axlUSDC via fallback (whitelisted returns 0, broader finds it)", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadata("axlUSDC", 137);
    expect(result.symbol).toBe("axlUSDC");
    expect(result.address).toBe("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed");
  });

  it("throws for completely unknown symbol", async () => {
    const { resolveTokenMetadata } = await import("@tools/kyberswap/helpers.js");
    await expect(resolveTokenMetadata("NONEXISTENT_TOKEN_XYZ", 137)).rejects.toThrow();
  });
});

// ── resolveTokenMetadataStrict (address-only for mutations) ────────

describe("resolveTokenMetadataStrict", () => {
  it("rejects symbol input (not address)", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    await expect(resolveTokenMetadataStrict("USDC", 137)).rejects.toThrow(/not a valid address/);
  });

  it("rejects name input", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    await expect(resolveTokenMetadataStrict("USD Coin", 137)).rejects.toThrow(/not a valid address/);
  });

  it("accepts valid address", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadataStrict("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed", 137);
    expect(result.address).toBe("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed");
    expect(result.isNative).toBe(false);
  });

  it("accepts native token keywords", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadataStrict("native", 137);
    expect(result.isNative).toBe(true);
    expect(result.decimals).toBe(18);
  });

  it("accepts ETH keyword", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenMetadataStrict("eth", 1);
    expect(result.isNative).toBe(true);
  });

  it("resolves the native SENTINEL ADDRESS to native (does NOT throw, does NOT ERC-20 read)", async () => {
    const { resolveTokenMetadataStrict } = await import("@tools/kyberswap/helpers.js");
    const { NATIVE_TOKEN_ADDRESS } = await import("@tools/kyberswap/constants.js");
    const { readErc20Metadata } = await import("../../tools/kyberswap/evm-utils.js");
    const mockRead = vi.mocked(readErc20Metadata);
    mockRead.mockClear();

    const result = await resolveTokenMetadataStrict(NATIVE_TOKEN_ADDRESS, 1);
    expect(result.isNative).toBe(true);
    expect(result.address).toBe(NATIVE_TOKEN_ADDRESS);
    expect(result.decimals).toBe(18);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("resolveTokenAddress — symbol fallback", () => {
  it("resolves address for whitelisted symbol", async () => {
    const { resolveTokenAddress } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenAddress("USDC", 137);
    expect(result).toBe("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
  });

  it("resolves address for non-whitelisted symbol via fallback", async () => {
    const { resolveTokenAddress } = await import("@tools/kyberswap/helpers.js");
    const result = await resolveTokenAddress("axlUSDC", 137);
    expect(result).toBe("0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed");
  });
});
