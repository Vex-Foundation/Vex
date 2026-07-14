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
    expect(resolveChainSlug("zk")).toBe("zksync");
    expect(resolveChainSlug("era")).toBe("zksync");
  });

  it("accepts ZaaS-only chain slugs", () => {
    expect(resolveChainSlug("scroll")).toBe("scroll");
    expect(resolveChainSlug("zksync")).toBe("zksync");
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
  it("returns all features for Ethereum", () => {
    const f = getChainFeatures("ethereum");
    expect(f.aggregator).toBe(true);
    expect(f.limitOrder).toBe(true);
    expect(f.zaas).toBe(true);
  });

  it("returns zaas=false for Mantle", () => {
    const f = getChainFeatures("mantle");
    expect(f.aggregator).toBe(true);
    expect(f.limitOrder).toBe(true);
    expect(f.zaas).toBe(false);
  });

  it("returns zaas=false for MegaETH", () => {
    const f = getChainFeatures("megaeth");
    expect(f.aggregator).toBe(true);
    expect(f.zaas).toBe(false);
  });

  it("returns aggregator-only for Robinhood (provisional; no limit order, no zap)", () => {
    const f = getChainFeatures("robinhood");
    expect(f.chainId).toBe(4663);
    expect(f.aggregator).toBe(true);
    expect(f.limitOrder).toBe(false);
    expect(f.zaas).toBe(false);
  });

  it("throws for unknown slug", () => {
    expect(() => getChainFeatures("unknown" as any)).toThrow(VexError);
  });
});

describe("chainSupportsFeature", () => {
  it("returns true for supported features", () => {
    expect(chainSupportsFeature("ethereum", "aggregator")).toBe(true);
    expect(chainSupportsFeature("ethereum", "zaas")).toBe(true);
    expect(chainSupportsFeature("arbitrum", "limitOrder")).toBe(true);
  });

  it("returns false for unsupported features", () => {
    expect(chainSupportsFeature("mantle", "zaas")).toBe(false);
    expect(chainSupportsFeature("megaeth", "zaas")).toBe(false);
    expect(chainSupportsFeature("scroll", "aggregator")).toBe(false);
    expect(chainSupportsFeature("zksync", "limitOrder")).toBe(false);
    // Robinhood is aggregator-only — limit order + zap are gated OFF.
    expect(chainSupportsFeature("robinhood", "aggregator")).toBe(true);
    expect(chainSupportsFeature("robinhood", "limitOrder")).toBe(false);
    expect(chainSupportsFeature("robinhood", "zaas")).toBe(false);
  });

  it("returns true for ZaaS-only chains' zaas feature", () => {
    expect(chainSupportsFeature("scroll", "zaas")).toBe(true);
    expect(chainSupportsFeature("zksync", "zaas")).toBe(true);
  });
});

describe("getKyberChains", () => {
  it("returns 21 chains", () => {
    const chains = getKyberChains();
    expect(chains).toHaveLength(21);
  });

  it("each chain has required fields", () => {
    for (const chain of getKyberChains()) {
      expect(chain.slug).toBeTruthy();
      expect(chain.chainId).toBeGreaterThan(0);
      expect(chain.name).toBeTruthy();
      expect(typeof chain.aggregator).toBe("boolean");
      expect(typeof chain.limitOrder).toBe("boolean");
      expect(typeof chain.zaas).toBe("boolean");
    }
  });

  it("aggregator-enabled chains have aggregator=true", () => {
    const aggregatorChains = getKyberChains().filter((c) => c.aggregator);
    expect(aggregatorChains.length).toBe(19);
  });

  it("ZaaS-only chains have aggregator=false and zaas=true", () => {
    const zaasOnly = getKyberChains().filter((c) => !c.aggregator && c.zaas);
    expect(zaasOnly.map((c) => c.slug).sort()).toEqual(["scroll", "zksync"]);
  });
});

describe("zaas catalog consistency", () => {
  it("every zaas:true chain has an entry in zap-dexes catalog", async () => {
    const { getSupportedZapChains } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
    const zaasChains = getKyberChains().filter(c => c.zaas).map(c => c.slug);
    const catalogChains = getSupportedZapChains();
    const missing = zaasChains.filter(slug => !catalogChains.includes(slug));
    expect(missing).toEqual([]);
  });

  it("every catalog entry has valid 5-axis position model", async () => {
    const { getSupportedZapChains, getZapDexConfig } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
    const validRefKinds = new Set(["tokenId", "ownerAddress", "erc1155TokenId", "opaqueRef"]);
    const validApprovalStandards = new Set(["erc721", "erc20", "erc1155", "none"]);
    const validApprovalTargets = new Set(["positionManager", "poolAddress", "vaultShare", "binManager", "lpToken", "none"]);
    const validCaptureKinds = new Set(["receiptNftMint", "receiptErc1155", "shareBalance", "none"]);
    const validKeyStrategies = new Set(["nftTokenId", "chainPoolWallet", "chainVaultWallet", "erc1155TokenId", "none"]);

    for (const chain of getSupportedZapChains()) {
      const config = getZapDexConfig(chain);
      expect(config).toBeDefined();
      for (const dex of config!.dexes) {
        expect(validRefKinds.has(dex.positionRefKind), `${chain}/${dex.id} invalid positionRefKind: ${dex.positionRefKind}`).toBe(true);
        expect(validApprovalStandards.has(dex.approvalStandard), `${chain}/${dex.id} invalid approvalStandard: ${dex.approvalStandard}`).toBe(true);
        expect(validApprovalTargets.has(dex.approvalTargetKind), `${chain}/${dex.id} invalid approvalTargetKind: ${dex.approvalTargetKind}`).toBe(true);
        expect(validCaptureKinds.has(dex.captureKind), `${chain}/${dex.id} invalid captureKind: ${dex.captureKind}`).toBe(true);
        expect(validKeyStrategies.has(dex.positionKeyStrategy), `${chain}/${dex.id} invalid positionKeyStrategy: ${dex.positionKeyStrategy}`).toBe(true);
        expect(dex.supports.length).toBeGreaterThan(0);
        expect(dex.id).toMatch(/^DEX_/);
      }
    }
  });

  it("no duplicate DEX IDs within a chain", async () => {
    const { getSupportedZapChains, getZapDexConfig } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
    for (const chain of getSupportedZapChains()) {
      const config = getZapDexConfig(chain)!;
      const ids = config.dexes.map(d => d.id);
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(duplicates, `${chain} has duplicate DEX IDs`).toEqual([]);
    }
  });

  it("5-axis tuples are internally consistent", async () => {
    const { getSupportedZapChains, getZapDexConfig } = await import("@tools/kyberswap/zaas/zap-dexes/index.js");
    for (const chain of getSupportedZapChains()) {
      const config = getZapDexConfig(chain)!;
      for (const dex of config.dexes) {
        // NFT CL family: tokenId ref → erc721 approval → positionManager target → receiptNftMint capture → nftTokenId key
        if (dex.approvalStandard === "erc721") {
          expect(dex.positionRefKind, `${chain}/${dex.id}`).toBe("tokenId");
          expect(dex.approvalTargetKind, `${chain}/${dex.id}`).toBe("positionManager");
          expect(dex.captureKind, `${chain}/${dex.id}`).toBe("receiptNftMint");
          expect(dex.positionKeyStrategy, `${chain}/${dex.id}`).toBe("nftTokenId");
        }
        // ERC-1155 family: erc1155TokenId ref → erc1155 approval → binManager target
        if (dex.approvalStandard === "erc1155") {
          expect(dex.positionRefKind, `${chain}/${dex.id}`).toBe("erc1155TokenId");
          expect(dex.approvalTargetKind, `${chain}/${dex.id}`).toBe("binManager");
          expect(dex.captureKind, `${chain}/${dex.id}`).toBe("receiptErc1155");
          expect(dex.positionKeyStrategy, `${chain}/${dex.id}`).toBe("erc1155TokenId");
        }
        // Source-only: no capture, no projection key
        if (dex.supports.length === 1 && dex.supports[0] === "zap-migrate-source") {
          expect(dex.captureKind, `${chain}/${dex.id}`).toBe("none");
          expect(dex.positionKeyStrategy, `${chain}/${dex.id}`).toBe("none");
        }
      }
    }
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
