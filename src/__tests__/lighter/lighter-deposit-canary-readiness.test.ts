import { describe, expect, it } from "vitest";

import {
  buildLighterDepositCanaryReadiness,
  LIGHTER_DEPOSIT_CANARY_MAX_UNITS,
} from "@tools/lighter/wallet-funding/deposit-canary-readiness.js";
import type { LighterDepositPreflightSnapshot } from "@tools/lighter/wallet-funding/deposit-preflight.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

function snapshot(
  overrides: Partial<LighterDepositPreflightSnapshot> = {},
): LighterDepositPreflightSnapshot {
  return {
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
    walletAddress: WALLET,
    chainId: 1,
    ethereumBlockNumber: "23456789",
    lighterBlockNumber: "23456780",
    gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits: LIGHTER_DEPOSIT_CANARY_MAX_UNITS.toString(10),
    minimumTransferUnits: LIGHTER_DEPOSIT_CANARY_MAX_UNITS.toString(10),
    walletBalanceUnits: "50000000",
    walletAllowanceUnits: "0",
    walletNativeBalanceWei: "1000000000000000000",
    approvalRequired: true,
    approveGasLimit: "100000",
    depositGasLimit: "200000",
    maxFeePerGasWei: "20000000000",
    maxPriorityFeePerGasWei: "2000000000",
    approveMaxFeeWei: "2000000000000000",
    depositMaxFeeWei: "4000000000000000",
    totalMaxFeeWei: "6000000000000000",
    nativeReserveWei: "4000000000000000",
    requiredNativeBalanceWei: "10000000000000000",
    ...overrides,
  };
}

describe("Lighter Phase 2 deposit canary readiness", () => {
  it("produces a non-signing readiness record for the exact live minimum", () => {
    expect(buildLighterDepositCanaryReadiness(snapshot())).toEqual({
      readyForExplicitApproval: true,
      signingPerformed: false,
      broadcastPerformed: false,
      requiresSeparateExplicitFundMovementApproval: true,
      walletAddress: WALLET,
      chainId: 1,
      route: "perps",
      amountUnits: "1000000",
      amountDisplay: "1 USDC",
      minimumTransferUnits: "1000000",
      approvalRequired: true,
      approveGasLimit: "100000",
      depositGasLimit: "200000",
      totalMaxFeeWei: "6000000000000000",
      nativeReserveWei: "4000000000000000",
      requiredNativeBalanceWei: "10000000000000000",
      ethereumBlockNumber: "23456789",
      observedAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("refuses an amount above the live minimum or the one-USDC cap", () => {
    expect(() => buildLighterDepositCanaryReadiness(snapshot({
      amountUnits: "2000000",
    }))).toThrow(/exact live minimum/);
    expect(() => buildLighterDepositCanaryReadiness(snapshot({
      amountUnits: "2000000",
      minimumTransferUnits: "2000000",
    }))).toThrow(/one-USDC/);
  });

  it("refuses a route other than Ethereum USDC perps", () => {
    expect(() => buildLighterDepositCanaryReadiness(snapshot({ routeType: 1 }))).toThrow(
      /supported Ethereum USDC-perps/,
    );
  });
});
