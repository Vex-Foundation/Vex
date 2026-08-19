import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getAuditIntent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.getApproval,
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.getAuditIntent,
}));

const { assertLighterDepositApprovalBinding } = await import(
  "@vex-agent/tools/protocols/lighter/deposit-approval-binding.js"
);

const INTENT_ID = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const WALLET = "0x1111111111111111111111111111111111111111";
const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");
const INTENT_UPDATED_AT = new Date("2030-01-01T00:00:01.000Z");
const DEPOSIT_CALLDATA = buildLighterDepositCalldata({
  environment: "core",
  to: WALLET,
  amountUnits: 1_000_000n,
}).data;

const INTENT = {
  intentId: INTENT_ID,
  environment: "core",
  walletAddress: WALLET,
  depositTo: WALLET,
  depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
  chainId: 1,
  assetIndex: 3,
  routeType: 0,
  amountUnits: "1000000",
  settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  settlementTokenDecimals: 6,
  preflightMinimumTransferUnits: "1000000",
  preflightWalletBalanceUnits: "1975761",
  preflightWalletAllowanceUnits: "0",
  preflightWalletNativeBalanceWei: "512000000000000",
  preflightEthereumBlockNumber: "25776307",
  preflightLighterBlockNumber: "0",
  preflightObservedAt: OBSERVED_AT,
  preflightApproveGasLimit: "112698",
  preflightDepositGasLimit: "385004",
  preflightMaxFeePerGasWei: "120185306",
  preflightMaxPriorityFeePerGasWei: "100000000",
  preflightApproveMaxFeeWei: "13544642193588",
  preflightDepositMaxFeeWei: "46271739031624",
  preflightTotalMaxFeeWei: "59816381225212",
  preflightNativeReserveWei: "46271739031624",
  preflightRequiredNativeBalanceWei: "106088120256836",
  preflightPublicSnapshot: {
    observedAt: OBSERVED_AT.toISOString(),
    environment: "core",
    lighterRestBaseUrl: "https://mainnet.zklighter.elliot.ai",
    settlementNetworkName: "Ethereum mainnet",
    walletAddress: WALLET,
    beneficiaryAddress: WALLET,
    chainId: 1,
    settlementBlockNumber: "25776307",
    ethereumBlockNumber: "25776307",
    lighterBlockNumber: "0",
    gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    gatewayImplementationAddress: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenImplementationAddress: null,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "1000000",
    minimumTransferUnits: "1000000",
    depositCalldata: DEPOSIT_CALLDATA,
    depositValueWei: "0",
    walletBalanceUnits: "1975761",
    walletAllowanceUnits: "0",
    walletNativeBalanceWei: "512000000000000",
    approvalRequired: true,
    approveGasLimit: "112698",
    depositGasLimit: "385004",
    maxFeePerGasWei: "120185306",
    maxPriorityFeePerGasWei: "100000000",
    approveMaxFeeWei: "13544642193588",
    depositMaxFeeWei: "46271739031624",
    totalMaxFeeWei: "59816381225212",
    nativeReserveWei: "46271739031624",
    requiredNativeBalanceWei: "106088120256836",
  },
  updatedAt: INTENT_UPDATED_AT,
} as LighterOnboardingIntentRow;

function criticalArgs() {
  return {
    toolId: "lighter.deposit",
    intentId: INTENT.intentId,
    environment: INTENT.environment,
    walletAddress: INTENT.walletAddress,
    depositTo: INTENT.depositTo,
    depositContract: INTENT.depositContract,
    chainId: INTENT.chainId,
    assetIndex: INTENT.assetIndex,
    routeType: INTENT.routeType,
    amountUnits: INTENT.amountUnits,
    amountDisplay: "1 USDC",
    settlementTokenAddress: INTENT.settlementTokenAddress,
    settlementTokenDecimals: INTENT.settlementTokenDecimals,
    preflightMinimumTransferUnits: INTENT.preflightMinimumTransferUnits,
    preflightWalletBalanceUnits: INTENT.preflightWalletBalanceUnits,
    preflightWalletAllowanceUnits: INTENT.preflightWalletAllowanceUnits,
    preflightEthereumBlockNumber: INTENT.preflightEthereumBlockNumber,
    preflightLighterBlockNumber: INTENT.preflightLighterBlockNumber,
    preflightObservedAt: OBSERVED_AT.toISOString(),
    settlementNetworkName: "Ethereum mainnet",
    lighterRestBaseUrl: "https://mainnet.zklighter.elliot.ai",
    beneficiaryAddress: WALLET,
    gatewayImplementationAddress: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenImplementationAddress: null,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    depositCalldata: DEPOSIT_CALLDATA,
    depositValueWei: "0",
    approvalRequired: true,
    summary: "Deposit 1 USDC into the selected wallet's Lighter Core account.",
    scopeNote: "This approval authorizes only the exact deposit.",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockResolvedValue({
    status: "approved",
    createdAt: "2030-01-01T00:00:02.000Z",
    toolCall: {
      command: "execute_tool",
      args: {
        toolId: "lighter.deposit",
        params: { intentId: INTENT_ID },
      },
    },
  });
  mocks.getAuditIntent.mockResolvedValue({
    sessionId: "session-1",
    decision: "approved",
    actionKind: "user_wallet_broadcast",
    executionStatus: "dispatching",
    previewJson: {
      toolName: "deposit",
      namespace: "lighter",
      criticalArgs: criticalArgs(),
    },
  });
});

describe("Lighter deposit approval binding", () => {
  it("accepts the exact on-chain broadcast approval and persisted disclosure", async () => {
    await expect(assertLighterDepositApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).resolves.toBeUndefined();
  });

  it("rejects an approval intent with the wrong action taxonomy", async () => {
    mocks.getAuditIntent.mockResolvedValue({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "deposit",
        namespace: "lighter",
        criticalArgs: criticalArgs(),
      },
    });

    await expect(assertLighterDepositApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("rejects a stale approval created before the intent was renewed", async () => {
    mocks.getApproval.mockResolvedValue({
      status: "approved",
      createdAt: "2030-01-01T00:00:00.000Z",
      toolCall: {
        command: "execute_tool",
        args: {
          toolId: "lighter.deposit",
          params: { intentId: INTENT_ID },
        },
      },
    });

    await expect(assertLighterDepositApprovalBinding({
      approvalId: "approval-old",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("rejects a preview whose exact deposit amount was changed", async () => {
    mocks.getAuditIntent.mockResolvedValue({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "deposit",
        namespace: "lighter",
        criticalArgs: { ...criticalArgs(), amountUnits: "1000001" },
      },
    });

    await expect(assertLighterDepositApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it.each([
    { environment: "rhc" },
    { chainId: 4663 },
    { beneficiaryAddress: "0x2222222222222222222222222222222222222222" },
    { depositCalldata: `${DEPOSIT_CALLDATA.slice(0, -1)}1` },
    { depositValueWei: "1" },
  ])("rejects replay or mutation of an environment-bound action field", async (override) => {
    mocks.getAuditIntent.mockResolvedValue({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "deposit",
        namespace: "lighter",
        criticalArgs: { ...criticalArgs(), ...override },
      },
    });

    await expect(assertLighterDepositApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });
});
