import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import {
  buildLighterFeeAuthorizationDisclosure,
  validateLighterFeeAuthorizationCriticalArgs,
} from "@vex-agent/tools/protocols/lighter/fee-authorization-disclosure.js";
const mocks = vi.hoisted(() => ({ approval: vi.fn(), audit: vi.fn() }));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.approval,
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.audit,
}));
const { assertLighterFeeAuthorizationApprovalBinding } =
  await import("@vex-agent/tools/protocols/lighter/fee-authorization-approval-binding.js");

const intent: LighterFeeAuthorizationIntentRow = {
  intentId: "fees-1",
  sessionId: "session-1",
  environment: "core",
  walletAddress: `0x${"1".repeat(40)}`,
  accountIndex: 42,
  apiKeyIndex: 4,
  terms: {
    collectorAccountIndex: 99,
    collectorL1Address: `0x${"2".repeat(40)}`,
    maxPerpsMakerFee: 1000,
    maxPerpsTakerFee: 1000,
    maxSpotMakerFee: 2500,
    maxSpotTakerFee: 2500,
    authorizationExpiryMs: 2208988800000,
    revoke: false,
    publicKey: "ab".repeat(40),
    currentTier: "standard",
    targetTier: "plus",
    exchangeMakerFeeTick: 50,
    exchangeTakerFeeTick: 50,
  },
  approvalId: null,
  approvalStatus: "approval_pending",
  executionState: "approval_pending",
  nonceValue: null,
  txHash: null,
  txExpiryMs: null,
  failureReason: null,
  expiresAt: new Date("2030-01-01T00:15:00Z"),
  verifiedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.approval.mockResolvedValue({
    status: "approved",
    toolCall: {
      command: "execute_tool",
      args: {
        toolId: "lighter.fees.approve",
        params: { intentId: intent.intentId },
      },
    },
  });
  mocks.audit.mockResolvedValue({
    sessionId: "session-1",
    decision: "approved",
    actionKind: "user_wallet_broadcast",
    executionStatus: "dispatching",
    previewJson: {
      namespace: "lighter",
      toolName: "fees.approve",
      criticalArgs: buildLighterFeeAuthorizationDisclosure(intent),
    },
  });
});

describe("Lighter fee approval", () => {
  it("discloses both fees, exact exchange precision, and separate authorization expiry", () => {
    const disclosure = buildLighterFeeAuthorizationDisclosure(intent);
    expect(disclosure.perpetualFee).toContain("0.1%");
    expect(disclosure.spotFee).toContain("0.25%");
    expect(disclosure.exchangeFees).toBe(
      "Up to 0.005% maker / 0.005% taker; separate from VEX fees",
    );
    expect(disclosure.authorizationValidUntil).toBe("2040-01-01T00:00:00.000Z");
    expect(disclosure.authorizationValidUntil).not.toBe(
      intent.expiresAt.toISOString(),
    );
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });
  it("binds one exact approved card to the session-owned intent", async () => {
    await expect(
      assertLighterFeeAuthorizationApprovalBinding({
        intent,
        sessionId: "session-1",
        approvalId: "approval-1",
      }),
    ).resolves.toBeUndefined();
  });
  it.each([
    { collectorAccountIndex: 100 },
    { spotFee: "0%" },
    { maxSpotMakerFee: 2501 },
    { authorizationExpiryMs: 0 },
    { publicKey: "invalid" },
    { environment: "unknown" },
    { extra: "injected" },
    { walletAddress: "invalid" },
  ])("refuses altered prepared details %j", (patch) => {
    expect(
      validateLighterFeeAuthorizationCriticalArgs(
        { ...buildLighterFeeAuthorizationDisclosure(intent), ...patch },
        intent.intentId,
      ),
    ).toBe(false);
  });
  it("refuses forged approved terms even when public validation would accept their shape", async () => {
    mocks.audit.mockResolvedValue({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "user_wallet_broadcast",
      executionStatus: "dispatching",
      previewJson: {
        namespace: "lighter",
        toolName: "fees.approve",
        criticalArgs: {
          ...buildLighterFeeAuthorizationDisclosure(intent),
          walletAddress: `0x${"3".repeat(40)}`,
        },
      },
    });
    await expect(
      assertLighterFeeAuthorizationApprovalBinding({
        intent,
        sessionId: "session-1",
        approvalId: "approval-1",
      }),
    ).rejects.toThrow("does not match");
  });
  it("refuses extra approved execution arguments", async () => {
    mocks.approval.mockResolvedValue({
      status: "approved",
      toolCall: {
        command: "execute_tool",
        args: {
          toolId: "lighter.fees.approve",
          params: { intentId: intent.intentId, revoke: true },
        },
      },
    });
    await expect(
      assertLighterFeeAuthorizationApprovalBinding({
        intent,
        sessionId: "session-1",
        approvalId: "approval-1",
      }),
    ).rejects.toThrow("does not match");
  });
  it("discloses RHC Premium fee ceilings without rounding", () => {
    const rhc = {
      ...intent,
      environment: "rhc" as const,
      terms: {
        ...intent.terms,
        targetTier: "premium" as const,
        exchangeMakerFeeTick: 120,
        exchangeTakerFeeTick: 350,
      },
    };
    const disclosure = buildLighterFeeAuthorizationDisclosure(rhc);
    expect(disclosure.exchangeFees).toBe(
      "Up to 0.012% maker / 0.035% taker; separate from VEX fees",
    );
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });
  it("revokes all four caps and expiry together", () => {
    const revoked = {
      ...intent,
      terms: {
        ...intent.terms,
        revoke: true,
        targetTier: null,
        authorizationExpiryMs: 0,
        maxPerpsMakerFee: 0,
        maxPerpsTakerFee: 0,
        maxSpotMakerFee: 0,
        maxSpotTakerFee: 0,
      },
    };
    const disclosure = buildLighterFeeAuthorizationDisclosure(revoked);
    expect(disclosure.authorizationValidUntil).toBe("Revoked");
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });
});
