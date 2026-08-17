import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveChainSlug,
  chainIdToSlug,
  slugToChainId,
  getChainFeatures,
  chainSupportsFeature,
  getKyberChains,
  setCachedDynamicChains,
  getCachedDynamicChains,
  clearDynamicChainsCache,
} from "@tools/kyberswap/chains.js";
import { VexError } from "../../errors.js";

describe("resolveChainSlug", () => {
  it("accepts exact slug", () => {
    expect(resolveChainSlug("ethereum")).toBe("ethereum");
    expect(resolveChainSlug("arbitrum")).toBe("arbitrum");
    expect(resolveChainSlug("base")).toBe("base");
    expect(resolveChainSlug("megaeth")).toBe("megaeth");
    expect(resolveChainSlug("robinhood")).toBe("robinhood");
  });

  it("resolves aliases", () => {
    expect(resolveChainSlug("eth")).toBe("ethereum");
    expect(resolveChainSlug("arb")).toBe("arbitrum");
    expect(resolveChainSlug("poly")).toBe("polygon");
    expect(resolveChainSlug("matic")).toBe("polygon");
    expect(resolveChainSlug("op")).toBe("optimism");
    expect(resolveChainSlug("avax")).toBe("avalanche");
    expect(resolveChainSlug("bera")).toBe("berachain");
  });

  it("is case-insensitive", () => {
    expect(resolveChainSlug("Ethereum")).toBe("ethereum");
    expect(resolveChainSlug("ARBITRUM")).toBe("arbitrum");
    expect(resolveChainSlug("ETH")).toBe("ethereum");
  });

  it("trims whitespace", () => {
    expect(resolveChainSlug("  eth  ")).toBe("ethereum");
    expect(resolveChainSlug(" base ")).toBe("base");
  });

  it("throws KYBER_UNSUPPORTED_CHAIN for unknown", () => {
    expect(() => resolveChainSlug("solana")).toThrow(VexError);
    expect(() => resolveChainSlug("solana")).toThrow(/Unsupported KyberSwap chain/);
    expect(() => resolveChainSlug("")).toThrow(VexError);
    expect(() => resolveChainSlug("unsupported-chain")).toThrow(VexError);
  });

  // Agent Scan (plan §4.2): Scroll/zkSync were ZaaS-only (aggregator: false).
  // Deleting zap tooling removed their only KyberSwap feature — dropped from
  // the registry entirely, not kept as dead aggregator-unsupported entries.
  it("no longer resolves the deleted ZaaS-only chains or their aliases", () => {
    expect(() => resolveChainSlug("scroll")).toThrow(VexError);
    expect(() => resolveChainSlug("zksync")).toThrow(VexError);
    expect(() => resolveChainSlug("zk")).toThrow(VexError);
    expect(() => resolveChainSlug("era")).toThrow(VexError);
  });
});

describe("chainIdToSlug", () => {
  it("returns slug for known IDs", () => {
    expect(chainIdToSlug(1)).toBe("ethereum");
    expect(chainIdToSlug(56)).toBe("bsc");
    expect(chainIdToSlug(42161)).toBe("arbitrum");
    expect(chainIdToSlug(8453)).toBe("base");
    expect(chainIdToSlug(4326)).toBe("megaeth");
    expect(chainIdToSlug(4663)).toBe("robinhood");
  });

  it("returns undefined for unknown IDs", () => {
    expect(chainIdToSlug(999999)).toBeUndefined();
    expect(chainIdToSlug(999998)).toBeUndefined();
  });

  it("returns undefined for the deleted ZaaS-only chain IDs (534352, 324)", () => {
    expect(chainIdToSlug(534352)).toBeUndefined();
    expect(chainIdToSlug(324)).toBeUndefined();
  });
});

describe("slugToChainId", () => {
  it("returns chain ID for known slugs", () => {
    expect(slugToChainId("ethereum")).toBe(1);
    expect(slugToChainId("bsc")).toBe(56);
    expect(slugToChainId("polygon")).toBe(137);
    expect(slugToChainId("base")).toBe(8453);
    expect(slugToChainId("robinhood")).toBe(4663);
  });

  it("throws for unknown slug", () => {
    expect(() => slugToChainId("unknown" as any)).toThrow(VexError);
  });
});

describe("getChainFeatures", () => {
  it("returns aggregator=true for Ethereum", () => {
    const f = getChainFeatures("ethereum");
    expect(f.aggregator).toBe(true);
  });

  it("returns aggregator=true for Mantle", () => {
    const f = getChainFeatures("mantle");
    expect(f.aggregator).toBe(true);
  });

  it("returns aggregator=true for MegaETH", () => {
    const f = getChainFeatures("megaeth");
    expect(f.aggregator).toBe(true);
  });

  it("returns aggregator=true for Robinhood (provisional)", () => {
    const f = getChainFeatures("robinhood");
    expect(f.chainId).toBe(4663);
    expect(f.aggregator).toBe(true);
  });

  it("throws for unknown slug", () => {
    expect(() => getChainFeatures("unknown" as any)).toThrow(VexError);
  });
});

describe("chainSupportsFeature", () => {
  it("returns true for aggregator-enabled chains", () => {
    expect(chainSupportsFeature("ethereum", "aggregator")).toBe(true);
    expect(chainSupportsFeature("arbitrum", "aggregator")).toBe(true);
    expect(chainSupportsFeature("robinhood", "aggregator")).toBe(true);
  });
});

describe("getKyberChains", () => {
  it("returns 18 chains (Scroll/zkSync/Etherlink dropped)", () => {
    const chains = getKyberChains();
    expect(chains).toHaveLength(18);
  });

  it("each chain has required fields", () => {
    for (const chain of getKyberChains()) {
      expect(chain.slug).toBeTruthy();
      expect(chain.chainId).toBeGreaterThan(0);
      expect(chain.name).toBeTruthy();
      expect(typeof chain.aggregator).toBe("boolean");
    }
  });

  it("every chain is aggregator-enabled (the only surviving feature)", () => {
    const aggregatorChains = getKyberChains().filter((c) => c.aggregator);
    expect(aggregatorChains.length).toBe(18);
  });

  it("no chain slug is the deleted Scroll/zkSync entry", () => {
    const slugs = getKyberChains().map((c) => c.slug);
    expect(slugs).not.toContain("scroll");
    expect(slugs).not.toContain("zksync");
  });

  // Owner decision 2026-08-17: a swap venue with zero bridge reach is removed.
  it("no chain slug or id is the deleted Etherlink entry", () => {
    expect(getKyberChains().map((c) => c.slug)).not.toContain("etherlink");
    expect(getKyberChains().map((c) => c.chainId)).not.toContain(42793);
    expect(() => resolveChainSlug("etherlink")).toThrow();
    expect(() => resolveChainSlug("42793")).toThrow();
  });
});

describe("dynamic chain cache", () => {
  beforeEach(() => {
    clearDynamicChainsCache();
  });

  it("returns null when cache is empty", () => {
    expect(getCachedDynamicChains()).toBeNull();
  });

  it("returns chains after set", () => {
    const chains = [{ chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" as const }];
    setCachedDynamicChains(chains);
    expect(getCachedDynamicChains()).toEqual(chains);
  });

  it("returns null after clear", () => {
    setCachedDynamicChains([{ chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" as const }]);
    clearDynamicChainsCache();
    expect(getCachedDynamicChains()).toBeNull();
  });

  it("expires after TTL", () => {
    const chains = [{ chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" as const }];
    setCachedDynamicChains(chains);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60 * 1000); // 61 minutes
    expect(getCachedDynamicChains()).toBeNull();

    vi.restoreAllMocks();
  });
});
