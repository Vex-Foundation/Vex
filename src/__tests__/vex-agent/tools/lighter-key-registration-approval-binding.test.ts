import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getAuditIntent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.getApproval,
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.getAuditIntent,
}));

const { assertLighterKeyRegistrationApprovalBinding } = await import(
  "@vex-agent/tools/protocols/lighter/key-registration-approval-binding.js"
);

const PUBLIC_KEY = "ab".repeat(40);
const FINGERPRINT = createHash("sha256")
  .update(Buffer.from(PUBLIC_KEY, "hex"))
  .digest("hex");
const NOW = new Date("2030-01-01T00:00:00.000Z");

const INTENT: LighterKeyRegistrationReservationRow = {
  intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  environment: "core",
  walletAddress: "0x1111111111111111111111111111111111111111",
  chainId: 1,
  accountIndex: 42,
  apiKeyIndex: 6,
  slotObservedAt: NOW,
  slotObservationHash: "a".repeat(64),
  approvalStatus: "approval_pending",
  executionState: "approval_pending",
  vaultCredentialId: "lighter/core/account-42/api-key-6",
  publicKey: PUBLIC_KEY,
  publicKeyFingerprint: FINGERPRINT,
  keyGeneratedAt: NOW,
  registrationNonce: "0",
  registrationNonceObservedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: new Date("2030-01-01T00:15:00.000Z"),
};

function criticalArgs() {
  const disclosure = buildLighterKeyRegistrationApprovalDisclosure(INTENT);
  return {
    toolId: "lighter.key.register",
    intentId: INTENT.intentId,
    environment: INTENT.environment,
    walletAddress: disclosure.walletAddress,
    ethereumChainId: disclosure.ethereumChainId,
    lighterChainId: disclosure.lighterChainId,
    accountIndex: disclosure.accountIndex,
    apiKeyIndex: disclosure.apiKeyIndex,
    registrationNonce: disclosure.registrationNonce,
    publicKey: disclosure.publicKey,
    publicKeyFingerprint: disclosure.publicKeyFingerprint,
    vaultCredentialId: disclosure.vaultCredentialId,
    summary: disclosure.summary,
    authorityNote: disclosure.authorityNote,
    signatureNote: disclosure.signatureNote,
    scopeNote: disclosure.scopeNote,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockResolvedValue({
    status: "approved",
    toolCall: {
      command: "execute_tool",
      args: {
        toolId: "lighter.key.register",
        params: { intentId: INTENT.intentId },
      },
    },
  });
  mocks.getAuditIntent.mockResolvedValue({
    sessionId: "session-1",
    decision: "approved",
    actionKind: "external_post",
    executionStatus: "dispatching",
    previewJson: {
      toolName: "key.register",
      namespace: "lighter",
      criticalArgs: criticalArgs(),
    },
  });
});

describe("Lighter key-registration approval binding", () => {
  it("accepts only the exact approved intent and persisted disclosure", async () => {
    await expect(assertLighterKeyRegistrationApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).resolves.toBeUndefined();
  });

  it.each([
    { walletAddress: "0x2222222222222222222222222222222222222222" },
    { accountIndex: 43 },
    { apiKeyIndex: 7 },
    { registrationNonce: "1" },
    { publicKey: "00".repeat(40) },
    { publicKeyFingerprint: "f".repeat(64) },
    { vaultCredentialId: "lighter/core/account-42/api-key-7" },
    { authorityNote: "Register anything." },
    { scopeNote: "Also withdraw." },
  ])("rejects a tampered approval preview: %o", async (override) => {
    mocks.getAuditIntent.mockResolvedValue({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "key.register",
        namespace: "lighter",
        criticalArgs: { ...criticalArgs(), ...override },
      },
    });

    await expect(assertLighterKeyRegistrationApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });

  it("rejects a host approval targeting another intent", async () => {
    mocks.getApproval.mockResolvedValue({
      status: "approved",
      toolCall: {
        command: "execute_tool",
        args: {
          toolId: "lighter.key.register",
          params: {
            intentId: "lighter-onboard-00000000-0000-4000-8000-000000000002",
          },
        },
      },
    });

    await expect(assertLighterKeyRegistrationApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: INTENT,
    })).rejects.toThrow("Nothing was signed or submitted");
  });
});
