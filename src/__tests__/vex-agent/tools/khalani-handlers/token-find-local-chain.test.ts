import { describe, expect, it, vi } from "vitest";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import type { InclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { handleTokenFind } from "@vex-agent/tools/internal/khalani.js";
import type { TokenFindDependencies } from "@vex-agent/tools/internal/token-find/types.js";
import { makeTestContext } from "../_test-context.js";

const VEX = "0x1111111111111111111111111111111111111111";
const COPYCAT = "0x2222222222222222222222222222222222222222";
const PAIR = "0x3333333333333333333333333333333333333333";

function robinhood(): InclusiveEvmChain {
  const config = getLocalChain(4663);
  if (!config) throw new Error("Robinhood Chain must be registered for this test.");
  return { source: "local", chainId: 4663, family: "eip155", config };
}

describe("TokenFind local EVM capability route", () => {
  it("exact address bypasses provider ranking and uses contract symbol and decimals", async () => {
    const search = vi.fn<TokenFindDependencies["executeDexScreenerSearch"]>();
    const result = await handleTokenFind(
      { query: VEX, chainIds: "robinhood" },
      makeTestContext(),
      {
        resolveChain: async () => robinhood(),
        executeDexScreenerSearch: search,
        readContractIdentity: async (_chain, address) => ({
          address,
          symbol: "VEX",
          decimals: 18,
        }),
      },
    );

    expect(search).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolution: { status: "unique_match", candidateCount: 1 },
      coverage: { status: "complete" },
      mutationReady: true,
      candidates: [{
        address: VEX,
        chainId: 4663,
        symbol: "VEX",
        decimals: 18,
        metadata: { status: "verified" },
        provenance: {
          identity: "exact_address",
          symbolAndDecimals: "rpc_contract",
        },
      }],
      providerAccounting: { searchRequestsIssued: 0 },
    });
  });

  it("returns every attributable candidate and reports a capped ambiguous window", async () => {
    const result = await handleTokenFind(
      { query: "VEX", chainIds: ["4663"] },
      makeTestContext(),
      {
        resolveChain: async () => robinhood(),
        executeDexScreenerSearch: async () => ({
          success: true,
          output: "{}",
          data: {
            providerCapped: true,
            rows: [
              {
                pairAddress: PAIR,
                dexId: "sushiswap",
                baseTokenAddress: VEX,
                baseTokenSymbol: "VEX",
                baseTokenName: "Vex",
                baseTokenDecimals: 9,
                quoteTokenAddress: "0x4444444444444444444444444444444444444444",
                quoteTokenSymbol: "WETH",
                quoteTokenDecimals: 18,
              },
              {
                pairAddress: "0x5555555555555555555555555555555555555555",
                dexId: "uniswap",
                baseTokenAddress: COPYCAT,
                baseTokenSymbol: "VEX",
                baseTokenName: "Vex Copy",
                baseTokenDecimals: 6,
                quoteTokenAddress: "0x4444444444444444444444444444444444444444",
                quoteTokenSymbol: "WETH",
                quoteTokenDecimals: 18,
              },
            ],
          },
        }),
        readContractIdentity: async (_chain, address) => ({
          address,
          symbol: address.toLowerCase() === VEX.toLowerCase() ? "VEX" : "VEXCOPY",
          decimals: address.toLowerCase() === VEX.toLowerCase() ? 18 : 8,
        }),
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolution: { status: "ambiguous", candidateCount: 2, ambiguous: true },
      coverage: { status: "provider_capped" },
      metadataCounts: { verified: 2 },
      mutationReady: false,
      candidates: [
        {
          address: VEX,
          symbol: "VEX",
          decimals: 18,
          providerMetadata: { symbol: "VEX", decimals: 9 },
          providerMetadataAgrees: { symbol: true, decimals: false },
          pairEvidence: [{ pairAddress: PAIR, dexId: "sushiswap", side: "base" }],
        },
        {
          address: COPYCAT,
          symbol: "VEXCOPY",
          decimals: 8,
        },
      ],
      providerAccounting: {
        dexProviderReturned: 2,
        dexRowsWithoutAttributableToken: 0,
        providerCandidateCount: 2,
      },
    });
    expect(result.output).toContain("No liquidity, price, quote-tier, or risk threshold");
    expect(result.output).toContain("fixed non-pageable window");
  });

  it("keeps metadata-unreadable distinct and refuses mutation readiness", async () => {
    const result = await handleTokenFind(
      { query: VEX, chainIds: "4663" },
      makeTestContext(),
      {
        resolveChain: async () => robinhood(),
        readContractIdentity: async () => {
          throw new Error("scripted RPC failure");
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      resolution: { status: "metadata_unreadable", candidateCount: 1 },
      coverage: { status: "complete" },
      metadataCounts: { unreadable: 1 },
      mutationReady: false,
      candidates: [{
        address: VEX,
        symbol: null,
        decimals: null,
        metadata: { status: "unreadable" },
      }],
    });
    expect(result.output).not.toContain("scripted RPC failure");
  });

  it("propagates operator cancellation before provider or RPC work", async () => {
    const controller = new AbortController();
    controller.abort();
    const search = vi.fn<TokenFindDependencies["executeDexScreenerSearch"]>();
    const readIdentity = vi.fn<TokenFindDependencies["readContractIdentity"]>();

    await expect(handleTokenFind(
      { query: "VEX", chainIds: "4663" },
      makeTestContext({ abortSignal: controller.signal }),
      {
        resolveChain: async () => robinhood(),
        executeDexScreenerSearch: search,
        readContractIdentity: readIdentity,
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(search).not.toHaveBeenCalled();
    expect(readIdentity).not.toHaveBeenCalled();
  });
});
