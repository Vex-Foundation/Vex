import { describe, expect, it, vi } from "vitest";

import {
  executeApprovedLighterDeposit,
  type LighterDepositExecutionDeps,
  type ReceiptOutcome,
} from "@tools/lighter/wallet-funding/deposit-execution.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

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
    markApproveSubmitted: vi.fn().mockResolvedValue(null),
    markApproveConfirmed: vi.fn().mockResolvedValue(null),
    markDepositSubmitted: vi.fn().mockResolvedValue(null),
    markDepositConfirmed: vi.fn().mockResolvedValue(null),
    markCredited: vi.fn().mockResolvedValue(null),
    markAmbiguous: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(null),
  };
}

function deps(overrides: Partial<LighterDepositExecutionDeps> = {}): LighterDepositExecutionDeps {
  return {
    depositGateEnabled: () => true,
    ensureAllowance: vi.fn().mockResolvedValue({ approveTxHash: "0x" + "a".repeat(64) }),
    sendDeposit: vi.fn().mockResolvedValue({ depositTxHash: "0x" + "b".repeat(64) }),
    confirmReceipt: vi.fn<[string], Promise<ReceiptOutcome>>().mockResolvedValue("confirmed"),
    resolveAccountIndex: vi.fn().mockResolvedValue(800123),
    intents: intentsSpy(),
    ...overrides,
  };
}

describe("executeApprovedLighterDeposit", () => {
  it("does nothing and signs nothing when the deposit gate is closed", async () => {
    const d = deps({ depositGateEnabled: () => false, ensureAllowance: vi.fn(), sendDeposit: vi.fn() });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("gate_closed");
    expect(d.ensureAllowance).not.toHaveBeenCalled();
    expect(d.sendDeposit).not.toHaveBeenCalled();
  });

  it("runs approve -> deposit -> credited on the happy path", async () => {
    const d = deps();
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "credited", depositTxHash: "0x" + "b".repeat(64), resolvedAccountIndex: 800123 });
    expect(d.intents.markApproveSubmitted).toHaveBeenCalled();
    expect(d.intents.markApproveConfirmed).toHaveBeenCalled();
    expect(d.intents.markDepositSubmitted).toHaveBeenCalledWith("lighter-onboard-1", "0x" + "b".repeat(64));
    expect(d.intents.markCredited).toHaveBeenCalledWith("lighter-onboard-1", 800123);
  });

  it("skips the approve broadcast when allowance already suffices", async () => {
    const d = deps({ ensureAllowance: vi.fn().mockResolvedValue({ approveTxHash: null }) });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result.status).toBe("credited");
    expect(d.intents.markApproveSubmitted).not.toHaveBeenCalled();
    expect(d.intents.markApproveConfirmed).toHaveBeenCalled();
  });

  it("fails on an approve revert without sending the deposit", async () => {
    const d = deps({ confirmReceipt: vi.fn().mockResolvedValue("reverted") });
    const result = await executeApprovedLighterDeposit({ intent: intent(), deps: d });
    expect(result).toMatchObject({ status: "failed", stage: "approve" });
    expect(d.sendDeposit).not.toHaveBeenCalled();
    expect(d.intents.markFailed).toHaveBeenCalled();
  });

  it("marks ambiguous and does not retry when the deposit receipt is unconfirmed", async () => {
    const confirm = vi.fn<[string], Promise<ReceiptOutcome>>()
      .mockResolvedValueOnce("confirmed") // approve
      .mockResolvedValueOnce("ambiguous"); // deposit
    const d = deps({ confirmReceipt: confirm });
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
});
