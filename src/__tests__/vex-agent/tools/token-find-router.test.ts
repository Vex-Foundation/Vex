import { describe, expect, it, vi } from "vitest";

import type { KhalaniChain } from "@tools/khalani/types.js";
import type { InclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { handleTokenFind } from "@vex-agent/tools/internal/khalani.js";
import type { TokenFindDependencies } from "@vex-agent/tools/internal/token-find/types.js";
import { makeTestContext } from "./_test-context.js";

const USDC = "0x1111111111111111111111111111111111111111";

function addressFor(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function base(): InclusiveEvmChain {
  const khalaniChain: KhalaniChain = {
    id: 8453,
    type: "eip155",
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  };
  return {
    source: "khalani",
    chainId: 8453,
    family: "eip155",
    khalaniChain,
    khalaniChains: [khalaniChain],
  };
}

function khalaniSearchResult(tokens: readonly Record<string, unknown>[]) {
  return {
    success: true,
    output: JSON.stringify({ count: tokens.length, tokens }),
    data: {},
  };
}

describe("TokenFind capability routing", () => {
  it("routes a Khalani-covered chain to Khalani and replaces provider metadata with contract facts", async () => {
    const executeKhalaniSearch = vi.fn<TokenFindDependencies["executeKhalaniSearch"]>(
      async () => khalaniSearchResult([{
        address: USDC,
        chainId: 8453,
        name: "USD Coin",
        symbol: "PROVIDER_USDC",
        decimals: 18,
      }]),
    );
    const result = await handleTokenFind(
      { query: "USDC", chainIds: "base" },
      makeTestContext(),
      {
        resolveChain: async () => base(),
        executeKhalaniSearch,
        readContractIdentity: async (_chain, address) => ({
          address,
          symbol: "USDC",
          decimals: 6,
        }),
      },
    );

    expect(executeKhalaniSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "khalani.tokens.search",
        params: { query: "USDC", chainIds: ["8453"] },
      }),
      expect.any(Object),
    );
    expect(result.data).toMatchObject({
      resolution: { status: "unique_match" },
      coverage: { status: "complete" },
      mutationReady: true,
      candidates: [{
        address: USDC,
        chainId: 8453,
        symbol: "USDC",
        decimals: 6,
        providerMetadata: { symbol: "PROVIDER_USDC", decimals: 18 },
        providerMetadataAgrees: { symbol: false, decimals: false },
        provenance: { identity: "khalani", symbolAndDecimals: "rpc_contract" },
      }],
    });
  });

  it("bounds contract metadata reads at four while preserving candidate order", async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const tokens = Array.from({ length: 7 }, (_, index) => ({
      address: addressFor(index + 1),
      chainId: 8453,
      name: `Token ${index + 1}`,
      symbol: `T${index + 1}`,
      decimals: 18,
    }));

    const result = await handleTokenFind(
      { query: "Token", chainIds: "base" },
      makeTestContext(),
      {
        resolveChain: async () => base(),
        executeKhalaniSearch: async () => khalaniSearchResult(tokens),
        readContractIdentity: async (_chain, address) => {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await Promise.resolve();
          activeReads -= 1;
          return { address, symbol: address, decimals: 18 };
        },
      },
    );

    expect(maxActiveReads).toBe(4);
    expect(result.data?.candidates).toEqual(
      tokens.map((token) => expect.objectContaining({ address: token.address })),
    );
  });

  it("reports the exact Khalani residue when the client candidate cap is reached", async () => {
    const tokens = Array.from({ length: 35 }, (_, index) => ({
      address: addressFor(index + 1),
      chainId: 8453,
      name: `Token ${index + 1}`,
      symbol: `T${index + 1}`,
      decimals: 18,
    }));
    const readContractIdentity = vi.fn<TokenFindDependencies["readContractIdentity"]>(
      async (_chain, address) => ({ address, symbol: "TOKEN", decimals: 18 }),
    );

    const result = await handleTokenFind(
      { query: "Token", chainIds: "base" },
      makeTestContext(),
      {
        resolveChain: async () => base(),
        executeKhalaniSearch: async () => khalaniSearchResult(tokens),
        readContractIdentity,
      },
    );

    expect(readContractIdentity).toHaveBeenCalledTimes(30);
    expect(result.data).toMatchObject({
      resolution: { status: "ambiguous", candidateCount: 30 },
      coverage: { status: "provider_capped" },
      mutationReady: false,
      providerAccounting: {
        khalaniRowsOmittedByClientCap: 5,
        khalaniCandidateLimit: 30,
        providerCandidateCount: 30,
      },
    });
    expect(result.output).toContain("Narrow to an exact contract address");
  });

  it("keeps an unscoped cross-chain lookup research-only", async () => {
    const result = await handleTokenFind(
      { query: "USDC" },
      makeTestContext(),
      {
        listKhalaniEvmChainIds: async () => [8453],
        executeKhalaniSearch: async () => khalaniSearchResult([{
          address: USDC,
          chainId: 8453,
          name: "USD Coin",
          symbol: "USDC",
          decimals: 6,
        }]),
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolution: { status: "target_chain_required", candidateCount: 1 },
      coverage: { status: "chain_scope_required" },
      mutationReady: false,
      candidates: [{
        address: USDC,
        symbol: null,
        decimals: null,
        metadata: { status: "target_chain_required" },
        providerMetadata: { symbol: "USDC", decimals: 6 },
      }],
    });
  });

  it("reports empty separately from unsupported and provider failures", async () => {
    const empty = await handleTokenFind(
      { query: "NO_MATCH", chainIds: "base" },
      makeTestContext(),
      {
        resolveChain: async () => base(),
        executeKhalaniSearch: async () => khalaniSearchResult([]),
      },
    );
    const unsupported = await handleTokenFind(
      { query: "NO_MATCH", chainIds: "not-a-chain" },
      makeTestContext(),
      { resolveChain: async () => { throw new Error("unknown"); } },
    );
    const unavailable = await handleTokenFind(
      { query: "NO_MATCH", chainIds: "base" },
      makeTestContext(),
      {
        resolveChain: async () => base(),
        executeKhalaniSearch: async () => ({
          success: false,
          output: "Khalani is temporarily unavailable.",
        }),
      },
    );

    expect(empty.success).toBe(true);
    expect(empty.data).toMatchObject({ resolution: { status: "empty" } });
    expect(unsupported.success).toBe(false);
    expect(unsupported.data).toMatchObject({ resolution: { status: "unsupported_chain" } });
    expect(unavailable.success).toBe(false);
    expect(unavailable.data).toMatchObject({ resolution: { status: "provider_unavailable" } });
  });

  it("requires a chain for an exact address instead of searching by ranking", async () => {
    const executeKhalaniSearch = vi.fn();
    const result = await handleTokenFind(
      { query: USDC },
      makeTestContext(),
      { executeKhalaniSearch },
    );

    expect(executeKhalaniSearch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      resolution: { status: "target_chain_required" },
      coverage: { status: "chain_scope_required" },
      mutationReady: false,
    });
  });
});
