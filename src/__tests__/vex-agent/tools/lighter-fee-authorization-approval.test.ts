import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import {
  buildLighterFeeAuthorizationDisclosure,
  validateLighterFeeAuthorizationCriticalArgs,
} from "@vex-agent/tools/protocols/lighter/fee-authorization-disclosure.js";
const mocks = vi.hoisted(() => ({
  approval: vi.fn(),
  audit: vi.fn(),
  findIntent: vi.fn(),
  markDecision: vi.fn(),
  getService: vi.fn(),
  execute: vi.fn(),
  withSessionControlLock: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.approval,
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.audit,
}));
// Only full-access reaches the repo directly in this file's tests -
// restricted calls (none here) would return at the host approval gate before
// any lookup.
vi.mock("@vex-agent/db/repos/lighter-fee-authorization-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-fee-authorization-intents.js")>()),
  findLighterFeeAuthorizationIntent: mocks.findIntent,
  markLighterFeeAuthorizationDecisionWith: (client: unknown, input: unknown) => mocks.markDecision(input),
}));
vi.mock("@vex-agent/tools/protocols/lighter/fee-authorization-execution.js", () => ({
  getConfiguredLighterFeeAuthorizationService: mocks.getService,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
}));
const { assertLighterFeeAuthorizationApprovalBinding } =
  await import("@vex-agent/tools/protocols/lighter/fee-authorization-approval-binding.js");
const { LIGHTER_FEE_AUTHORIZATION_HANDLERS } =
  await import("@vex-agent/tools/protocols/lighter/handlers/fee-authorization.js");

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
    currentExchangeMakerFeeTick: null,
    currentExchangeTakerFeeTick: null,
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
  mocks.findIntent.mockReset().mockResolvedValue(null);
  mocks.markDecision.mockReset();
  mocks.execute.mockReset();
  mocks.getService.mockReset().mockReturnValue({ execute: mocks.execute });
  mocks.withSessionControlLock.mockReset().mockImplementation(async (_sessionId, fn) => fn({ marker: "locked-client" }));
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
        currentExchangeMakerFeeTick: null,
        currentExchangeTakerFeeTick: null,
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
  it("shows today's exchange fees beside the ones the tier change targets", () => {
    const withCurrent = {
      ...intent,
      terms: {
        ...intent.terms,
        currentExchangeMakerFeeTick: 0,
        currentExchangeTakerFeeTick: 0,
      },
    };
    const disclosure = buildLighterFeeAuthorizationDisclosure(withCurrent);
    expect(disclosure.currentAccountTier).toBe("Standard");
    expect(disclosure.exchangeFeeChange).toBe(
      "today: 0% / 0%, after the change: up to 0.005% / 0.005% (maker / taker)",
    );
    expect(disclosure.currentExchangeMakerFeeTick).toBe(0);
    expect(disclosure.currentExchangeTakerFeeTick).toBe(0);
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });
  it("refuses a rebuilt card that drops or alters today's exchange fees", () => {
    const withCurrent = {
      ...intent,
      terms: {
        ...intent.terms,
        currentExchangeMakerFeeTick: 0,
        currentExchangeTakerFeeTick: 0,
      },
    };
    const disclosure = buildLighterFeeAuthorizationDisclosure(withCurrent);
    for (const patch of [
      { currentExchangeMakerFeeTick: null },
      { currentExchangeTakerFeeTick: null },
      { currentExchangeMakerFeeTick: 50 },
      { currentExchangeMakerFeeTick: -1 },
      { currentExchangeMakerFeeTick: 1_000_001 },
      { currentExchangeMakerFeeTick: "0" },
      {
        exchangeFeeChange:
          "today: 0.005% / 0.005%, after the change: up to 0.005% / 0.005% (maker / taker)",
      },
      { currentAccountTier: "Plus" },
      { currentAccountTier: "" },
    ]) {
      expect(
        validateLighterFeeAuthorizationCriticalArgs(
          { ...disclosure, ...patch },
          intent.intentId,
        ),
      ).toBe(false);
    }
  });
  it("says so when Lighter did not report today's exchange fees", () => {
    const disclosure = buildLighterFeeAuthorizationDisclosure(intent);
    expect(disclosure.exchangeFeeChange).toBe(
      "today: not reported by Lighter, after the change: up to 0.005% / 0.005% (maker / taker)",
    );
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });
  it("states the reason for the tier change, its reversibility and the duration", () => {
    const disclosure = buildLighterFeeAuthorizationDisclosure(intent);
    expect(disclosure.tierChangeReason).toBe(
      "Lighter rejects integrator-attributed trades from Standard accounts from 2026-09-14, so fee-bearing trading through Vex needs the Plus tier on Core and the Premium tier on Robinhood Chain",
    );
    expect(disclosure.tierReversibility).toBe(
      "Vex does not switch the tier back; you can change the account type in the Lighter app. Upgrades apply immediately; a downgrade is allowed once 24 hours have passed since the last tier change.",
    );
    expect(disclosure.authorizationDuration).toBe(
      "valid for 10 years, revocable at any time with lighter__fees_approve_prepare revoke. Fee-bearing authorization is required to open positions; without it, orders that only reduce an existing position stay available and are sent without a Vex fee.",
    );
    for (const patch of [
      { tierChangeReason: "Lighter asked for it" },
      { tierReversibility: "Vex switches the tier back afterwards." },
      { authorizationDuration: "valid for 10 years" },
      { tierChangeReason: null },
    ]) {
      expect(
        validateLighterFeeAuthorizationCriticalArgs(
          { ...disclosure, ...patch },
          intent.intentId,
        ),
      ).toBe(false);
    }
  });
  it("omits the tier-change sentences when no tier changes", () => {
    const keep = {
      ...intent,
      terms: {
        ...intent.terms,
        currentTier: "plus",
        targetTier: null,
        currentExchangeMakerFeeTick: 50,
        currentExchangeTakerFeeTick: 50,
      },
    };
    const disclosure = buildLighterFeeAuthorizationDisclosure(keep);
    expect(disclosure.currentAccountTier).toBe("Plus");
    expect(disclosure.tierChangeReason).toBeNull();
    expect(disclosure.tierReversibility).toBeNull();
    expect(disclosure.exchangeFeeChange).toBe(
      "today: 0.005% / 0.005%, unchanged by this authorization (maker / taker)",
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
    expect(disclosure.authorizationDuration).toBe(
      "Revoked now. Authorizing again later is a fresh approval, valid for 10 years from that approval.",
    );
    expect(disclosure.tierChangeReason).toBeNull();
    expect(
      validateLighterFeeAuthorizationCriticalArgs(disclosure, intent.intentId),
    ).toBe(true);
  });

  it("auto-approves a full-access fee authorization without the binding lookup", async () => {
    mocks.findIntent.mockResolvedValueOnce(intent);
    mocks.markDecision.mockResolvedValueOnce({ ...intent, approvalStatus: "approved", approvalId: null });
    mocks.execute.mockResolvedValueOnce({ source: "vex_lighter_fee_authorization", status: "active" });

    const result = await requireValue(LIGHTER_FEE_AUTHORIZATION_HANDLERS["lighter.fees.approve"])(
      { intentId: intent.intentId },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(mocks.approval).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.markDecision).toHaveBeenCalledWith(expect.objectContaining({
      intentId: intent.intentId,
      sessionId: "session-1",
      approvalId: null,
      status: "approved",
    }));
    expect(result.success, result.output).toBe(true);
  });

  it("still refuses a full-access fee authorization for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_FEE_AUTHORIZATION_HANDLERS["lighter.fees.approve"])(
      { intentId: "fees-never-prepared" },
      { sessionId: "session-1", sessionPermission: "full", approved: false,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" } },
    );

    expect(result.success).toBe(false);
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("does not belong to this session");
    expect(mocks.approval).not.toHaveBeenCalled();
    expect(mocks.markDecision).not.toHaveBeenCalled();
  });
});
