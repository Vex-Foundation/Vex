/**
 * getKyberWrappedNativeAddress — per-chain wrapped-native registry. Coverage
 * must be EXACTLY the `aggregator: true` chains in chains.ts: fail-closed
 * (throw) for any chain slug without a registered entry.
 */

import { describe, it, expect } from "vitest";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { VexError } from "../../errors.js";

describe("getKyberWrappedNativeAddress", () => {
  it("resolves the wrapped-native address for every aggregator chain", () => {
    const expected: Partial<Record<KyberChainSlug, string>> = {
      ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      optimism: "0x4200000000000000000000000000000000000006",
      avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      base: "0x4200000000000000000000000000000000000006",
      linea: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
      mantle: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
      sonic: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38",
      berachain: "0x6969696969696969696969696969696969696969",
      ronin: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
      unichain: "0x4200000000000000000000000000000000000006",
      hyperevm: "0x5555555555555555555555555555555555555555",
      plasma: "0x6100e367285b01f48d07953803a2d8dca5d19873",
      monad: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
      megaeth: "0x4200000000000000000000000000000000000006",
      robinhood: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    };

    for (const slug of Object.keys(expected) as KyberChainSlug[]) {
      const address = expected[slug];
      expect(address).toBeDefined();
      expect(getKyberWrappedNativeAddress(slug).toLowerCase()).toBe((address ?? "").toLowerCase());
    }
  });

  it("throws a VexError for a non-aggregator chain (scroll)", () => {
    expect(() => getKyberWrappedNativeAddress("scroll")).toThrow(VexError);
  });

  it("throws a VexError for a non-aggregator chain (zksync)", () => {
    expect(() => getKyberWrappedNativeAddress("zksync")).toThrow(VexError);
  });

  it("covers EXACTLY the aggregator: true chains from the chain registry", () => {
    for (const chain of getKyberChains()) {
      if (chain.aggregator) {
        expect(() => getKyberWrappedNativeAddress(chain.slug)).not.toThrow();
      } else {
        expect(() => getKyberWrappedNativeAddress(chain.slug)).toThrow(VexError);
      }
    }
  });
});
