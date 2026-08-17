import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import {
  executeApprovedLighterDeposit,
  type LighterDepositExecutionDeps,
} from "@tools/lighter/wallet-funding/deposit-execution.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  LIGHTER_DEPOSIT_EVENT_ABI,
  type LighterDepositReceipt,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const APPROVE_HASH = "0x" + "a".repeat(64);
const DEPOSIT_HASH = "0x" + "b".repeat(64);
const BLOCK_HASH = "0x" + "c".repeat(64);

function depositReceipt(): LighterDepositReceipt {
  return {
    status: "success",
    transactionHash: DEPOSIT_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: 123n,
    from: WALLET,
    to: CONTRACT,
    logs: [{
      address: CONTRACT,
      topics: depositEventTopics(),
      data: encodeAbiParameters(
        [
          { type: "uint48" },
          { type: "address" },
          { type: "uint16" },
          { type: "uint8" },
          { type: "uint128" },
        ],
        [42, WALLET, 3, 0, 11_000_000n],
      ),
    }],
  };
}

function depositEventTopics(): readonly string[] {
  const [signature, ...unexpected] = encodeEventTopics({
    abi: LIGHTER_DEPOSIT_EVENT_ABI,
    eventName: "Deposit",
  });
  if (typeof signature !== "string" || unexpected.length !== 0) {
    throw new Error("unexpected Deposit topic fixture");
  }
  return [signature];
}

function intent(overrides: Partial<LighterOnboardingIntentRow> = {}): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-1",
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
    amountUnits: "11000000",
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    preflightMinimumTransferUnits: "1000000",
    preflightWalletBalanceUnits: "50000000",
    preflightWalletAllowanceUnits: "0",
    preflightWalletNativeBalanceWei: "1000000000000000000",
    preflightEthereumBlockNumber: "23456789",
    preflightLighterBlockNumber: "23456780",
    preflightObservedAt: new Date(),
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
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function intentsSpy() {
  return {
    markAllowanceVerified: vi.fn().mockResolvedValue({ executionState: "allowance_verified" }),
    markApproveSubmitted: vi.fn().mockResolvedValue({ executionState: "approve_submitted" }),
    markApproveConfirmed: vi.fn().mockResolvedValue({ executionState: "approve_confirmed" }),
    markDepositSubmitted: vi.fn().mockResolvedValue({ executionState: "deposit_submitted" }),
    markDepositConfirmed: vi.fn().mockResolvedValue({ executionState: "deposit_confirmed" }),
    markAmbiguous: vi.fn().mockResolvedValue({ executionState: "ambiguous" }),
    markFailed: vi.fn().mockResolvedValue({ executionState: "failed" }),
  };
}

function deps(overrides: Partial<LighterDepositExecutionDeps> = {}): LighterDepositExecutionDeps {
  return {
    depositGateEnabled: () => true,
    depositFeePreflightComplete: () => true,
    assertExecutionLease: vi.fn().mockResolvedValue(undefined),
    assertFreshPreSignPreflight: vi.fn().mockResolvedValue(undefined),
    runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
      await onHashStaged(APPROVE_HASH);
      return { skipped: false as const, txHash: APPROVE_HASH, outcome: "confirmed" as const };
    }),
    runDepositLeg: vi.fn(async ({ onHashStaged }) => {
      await onHashStaged(DEPOSIT_HASH);
      return { txHash: DEPOSIT_HASH, outcome: "confirmed" as const, receipt: depositReceipt() };
    }),
    intents: intentsSpy(),
    ...overrides,
  };
}

describe("executeApprovedLighterDeposit", () => {
  it("does nothing and signs nothing when the deposit gate is closed", async () => {
    const d = deps({
      depositGateEnabled: () => false,
      runApproveLegIfNeeded: vi.fn(),
      runDepositLeg: vi.fn(),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("gate_closed");
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does nothing when the operator gate opens before fee preflight is complete", async () => {
    const d = deps({
      depositFeePreflightComplete: () => false,
      runApproveLegIfNeeded: vi.fn(),
      runDepositLeg: vi.fn(),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({
      status: "failed",
      stage: "approve",
      reason: expect.stringContaining("fee preflight is not complete"),
    });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not start a transaction leg after the cross-process lease is lost", async () => {
    const d = deps({
      assertExecutionLease: vi.fn().mockRejectedValue(new Error("lease lost")),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not start the approval leg when signer-adjacent revalidation fails", async () => {
    const d = deps({
      assertFreshPreSignPreflight: vi.fn().mockRejectedValue(
        new Error("live fee exceeds approved ceiling"),
      ),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });

    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("stages each tx hash before broadcast and stops at Lighter credit pending", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "l2_pending", depositTxHash: DEPOSIT_HASH });
    // Hash persisted (markApproveSubmitted/markDepositSubmitted) via onHashStaged.
    expect(d.intents.markApproveSubmitted).toHaveBeenCalledWith("lighter-onboard-1", APPROVE_HASH);
    expect(d.intents.markDepositSubmitted).toHaveBeenCalledWith("lighter-onboard-1", DEPOSIT_HASH);
    expect(d.runApproveLegIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      feeCeiling: {
        gasLimit: 100000n,
        maxFeePerGas: 20000000000n,
        maxPriorityFeePerGas: 2000000000n,
        maxNetworkFeeWei: 2000000000000000n,
      },
    }));
    expect(d.runDepositLeg).toHaveBeenCalledWith(expect.objectContaining({
      feeCeiling: {
        gasLimit: 200000n,
        maxFeePerGas: 20000000000n,
        maxPriorityFeePerGas: 2000000000n,
        maxNetworkFeeWei: 4000000000000000n,
      },
    }));
    expect(d.assertFreshPreSignPreflight).toHaveBeenNthCalledWith(1, expect.anything(), "approve");
    expect(d.assertFreshPreSignPreflight).toHaveBeenNthCalledWith(2, expect.anything(), "deposit");
  });

  it("skips the approve broadcast when allowance already suffices", async () => {
    const d = deps({ runApproveLegIfNeeded: vi.fn().mockResolvedValue({ skipped: true }) });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("l2_pending");
    expect(d.intents.markApproveSubmitted).not.toHaveBeenCalled();
    expect(d.intents.markAllowanceVerified).toHaveBeenCalledWith("lighter-onboard-1");
    expect(d.intents.markApproveConfirmed).not.toHaveBeenCalled();
  });

  it("fails on an approve revert without sending the deposit", async () => {
    const d = deps({
      runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(APPROVE_HASH);
        return { skipped: false as const, txHash: APPROVE_HASH, outcome: "reverted" as const };
      }),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
    expect(d.intents.markFailed).toHaveBeenCalled();
  });

  it("marks ambiguous and does not credit when the deposit is unconfirmed", async () => {
    const d = deps({
      runDepositLeg: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(DEPOSIT_HASH);
        return { txHash: DEPOSIT_HASH, outcome: "ambiguous" as const };
      }),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "deposit" });
    expect(d.intents.markAmbiguous).toHaveBeenCalled();
  });

  it("does not claim Lighter credit from an Ethereum receipt alone", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({
      status: "l2_pending",
      reason: expect.stringContaining("Exact Lighter-side evidence"),
    });
    expect(d.intents.markDepositConfirmed).toHaveBeenCalled();
  });

  it("refuses to start unless the exact approved lifecycle state is supplied", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({
      intent: intent({ executionState: "approve_submitted" }),
      deps: d,
    });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it.each([
    { environment: "rhc" as const },
    { chainId: 8453 },
    { depositContract: "0x2222222222222222222222222222222222222222" },
    { depositTo: "0x2222222222222222222222222222222222222222" },
    { assetIndex: 4 },
    { routeType: 1 },
    { settlementTokenAddress: "0x2222222222222222222222222222222222222222" },
    { preflightWalletBalanceUnits: "10999999" },
    { preflightWalletNativeBalanceWei: "0" },
    { preflightObservedAt: null },
    { approvalStatus: "rejected" as const },
  ])("refuses a persisted deposit whose execution binding was altered: %j", async (override) => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({
      intent: intent(override),
      deps: d,
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("aborts the approval broadcast when its staged hash cannot advance by CAS", async () => {
    let broadcastReached = false;
    const intentTransitions = intentsSpy();
    intentTransitions.markApproveSubmitted.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(APPROVE_HASH);
        broadcastReached = true;
        return { skipped: false as const, txHash: APPROVE_HASH, outcome: "confirmed" as const };
      }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(broadcastReached).toBe(false);
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not sign the deposit when the sufficient-allowance transition conflicts", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markAllowanceVerified.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runApproveLegIfNeeded: vi.fn().mockResolvedValue({ skipped: true }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not sign the deposit when approval confirmation cannot advance by CAS", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markApproveConfirmed.mockResolvedValueOnce(null);
    const d = deps({ intents: intentTransitions });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "approve", txHash: APPROVE_HASH });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("aborts the deposit broadcast when its staged hash cannot advance by CAS", async () => {
    let broadcastReached = false;
    const intentTransitions = intentsSpy();
    intentTransitions.markDepositSubmitted.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runDepositLeg: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(DEPOSIT_HASH);
        broadcastReached = true;
        return { txHash: DEPOSIT_HASH, outcome: "confirmed" as const, receipt: depositReceipt() };
      }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "deposit" });
    expect(broadcastReached).toBe(false);
    expect(d.intents.markDepositConfirmed).not.toHaveBeenCalled();
  });

  it("never reports credited when a post-broadcast lifecycle transition conflicts", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markDepositConfirmed.mockResolvedValueOnce(null);
    const d = deps({ intents: intentTransitions });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "deposit", txHash: DEPOSIT_HASH });
  });
});
