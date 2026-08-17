import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { validatePreparedActionFollowUp } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

const mocks = vi.hoisted(() => ({
  createOrFind: vi.fn(),
  listUnresolvedDepositsForWallet: vi.fn(),
  isIntegrationEnabled: vi.fn(),
  setIntegrationEnabled: vi.fn(),
  findByIntentId: vi.fn(),
  markApprovalDecision: vi.fn(),
  markConfirmedRecoveryDecision: vi.fn(),
  renewPristineApproved: vi.fn(),
  renewConfirmedApproval: vi.fn(),
  supersedePristine: vi.fn(),
  markAmbiguous: vi.fn(),
  withSessionControlLock: vi.fn(),
  withSessionControlLocks: vi.fn(),
  resolveSelectedAddress: vi.fn(),
  resolveSigningWallet: vi.fn(),
  assertApprovalBinding: vi.fn(),
  acquireExecutionLease: vi.fn(),
  leaseAssertOwned: vi.fn(),
  leaseRelease: vi.fn(),
  buildExecutionDeps: vi.fn(),
  executeApprovedDeposit: vi.fn(),
  releaseGateEnabled: vi.fn(),
  buildRepairDeps: vi.fn(),
  repairDepositIntent: vi.fn(),
  getOnboardingWorkflow: vi.fn(),
  readDepositPreflight: vi.fn(),
  feePreflightComplete: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  createOrFindLiveDepositApprovalPendingWith: mocks.createOrFind,
  listUnresolvedDepositsForWallet: mocks.listUnresolvedDepositsForWallet,
  findByIntentId: mocks.findByIntentId,
  markApprovalDecisionWith: (_client: unknown, input: unknown) =>
    mocks.markApprovalDecision(input),
  markConfirmedApprovalRecoveryDecisionWith: (_client: unknown, input: unknown) =>
    mocks.markConfirmedRecoveryDecision(input),
  renewPristineApprovedDepositIntentWith: (_client: unknown, input: unknown) =>
    mocks.renewPristineApproved(input),
  renewConfirmedApprovalDepositIntentWith: (_client: unknown, input: unknown) =>
    mocks.renewConfirmedApproval(input),
  supersedePristineDepositIntentWith: (_client: unknown, input: unknown) =>
    mocks.supersedePristine(input),
  markAmbiguousWith: (_client: unknown, intentId: string, reason: string) =>
    mocks.markAmbiguous(intentId, reason),
}));

vi.mock("@vex-agent/db/repos/lighter-integration-settings.js", () => ({
  isLighterIntegrationEnabled: mocks.isIntegrationEnabled,
  setLighterIntegrationEnabled: mocks.setIntegrationEnabled,
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-workflows.js", () => ({
  getLighterOnboardingWorkflow: mocks.getOnboardingWorkflow,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
  withSessionControlLocks: mocks.withSessionControlLocks,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: mocks.resolveSelectedAddress,
  resolveSigningWallet: mocks.resolveSigningWallet,
  walletScopeErrorToResult: (err: unknown) => {
    throw err;
  },
}));

vi.mock("@vex-agent/tools/protocols/lighter/deposit-approval-binding.js", () => ({
  assertLighterDepositApprovalBinding: mocks.assertApprovalBinding,
}));

vi.mock("@tools/lighter/wallet-funding/execution-lease.js", () => ({
  acquireLighterDepositExecutionLease: mocks.acquireExecutionLease,
}));

vi.mock("@tools/lighter/wallet-funding/deposit-execution-deps.js", () => ({
  buildLighterDepositExecutionDeps: mocks.buildExecutionDeps,
}));

vi.mock("@tools/lighter/wallet-funding/deposit-execution.js", () => ({
  executeApprovedLighterDeposit: mocks.executeApprovedDeposit,
}));

vi.mock("@tools/lighter/wallet-funding/deposit-preflight.js", () => ({
  readLighterDepositPreflight: mocks.readDepositPreflight,
  isLighterDepositFeePreflightComplete: mocks.feePreflightComplete,
}));

vi.mock("@tools/lighter/wallet-funding/release-gates.js", () => ({
  LIGHTER_DEPOSIT_RELEASE_GATE: {
    isEnabled: mocks.releaseGateEnabled,
  },
}));

vi.mock("@vex-agent/sync/lighter-deposit-repair.js", () => ({
  buildProductionLighterDepositRepairDeps: mocks.buildRepairDeps,
  repairLighterDepositIntent: mocks.repairDepositIntent,
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LIGHTER_DEPOSIT_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/deposit.js"
);

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: "session-1",
};

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: null,
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
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
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

function preflightSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: new Date(),
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
    amountUnits: "11000000",
    minimumTransferUnits: "1000000",
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSelectedAddress.mockReturnValue(WALLET);
  mocks.listUnresolvedDepositsForWallet.mockResolvedValue([]);
  mocks.getOnboardingWorkflow.mockResolvedValue(null);
  mocks.isIntegrationEnabled.mockResolvedValue(true);
  mocks.setIntegrationEnabled.mockResolvedValue({ enabled: true });
  mocks.releaseGateEnabled.mockReturnValue(true);
  mocks.feePreflightComplete.mockReturnValue(true);
  mocks.buildRepairDeps.mockReturnValue({ marker: "repair-deps" });
  mocks.repairDepositIntent.mockImplementation(async (row) => ({
    intentId: row.intentId,
    stateBefore: row.executionState,
    stateAfter: row.executionState,
    resolution: "awaiting_chain",
    evidence: "none",
    txHash: row.depositTxHash ?? row.approveTxHash,
    accountIndex: null,
    guidance: "wait",
  }));
  mocks.assertApprovalBinding.mockResolvedValue(undefined);
  mocks.markAmbiguous.mockResolvedValue(intentRow({ executionState: "ambiguous" }));
  mocks.renewPristineApproved.mockImplementation(async (input) =>
    intentRow({
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approved",
      decisionReason: "user approved exact Lighter deposit intent",
      expiresAt: input.expiresAt,
    }));
  mocks.renewConfirmedApproval.mockImplementation(async (input) =>
    intentRow({
      approvalId: null,
      approvalStatus: "approval_pending",
      executionState: "approve_confirmed",
      approveTxHash: `0x${"a".repeat(64)}`,
      approveTxFrom: WALLET,
      approveTxNonce: "7",
      decisionReason: null,
      preflightWalletAllowanceUnits: input.preflight.walletAllowanceUnits,
      preflightEthereumBlockNumber: input.preflight.ethereumBlockNumber,
      preflightLighterBlockNumber: input.preflight.lighterBlockNumber,
      preflightObservedAt: input.preflight.observedAt,
      preflightApproveGasLimit: input.preflight.approveGasLimit,
      preflightDepositGasLimit: input.preflight.depositGasLimit,
      preflightMaxFeePerGasWei: input.preflight.maxFeePerGasWei,
      preflightMaxPriorityFeePerGasWei: input.preflight.maxPriorityFeePerGasWei,
      preflightApproveMaxFeeWei: input.preflight.approveMaxFeeWei,
      preflightDepositMaxFeeWei: input.preflight.depositMaxFeeWei,
      preflightTotalMaxFeeWei: input.preflight.totalMaxFeeWei,
      preflightNativeReserveWei: input.preflight.nativeReserveWei,
      preflightRequiredNativeBalanceWei: input.preflight.requiredNativeBalanceWei,
      expiresAt: input.expiresAt,
    }));
  mocks.markConfirmedRecoveryDecision.mockImplementation(async (input) =>
    intentRow({
      approvalId: input.approvalId ?? null,
      approvalStatus: input.decision,
      executionState: input.decision === "approved" ? "approve_confirmed" : "failed",
      approveTxHash: `0x${"a".repeat(64)}`,
      approveTxFrom: WALLET,
      approveTxNonce: "7",
      preflightWalletAllowanceUnits: "11000000",
      preflightApproveGasLimit: "0",
      preflightApproveMaxFeeWei: "0",
      preflightTotalMaxFeeWei: "4000000000000000",
      preflightRequiredNativeBalanceWei: "8000000000000000",
    }));
  mocks.supersedePristine.mockImplementation(async () =>
    intentRow({
      sessionId: "session-previous",
      approvalStatus: "approved",
      executionState: "failed",
      failureReason:
        "Superseded by a fresh Lighter onboarding session before any transaction was signed or submitted.",
    }));
  mocks.leaseAssertOwned.mockResolvedValue(undefined);
  mocks.leaseRelease.mockResolvedValue(undefined);
  mocks.buildExecutionDeps.mockReturnValue({ marker: "execution-deps" });
  mocks.withSessionControlLock.mockImplementation(async (_sessionId, fn) =>
    fn({ marker: "locked-client" }));
  mocks.withSessionControlLocks.mockImplementation(async (_sessionIds, fn) =>
    fn({ marker: "multi-locked-client" }));
  mocks.readDepositPreflight.mockResolvedValue(preflightSnapshot());
});

describe("lighter.deposit.status", () => {
  it("lists only unresolved deposits for the selected wallet without executing", async () => {
    mocks.getOnboardingWorkflow.mockResolvedValueOnce({
      environment: "core",
      walletAddress: WALLET.toLowerCase(),
      workflowState: "ambiguous",
      lastStableState: "deposit_staged",
      activeDepositIntentId: intentRow().intentId,
      resolvedAccountIndex: null,
      apiKeyIndex: null,
      publicKeyFingerprint: null,
      failureCode: "deposit_outcome_ambiguous",
      revision: 4,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-01T00:02:00.000Z"),
    });
    mocks.listUnresolvedDepositsForWallet.mockResolvedValueOnce([
      intentRow({
        executionState: "ambiguous",
        approvalStatus: "approved",
        depositTxHash: `0x${"b".repeat(64)}`,
        failureReason: "receipt unavailable",
      }),
    ]);
    mocks.findByIntentId.mockResolvedValueOnce(intentRow({
      executionState: "ambiguous",
      approvalStatus: "approved",
      depositTxHash: `0x${"b".repeat(64)}`,
      failureReason: "receipt unavailable",
    }));

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.status"]!(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(mocks.listUnresolvedDepositsForWallet).toHaveBeenCalledWith(
      "core",
      WALLET,
    );
    expect(result.data).toMatchObject({
      source: "vex_lighter_local_deposit_status",
      checkedIntents: 1,
      reconciliationErrors: 0,
      workflow: {
        state: "ambiguous",
        lastStableState: "deposit_staged",
        activeDepositIntentId: intentRow().intentId,
        failureCode: "deposit_outcome_ambiguous",
        revision: 4,
      },
      intents: [
        {
          intentId: intentRow().intentId,
          executionState: "ambiguous",
          nextAction: expect.stringContaining("Never rebroadcast"),
        },
      ],
    });
    expect(mocks.repairDepositIntent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: intentRow().intentId }),
      { marker: "repair-deps" },
    );
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it("refuses an exact intent owned by a different wallet", async () => {
    mocks.findByIntentId.mockResolvedValueOnce(intentRow({
      walletAddress: "0x2222222222222222222222222222222222222222",
    }));

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.status"]!(
      { environment: "core", intentId: intentRow().intentId },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("does not belong to this wallet and environment");
  });

  it("returns durable local status when reconciliation infrastructure is unavailable", async () => {
    mocks.listUnresolvedDepositsForWallet.mockResolvedValueOnce([
      intentRow({
        executionState: "deposit_submitted",
        approvalStatus: "approved",
        depositTxHash: `0x${"b".repeat(64)}`,
      }),
    ]);
    mocks.buildRepairDeps.mockImplementationOnce(() => {
      throw new Error("RPC config unavailable");
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.status"]!(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      checkedIntents: 1,
      reconciliationErrors: 1,
      intents: [{ executionState: "deposit_submitted" }],
    });
    expect(mocks.repairDepositIntent).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });
});

describe("lighter.deposit execution lease", () => {
  const approvedContext: ProtocolExecutionContext = {
    ...CONTEXT,
    approved: true,
    approvalId: "approval-1",
  };

  beforeEach(() => {
    mocks.findByIntentId.mockResolvedValue(intentRow());
    mocks.markApprovalDecision.mockResolvedValue(intentRow({
      approvalId: "approval-1",
      approvalStatus: "approved",
      executionState: "approved",
    }));
  });

  it("honors a disable that lands before approved execution", async () => {
    mocks.isIntegrationEnabled.mockResolvedValue(false);

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("disabled for this Vex wallet before execution");
    expect(result.output).toContain("Nothing was signed or submitted");
    expect(mocks.markApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it("refuses a busy wallet lease before resolving the private key", async () => {
    mocks.acquireExecutionLease.mockResolvedValue({
      acquired: false,
      retryAfter: new Date("2030-01-01T00:02:00.000Z"),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("owns this Ethereum wallet execution slot");
    expect(result.output).toContain("Nothing was signed");
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
    expect(mocks.buildExecutionDeps).not.toHaveBeenCalled();
  });

  it("stops before lease acquisition and key resolution while fee preflight is incomplete", async () => {
    mocks.feePreflightComplete.mockReturnValue(false);

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_recorded_fee_preflight_closed",
      executionState: "approved",
    });
    expect(JSON.stringify(result.output)).toContain("signing key was not resolved");
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
    expect(mocks.buildExecutionDeps).not.toHaveBeenCalled();
  });

  it("revalidates live fee exposure before lease acquisition and key resolution", async () => {
    mocks.readDepositPreflight.mockResolvedValueOnce({
      ...(await mocks.readDepositPreflight()),
      observedAt: new Date(),
      maxFeePerGasWei: "20000000001",
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("exceeds the user's approved ceiling");
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it("holds the lease across execution and always releases it", async () => {
    mocks.acquireExecutionLease.mockResolvedValue({
      acquired: true,
      handle: {
        assertOwned: mocks.leaseAssertOwned,
        releaseExecutionLease: mocks.leaseRelease,
      },
    });
    mocks.resolveSigningWallet.mockReturnValue({
      family: "eip155",
      address: WALLET,
      privateKey: `0x${"1".repeat(64)}`,
    });
    mocks.executeApprovedDeposit.mockResolvedValue({
      status: "l2_pending",
      approveTxHash: null,
      depositTxHash: `0x${"b".repeat(64)}`,
      reason: "exact Lighter evidence pending",
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success, result.output).toBe(true);
    const [acquiredAt] = mocks.acquireExecutionLease.mock.invocationCallOrder;
    const [keyResolvedAt] = mocks.resolveSigningWallet.mock.invocationCallOrder;
    expect(acquiredAt).toBeLessThan(keyResolvedAt!);
    expect(mocks.leaseAssertOwned).toHaveBeenCalled();
    expect(mocks.buildExecutionDeps).toHaveBeenCalledWith(expect.objectContaining({
      privateKey: `0x${"1".repeat(64)}`,
      sessionId: "session-1",
      assertExecutionLease: expect.any(Function),
    }));
    expect(mocks.executeApprovedDeposit).toHaveBeenCalledWith({
      intent: expect.objectContaining({ executionState: "approved" }),
      deps: { marker: "execution-deps" },
    });
    expect(JSON.stringify(result.output)).toContain("awaiting Lighter confirmation");
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("executes a pristine approved intent only through a freshly bound approval", async () => {
    const pristineApproved = intentRow({
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approved",
      decisionReason: "user approved exact Lighter deposit intent",
    });
    mocks.findByIntentId.mockResolvedValueOnce(pristineApproved);
    mocks.acquireExecutionLease.mockResolvedValue({
      acquired: true,
      handle: {
        assertOwned: mocks.leaseAssertOwned,
        releaseExecutionLease: mocks.leaseRelease,
      },
    });
    mocks.resolveSigningWallet.mockReturnValue({
      family: "eip155",
      address: WALLET,
      privateKey: `0x${"1".repeat(64)}`,
    });
    mocks.executeApprovedDeposit.mockResolvedValue({
      status: "l2_pending",
      approveTxHash: null,
      depositTxHash: `0x${"b".repeat(64)}`,
      reason: "exact Lighter evidence pending",
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: pristineApproved.intentId },
      approvedContext,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.assertApprovalBinding).toHaveBeenCalledWith({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: pristineApproved,
    });
    expect(mocks.markApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.executeApprovedDeposit).toHaveBeenCalledWith({
      intent: pristineApproved,
      deps: { marker: "execution-deps" },
    });
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("executes a confirmed-allowance recovery only from its fresh pending approval", async () => {
    const recoveryPending = intentRow({
      approvalStatus: "approval_pending",
      executionState: "approve_confirmed",
      approveTxHash: `0x${"a".repeat(64)}`,
      approveTxFrom: WALLET,
      approveTxNonce: "7",
      preflightWalletAllowanceUnits: "11000000",
      preflightApproveGasLimit: "0",
      preflightApproveMaxFeeWei: "0",
      preflightTotalMaxFeeWei: "4000000000000000",
      preflightRequiredNativeBalanceWei: "8000000000000000",
    });
    mocks.findByIntentId.mockResolvedValueOnce(recoveryPending);
    mocks.readDepositPreflight.mockResolvedValueOnce(preflightSnapshot({
      walletAllowanceUnits: "11000000",
      approvalRequired: false,
      approveGasLimit: "0",
      approveMaxFeeWei: "0",
      totalMaxFeeWei: "4000000000000000",
      requiredNativeBalanceWei: "8000000000000000",
    }));
    mocks.acquireExecutionLease.mockResolvedValue({
      acquired: true,
      handle: {
        assertOwned: mocks.leaseAssertOwned,
        releaseExecutionLease: mocks.leaseRelease,
      },
    });
    mocks.resolveSigningWallet.mockReturnValue({
      family: "eip155",
      address: WALLET,
      privateKey: `0x${"1".repeat(64)}`,
    });
    mocks.executeApprovedDeposit.mockResolvedValue({
      status: "l2_pending",
      approveTxHash: `0x${"a".repeat(64)}`,
      depositTxHash: `0x${"b".repeat(64)}`,
      reason: "exact Lighter evidence pending",
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: recoveryPending.intentId },
      approvedContext,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.markConfirmedRecoveryDecision).toHaveBeenCalledWith({
      intentId: recoveryPending.intentId,
      decision: "approved",
      approvalId: "approval-1",
      reason: "user approved exact Lighter deposit-only recovery",
    });
    expect(mocks.markApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.executeApprovedDeposit).toHaveBeenCalledWith({
      intent: expect.objectContaining({ executionState: "approve_confirmed" }),
      deps: { marker: "execution-deps" },
    });
  });

  it("does not reuse an already spent approval for a confirmed allowance", async () => {
    mocks.findByIntentId.mockResolvedValueOnce(intentRow({
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approve_confirmed",
      approveTxHash: `0x${"a".repeat(64)}`,
      approveTxFrom: WALLET,
      approveTxNonce: "7",
    }));

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("not approval-authorized");
    expect(mocks.markConfirmedRecoveryDecision).not.toHaveBeenCalled();
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
  });

  it("reports an executor throw as ambiguous so approval runtime cannot claim failure", async () => {
    const depositHash = `0x${"b".repeat(64)}`;
    mocks.acquireExecutionLease.mockResolvedValue({
      acquired: true,
      handle: {
        assertOwned: mocks.leaseAssertOwned,
        releaseExecutionLease: mocks.leaseRelease,
      },
    });
    mocks.resolveSigningWallet.mockReturnValue({
      family: "eip155",
      address: WALLET,
      privateKey: `0x${"1".repeat(64)}`,
    });
    mocks.executeApprovedDeposit.mockRejectedValueOnce(new Error("receipt unavailable"));
    mocks.markAmbiguous.mockResolvedValueOnce(intentRow({
      executionState: "ambiguous",
      depositTxHash: depositHash,
    }));

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit"]!(
      { intentId: intentRow().intentId },
      approvedContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      source: "vex_lighter_live_deposit",
      status: "ambiguous",
      stage: "deposit",
      txHash: depositHash,
    });
    expect(mocks.markAmbiguous).toHaveBeenCalledWith(
      intentRow().intentId,
      "Deposit executor error: receipt unavailable",
    );
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });
});

describe("lighter.deposit.prepare", () => {
  it("activates managed Lighter setup before preparing a deposit", async () => {
    mocks.isIntegrationEnabled.mockResolvedValue(false);
    mocks.createOrFind.mockResolvedValue({
      outcome: "created",
      intent: intentRow(),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.setIntegrationEnabled).toHaveBeenCalledWith({
      environment: "core",
      walletAddress: WALLET,
      enabled: true,
    });
    expect(mocks.createOrFind).toHaveBeenCalled();
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
  });

  it("creates the money-state row inside the session control lock", async () => {
    mocks.createOrFind.mockResolvedValue({
      outcome: "created",
      intent: intentRow(),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.withSessionControlLock).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function),
    );
    expect(mocks.createOrFind).toHaveBeenCalledWith(
      { marker: "locked-client" },
      expect.objectContaining({
        sessionId: "session-1",
        walletAddress: WALLET,
        amountUnits: "11000000",
        chainId: 1,
        assetIndex: 3,
        routeType: 0,
        preflight: expect.objectContaining({
          ethereumBlockNumber: "23456789",
          walletBalanceUnits: "50000000",
          approvalRequired: true,
        }),
      }),
    );
    expect(result.preparedActionFollowUp).toMatchObject({
      toolName: "execute_tool",
      args: {
        toolId: "lighter.deposit",
        params: { intentId: intentRow().intentId },
      },
      approvalPreview: {
        criticalArgs: { amountDisplay: "11 USDC" },
      },
    });
    expect(
      validatePreparedActionFollowUp(
        "lighter__deposit__prepare",
        result.preparedActionFollowUp!,
      ),
    ).toEqual({ ok: true, followUp: result.preparedActionFollowUp });
  });

  it("does not create an approval when the live deposit preflight fails", async () => {
    mocks.readDepositPreflight.mockRejectedValueOnce(
      new Error("The selected wallet does not have enough USDC for this deposit."),
    );

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("does not have enough USDC");
    expect(mocks.createOrFind).not.toHaveBeenCalled();
    expect(mocks.withSessionControlLock).not.toHaveBeenCalled();
  });

  it("reissues an approval for the same session's exact pristine intent", async () => {
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: intentRow(),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_prepared",
      intentId: intentRow().intentId,
      approvalReissued: true,
    });
    expect(result.preparedActionFollowUp).toMatchObject({
      args: {
        toolId: "lighter.deposit",
        params: { intentId: intentRow().intentId },
      },
    });
  });

  it("renews a gate-closed pristine approval and requires a fresh approval card", async () => {
    const gateClosedIntent = intentRow({
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approved",
      decisionReason: "user approved exact Lighter deposit intent",
    });
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: gateClosedIntent,
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_prepared",
      intentId: gateClosedIntent.intentId,
      approvalReissued: true,
    });
    expect(mocks.renewPristineApproved).toHaveBeenCalledWith({
      intentId: gateClosedIntent.intentId,
      sessionId: "session-1",
      expiresAt: expect.any(Date),
    });
    expect(result.preparedActionFollowUp).toMatchObject({
      args: {
        toolId: "lighter.deposit",
        params: { intentId: gateClosedIntent.intentId },
      },
    });
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it("prepares a fresh deposit-only approval after the allowance already confirmed", async () => {
    const confirmed = intentRow({
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approve_confirmed",
      approveTxHash: `0x${"a".repeat(64)}`,
      approveTxFrom: WALLET,
      approveTxNonce: "7",
      decisionReason: "user approved exact Lighter deposit intent",
    });
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: confirmed,
    });
    mocks.readDepositPreflight.mockResolvedValueOnce(preflightSnapshot({
      walletAllowanceUnits: "11000000",
      approvalRequired: false,
      approveGasLimit: "0",
      approveMaxFeeWei: "0",
      totalMaxFeeWei: "4000000000000000",
      requiredNativeBalanceWei: "8000000000000000",
    }));

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_prepared",
      intentId: confirmed.intentId,
      approvalRequired: false,
      approvalReissued: true,
      recovery: "confirmed_allowance_deposit_only",
    });
    expect(mocks.renewConfirmedApproval).toHaveBeenCalledWith({
      intentId: confirmed.intentId,
      sessionId: "session-1",
      preflight: expect.objectContaining({
        approvalRequired: false,
        walletAllowanceUnits: "11000000",
      }),
      expiresAt: expect.any(Date),
    });
    expect(result.preparedActionFollowUp).toMatchObject({
      approvalPreview: {
        criticalArgs: {
          approvalRequired: false,
          preflightApproveGasLimit: "0",
        },
      },
    });
    expect(mocks.acquireExecutionLease).not.toHaveBeenCalled();
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it("starts fresh in a new chat after a prior gate-closed approval signed nothing", async () => {
    const previous = intentRow({
      sessionId: "session-previous",
      approvalId: "approval-previous",
      approvalStatus: "approved",
      executionState: "approved",
      decisionReason: "user approved exact Lighter deposit intent",
    });
    const fresh = intentRow({
      intentId: "lighter-onboard-00000000-0000-4000-8000-000000000002",
      sessionId: "session-1",
    });
    mocks.createOrFind
      .mockResolvedValueOnce({ outcome: "live_conflict", intent: previous })
      .mockResolvedValueOnce({ outcome: "created", intent: fresh });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_prepared",
      intentId: fresh.intentId,
    });
    expect(result.data).not.toHaveProperty("approvalReissued");
    expect(mocks.withSessionControlLocks).toHaveBeenCalledWith(
      ["session-previous", "session-1"],
      expect.any(Function),
    );
    expect(mocks.supersedePristine).toHaveBeenCalledWith({
      intentId: previous.intentId,
      sessionId: "session-previous",
      environment: "core",
      walletAddress: WALLET,
    });
    expect(mocks.createOrFind).toHaveBeenLastCalledWith(
      { marker: "multi-locked-client" },
      expect.objectContaining({
        sessionId: "session-1",
        walletAddress: WALLET,
        amountUnits: "11000000",
      }),
    );
    expect(result.preparedActionFollowUp).toMatchObject({
      args: {
        toolId: "lighter.deposit",
        params: { intentId: fresh.intentId },
      },
    });
    expect(mocks.resolveSigningWallet).not.toHaveBeenCalled();
  });

  it.each([
    { approvalId: "approval-previous" },
    { approveTxHash: `0x${"a".repeat(64)}` },
    { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
  ])("refuses to reissue a non-pristine approval conflict: %o", async (override) => {
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: intentRow(override),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("already unresolved");
    expect(result.preparedActionFollowUp).toBeUndefined();
  });

  it("refuses to renew an approved intent after any transaction identity was staged", async () => {
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: intentRow({
        sessionId: "session-previous",
        approvalId: "approval-previous",
        approvalStatus: "approved",
        executionState: "approved",
        approveTxHash: `0x${"a".repeat(64)}`,
      }),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("already unresolved in state approved");
    expect(mocks.renewPristineApproved).not.toHaveBeenCalled();
    expect(result.preparedActionFollowUp).toBeUndefined();
  });

  it("returns a deterministic conflict and never prepares a second deposit", async () => {
    mocks.createOrFind.mockResolvedValue({
      outcome: "live_conflict",
      intent: intentRow({ executionState: "ambiguous", approvalStatus: "approved" }),
    });

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "12" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(intentRow().intentId);
    expect(result.output).toContain("already unresolved in state ambiguous");
    expect(result.output).toContain("No second deposit was prepared");
    expect(result.preparedActionFollowUp).toBeUndefined();
  });
});
