import { describe, expect, it, vi } from "vitest";

import type { RelayChain } from "@tools/relay/types.js";
import { buildApprovalIntentPreview } from "@vex-agent/engine/core/approval-runtime/enqueue.js";
import { buildIntentPreview } from "@vex-agent/engine/core/approval-intent-preview.js";
import {
  resolveRelayBridgeTokenPreview,
  type BridgeAssetIdentity,
  type BridgeTokenIdentityPreview,
} from "@vex-agent/tools/protocols/bridge-token-identity.js";
import { resolveKhalaniBridgeTokenInfo } from "@vex-agent/tools/protocols/khalani/handlers/bridge-usd.js";
import { bridgeSideDisplay } from "@vex-agent/tools/protocols/relay/handlers/bridge-output.js";
import { relayLegInput } from "@vex-agent/tools/protocols/relay/handlers/bridge/recording.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { evaluateApprovalGate } from "@vex-agent/tools/protocols/runtime/gates.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { makeProtocolContext } from "./_test-context.js";

const USDC = "0x1111111111111111111111111111111111111111";
const WETH = "0x2222222222222222222222222222222222222222";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const BASE: RelayChain = { id: 8453, name: "base", vmType: "evm" };
const SOLANA: RelayChain = { id: 792_703_809, name: "solana", vmType: "svm" };

const SOURCE: BridgeAssetIdentity = {
  family: "eip155",
  kind: "erc20",
  chainId: 8453,
  tokenAddress: USDC,
  symbol: "USDC",
  decimals: 6,
  metadataSource: "rpc_contract",
  symbolSanitized: false,
};

const DESTINATION: BridgeAssetIdentity = {
  family: "eip155",
  kind: "erc20",
  chainId: 4663,
  tokenAddress: WETH,
  symbol: "WETH",
  decimals: 18,
  metadataSource: "rpc_contract",
  symbolSanitized: false,
};

describe("bridge token identity", () => {
  it("does not invent an EVM contract read for a Relay Solana side", async () => {
    const resolveEvmIdentity = vi.fn(async (): Promise<BridgeAssetIdentity> => SOURCE);
    const preview = await resolveRelayBridgeTokenPreview(
      {
        fromChain: "8453",
        fromToken: USDC,
        toChain: "792703809",
        toToken: SOL_MINT,
        amountRaw: "1000000",
      },
      undefined,
      { relayChains: [BASE, SOLANA], resolveEvmIdentity },
    );

    expect(resolveEvmIdentity).toHaveBeenCalledTimes(1);
    expect(preview.source).toEqual(SOURCE);
    expect(preview.destination).toEqual({
      family: "solana",
      kind: "solana",
      chainId: 792_703_809,
      tokenAddress: SOL_MINT,
      symbol: null,
      decimals: null,
      metadataSource: "solana_not_read_by_evm_contract_resolver",
      symbolSanitized: false,
    });
    expect(preview.amountHuman).toBe("1");
  });

  it("replaces Khalani provider symbol/decimals with contract facts but retains price", async () => {
    const info = await resolveKhalaniBridgeTokenInfo(
      USDC,
      8453,
      SOURCE,
      {
        resolveProvider: async () => ({
          symbol: "WRONG",
          decimals: 18,
          priceUsd: "0.999",
        }),
      },
    );

    expect(info).toEqual({ symbol: "USDC", decimals: 6, priceUsd: "0.999" });
  });

  it("uses contract decimals for Relay humanization and durable leg metadata", () => {
    const providerSide = {
      address: USDC,
      symbol: "WRONG",
      decimals: 18,
      amountRaw: "1000000",
      amountFormatted: "0.000000000001",
      amountUsd: "1",
      minimumAmountRaw: null,
    };
    const chains: RelayChain[] = [BASE];

    expect(bridgeSideDisplay(providerSide, USDC, 8453, chains, undefined, SOURCE)).toMatchObject({
      token: "USDC",
      amount: "1",
      amountRaw: "1000000",
    });
    expect(relayLegInput(providerSide, USDC, undefined, SOURCE)).toEqual({
      tokenAddress: USDC,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountHuman: "1",
      amountRaw: "1000000",
    });
  });
});

describe("bridge approval card", () => {
  const bridgePreview: BridgeTokenIdentityPreview = {
    source: SOURCE,
    destination: DESTINATION,
    amountRaw: "1500000",
    amountHuman: "1.5",
  };

  it("renders chain, address, contract symbol/decimals, human amount, and raw amount", () => {
    const preview = buildIntentPreview(
      "execute_tool",
      {
        toolId: "relay.bridge",
        params: {
          fromChain: "8453",
          fromToken: USDC,
          toChain: "4663",
          toToken: WETH,
          amountRaw: "1500000",
        },
      },
      { prequoteVerdict: "unknown", bridgeTokenPreview: bridgePreview },
    );

    expect(preview.criticalArgs.bridgeSourceAsset).toContain(`EVM chain 8453 | erc20 ${USDC} | USDC | 6 decimals | rpc_contract`);
    expect(preview.criticalArgs.bridgeDestinationAsset).toContain(`EVM chain 4663 | erc20 ${WETH} | WETH | 18 decimals | rpc_contract`);
    expect(preview.criticalArgs.bridgeAmount).toBe("1.5 USDC | 1500000 raw units | 6 decimals");
  });

  it("renders typed metadata unavailability with raw amount and a signing block", () => {
    const unavailable: BridgeTokenIdentityPreview = {
      source: {
        family: "eip155",
        kind: "metadata_unavailable",
        chainId: 8453,
        tokenAddress: USDC,
        symbol: null,
        decimals: null,
        metadataSource: "rpc_contract_unavailable",
        symbolSanitized: false,
        metadataErrorCode: "contract_metadata_unavailable",
        metadataErrorMessage: "Direct contract symbol and decimals could not be read on this chain.",
      },
      destination: DESTINATION,
      amountRaw: "1500000",
      amountHuman: null,
    };
    const preview = buildIntentPreview(
      "execute_tool",
      { toolId: "relay.bridge", params: { amountRaw: "1500000" } },
      { prequoteVerdict: "unknown", bridgeTokenPreview: unavailable },
    );

    expect(preview.criticalArgs.bridgeSourceAsset).toContain(`EVM chain 8453 | token ${USDC}`);
    expect(preview.criticalArgs.bridgeSourceAsset).toContain("contract_metadata_unavailable");
    expect(preview.criticalArgs.bridgeSourceAsset).toContain("rpc_contract_unavailable");
    expect(preview.criticalArgs.bridgeSourceAsset).toContain("signing blocked");
    expect(preview.criticalArgs.bridgeAmount).toBe(
      "1500000 raw units | human amount unavailable because source contract decimals could not be read | signing blocked",
    );
  });

  it("carries the typed gate result through the complete approval builder", () => {
    const result: ToolResult = {
      success: false,
      output: "approval required",
      pendingApproval: true,
      prequote: {
        verdict: "unknown",
        bridgeTokenPreview: bridgePreview,
      },
    };
    const preview = buildApprovalIntentPreview({
      toolName: "execute_tool",
      toolArgs: {
        toolId: "relay.bridge",
        params: {
          fromChain: "8453",
          fromToken: USDC,
          toChain: "4663",
          toToken: WETH,
          amountRaw: "1500000",
        },
      },
      result,
    });

    expect(preview.criticalArgs).toMatchObject({
      bridgeSourceAsset: expect.stringContaining("USDC | 6 decimals | rpc_contract"),
      bridgeDestinationAsset: expect.stringContaining("WETH | 18 decimals | rpc_contract"),
      bridgeAmount: "1.5 USDC | 1500000 raw units | 6 decimals",
    });
  });

  it("puts the direct identity block on the pending result at the approval gate", () => {
    const manifest = getProtocolManifest("relay.bridge");
    if (!manifest) throw new Error("relay.bridge manifest missing");
    const pending = evaluateApprovalGate(
      manifest,
      { toolId: "relay.bridge" },
      { fromChain: "8453", fromToken: USDC, toChain: "4663", toToken: WETH, amountRaw: "1500000" },
      makeProtocolContext(),
      "unknown",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bridgePreview,
    );

    expect(pending).toMatchObject({
      pendingApproval: true,
      prequote: {
        verdict: "unknown",
        bridgeTokenPreview: bridgePreview,
      },
    });
  });
});
