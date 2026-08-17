import { describe, expect, it } from "vitest";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  approvedFeeCeiling,
  assertLighterDepositPreflightWithinApproval,
} from "@tools/lighter/wallet-funding/deposit-pre-sign.js";
import type { LighterDepositPreflightSnapshot } from "@tools/lighter/wallet-funding/deposit-preflight.js";

const NOW = new Date("2030-01-01T00:00:10.000Z");
const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function intent(overrides: Partial<LighterOnboardingIntentRow> = {}): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-1",
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: GATEWAY,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    settlementTokenAddress: USDC,
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    preflightMinimumTransferUnits: "1000000",
    preflightWalletBalanceUnits: "50000000",
    preflightWalletAllowanceUnits: "0",
    preflightWalletNativeBalanceWei: "1000000000000000000",
    preflightEthereumBlockNumber: "23456789",
    preflightLighterBlockNumber: "0",
    preflightObservedAt: new Date("2030-01-01T00:00:00.000Z"),
    preflightApproveGasLimit: "100000",
    preflightDepositGasLimit: "200000",
    preflightMaxFeePerGasWei: "20000000000",
    preflightMaxPriorityFeePerGasWei: "2000000000",
    preflightApproveMaxFeeWei: "2000000000000000",
    preflightDepositMaxFeeWei: "4000000000000000",
    preflightTotalMaxFeeWei: "6000000000000000",
    preflightNativeReserveWei: "4000000000000000",
    preflightRequiredNativeBalanceWei: "10000000000000000",
    approvalStatus: "approved",
    executionState: "approved",
    approveTxHash: null,
    depositTxHash: null,
    depositL1BlockHash: null,
    depositL1BlockNumber: null,
    depositEventAccountIndex: null,
    lighterTxHash: null,
    lighterTxStatus: null,
    lighterBlockHeight: null,
    lighterExecutedAt: null,
    lighterEvidenceObservedAt: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

function fresh(overrides: Partial<LighterDepositPreflightSnapshot> = {}): LighterDepositPreflightSnapshot {
  return {
    observedAt: new Date("2030-01-01T00:00:09.000Z"),
    walletAddress: WALLET,
    chainId: 1,
    ethereumBlockNumber: "23456790",
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
    walletNativeBalanceWei: "1000000000000000000",
    approvalRequired: true,
    approveGasLimit: "90000",
    depositGasLimit: "190000",
    maxFeePerGasWei: "19000000000",
    maxPriorityFeePerGasWei: "1900000000",
    approveMaxFeeWei: "1710000000000000",
    depositMaxFeeWei: "3610000000000000",
    totalMaxFeeWei: "5320000000000000",
    nativeReserveWei: "3610000000000000",
    requiredNativeBalanceWei: "8930000000000000",
    ...overrides,
  };
}

describe("Lighter deposit pre-sign revalidation", () => {
  it("accepts equivalent-or-safer live evidence", () => {
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: intent(),
      fresh: fresh(),
      stage: "execution",
      now: NOW,
    })).not.toThrow();
  });

  it("allows a now-sufficient allowance because it removes an approved leg", () => {
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: intent(),
      fresh: fresh({
        walletAllowanceUnits: "11000000",
        approvalRequired: false,
        approveGasLimit: "0",
        approveMaxFeeWei: "0",
        totalMaxFeeWei: "3610000000000000",
        requiredNativeBalanceWei: "7220000000000000",
      }),
      stage: "execution",
      now: NOW,
    })).not.toThrow();
  });

  it("refuses a newly required approval leg", () => {
    const approved = intent({
      preflightWalletAllowanceUnits: "11000000",
      preflightApproveGasLimit: "0",
      preflightApproveMaxFeeWei: "0",
      preflightTotalMaxFeeWei: "4000000000000000",
      preflightRequiredNativeBalanceWei: "8000000000000000",
    });
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: approved,
      fresh: fresh(),
      stage: "execution",
      now: NOW,
    })).toThrow(/unapproved transaction/);
  });

  it.each([
    ["changed destination", { walletAddress: "0x1111111111111111111111111111111111111111" }],
    ["higher gas", { approveGasLimit: "100001", approveMaxFeeWei: "1900019000000000" }],
    ["higher per-gas fee", { maxFeePerGasWei: "20000000001" }],
    ["higher leg maximum", { approveMaxFeeWei: "2000000000000001" }],
    ["older head", { ethereumBlockNumber: "23456788" }],
  ])("refuses %s", (_name, override) => {
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: intent(),
      fresh: fresh(override),
      stage: "execution",
      now: NOW,
    })).toThrow(/revalidation refused/);
  });

  it("refuses stale refreshed evidence", () => {
    expect(() => assertLighterDepositPreflightWithinApproval({
      intent: intent(),
      fresh: fresh({ observedAt: new Date("2029-12-31T23:59:00.000Z") }),
      stage: "execution",
      now: NOW,
    })).toThrow(/stale/);
  });

  it("projects exact signer ceilings from the approved snapshot", () => {
    expect(approvedFeeCeiling(intent(), "deposit")).toEqual({
      gasLimit: 200000n,
      maxFeePerGas: 20000000000n,
      maxPriorityFeePerGas: 2000000000n,
      maxNetworkFeeWei: 4000000000000000n,
    });
  });
});
