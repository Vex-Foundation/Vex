import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

const mocks = vi.hoisted(() => ({
  findCurrent: vi.fn(),
  findForWallet: vi.fn(),
  findLatestSession: vi.fn(),
  findLatestWallet: vi.fn(),
  findClaim: vi.fn(),
  createClaim: vi.fn(),
  readClaimPreflight: vi.fn(),
  buildClaimPreview: vi.fn(),
  withLocks: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", () => ({
  findByIntentId: mocks.findCurrent,
  findByIntentIdForWallet: mocks.findForWallet,
  findLatestForSession: mocks.findLatestSession,
  findLatestForWallet: mocks.findLatestWallet,
}));

vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", () => ({
  createManualClaimAttemptWith: mocks.createClaim,
  findLatestForWithdrawalIntent: mocks.findClaim,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: vi.fn(),
  withSessionControlLocks: (...args: unknown[]) => mocks.withLocks(...args),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => OWNER),
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: vi.fn(),
}));

vi.mock("@tools/lighter/withdrawal/core-claim.js", () => ({
  readLighterWithdrawalClaimPreflight: (...args: unknown[]) => mocks.readClaimPreflight(...args),
  buildLighterWithdrawalClaimPreview: (...args: unknown[]) => mocks.buildClaimPreview(...args),
  assertLighterWithdrawalClaimPreflightWithinApproval: vi.fn(),
}));

vi.mock("@tools/uniswap/deployments.js", () => ({
  getUniswapDeployment: vi.fn(() => ({ chainId: 4663 })),
}));

vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => ({})),
  getUniswapEvmClients: vi.fn(),
}));

vi.mock("@vex-agent/tools/protocols/lighter/withdrawal-claim-approval-binding.js", () => ({
  assertLighterWithdrawalClaimApprovalBinding: vi.fn(),
  buildLighterWithdrawalClaimCriticalArgs: vi.fn(() => ({
    toolId: "lighter.withdraw.claim",
    claimId: "lighter-withdrawal-claim-test",
  })),
}));

const { LIGHTER_WITHDRAWAL_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/withdrawal.js"
);

const recoveredIntent = {
  intentId: "lighter-withdrawal-old",
  sessionId: "session-old",
  environment: "rhc",
  executionState: "claimable",
  pendingBalanceUnits: "1000000",
  amountUnits: "1000000",
  walletAddress: OWNER,
  gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
  gatewayCodeHash: `0x${"1".repeat(64)}`,
  settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  settlementTokenCodeHash: `0x${"2".repeat(64)}`,
};

const claimSnapshot = {
  settlementChainId: 4663,
  settlementNetworkName: "Robinhood Chain mainnet",
  walletAddress: OWNER,
  ownerAddress: OWNER,
  assetSymbol: "USDG",
  amountUnits: "1000000",
};

const claimAttempt = {
  claimId: "lighter-withdrawal-claim-test",
  withdrawalIntentId: recoveredIntent.intentId,
  sessionId: "session-new",
  amountUnits: "1000000",
  networkFeeCeilingWei: "1000",
  expiresAt: "2030-01-01T00:03:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCurrent.mockResolvedValue(null);
  mocks.findForWallet.mockResolvedValue(recoveredIntent);
  mocks.findLatestSession.mockResolvedValue(null);
  mocks.findLatestWallet.mockResolvedValue(null);
  mocks.findClaim.mockResolvedValue(null);
  mocks.readClaimPreflight.mockResolvedValue(claimSnapshot);
  mocks.buildClaimPreview.mockImplementation((input: Record<string, unknown>) => ({
    previewId: "lwcp_test",
    matchHash: "a".repeat(64),
    identity: {
      sessionId: input.sessionId,
      withdrawalIntentId: input.withdrawalIntentId,
    },
    snapshot: input.snapshot,
  }));
  mocks.createClaim.mockResolvedValue(claimAttempt);
  mocks.withLocks.mockImplementation(async (
    _sessionIds: string[],
    fn: (client: object) => Promise<unknown>,
  ) => fn({}));
});

describe("cross-session Lighter withdrawal claim continuation", () => {
  it("keeps the original withdrawal audit but prepares a new session-scoped claim approval", async () => {
    const result = await LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.claim.prepare"]!(
      { intentId: recoveredIntent.intentId },
      { sessionId: "session-new", walletResolution: {}, walletPolicy: {} } as never,
    );

    expect(mocks.findCurrent).toHaveBeenCalledWith("session-new", recoveredIntent.intentId);
    expect(mocks.findForWallet).toHaveBeenCalledWith(recoveredIntent.intentId, OWNER);
    expect(mocks.withLocks).toHaveBeenCalledWith(
      ["session-new", "session-old"],
      expect.any(Function),
    );
    expect(mocks.buildClaimPreview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-new",
      withdrawalIntentId: recoveredIntent.intentId,
    }));
    expect(mocks.createClaim).toHaveBeenCalledWith({}, expect.objectContaining({
      preview: expect.objectContaining({
        identity: expect.objectContaining({ sessionId: "session-new" }),
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      data: {
        status: "approval_prepared",
        withdrawalIntentId: recoveredIntent.intentId,
      },
      preparedActionFollowUp: {
        args: {
          toolId: "lighter.withdraw.claim",
          params: { claimId: claimAttempt.claimId },
        },
      },
    });
  });

  it("binds status lookup to the selected wallet even when this session has another wallet", async () => {
    const otherWallet = "0x1111111111111111111111111111111111111111";
    mocks.findLatestSession.mockResolvedValue({
      ...recoveredIntent,
      sessionId: "session-new",
      walletAddress: otherWallet,
      destinationAddress: otherWallet,
      executionState: "destination_confirmed",
      approvalStatus: "approved",
    });
    mocks.findLatestWallet.mockResolvedValue({
      ...recoveredIntent,
      destinationAddress: OWNER,
      executionState: "destination_confirmed",
      approvalStatus: "approved",
    });

    const result = await LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.status"]!(
      {},
      { sessionId: "session-new", walletResolution: {}, walletPolicy: {} } as never,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.findLatestSession).not.toHaveBeenCalled();
    expect(mocks.findLatestWallet).toHaveBeenCalledWith(OWNER);
    expect(result.data).toMatchObject({
      intentId: recoveredIntent.intentId,
      destinationAddress: OWNER,
      recoveredFromEarlierSession: true,
      final: true,
    });
    expect(JSON.stringify(result.data)).not.toContain(otherWallet);
  });
});
