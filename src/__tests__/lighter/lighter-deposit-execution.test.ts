import { describe, expect, it, vi } from "vitest";

import {
  executeApprovedLighterDeposit,
  type LighterDepositExecutionDeps,
} from "@tools/lighter/wallet-funding/deposit-execution.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const APPROVE_HASH = "0x" + "a".repeat(64);
const DEPOSIT_HASH = "0x" + "b".repeat(64);

function intent(overrides: Partial<LighterOnboardingIntentRow> = {}): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-1",
    sessionId: "s1",
    protocolExecutionId: null,
    approvalId: null,
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: CONTRACT,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    approvalStatus: "approved",
    executionState: "approved",
    approveTxHash: null,
    depositTxHash: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function intentsSpy() {
  return {
    markAllowanceVerified: vi.fn().mockResolvedValue({ executionState: "allowance_verified" }),
    markApproveSubmitted: vi.fn().mockResolvedValue({ executionState: "approve_submitted" }),
    markApproveConfirmed: vi.fn().mockResolvedValue({ executionState: "approve_confirmed" }),
    markDepositSubmitted: vi.fn().mockResolvedValue({ executionState: "deposit_submitted" }),
    markDepositConfirmed: vi.fn().mockResolvedValue({ executionState: "deposit_confirmed" }),
    markCredited: vi.fn().mockResolvedValue({ executionState: "credited" }),
    markAmbiguous: vi.fn().mockResolvedValue({ executionState: "ambiguous" }),
    markFailed: vi.fn().mockResolvedValue({ executionState: "failed" }),
  };
}

function deps(overrides: Partial<LighterDepositExecutionDeps> = {}): LighterDepositExecutionDeps {
  return {
    depositGateEnabled: () => true,
    assertExecutionLease: vi.fn().mockResolvedValue(undefined),
    runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
      await onHashStaged(APPROVE_HASH);
      return { skipped: false as const, txHash: APPROVE_HASH, outcome: "confirmed" as const };
    }),
    runDepositLeg: vi.fn(async ({ onHashStaged }) => {
      await onHashStaged(DEPOSIT_HASH);
      return { txHash: DEPOSIT_HASH, outcome: "confirmed" as const };
    }),
    resolveAccountIndex: vi.fn().mockResolvedValue(800123),
    intents: intentsSpy(),
    ...overrides,
  };
}

describe("executeApprovedLighterDeposit", () => {
  it("does nothing and signs nothing when the deposit gate is closed", async () => {
    const d = deps({
      depositGateEnabled: () => false,
      runApproveLegIfNeeded: vi.fn(),
      runDepositLeg: vi.fn(),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("gate_closed");
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not start a transaction leg after the cross-process lease is lost", async () => {
    const d = deps({
      assertExecutionLease: vi.fn().mockRejectedValue(new Error("lease lost")),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("stages each tx hash before broadcast and credits on the happy path", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "credited", depositTxHash: DEPOSIT_HASH, resolvedAccountIndex: 800123 });
    // Hash persisted (markApproveSubmitted/markDepositSubmitted) via onHashStaged.
    expect(d.intents.markApproveSubmitted).toHaveBeenCalledWith("lighter-onboard-1", APPROVE_HASH);
    expect(d.intents.markDepositSubmitted).toHaveBeenCalledWith("lighter-onboard-1", DEPOSIT_HASH);
    expect(d.intents.markCredited).toHaveBeenCalledWith("lighter-onboard-1", 800123);
  });

  it("skips the approve broadcast when allowance already suffices", async () => {
    const d = deps({ runApproveLegIfNeeded: vi.fn().mockResolvedValue({ skipped: true }) });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("credited");
    expect(d.intents.markApproveSubmitted).not.toHaveBeenCalled();
    expect(d.intents.markAllowanceVerified).toHaveBeenCalledWith("lighter-onboard-1");
    expect(d.intents.markApproveConfirmed).not.toHaveBeenCalled();
  });

  it("fails on an approve revert without sending the deposit", async () => {
    const d = deps({
      runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(APPROVE_HASH);
        return { skipped: false as const, txHash: APPROVE_HASH, outcome: "reverted" as const };
      }),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
    expect(d.intents.markFailed).toHaveBeenCalled();
  });

  it("marks ambiguous and does not credit when the deposit is unconfirmed", async () => {
    const d = deps({
      runDepositLeg: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(DEPOSIT_HASH);
        return { txHash: DEPOSIT_HASH, outcome: "ambiguous" as const };
      }),
    });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "deposit" });
    expect(d.intents.markAmbiguous).toHaveBeenCalled();
    expect(d.intents.markCredited).not.toHaveBeenCalled();
  });

  it("still reports credited when the account index has not resolved yet", async () => {
    const d = deps({ resolveAccountIndex: vi.fn().mockResolvedValue(null) });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "credited", resolvedAccountIndex: null });
    expect(d.intents.markCredited).not.toHaveBeenCalled();
    expect(d.intents.markDepositConfirmed).toHaveBeenCalled();
  });

  it("refuses to start unless the exact approved lifecycle state is supplied", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({
      intent: intent({ executionState: "approve_submitted" }),
      deps: d,
    });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it.each([
    { environment: "rhc" as const },
    { chainId: 8453 },
    { depositContract: "0x2222222222222222222222222222222222222222" },
    { depositTo: "0x2222222222222222222222222222222222222222" },
    { assetIndex: 4 },
    { routeType: 1 },
    { approvalStatus: "rejected" as const },
  ])("refuses a persisted deposit whose execution binding was altered: %j", async (override) => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({
      intent: intent(override),
      deps: d,
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(d.runApproveLegIfNeeded).not.toHaveBeenCalled();
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("aborts the approval broadcast when its staged hash cannot advance by CAS", async () => {
    let broadcastReached = false;
    const intentTransitions = intentsSpy();
    intentTransitions.markApproveSubmitted.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runApproveLegIfNeeded: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(APPROVE_HASH);
        broadcastReached = true;
        return { skipped: false as const, txHash: APPROVE_HASH, outcome: "confirmed" as const };
      }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(broadcastReached).toBe(false);
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not sign the deposit when the sufficient-allowance transition conflicts", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markAllowanceVerified.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runApproveLegIfNeeded: vi.fn().mockResolvedValue({ skipped: true }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("does not sign the deposit when approval confirmation cannot advance by CAS", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markApproveConfirmed.mockResolvedValueOnce(null);
    const d = deps({ intents: intentTransitions });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "approve", txHash: APPROVE_HASH });
    expect(d.runDepositLeg).not.toHaveBeenCalled();
  });

  it("aborts the deposit broadcast when its staged hash cannot advance by CAS", async () => {
    let broadcastReached = false;
    const intentTransitions = intentsSpy();
    intentTransitions.markDepositSubmitted.mockResolvedValueOnce(null);
    const d = deps({
      intents: intentTransitions,
      runDepositLeg: vi.fn(async ({ onHashStaged }) => {
        await onHashStaged(DEPOSIT_HASH);
        broadcastReached = true;
        return { txHash: DEPOSIT_HASH, outcome: "confirmed" as const };
      }),
    });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "deposit" });
    expect(broadcastReached).toBe(false);
    expect(d.intents.markDepositConfirmed).not.toHaveBeenCalled();
  });

  it("never reports credited when a post-broadcast lifecycle transition conflicts", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markDepositConfirmed.mockResolvedValueOnce(null);
    const d = deps({ intents: intentTransitions });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "deposit", txHash: DEPOSIT_HASH });
    expect(d.intents.markCredited).not.toHaveBeenCalled();
  });

  it("never reports credited when the final credited CAS conflicts", async () => {
    const intentTransitions = intentsSpy();
    intentTransitions.markCredited.mockResolvedValueOnce(null);
    const d = deps({ intents: intentTransitions });

    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "ambiguous", stage: "deposit", txHash: DEPOSIT_HASH });
  });
});
