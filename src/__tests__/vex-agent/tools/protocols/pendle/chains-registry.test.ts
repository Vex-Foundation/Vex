/**
 * Pendle chain registry — network-free resolution across all 11 chains: slug /
 * alias / stringified-id → chainId, id → slug, unknown → undefined, and the
 * slug↔id round-trip. This is the source of truth the handlers, prequote gate,
 * recorder, and evm-client all agree on.
 */

import { describe, it, expect } from "vitest";

import {
  resolvePendleChainId,
  pendleChainSlug,
  getPendleChain,
  PENDLE_SUPPORTED_CHAIN_IDS,
  PENDLE_CHAIN_REGISTRY,
} from "@tools/pendle/chains.js";
import { resolveRpcEndpoints } from "@tools/evm-chains/rpc-endpoints.js";

const EXPECTED_IDS = [1, 10, 56, 143, 146, 999, 5000, 8453, 9745, 42161, 80094];

describe("pendle chain registry", () => {
  it("covers exactly the 11 supported chains", () => {
    expect([...PENDLE_SUPPORTED_CHAIN_IDS].sort((a, b) => a - b)).toEqual([...EXPECTED_IDS].sort((a, b) => a - b));
    expect(PENDLE_CHAIN_REGISTRY).toHaveLength(11);
  });

  it("resolves canonical slugs to their chainId", () => {
    expect(resolvePendleChainId("ethereum")).toBe(1);
    expect(resolvePendleChainId("optimism")).toBe(10);
    expect(resolvePendleChainId("bsc")).toBe(56);
    expect(resolvePendleChainId("monad")).toBe(143);
    expect(resolvePendleChainId("sonic")).toBe(146);
    expect(resolvePendleChainId("hyperevm")).toBe(999);
    expect(resolvePendleChainId("mantle")).toBe(5000);
    expect(resolvePendleChainId("base")).toBe(8453);
    expect(resolvePendleChainId("plasma")).toBe(9745);
    expect(resolvePendleChainId("arbitrum")).toBe(42161);
    expect(resolvePendleChainId("berachain")).toBe(80094);
  });

  it("resolves aliases and is case/whitespace insensitive", () => {
    expect(resolvePendleChainId("eth")).toBe(1);
    expect(resolvePendleChainId("mainnet")).toBe(1);
    expect(resolvePendleChainId("ETHEREUM")).toBe(1);
    expect(resolvePendleChainId("  Arbitrum  ")).toBe(42161);
    expect(resolvePendleChainId("arb")).toBe(42161);
    expect(resolvePendleChainId("bnb")).toBe(56);
    expect(resolvePendleChainId("op")).toBe(10);
    expect(resolvePendleChainId("hyperliquid")).toBe(999);
    expect(resolvePendleChainId("bera")).toBe(80094);
  });

  it("resolves stringified chain ids", () => {
    expect(resolvePendleChainId("1")).toBe(1);
    expect(resolvePendleChainId("42161")).toBe(42161);
    expect(resolvePendleChainId("80094")).toBe(80094);
  });

  it("returns undefined for unknown / empty input", () => {
    expect(resolvePendleChainId("")).toBeUndefined();
    expect(resolvePendleChainId("   ")).toBeUndefined();
    expect(resolvePendleChainId("dogechain")).toBeUndefined();
    expect(resolvePendleChainId("137")).toBeUndefined(); // polygon — not a Pendle chain here
    expect(resolvePendleChainId("0")).toBeUndefined();
  });

  it("maps a chainId back to its canonical slug (unknown → undefined)", () => {
    expect(pendleChainSlug(1)).toBe("ethereum");
    expect(pendleChainSlug(42161)).toBe("arbitrum");
    expect(pendleChainSlug(999)).toBe("hyperevm");
    expect(pendleChainSlug(137)).toBeUndefined();
  });

  it("round-trips slug ↔ id for every registry chain, with a wired Multicall3", () => {
    for (const chain of PENDLE_CHAIN_REGISTRY) {
      expect(resolvePendleChainId(chain.slug)).toBe(chain.chainId);
      expect(pendleChainSlug(chain.chainId)).toBe(chain.slug);
      expect(getPendleChain(chain.chainId)).toBe(chain);
      // Multicall3 is required for publicClient.multicall on every chain.
      expect(chain.multicall3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
      // The endpoint is no longer a field on the Pendle chain row: every
      // chain's endpoints belong to `@tools/evm-chains/rpc-endpoints.ts`. The
      // property this line guarded - that Pendle can build a client for every
      // chain it claims to support - is asserted against the owner instead.
      expect(resolveRpcEndpoints(chain.chainId).length).toBeGreaterThan(0);
    }
  });

  it("getPendleChain returns undefined for an unsupported id", () => {
    expect(getPendleChain(137)).toBeUndefined();
  });
});
