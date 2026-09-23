import { describe, expect, it, vi } from "vitest";

import {
  resolveLighterAccountSetupStatus,
  resolveLighterOnboardingChecklist,
  type LighterAccountSetupStatusDeps,
  type LighterOnboardingChecklistDeps,
} from "../onboarding-checklist.js";
import type { LighterOnboardingWorkflowRow } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const SESSION = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<LighterOnboardingChecklistDeps> = {}): LighterOnboardingChecklistDeps {
  return {
    readSessionWallet: vi.fn().mockResolvedValue({
      walletAddress: WALLET,
      walletResolution: { source: "session", evm: { id: "w1", address: WALLET }, solana: null },
      walletPolicy: { kind: "none" },
    }),
    readLighterAccount: vi.fn().mockResolvedValue({ account_index: 42 }),
    readWorkflow: vi.fn().mockResolvedValue(null),
    hasTradingKey: vi.fn().mockReturnValue(false),
    inspectFee: vi.fn().mockResolvedValue({ status: "needs_approval", reason: "", accountIndex: 42 }),
    ...overrides,
  };
}

function workflow(
  workflowState: LighterOnboardingWorkflowRow["workflowState"],
): LighterOnboardingWorkflowRow {
  return {
    environment: "rhc",
    walletAddress: WALLET,
    workflowState,
    lastStableState: null,
    activeDepositIntentId: null,
    resolvedAccountIndex: null,
    apiKeyIndex: null,
    publicKeyFingerprint: null,
    failureCode: null,
    revision: 1,
    createdAt: new Date("2026-09-18T00:00:00.000Z"),
    updatedAt: new Date("2026-09-18T00:01:00.000Z"),
  };
}

describe("resolveLighterOnboardingChecklist", () => {
  it("marks every step todo when the wallet owns no Lighter account, without a fee read", async () => {
    const d = deps({ readLighterAccount: vi.fn().mockResolvedValue(null) });
    await expect(resolveLighterOnboardingChecklist({ sessionId: SESSION, environment: "rhc" }, d))
      .resolves.toEqual({
        deposit: "todo",
        key: "todo",
        fee: "todo",
        progress: "not_started",
        detail: "Setup has not started.",
        nextAction: "start_setup",
        updatedAt: null,
      });
    expect(d.readLighterAccount).toHaveBeenCalledWith("rhc", WALLET);
    expect(d.readWorkflow).toHaveBeenCalledWith("rhc", WALLET);
    expect(d.inspectFee).not.toHaveBeenCalled();
  });

  it("reads the key from the vault scope for the account and the fee from the inspection", async () => {
    const d = deps({
      hasTradingKey: vi.fn().mockReturnValue(true),
      inspectFee: vi.fn().mockResolvedValue({ status: "ready", reason: "", accountIndex: 42 }),
    });
    await expect(resolveLighterOnboardingChecklist({ sessionId: SESSION, environment: "core" }, d))
      .resolves.toEqual({
        deposit: "done",
        key: "done",
        fee: "done",
        progress: "ready",
        detail: "Lighter setup is complete.",
        nextAction: "none",
        updatedAt: null,
      });
    expect(d.hasTradingKey).toHaveBeenCalledWith("core", 42);
    expect(d.inspectFee).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      environment: "core",
      walletPolicy: { kind: "none" },
    }));
  });

  it("reports a disabled fee policy as not required and anything else as todo", async () => {
    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "core" },
      deps({ inspectFee: vi.fn().mockResolvedValue({ status: "disabled", reason: "", accountIndex: null }) }),
    )).resolves.toEqual({
      deposit: "done",
      key: "todo",
      fee: "not_required",
      progress: "action_required",
      detail: "Trading key approval is required.",
      nextAction: "continue_setup",
      updatedAt: null,
    });
    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "core" },
      deps({ inspectFee: vi.fn().mockResolvedValue({ status: "blocked", reason: "", accountIndex: 42 }) }),
    )).resolves.toEqual({
      deposit: "done",
      key: "todo",
      fee: "todo",
      progress: "action_required",
      detail: "Trading key approval is required.",
      nextAction: "continue_setup",
      updatedAt: null,
    });
  });

  it("surfaces a pending deposit and an ambiguous workflow with one safe next action", async () => {
    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "rhc" },
      deps({
        readLighterAccount: vi.fn().mockResolvedValue(null),
        readWorkflow: vi.fn().mockResolvedValue(workflow("deposit_l2_pending")),
      }),
    )).resolves.toMatchObject({
      progress: "in_progress",
      detail: "Deposit confirmed on Ethereum. Waiting for Lighter credit.",
      nextAction: "check_status",
      updatedAt: "2026-09-18T00:01:00.000Z",
    });

    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "rhc" },
      deps({
        readLighterAccount: vi.fn().mockResolvedValue(null),
        readWorkflow: vi.fn().mockResolvedValue(workflow("ambiguous")),
      }),
    )).resolves.toMatchObject({
      progress: "needs_reconciliation",
      detail: "Setup needs a status check before you continue.",
      nextAction: "check_status",
    });
  });
});

function setupDeps(
  overrides: Partial<LighterAccountSetupStatusDeps> = {},
): LighterAccountSetupStatusDeps {
  return {
    readSessionWallet: vi.fn().mockResolvedValue({
      walletAddress: WALLET,
      walletResolution: { source: "session", evm: { id: "w1", address: WALLET }, solana: null },
      walletPolicy: { kind: "none" },
    }),
    readers: {
      readWalletSettlementUnits: vi.fn().mockResolvedValue(0n),
      readWalletNativeBalanceWei: vi.fn().mockResolvedValue(0n),
      readWalletSettlementAllowanceUnits: vi.fn().mockResolvedValue(0n),
      readWalletCanAcquireSettlement: vi.fn().mockResolvedValue(true),
      readMinimumDepositUnits: vi.fn().mockResolvedValue(0n),
      readLighterAccount: vi.fn().mockResolvedValue({ account_index: 42, available_balance: "0" }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(false),
    },
    hasTradingKey: vi.fn().mockReturnValue(false),
    readLiveKeyRegistrationState: vi.fn().mockResolvedValue(null),
    readWorkflow: vi.fn().mockResolvedValue(null),
    // No fee policy keeps the fee read out of the way; the key gate is the focus.
    feePolicy: vi.fn().mockReturnValue(null),
    inspectFee: vi.fn(),
    ...overrides,
  };
}

describe("resolveLighterAccountSetupStatus key gate", () => {
  it("marks a submitted-but-inactive key resumable (reconcile completes it, no signing)", async () => {
    for (const state of ["change_pub_key_submitted", "key_verified", "nonce_synchronized", "ambiguous"]) {
      const status = await resolveLighterAccountSetupStatus(
        { sessionId: SESSION, environment: "rhc" },
        setupDeps({ readLiveKeyRegistrationState: vi.fn().mockResolvedValue(state) }),
      );
      expect(status.tradingKeyRegistered).toBe(false);
      expect(status.keyRegistrationResumable).toBe(true);
      expect(status.setupRecovery).toBe("key");
    }
  });

  it("never marks a pre-submission intent resumable (finishing it would sign)", async () => {
    for (const state of ["approved", null]) {
      const status = await resolveLighterAccountSetupStatus(
        { sessionId: SESSION, environment: "rhc" },
        setupDeps({ readLiveKeyRegistrationState: vi.fn().mockResolvedValue(state) }),
      );
      expect(status.keyRegistrationResumable).toBe(false);
      expect(status.setupRecovery).toBe("none");
    }
  });

  it("holds a signed staged registration for checking without sending it again", async () => {
    const status = await resolveLighterAccountSetupStatus(
      { sessionId: SESSION, environment: "rhc" },
      setupDeps({ readLiveKeyRegistrationState: vi.fn().mockResolvedValue("key_registration_tx_staged") }),
    );
    expect(status.keyRegistrationResumable).toBe(false);
    expect(status.setupRecovery).toBe("key");
  });

  it("holds an ambiguous deposit for evidence-only recovery even when the account is visible", async () => {
    const deposit = { ...workflow("ambiguous"), activeDepositIntentId: "deposit-1" };
    const status = await resolveLighterAccountSetupStatus(
      { sessionId: SESSION, environment: "rhc" },
      setupDeps({ readWorkflow: vi.fn().mockResolvedValue(deposit) }),
    );
    expect(status.accountExists).toBe(true);
    expect(status.setupRecovery).toBe("deposit");
    expect(status.keyRegistrationResumable).toBe(false);
  });

  it("does not offer a second deposit while a credited account is temporarily absent from the provider read", async () => {
    const status = await resolveLighterAccountSetupStatus(
      { sessionId: SESSION, environment: "rhc" },
      setupDeps({
        readWorkflow: vi.fn().mockResolvedValue({ ...workflow("account_resolved"), activeDepositIntentId: "deposit-1" }),
        readers: { ...setupDeps().readers, readLighterAccount: vi.fn().mockResolvedValue(null) },
      }),
    );
    expect(status.accountExists).toBe(false);
    expect(status.setupRecovery).toBe("deposit");
  });

  it("holds an ambiguous workflow without an attributable intent for review", async () => {
    const status = await resolveLighterAccountSetupStatus(
      { sessionId: SESSION, environment: "rhc" },
      setupDeps({ readWorkflow: vi.fn().mockResolvedValue(workflow("ambiguous")) }),
    );
    expect(status.setupRecovery).toBe("manual_review");
  });

  it("is never resumable once the local key is active", async () => {
    const status = await resolveLighterAccountSetupStatus(
      { sessionId: SESSION, environment: "rhc" },
      setupDeps({
        hasTradingKey: vi.fn().mockReturnValue(true),
        readLiveKeyRegistrationState: vi.fn().mockResolvedValue("change_pub_key_submitted"),
      }),
    );
    expect(status.tradingKeyRegistered).toBe(true);
    expect(status.keyRegistrationResumable).toBe(false);
  });
});
