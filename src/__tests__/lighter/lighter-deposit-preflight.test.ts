import { describe, expect, it } from "vitest";

import {
  proveLighterDepositPreflight,
  type LighterDepositPreflightEvidence,
} from "@tools/lighter/wallet-funding/deposit-preflight.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ASSET = {
  asset_id: 3,
  symbol: "USDC",
  l1_decimals: 6,
  decimals: 6,
  min_transfer_amount: "1.000000",
  l1_address: USDC,
};

function evidence(
  overrides: Partial<LighterDepositPreflightEvidence> = {},
): LighterDepositPreflightEvidence {
  return {
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
    walletAddress: WALLET,
    requestedAmountUnits: 11_000_000n,
    routeType: 0,
    ethereum: {
      chainId: 1,
      blockNumber: 23_456_789n,
      settlementBalanceUnits: 50_000_000n,
      settlementAllowanceUnits: 0n,
      nativeBalanceWei: 1_000_000_000_000_000n,
    },
    lighterLayer1: {
      code: 200,
      l1_providers: [{ chainId: 1, networkId: 1, latestBlockNumber: 0 }],
      l1_providers_health: true,
      contract_addresses: [{ name: "ZkLighterContract", address: GATEWAY }],
    },
    lighterAssets: {
      code: 200,
      asset_details: [{ ...USDC_ASSET }],
    },
    ...overrides,
  };
}

describe("Lighter live deposit preflight proof", () => {
  it("binds live gateway, USDC metadata, balances, allowance, and block evidence", () => {
    const snapshot = proveLighterDepositPreflight(evidence());

    expect(snapshot).toEqual({
      observedAt: new Date("2030-01-01T00:00:00.000Z"),
      walletAddress: WALLET,
      chainId: 1,
      ethereumBlockNumber: "23456789",
      lighterBlockNumber: "0",
      gatewayAddress: GATEWAY,
      settlementTokenAddress: USDC,
      settlementTokenSymbol: "USDC",
      settlementTokenDecimals: 6,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      minimumTransferUnits: "1000000",
      walletBalanceUnits: "50000000",
      walletAllowanceUnits: "0",
      walletNativeBalanceWei: "1000000000000000",
      approvalRequired: true,
    });
  });

  it("records when the exact amount is already allowed", () => {
    const base = evidence();
    const snapshot = proveLighterDepositPreflight({
      ...base,
      ethereum: { ...base.ethereum, settlementAllowanceUnits: 11_000_000n },
    });
    expect(snapshot.approvalRequired).toBe(false);
  });

  it.each([
    ["wrong chain", { ethereum: { ...evidence().ethereum, chainId: 8453 } }, /not Ethereum mainnet/],
    ["unhealthy L1", { lighterLayer1: { ...evidence().lighterLayer1, l1_providers_health: false } }, /unhealthy/],
    ["changed gateway", {
      lighterLayer1: {
        ...evidence().lighterLayer1,
        contract_addresses: [{ name: "ZkLighterContract", address: WALLET }],
      },
    }, /gateway address differs/],
    ["changed USDC", {
      lighterAssets: {
        ...evidence().lighterAssets,
        asset_details: [{ ...USDC_ASSET, l1_address: WALLET }],
      },
    }, /USDC metadata differs/],
    ["insufficient USDC", {
      ethereum: { ...evidence().ethereum, settlementBalanceUnits: 10_999_999n },
    }, /enough USDC/],
    ["no ETH", {
      ethereum: { ...evidence().ethereum, nativeBalanceWei: 0n },
    }, /no ETH/],
  ])("refuses %s", (_name, override, message) => {
    expect(() => proveLighterDepositPreflight(evidence(override))).toThrow(message);
  });

  it("enforces Lighter's live transfer minimum, not only a local constant", () => {
    const base = evidence();
    expect(() => proveLighterDepositPreflight({
      ...base,
      requestedAmountUnits: 4_000_000n,
      lighterAssets: {
        ...base.lighterAssets,
        asset_details: [{ ...USDC_ASSET, min_transfer_amount: "5.000000" }],
      },
    })).toThrow(/below Lighter's live minimum/);
  });
});
