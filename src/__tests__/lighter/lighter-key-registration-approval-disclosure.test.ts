import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";

const PUBLIC_KEY = "ab".repeat(40);
const FINGERPRINT = createHash("sha256")
  .update(Buffer.from(PUBLIC_KEY, "hex"))
  .digest("hex");
const NOW = new Date("2030-01-01T00:00:00.000Z");

function intent(
  overrides: Partial<LighterKeyRegistrationReservationRow> = {},
): LighterKeyRegistrationReservationRow {
  return {
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
    ...overrides,
  };
}

describe("Lighter key-registration approval disclosure", () => {
  it("binds the exact wallet, account, slot, public key, fingerprint, and nonce", () => {
    const disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent());

    expect(disclosure).toMatchObject({
      walletAddress: "0x1111111111111111111111111111111111111111",
      ethereumChainId: 1,
      lighterChainId: 304,
      accountIndex: 42,
      apiKeyIndex: 6,
      registrationNonce: "0",
      publicKey: PUBLIC_KEY,
      publicKeyFingerprint: FINGERPRINT,
      vaultCredentialId: "lighter/core/account-42/api-key-6",
    });
    expect(disclosure.signatureNote).toContain("off-chain EIP-191");
    expect(disclosure.scopeNote).toContain("does not authorize a deposit, order, transfer, or withdrawal");
    expect(disclosure.authorityNote).toContain("withdrawal");
  });

  it.each([
    { publicKey: "00".repeat(40) },
    { publicKeyFingerprint: "f".repeat(64) },
    { vaultCredentialId: "lighter/core/account-42/api-key-7" },
    { registrationNonce: null },
    { registrationNonce: "01" },
    { apiKeyIndex: 3 },
    { environment: "rhc" as const },
  ])("fails closed when persisted approval material is inconsistent: %o", (override) => {
    expect(() => buildLighterKeyRegistrationApprovalDisclosure(
      intent(override as Partial<LighterKeyRegistrationReservationRow>),
    )).toThrow();
  });
});
