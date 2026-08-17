import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

const mocks = vi.hoisted(() => ({
  createOrFind: vi.fn(),
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
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  createOrFindLiveDepositApprovalPendingWith: mocks.createOrFind,
  findByIntentId: mocks.findByIntentId,
  markApprovalDecision: mocks.markApprovalDecision,
  markAmbiguous: mocks.markAmbiguous,
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
  mocks.releaseGateEnabled.mockReturnValue(true);
  mocks.assertApprovalBinding.mockResolvedValue(undefined);
  mocks.markAmbiguous.mockResolvedValue(intentRow({ executionState: "ambiguous" }));
  mocks.leaseAssertOwned.mockResolvedValue(undefined);
  mocks.leaseRelease.mockResolvedValue(undefined);
  mocks.buildExecutionDeps.mockReturnValue({ marker: "execution-deps" });
  mocks.withSessionControlLock.mockImplementation(async (_sessionId, fn) =>
    fn({ marker: "locked-client" }));
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
        release: mocks.leaseRelease,
      },
    });
    mocks.resolveSigningWallet.mockReturnValue({
      family: "eip155",
      address: WALLET,
      privateKey: `0x${"1".repeat(64)}`,
    });
    mocks.executeApprovedDeposit.mockResolvedValue({
      status: "credited",
      approveTxHash: null,
      depositTxHash: `0x${"b".repeat(64)}`,
      resolvedAccountIndex: 800123,
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
      assertExecutionLease: expect.any(Function),
    }));
    expect(mocks.executeApprovedDeposit).toHaveBeenCalledWith({
      intent: expect.objectContaining({ executionState: "approved" }),
      deps: { marker: "execution-deps" },
    });
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });
});

describe("lighter.deposit.prepare", () => {
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
    });
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
