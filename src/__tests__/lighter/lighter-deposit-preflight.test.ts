import { describe, expect, it } from "vitest";

import {
  proveLighterDepositPreflight,
  type LighterDepositPreflightEvidence,
} from "@tools/lighter/wallet-funding/deposit-preflight.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");
const BLOCK_TIMESTAMP_SECONDS = 1_893_456_000n;

function evidence(
  environment: "core" | "rhc" = "core",
): LighterDepositPreflightEvidence {
  const deployment = getLighterFundingDeployment(environment);
  return {
    observedAt: OBSERVED_AT,
    environment,
    walletAddress: WALLET,
    requestedAmountUnits: 11_000_000n,
    routeType: deployment.perpsRouteType,
    settlementChain: {
      chainId: deployment.settlementChainId,
      blockNumber: 23_456_789n,
      blockTimestampSeconds: BLOCK_TIMESTAMP_SECONDS,
      settlementBalanceUnits: 50_000_000n,
      settlementAllowanceUnits: 0n,
      nativeBalanceWei: 1_000_000_000_000_000_000n,
      gatewayCode: "0x6000",
      settlementTokenCode: "0x6001",
      gatewayImplementationAddress: deployment.expectedGatewayImplementation ?? null,
      settlementTokenImplementationAddress:
        deployment.expectedSettlementTokenImplementation ?? null,
      settlementTokenSymbol: deployment.settlementSymbol,
      settlementTokenDecimals: deployment.settlementDecimals,
      gatewaySettlementAssetIndex: deployment.settlementAssetIndex,
      depositSimulationSucceeded: true,
      approveGasEstimate: 50_000n,
      depositGasEstimate: 100_000n,
      maxFeePerGasWei: 20_000_000_000n,
      maxPriorityFeePerGasWei: 2_000_000_000n,
    },
    lighterInfo: { contract_address: deployment.gatewayProxy },
    lighterLayer1: {
      code: 200,
      l1_providers: [{
        chainId: deployment.settlementChainId,
        networkId: deployment.settlementChainId,
        latestBlockNumber: 0,
      }],
      l1_providers_health: true,
      contract_addresses: [
        { name: "ZkLighterContract", address: deployment.gatewayProxy },
        { name: "USDCContract", address: deployment.settlementTokenProxy },
      ],
    },
    lighterAssets: {
      code: 200,
      asset_details: [{
        asset_id: deployment.settlementAssetIndex,
        symbol: deployment.settlementSymbol,
        l1_decimals: deployment.settlementDecimals,
        decimals: deployment.settlementDecimals,
        min_transfer_amount: "1.000000",
        margin_mode: "enabled",
        l1_address: deployment.settlementTokenProxy,
      }],
    },
  };
}

describe("Lighter environment-scoped deposit preflight proof", () => {
  it("preserves the live-proven Core preparation identity", () => {
    const deployment = getLighterFundingDeployment("core");
    const snapshot = proveLighterDepositPreflight(evidence("core"));

    expect(snapshot).toMatchObject({
      observedAt: OBSERVED_AT,
      environment: "core",
      lighterRestBaseUrl: deployment.restBaseUrl,
      settlementNetworkName: "Ethereum mainnet",
      walletAddress: WALLET,
      beneficiaryAddress: WALLET,
      chainId: 1,
      settlementBlockNumber: "23456789",
      ethereumBlockNumber: "23456789",
      lighterBlockNumber: "0",
      gatewayAddress: deployment.gatewayProxy,
      gatewayImplementationAddress: deployment.expectedGatewayImplementation,
      settlementTokenAddress: deployment.settlementTokenProxy,
      settlementTokenImplementationAddress: null,
      settlementTokenSymbol: "USDC",
      settlementTokenDecimals: 6,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      minimumTransferUnits: "1000000",
      depositValueWei: "0",
      walletBalanceUnits: "50000000",
      walletAllowanceUnits: "0",
      walletNativeBalanceWei: "1000000000000000000",
      approvalRequired: true,
      approveGasLimit: "100000",
      depositGasLimit: "200000",
      requiredNativeBalanceWei: "10000000000000000",
    });
    expect(snapshot.depositCalldata.startsWith(deployment.depositSelector)).toBe(true);
  });

  it("proves the exact RHC USDG deployment without confusing signer chain 466324", () => {
    const deployment = getLighterFundingDeployment("rhc");
    const snapshot = proveLighterDepositPreflight(evidence("rhc"));

    expect(snapshot).toMatchObject({
      environment: "rhc",
      lighterRestBaseUrl: "https://api.rh.lighter.xyz",
      settlementNetworkName: "Robinhood Chain mainnet",
      chainId: 4663,
      gatewayAddress: deployment.gatewayProxy,
      gatewayImplementationAddress: deployment.expectedGatewayImplementation,
      settlementTokenAddress: deployment.settlementTokenProxy,
      settlementTokenImplementationAddress:
        deployment.expectedSettlementTokenImplementation,
      settlementTokenSymbol: "USDG",
      settlementTokenDecimals: 6,
      assetIndex: 3,
      routeType: 0,
      beneficiaryAddress: WALLET,
      depositValueWei: "0",
    });
    expect(snapshot.depositCalldata.startsWith("0x8a857083")).toBe(true);
  });

  it("records when the exact amount is already allowed", () => {
    const base = evidence("rhc");
    const snapshot = proveLighterDepositPreflight({
      ...base,
      settlementChain: {
        ...base.settlementChain,
        settlementAllowanceUnits: 11_000_000n,
        approveGasEstimate: 0n,
      },
    });
    expect(snapshot.approvalRequired).toBe(false);
    expect(snapshot.approveGasLimit).toBe("0");
    expect(snapshot.approveMaxFeeWei).toBe("0");
    expect(snapshot.totalMaxFeeWei).toBe(snapshot.depositMaxFeeWei);
  });

  it.each([
    ["signer chain used as settlement chain", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, chainId: 466324 },
    }), /not Robinhood Chain mainnet/],
    ["unhealthy L1", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      lighterLayer1: { ...base.lighterLayer1, l1_providers_health: false },
    }), /unhealthy/],
    ["changed gateway", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      lighterLayer1: {
        ...base.lighterLayer1,
        contract_addresses: [
          { name: "ZkLighterContract", address: WALLET },
          { name: "USDCContract", address: getLighterFundingDeployment("rhc").settlementTokenProxy },
        ],
      },
    }), /gateway address differs/],
    ["legacy token field drift", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      lighterLayer1: {
        ...base.lighterLayer1,
        contract_addresses: [
          { name: "ZkLighterContract", address: getLighterFundingDeployment("rhc").gatewayProxy },
          { name: "USDCContract", address: WALLET },
        ],
      },
    }), /legacy settlement-token field differs/],
    ["USDC substituted for USDG", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, settlementTokenSymbol: "USDC" },
    }), /not USDG/],
    ["proxy implementation drift", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, gatewayImplementationAddress: WALLET },
    }), /proxy implementation differs/],
    ["wrong gateway asset mapping", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, gatewaySettlementAssetIndex: 4 },
    }), /verified asset index/],
    ["failed calldata simulation", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, depositSimulationSucceeded: false },
    }), /simulation did not succeed/],
    ["missing gateway code", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, gatewayCode: "0x" as const },
    }), /no deployed bytecode/],
    ["insufficient USDG", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, settlementBalanceUnits: 10_999_999n },
    }), /enough USDG/],
    ["stale block", (base: LighterDepositPreflightEvidence) => ({
      ...base,
      settlementChain: { ...base.settlementChain, blockTimestampSeconds: BLOCK_TIMESTAMP_SECONDS - 301n },
    }), /latest block is stale/],
  ])("refuses %s", (_name, mutate, message) => {
    expect(() => proveLighterDepositPreflight(mutate(evidence("rhc")))).toThrow(message);
  });

  it("requires the live minimum to match the pinned one-USDG deployment floor", () => {
    const base = evidence("rhc");
    expect(() => proveLighterDepositPreflight({
      ...base,
      lighterAssets: {
        ...base.lighterAssets,
        asset_details: [{ ...base.lighterAssets.asset_details[0]!, min_transfer_amount: "5.000000" }],
      },
    })).toThrow(/conflicts with Lighter's verified minimum/);
  });
});
