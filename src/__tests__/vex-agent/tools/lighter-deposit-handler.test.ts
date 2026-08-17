import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

const mocks = vi.hoisted(() => ({
  createOrFind: vi.fn(),
  withSessionControlLock: vi.fn(),
  resolveSelectedAddress: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  createOrFindLiveDepositApprovalPendingWith: mocks.createOrFind,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: mocks.resolveSelectedAddress,
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: (err: unknown) => {
    throw err;
  },
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
  mocks.withSessionControlLock.mockImplementation(async (_sessionId, fn) =>
    fn({ marker: "locked-client" }));
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
