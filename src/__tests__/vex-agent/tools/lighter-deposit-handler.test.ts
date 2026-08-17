import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { validatePreparedActionFollowUp } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

const mocks = vi.hoisted(() => ({
  createOrFind: vi.fn(),
  listUnresolvedDepositsForWallet: vi.fn(),
  isIntegrationEnabled: vi.fn(),
  findByIntentId: vi.fn(),
  markApprovalDecision: vi.fn(),
  markAmbiguous: vi.fn(),
  withSessionControlLock: vi.fn(),
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
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  createOrFindLiveDepositApprovalPendingWith: mocks.createOrFind,
  listUnresolvedDepositsForWallet: mocks.listUnresolvedDepositsForWallet,
  findByIntentId: mocks.findByIntentId,
  markApprovalDecisionWith: (_client: unknown, input: unknown) =>
    mocks.markApprovalDecision(input),
  markAmbiguousWith: (_client: unknown, intentId: string, reason: string) =>
    mocks.markAmbiguous(intentId, reason),
}));

vi.mock("@vex-agent/db/repos/lighter-integration-settings.js", () => ({
  isLighterIntegrationEnabled: mocks.isIntegrationEnabled,
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-workflows.js", () => ({
  getLighterOnboardingWorkflow: mocks.getOnboardingWorkflow,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
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
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    approveTxHash: null,
    depositTxHash: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: null,
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSelectedAddress.mockReturnValue(WALLET);
  mocks.listUnresolvedDepositsForWallet.mockResolvedValue([]);
  mocks.getOnboardingWorkflow.mockResolvedValue(null);
  mocks.isIntegrationEnabled.mockResolvedValue(true);
  mocks.releaseGateEnabled.mockReturnValue(true);
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
  mocks.leaseAssertOwned.mockResolvedValue(undefined);
  mocks.leaseRelease.mockResolvedValue(undefined);
  mocks.buildExecutionDeps.mockReturnValue({ marker: "execution-deps" });
  mocks.withSessionControlLock.mockImplementation(async (_sessionId, fn) =>
    fn({ marker: "locked-client" }));
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
  it("is default-closed when the wallet has not enabled Lighter", async () => {
    mocks.isIntegrationEnabled.mockResolvedValue(false);

    const result = await LIGHTER_DEPOSIT_HANDLERS["lighter.deposit.prepare"]!(
      { environment: "core", amountIn: "11" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("not enabled for this Vex wallet");
    expect(result.output).toContain("enabling it does not move funds");
    expect(mocks.createOrFind).not.toHaveBeenCalled();
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
