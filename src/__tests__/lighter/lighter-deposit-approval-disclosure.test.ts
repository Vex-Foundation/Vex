import { describe, expect, it } from "vitest";

import { buildLighterDepositApprovalDisclosure } from "@tools/lighter/wallet-funding/deposit-approval-disclosure.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

function depositIntent(overrides: Partial<LighterOnboardingIntentRow> = {}): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-test",
    sessionId: "s1",
    protocolExecutionId: null,
    approvalId: null,
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: CONTRACT,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11520000",
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    preflightMinimumTransferUnits: "1000000",
    preflightWalletBalanceUnits: "50000000",
    preflightWalletAllowanceUnits: "0",
    preflightWalletNativeBalanceWei: "1000000000000000000",
    preflightEthereumBlockNumber: "23456789",
    preflightLighterBlockNumber: "23456780",
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
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    approveTxHash: null,
    approveTxFrom: null,
    approveTxNonce: null,
    approveReplacementTxHash: null,
    approveReplacementReason: null,
    approveReplacementObservedAt: null,
    depositTxHash: null,
    depositTxFrom: null,
    depositTxNonce: null,
    depositReplacementTxHash: null,
    depositReplacementReason: null,
    depositReplacementObservedAt: null,
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
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

describe("buildLighterDepositApprovalDisclosure", () => {
  it("recomputes the amount and destination from the persisted intent", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.amountDisplay).toBe("11.52 USDC");
    expect(d.walletBalanceDisplay).toBe("50 USDC");
    expect(d.walletAllowanceDisplay).toBe("0 USDC");
    expect(d.nativeBalanceDisplay).toBe("1 ETH");
    expect(d.approvalRequired).toBe(true);
    expect(d.creditAddress).toBe(WALLET);
    expect(d.depositContract).toBe(CONTRACT);
    expect(d.chainLabel).toBe("Ethereum");
    expect(d.routeLabel).toBe("perps");
    expect(d.environmentLabel).toBe("Lighter Core");
    expect(d.summary).toContain("Deposit 11.52 USDC");
    expect(d).not.toHaveProperty("maximumNetworkFeeDisplay");
    expect(d).not.toHaveProperty("requiredNativeBalanceDisplay");
    expect(d).not.toHaveProperty("maxFeePerGasDisplay");
  });

  it("states the deposit-only scope (no trade, no withdrawal)", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.scopeNote).toMatch(/only a deposit/i);
    expect(d.scopeNote).toMatch(/does not place any trade/i);
    expect(d.scopeNote).toMatch(/withdrawal/i);
  });

  it("labels account creation without disclosing a stale gas quote", () => {
    const d = buildLighterDepositApprovalDisclosure(depositIntent());
    expect(d.createsAccountNote).toMatch(/first Lighter deposit/i);
    expect(d).not.toHaveProperty("gasNote");
    expect(d).not.toHaveProperty("approveGasLimit");
    expect(d).not.toHaveProperty("maxFeePerGasWei");
  });

  it("refuses a non-deposit capability", () => {
    expect(() => buildLighterDepositApprovalDisclosure(depositIntent({ capability: "swap" }))).toThrow(/only for Lighter deposit/i);
  });

  it("refuses an intent missing deposit fields", () => {
    expect(() => buildLighterDepositApprovalDisclosure(depositIntent({ amountUnits: null }))).toThrow(/missing required deposit/i);
  });
});
