import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";

const mocks = vi.hoisted(() => ({ getApproval: vi.fn(), getAudit: vi.fn() }));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({ getByIdForSession: mocks.getApproval }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ getByApprovalId: mocks.getAudit }));

const { assertLighterWithdrawalApprovalBinding, buildLighterWithdrawalCriticalArgs } = await import(
  "@vex-agent/tools/protocols/lighter/withdrawal-approval-binding.js"
);

const INTENT = {
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
} as unknown as LighterWithdrawalIntentRow;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockResolvedValue({ status: "approved",
    toolCall: { command: "execute_tool", args: { toolId: "lighter.withdraw", params: { intentId: INTENT.intentId } } } });
  mocks.getAudit.mockResolvedValue({ sessionId: "session-1", decision: "approved",
    actionKind: "external_post", executionStatus: "dispatching",
    previewJson: { toolName: "withdraw", namespace: "lighter",
      criticalArgs: buildLighterWithdrawalCriticalArgs(INTENT) } });
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
});
