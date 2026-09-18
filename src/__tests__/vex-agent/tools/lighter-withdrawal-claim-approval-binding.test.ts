import { requireValue } from "../../helpers/require-value.js";
import { claimAttempt } from "../../helpers/lighter-intents.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getAudit: vi.fn(),
  findByClaimId: vi.fn(),
  markDecisionWith: vi.fn(),
  withSessionControlLock: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({ getByIdForSession: mocks.getApproval }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ getByApprovalId: mocks.getAudit }));
// Only full-access reaches the repo directly in this file's tests - restricted
// calls (none here) would return at the host approval gate before any lookup.
vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-withdrawal-claims.js")>()),
  findByClaimId: mocks.findByClaimId,
  markDecisionWith: (client: unknown, input: unknown) => mocks.markDecisionWith(input),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
}));

const {
  assertLighterCoreClaimApprovalBinding,
  assertLighterWithdrawalClaimApprovalBinding,
  buildLighterCoreClaimCriticalArgs,
  buildLighterWithdrawalClaimCriticalArgs,
} = await import(
  "@vex-agent/tools/protocols/lighter/withdrawal-claim-approval-binding.js"
);
const { LIGHTER_WITHDRAWAL_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/withdrawal.js"
);

const ATTEMPT = claimAttempt({
  claimId: "claim-1",
  withdrawalIntentId: "withdrawal-1",
  sessionId: "session-1",
  previewId: "lwcp_preview",
  matchHash: "a".repeat(64),
  operationClass: "manual_core_usdc_claim",
  settlementChainId: 1,
  settlementNetworkName: "Ethereum mainnet",
  walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  ownerAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
  gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
  gatewayCodeHash: `0x${"1".repeat(64)}`,
  settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  settlementTokenCodeHash: `0x${"2".repeat(64)}`,
  assetIndex: 3,
  assetSymbol: "USDC",
  assetDecimals: 6,
  amountUnits: "2000000",
  calldata: `0x${"3".repeat(200)}`,
  valueWei: "0",
  gasLimit: "200000",
  quotedMaxFeePerGasWei: "100000000",
  quotedPriorityFeePerGasWei: "1000000",
  networkFeeCeilingWei: "80000000000000",
  preflightBlockNumber: "20000000",
  preflightObservedAt: "2030-01-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockResolvedValue({
    status: "approved",
    toolCall: { command: "execute_tool", args: { toolId: "lighter.withdraw.claim", params: { claimId: "claim-1" } } },
  });
  mocks.getAudit.mockResolvedValue({
    sessionId: "session-1", decision: "approved", actionKind: "user_wallet_broadcast",
    executionStatus: "dispatching",
    previewJson: { toolName: "claim", namespace: "lighter", criticalArgs: buildLighterCoreClaimCriticalArgs(ATTEMPT) },
  });
  mocks.findByClaimId.mockReset().mockResolvedValue(null);
  mocks.markDecisionWith.mockReset();
  mocks.withSessionControlLock.mockReset().mockImplementation(async (_sessionId, fn) => fn({ marker: "locked-client" }));
});

describe("Lighter RHC manual claim approval binding", () => {
  const rhcAttempt: LighterWithdrawalClaimAttemptRow = {
    ...ATTEMPT,
    operationClass: "manual_rhc_usdg_claim",
    settlementChainId: 4663,
    settlementNetworkName: "Robinhood Chain mainnet",
    gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
    gatewayImplementation: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
    settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    assetSymbol: "USDG",
  };

  it("binds RHC chain, USDG, gateway, amount, and fee ceiling independently", async () => {
    mocks.getAudit.mockResolvedValue({
      sessionId: "session-1", decision: "approved", actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: { toolName: "claim", namespace: "lighter", criticalArgs: buildLighterWithdrawalClaimCriticalArgs(rhcAttempt) },
    });
    await expect(assertLighterWithdrawalClaimApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", attempt: rhcAttempt,
    })).resolves.toBeUndefined();
  });

  it.each([
    { operationClass: "manual_core_usdc_claim" },
    { settlementChainId: 1 },
    { assetSymbol: "USDC" },
    { gatewayAddress: ATTEMPT.gatewayAddress },
    { settlementTokenAddress: ATTEMPT.settlementTokenAddress },
    { amountUnits: "2000001" },
  ])("rejects an RHC claim identity mutation", async (changed) => {
    mocks.getAudit.mockResolvedValue({
      sessionId: "session-1", decision: "approved", actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "claim", namespace: "lighter",
        criticalArgs: { ...buildLighterWithdrawalClaimCriticalArgs(rhcAttempt), ...changed },
      },
    });
    await expect(assertLighterWithdrawalClaimApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", attempt: rhcAttempt,
    })).rejects.toThrow("Nothing was signed or submitted");
  });
});

describe("Lighter Core manual claim approval binding", () => {
  it("accepts only the exact separate Ethereum claim approval", async () => {
    await expect(assertLighterCoreClaimApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", attempt: ATTEMPT,
    })).resolves.toBeUndefined();
  });

  it.each([
    { amountUnits: "2000001" },
    { valueWei: "1" },
    { settlementChainId: 4663 },
    { ownerAddress: "0x1111111111111111111111111111111111111111" },
    { networkFeeCeilingWei: "90000000000000" },
  ])("rejects mutation of a claim-bound field", async (changed) => {
    mocks.getAudit.mockResolvedValue({
      sessionId: "session-1", decision: "approved", actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "claim", namespace: "lighter",
        criticalArgs: { ...buildLighterCoreClaimCriticalArgs(ATTEMPT), ...changed },
      },
    });
    await expect(assertLighterCoreClaimApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", attempt: ATTEMPT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("rejects reuse of the L2 withdrawal action taxonomy", async () => {
    mocks.getAudit.mockResolvedValue({
      sessionId: "session-1", decision: "approved", actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: { toolName: "claim", namespace: "lighter", criticalArgs: buildLighterCoreClaimCriticalArgs(ATTEMPT) },
    });
    await expect(assertLighterCoreClaimApprovalBinding({
      approvalId: "approval-1", sessionId: "session-1", attempt: ATTEMPT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("auto-approves a full-access manual claim without the binding lookup", async () => {
    mocks.findByClaimId.mockResolvedValueOnce(ATTEMPT);
    mocks.markDecisionWith.mockResolvedValueOnce({ ...ATTEMPT, state: "approved" });

    const result = await requireValue(LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.claim"])(
      { claimId: ATTEMPT.claimId },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(mocks.getApproval).not.toHaveBeenCalled();
    expect(mocks.getAudit).not.toHaveBeenCalled();
    expect(mocks.markDecisionWith).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    // No real chain/lease infra in this test env - proves it reached that
    // boundary having never required a Vex approval card.
    expect(result.pendingApproval).not.toBe(true);
    expect(result.success).toBe(false);
  });

  it("still refuses a full-access manual claim for a claim nothing prepared", async () => {
    const result = await requireValue(LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.claim"])(
      { claimId: "claim-never-prepared" },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(result.success).toBe(false);
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("No manual Lighter claim");
    expect(mocks.getApproval).not.toHaveBeenCalled();
    expect(mocks.markDecisionWith).not.toHaveBeenCalled();
  });
});
