import { requireValue } from "../../helpers/require-value.js";
import { withdrawalIntent } from "../../helpers/lighter-intents.js";
import { beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getAudit: vi.fn(),
  findByIntentId: vi.fn(),
  markApprovalDecision: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({ getByIdForSession: mocks.getApproval }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ getByApprovalId: mocks.getAudit }));
// Only full-access reaches the repo directly in this file's tests - restricted
// calls (none here) would return at the host approval gate before any lookup.
vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-withdrawal-intents.js")>()),
  findByIntentId: mocks.findByIntentId,
  markApprovalDecision: mocks.markApprovalDecision,
}));

const { assertLighterWithdrawalApprovalBinding, buildLighterWithdrawalCriticalArgs } = await import(
  "@vex-agent/tools/protocols/lighter/withdrawal-approval-binding.js"
);
const { LIGHTER_WITHDRAWAL_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/withdrawal.js"
);

const INTENT = withdrawalIntent({
  intentId: "withdrawal-rhc-1", previewId: "lwp_rhc", sessionId: "session-1",
  matchHash: "a".repeat(64), environment: "rhc", operationClass: "secure_l2_withdrawal",
  signingChainId: 466324, settlementChainId: 4663,
  settlementNetworkName: "Robinhood Chain mainnet", accountIndex: 42, apiKeyIndex: 4,
  walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  destinationAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  assetIndex: 3, assetSymbol: "USDG", assetDecimals: 6,
  settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  routeType: 0, amountUnits: "2000000", minimumWithdrawalUnits: "1000000",
  availableBalanceUnits: "8000000", collateralUnits: "10000000",
  initialMarginUnits: "1000000", pendingOrderCount: 0, openPositionCount: 0,
  activeOrderCount: 0, withdrawalDelaySeconds: 2687,
  gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
  gatewayImplementation: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
  gatewayCodeHash: `0x${"1".repeat(64)}`,
  settlementTokenCodeHash: `0x${"2".repeat(64)}`,
  preflightObservedAt: "2030-01-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockResolvedValue({ status: "approved",
    toolCall: { command: "execute_tool", args: { toolId: "lighter.withdraw", params: { intentId: INTENT.intentId } } } });
  mocks.getAudit.mockResolvedValue({ sessionId: "session-1", decision: "approved",
    actionKind: "external_post", executionStatus: "dispatching",
    previewJson: { toolName: "withdraw", namespace: "lighter",
      criticalArgs: buildLighterWithdrawalCriticalArgs(INTENT) } });
  mocks.findByIntentId.mockReset().mockResolvedValue(null);
  mocks.markApprovalDecision.mockReset();
});

describe("Lighter RHC withdrawal approval binding", () => {
  it("accepts the exact RHC USDG approval", async () => {
    await expect(assertLighterWithdrawalApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", intent: INTENT,
    })).resolves.toBeUndefined();
  });

  it.each([
    { environment: "core" }, { signingChainId: 304 }, { settlementChainId: 1 },
    { assetSymbol: "USDC" }, { amountUnits: "2000001" },
    { gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7" },
  ])("rejects cross-environment or amount mutation", async (changed) => {
    mocks.getAudit.mockResolvedValue({ sessionId: "session-1", decision: "approved",
      actionKind: "external_post", executionStatus: "dispatching",
      previewJson: { toolName: "withdraw", namespace: "lighter",
        criticalArgs: { ...buildLighterWithdrawalCriticalArgs(INTENT), ...changed } } });
    await expect(assertLighterWithdrawalApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("auto-approves a full-access withdrawal without the binding lookup", async () => {
    mocks.findByIntentId.mockResolvedValueOnce(INTENT);
    mocks.markApprovalDecision.mockResolvedValueOnce({ ...INTENT, approvalStatus: "approved" });

    const result = await requireValue(LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw"])(
      { intentId: INTENT.intentId },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(mocks.getApproval).not.toHaveBeenCalled();
    expect(mocks.getAudit).not.toHaveBeenCalled();
    expect(mocks.markApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    // No deps configured in this test env - proves it reached the signer
    // boundary having never required a Vex approval card.
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("unavailable");
  });

  it("still refuses a full-access withdrawal for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw"])(
      { intentId: "lighter-withdrawal-never-prepared" },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(result.success).toBe(false);
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("No Lighter withdrawal intent");
    expect(mocks.getApproval).not.toHaveBeenCalled();
    expect(mocks.markApprovalDecision).not.toHaveBeenCalled();
  });
});
