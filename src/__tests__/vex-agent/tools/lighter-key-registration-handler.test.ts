import { requireValue } from "../../helpers/require-value.js";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { validatePreparedActionFollowUp } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const INTENT_ID = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const PUBLIC_KEY = "ab".repeat(40);
const FINGERPRINT = createHash("sha256")
  .update(Buffer.from(PUBLIC_KEY, "hex"))
  .digest("hex");

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getAccountsByL1Address: vi.fn(),
  getNextNonce: vi.fn(),
  findLive: vi.fn(),
  reserve: vi.fn(),
  findIntent: vi.fn(),
  adoptPristineApproval: vi.fn(),
  markApprovalPending: vi.fn(),
  markApproved: vi.fn(),
  renewPristineApproved: vi.fn(),
  isIntegrationEnabled: vi.fn(),
  setIntegrationEnabled: vi.fn(),
  getWorkflow: vi.fn(),
  transitionWorkflow: vi.fn(),
  withSessionControlLock: vi.fn(),
  withSessionControlLocks: vi.fn(),
  resolveSelectedAddress: vi.fn(),
  getPreparer: vi.fn(),
  prepareCredential: vi.fn(),
  assertApprovalBinding: vi.fn(),
  getExecutor: vi.fn(),
  executeRegistration: vi.fn(),
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => ({
    getApiKeys: mocks.getApiKeys,
    getAccountsByL1Address: mocks.getAccountsByL1Address,
    getNextNonce: mocks.getNextNonce,
  }),
}));

vi.mock("@vex-agent/db/repos/lighter-key-registration-intents.js", () => ({
  findLiveLighterKeyRegistrationIntentForAccount: mocks.findLive,
  reserveLighterApiKeySlotWith: (_client: unknown, input: unknown) => mocks.reserve(input),
  findLighterKeyRegistrationIntent: mocks.findIntent,
  adoptPristineLighterKeyRegistrationApprovalWith: (_client: unknown, input: unknown) =>
    mocks.adoptPristineApproval(input),
  markLighterKeyRegistrationApprovalPendingWith: (_client: unknown, input: unknown) =>
    mocks.markApprovalPending(input),
  markLighterKeyRegistrationApprovedWith: (_client: unknown, input: unknown) =>
    mocks.markApproved(input),
  renewPristineApprovedLighterKeyRegistrationIntentWith: (_client: unknown, input: unknown) =>
    mocks.renewPristineApproved(input),
}));

vi.mock("@vex-agent/db/repos/lighter-integration-settings.js", () => ({
  isLighterIntegrationEnabled: mocks.isIntegrationEnabled,
  setLighterIntegrationEnabled: mocks.setIntegrationEnabled,
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-workflows.js", () => ({
  getLighterOnboardingWorkflow: mocks.getWorkflow,
  transitionLighterOnboardingWorkflowWith: (_client: unknown, input: unknown) =>
    mocks.transitionWorkflow(input),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.withSessionControlLock,
  withSessionControlLocks: mocks.withSessionControlLocks,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: mocks.resolveSelectedAddress,
  walletScopeErrorToResult: (error: unknown) => { throw error; },
}));

vi.mock("@vex-agent/tools/protocols/lighter/key-registration-preparation.js", () => ({
  getConfiguredLighterKeyRegistrationCredentialPreparer: mocks.getPreparer,
}));

vi.mock("@vex-agent/tools/protocols/lighter/key-registration-approval-binding.js", () => ({
  assertLighterKeyRegistrationApprovalBinding: mocks.assertApprovalBinding,
}));

vi.mock("@vex-agent/tools/protocols/lighter/key-registration-execution.js", () => ({
  getConfiguredLighterKeyRegistrationExecutor: mocks.getExecutor,
}));

const { LIGHTER_KEY_REGISTRATION_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/key-registration.js"
);

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: "session-1",
};

function row(
  executionState: "slot_reserved" | "key_generated_encrypted" | "approval_pending" | "approved",
  environment: LighterEnvironment = "core",
) {
  const hasKey = executionState !== "slot_reserved";
  const hasNonce = executionState === "approval_pending" || executionState === "approved";
  return {
    intentId: INTENT_ID,
    sessionId: "session-1",
    environment,
    walletAddress: WALLET,
    chainId: environment === "core" ? 1 : 4663,
    accountIndex: 42,
    apiKeyIndex: 6,
    slotObservedAt: new Date("2030-01-01T00:00:00.000Z"),
    slotObservationHash: "a".repeat(64),
    approvalStatus: executionState === "approved" ? "approved" as const : "approval_pending" as const,
    executionState,
    vaultCredentialId: hasKey ? `lighter/${environment}/account-42/api-key-6` : null,
    publicKey: hasKey ? PUBLIC_KEY : null,
    publicKeyFingerprint: hasKey ? FINGERPRINT : null,
    keyGeneratedAt: hasKey ? new Date("2030-01-01T00:00:00.000Z") : null,
    registrationNonce: hasNonce ? "0" : null,
    registrationNonceObservedAt: hasNonce ? new Date("2030-01-01T00:01:00.000Z") : null,
    registrationTxType: null,
    registrationTxHash: null,
    registrationTxExpiredAt: null,
    registrationTxStagedAt: null,
    registrationSubmittedTxHash: null,
    registrationSubmitCode: null,
    registrationPredictedExecutionTimeMs: null,
    registrationSubmitAcceptedAt: null,
    registrationAmbiguityReason: null,
    registrationKeyVerifiedAt: null,
    registrationClientCheckedAt: null,
    postRegistrationNonce: null,
    registrationNonceSynchronizedAt: null,
    registrationActivatedAt: null,
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:01:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSelectedAddress.mockReturnValue(WALLET);
  mocks.isIntegrationEnabled.mockResolvedValue(true);
  mocks.setIntegrationEnabled.mockResolvedValue({ enabled: true });
  mocks.getWorkflow.mockResolvedValue({
    workflowState: "account_resolved",
    resolvedAccountIndex: 42,
  });
  mocks.getAccountsByL1Address.mockResolvedValue({
    code: 200,
    l1_address: WALLET,
    sub_accounts: [{ account_type: 0, index: 42, l1_address: WALLET }],
  });
  mocks.transitionWorkflow.mockResolvedValue({
    workflowState: "account_resolved",
    resolvedAccountIndex: 42,
  });
  mocks.getPreparer.mockReturnValue({ prepare: mocks.prepareCredential });
  mocks.withSessionControlLock.mockImplementation(async (_sessionId, fn) =>
    fn({ marker: "locked-client" }));
  mocks.withSessionControlLocks.mockImplementation(async (_sessionIds, fn) =>
    fn({ marker: "multi-locked-client" }));
  mocks.getApiKeys.mockResolvedValue({ code: 200, api_keys: [] });
  mocks.getNextNonce.mockResolvedValue({ code: 200, nonce: 0 });
  mocks.findLive.mockResolvedValue(null);
  mocks.reserve.mockResolvedValue({ outcome: "created", reservation: row("slot_reserved") });
  mocks.prepareCredential.mockResolvedValue({
    intentId: INTENT_ID,
    environment: "core",
    accountIndex: 42,
    apiKeyIndex: 6,
    vaultCredentialId: "lighter/core/account-42/api-key-6",
    publicKey: PUBLIC_KEY,
    publicKeyFingerprint: FINGERPRINT,
    outcome: "generated",
  });
  mocks.findIntent.mockResolvedValue(row("key_generated_encrypted"));
  mocks.markApprovalPending.mockResolvedValue(row("approval_pending"));
  mocks.markApproved.mockResolvedValue(row("approved"));
  mocks.renewPristineApproved.mockResolvedValue(row("approved"));
  mocks.adoptPristineApproval.mockResolvedValue(null);
  mocks.assertApprovalBinding.mockResolvedValue(undefined);
  mocks.getExecutor.mockReturnValue(null);
});

describe("lighter.key.register.prepare", () => {
  it("activates managed setup without asking the user to visit Settings", async () => {
    mocks.isIntegrationEnabled.mockResolvedValue(false);

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.setIntegrationEnabled).toHaveBeenCalledWith({
      environment: "core",
      walletAddress: WALLET,
      enabled: true,
    });
    expect(result.data).toMatchObject({ status: "approval_prepared" });
  });

  it("adopts one live wallet-owned master account before reserving a key slot", async () => {
    mocks.getWorkflow.mockResolvedValue({
      workflowState: "integration_enabled",
      resolvedAccountIndex: null,
    });

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.getAccountsByL1Address).toHaveBeenCalledWith("core", {
      l1Address: WALLET,
      cursor: undefined,
    });
    expect(mocks.transitionWorkflow).toHaveBeenCalledWith({
      environment: "core",
      walletAddress: WALLET,
      expectedStates: ["integration_enabled"],
      nextState: "account_resolved",
      resolvedAccountIndex: 42,
    });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      accountIndex: 42,
    }));
  });

  it("reserves from a full-slot read, encrypts through the privileged preparer, and binds nextNonce", async () => {
    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.getApiKeys).toHaveBeenCalledWith("core", {
      accountIndex: 42,
      apiKeyIndex: 255,
    });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      walletAddress: WALLET,
      accountIndex: 42,
      observation: expect.objectContaining({ occupiedApiKeyIndexes: [] }),
    }));
    expect(mocks.prepareCredential).toHaveBeenCalledWith({
      sessionId: "session-1",
      intentId: INTENT_ID,
    });
    expect(mocks.getNextNonce).toHaveBeenCalledWith("core", {
      accountIndex: 42,
      apiKeyIndex: 6,
    });
    expect(mocks.markApprovalPending).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      sessionId: "session-1",
      registrationNonce: "0",
    }));
    expect(validatePreparedActionFollowUp(
      "lighter.key.register.prepare",
      requireValue(result.preparedActionFollowUp),
    )).toEqual({ ok: true, followUp: result.preparedActionFollowUp });
    expect(result.data).toMatchObject({
      accountIndex: 42,
      apiKeyIndex: 6,
      registrationNonce: "0",
      publicKeyFingerprint: FINGERPRINT,
    });
    expect(JSON.stringify(result)).not.toContain("privateKey");
  });

  it("prepares Robinhood Chain credentials against the RHC account, slot, and nonce APIs", async () => {
    mocks.getWorkflow.mockResolvedValue({
      workflowState: "account_resolved",
      resolvedAccountIndex: 42,
    });
    mocks.reserve.mockResolvedValue({
      outcome: "created",
      reservation: row("slot_reserved", "rhc"),
    });
    mocks.prepareCredential.mockResolvedValue({
      intentId: INTENT_ID,
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 6,
      vaultCredentialId: "lighter/rhc/account-42/api-key-6",
      publicKey: PUBLIC_KEY,
      publicKeyFingerprint: FINGERPRINT,
      outcome: "generated",
    });
    mocks.findIntent.mockResolvedValue(row("key_generated_encrypted", "rhc"));
    mocks.markApprovalPending.mockResolvedValue(row("approval_pending", "rhc"));

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "rhc" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.getApiKeys).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 255,
    });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      environment: "rhc",
      chainId: 4663,
    }));
    expect(mocks.getNextNonce).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 6,
    });
    expect(result.data).toMatchObject({
      status: "approval_prepared",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 6,
    });
    expect(validatePreparedActionFollowUp(
      "lighter.key.register.prepare",
      requireValue(result.preparedActionFollowUp),
    )).toEqual({ ok: true, followUp: result.preparedActionFollowUp });
  });

  it("fails before reserving a slot when the privileged preparer is unavailable", async () => {
    mocks.getPreparer.mockReturnValue(null);

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("No slot was reserved and no key was generated");
    expect(mocks.getApiKeys).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("refuses a durable reservation owned by another session", async () => {
    mocks.findLive.mockResolvedValue({ ...row("slot_reserved"), sessionId: "session-2" });

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("belongs to another session");
    expect(mocks.prepareCredential).not.toHaveBeenCalled();
  });

  it("adopts an unsubmitted RHC approval preparation into the current session", async () => {
    const previous = { ...row("approval_pending", "rhc"), sessionId: "session-2" };
    const adopted = { ...previous, sessionId: "session-1" };
    mocks.getWorkflow.mockResolvedValue({
      workflowState: "key_registration_approval_pending",
      resolvedAccountIndex: 42,
    });
    mocks.findLive.mockResolvedValue(previous);
    mocks.adoptPristineApproval.mockResolvedValue(adopted);

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "rhc" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(mocks.withSessionControlLocks).toHaveBeenCalledWith(
      ["session-2", "session-1"],
      expect.any(Function),
    );
    expect(mocks.adoptPristineApproval).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      previousSessionId: "session-2",
      sessionId: "session-1",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 42,
      expiresAt: expect.any(Date),
    }));
    expect(result.preparedActionFollowUp).toBeDefined();
    expect(validatePreparedActionFollowUp(
      "lighter.key.register.prepare",
      requireValue(result.preparedActionFollowUp),
    )).toEqual({ ok: true, followUp: result.preparedActionFollowUp });
    expect(mocks.prepareCredential).not.toHaveBeenCalled();
    expect(mocks.getNextNonce).not.toHaveBeenCalled();
  });

  it("fails closed when the reserved slot has no valid public nextNonce", async () => {
    mocks.getNextNonce.mockResolvedValue({ code: 500, nonce: 0 });

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("valid public next nonce");
    expect(mocks.markApprovalPending).not.toHaveBeenCalled();
    expect(result.preparedActionFollowUp).toBeUndefined();
  });

  it("reissues a fresh approval for the same pristine approved intent", async () => {
    mocks.findLive.mockResolvedValue(row("approved"));
    mocks.getWorkflow.mockResolvedValue({
      workflowState: "key_registration_approval_pending",
      resolvedAccountIndex: 42,
    });

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data).toMatchObject({
      status: "approval_reissued",
      intentId: INTENT_ID,
      accountIndex: 42,
      apiKeyIndex: 6,
      registrationNonce: "0",
    });
    expect(result.preparedActionFollowUp).toBeDefined();
    expect(mocks.getApiKeys).not.toHaveBeenCalled();
    expect(mocks.prepareCredential).not.toHaveBeenCalled();
    expect(mocks.getNextNonce).not.toHaveBeenCalled();
    expect(mocks.markApprovalPending).not.toHaveBeenCalled();
    expect(mocks.renewPristineApproved).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      sessionId: "session-1",
      expiresAt: expect.any(Date),
    }));
  });

  it("refuses approval reissue once any signing evidence exists", async () => {
    mocks.findLive.mockResolvedValue({
      ...row("approved"),
      registrationTxType: 8,
      registrationTxHash: "a".repeat(80),
      registrationTxExpiredAt: "1893456000000",
      registrationTxStagedAt: new Date("2030-01-01T00:02:00.000Z"),
    });
    mocks.getWorkflow.mockResolvedValue({
      workflowState: "key_registration_approval_pending",
      resolvedAccountIndex: 42,
    });

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register.prepare"])(
      { environment: "core" },
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("already in approved");
    expect(result.preparedActionFollowUp).toBeUndefined();
  });
});

describe("lighter.key.register", () => {
  it("requires the exact host approval before recording a decision", async () => {
    mocks.findIntent.mockResolvedValue(row("approval_pending"));
    mocks.assertApprovalBinding.mockRejectedValue(new Error("approval mismatch"));

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register"])(
      { intentId: INTENT_ID },
      { ...CONTEXT, approved: true, approvalId: "approval-1" },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("approval mismatch");
    expect(mocks.markApproved).not.toHaveBeenCalled();
  });

  it("stops at the privileged code boundary when the executor is unavailable", async () => {
    mocks.findIntent.mockResolvedValue(row("approval_pending"));

    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register"])(
      { intentId: INTENT_ID },
      { ...CONTEXT, approved: true, approvalId: "approval-1" },
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data?.status).toBe("approval_recorded_execution_closed");
    expect(result.output).toContain("Nothing was signed or submitted");
  });

  it("passes only trusted session wallet scope into the privileged executor", async () => {
    mocks.findIntent.mockResolvedValue(row("approval_pending"));
    mocks.getExecutor.mockReturnValue({ execute: mocks.executeRegistration });
    mocks.executeRegistration.mockResolvedValue({
      source: "vex_lighter_key_registration",
      status: "active",
      intentId: INTENT_ID,
      executionState: "active",
      accountIndex: 42,
      apiKeyIndex: 6,
      txHash: "a".repeat(80),
      postRegistrationNonce: "1",
      message: "Registration verified.",
    });

    const context = { ...CONTEXT, approved: true, approvalId: "approval-1" };
    const result = await requireValue(LIGHTER_KEY_REGISTRATION_HANDLERS["lighter.key.register"])(
      { intentId: INTENT_ID },
      context,
    );

    expect(result.success, result.output).toBe(true);
    expect(result.data?.status).toBe("active");
    expect(mocks.executeRegistration).toHaveBeenCalledWith({
      sessionId: "session-1",
      intentId: INTENT_ID,
      walletResolution: context.walletResolution,
      walletPolicy: context.walletPolicy,
      abortSignal: undefined,
    });
  });
});
